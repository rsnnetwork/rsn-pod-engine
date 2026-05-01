# 1st May Architectural Fixes — Phased Execution Plan

**Source spec:** `assets/1st may.pdf` (Stefan, post-1 May 2026 test with 8 users incl. Stefan, Ali, Raja, Ali King, Stephen).

**Scope:** All 12 items from the doc EXCEPT building Matching Engine 1.0 itself (which Stefan defers and which is "one of many" matching algorithms). Engine V1 internals stay; we only add the registry seam so future event types can register their own algorithm.

**Design rule:** every phase is an **architectural upgrade**, not a bug patch. Each phase ends with: (a) architectural pinning tests, (b) full server test suite green, (c) commit, (d) push to staging + main, (e) `check whole` post-deploy.

**Critical regression caught after April 30 deploy:** Breakout-room chat is still not delivering messages between users in the same breakout (Stefan + Ali tested in real event). My Phase A fix from earlier today is insufficient. Phase 0 below is the urgent root-cause fix.

---

## Phase 0 — Breakout chat true root-cause (URGENT, regression)

**Problem:** When two users are in a breakout (LiveKit room), one types a message, the other never sees it. Phase A fix from `b8abcdc` set `roomParticipants` map as primary source, but production behavior shows it's not populated correctly OR the fallback path is silently failing.

**Pre-audit (mandatory before code):**
- Verify whether `presence:room_joined` fires from the client when LiveKit `room.connect()` resolves. Trace `client/src/features/event/VideoRoom.tsx` (or equivalent) for the emit. If the emit fires but the server handler doesn't update `roomParticipants`, that's the bug.
- Check the chat-handler flow under round-active conditions: when a breakout match is created, is `roomParticipants` populated server-side at the moment of match creation, or does it wait for a client-emitted presence event that may race?
- Check the actual production behavior via Render logs from today's test session — find the chat send events and trace recipient resolution.

**Architectural fix (not a band-aid):**
- Server-side `roomParticipants` must be populated AT MATCH-CREATION time (orchestration writes the canonical room → participant mapping when it issues the LK token), not lazily via a client-emit. Client `presence:room_joined` becomes a confirmation, not the source of truth.
- Chat handler resolves recipients in this order: (1) `roomParticipants` server-canonical map, (2) `matches` row for this user with `status IN ('active', 'round_rating')`, (3) only-self emit (last resort, log warning).
- Same architectural rule applied to `chat:react` and any future room-scoped event.

**Tests:**
- Architectural pinning test that asserts `roomParticipants` is populated by `assignParticipantsToRoom` (or wherever match creation happens), not by client-emitted presence.
- Integration test: simulate two-user breakout, send chat from A, assert socket received by B.

**Acceptance:** real-world test — user enters breakout, types, partner sees message. Confirmed by post-deploy Render log scrape showing `recipientsResolved: 2` (or whatever the metric is).

---

## Phase 1 — Participant State Machine (the spine)

**Maps to Stefan's items 1, 2, partly 9, partly 10.**

**Pre-audit:**
- Map every existing call site that mutates participant state: `updateParticipantStatus`, `presenceMap.set/delete`, `roomParticipants.set/delete`, `manuallyLeftRound.add/delete`, DB `UPDATE session_participants SET status = ...`. Confirmed >11 sites in audit; need exact count.
- Identify which existing `withSessionGuard` wraps already serialise these vs which do not.

**Architectural shape:**
- New service `services/orchestration/state/participant-state-machine.ts`:
  - `transition(sessionId, userId, toState, reason): Promise<TransitionResult>` — only legal mutation path.
  - States: `not_joined | registered | in_main_room | in_matching | in_breakout(roomId) | in_rating | finished | disconnected | removed`.
  - Validates legal `from → to` transitions via a static table; rejects illegal transitions with telemetry log.
  - Atomically updates: in-memory `ActiveSession.participantStates: Map<userId, State>` (new field), DB `session_participants.status`, `presenceMap` projection, `roomParticipants` projection.
  - Wrapped in `withSessionGuard` so it's race-free per-process.
  - Emits a single `host:dashboard` refresh per transition (or coalesces if multiple transitions land in the same tick).
- DB migration adds the two missing enum values: `'in_matching'` and `'in_rating'`.
- All existing call sites refactored to call `transition()`. Direct status writes are removed (or wrapped if they need to stay for legacy reasons).

**Forward compatibility:** the `transition()` API is the seam for future Redis-backed state when we move horizontal — same interface, swap the storage backend. No call site needs to change.

**Tests:**
- Pinning tests for the transition table (all legal pairs, all illegal pairs).
- Integration: `endRound` → all participants transition `in_breakout(X) → in_rating → in_main_room` in expected order.
- Race test: two concurrent transitions, only one wins, the loser sees a clean error.

---

## Phase 2 — Stored Meeting Records + Recap Stability

**Maps to items 3, 4, 12.**

**Pre-audit:**
- Inventory all 4 (audit said 4) recap consumers: REST UI, recap email, host recap, encounters page. Confirm exact SQL queries.
- Determine whether `encounter_history.mutual_meet_again` mutates after later rounds finalise (audit suggests yes).

**Architectural shape:**
- New table `meeting_records`:
  ```
  id              UUID PK
  session_id      UUID NOT NULL
  round_number    INT NOT NULL
  match_id        UUID NOT NULL REFERENCES matches(id)
  user_id         UUID NOT NULL
  partner_id      UUID NOT NULL
  rating_given    INT
  meet_again_self BOOLEAN
  meet_again_partner BOOLEAN
  is_mutual       BOOLEAN GENERATED ALWAYS AS (meet_again_self AND meet_again_partner) STORED
  recorded_at     TIMESTAMPTZ
  is_recap_eligible BOOLEAN NOT NULL DEFAULT TRUE
  UNIQUE(session_id, round_number, user_id, partner_id)
  ```
- Written exactly once by `finalizeRoundRatings` (extended). Never mutated again unless the partner later submits their rating, which updates `meet_again_partner` and recomputes `is_mutual` (single UPDATE).
- Three-metric API:
  - `getUniquePeopleMet(userId, sessionId): COUNT(DISTINCT partner_id)`
  - `getTotalMeetings(userId, sessionId): COUNT(*)`
  - `getMutualMatches(userId, sessionId): COUNT(*) WHERE is_mutual`
- All 4 consumers refactored to read from `meeting_records`. `encounter_history.mutual_meet_again` becomes read-only "ever mutual across all sessions" — it stops driving recap counts.
- Backfill migration: populate `meeting_records` from existing `matches × ratings`.

**Forward compatibility:** the table is the canonical record of every meeting forever. Adding new metrics later (e.g. "met in person count" via offline events) becomes adding columns, not refactoring 4 SQL queries.

**Tests:**
- Pinning: meeting_records row count == match count for any session.
- Determinism: refreshing recap 5 times in a row never changes the displayed counts.
- Backfill correctness: post-backfill, every existing recap renders the same as pre-backfill ± definitional improvements.

---

## Phase 3 — Pluggable Matching Engine Registry

**Maps to item 11 + your strategic note about "one of many algorithms".**

**Pre-audit:** confirm `IMatchingEngine` interface is complete enough to host non-greedy algorithms (e.g. constraint-satisfaction, ML-ranked).

**Architectural shape:**
- `services/matching/registry.ts`:
  - `registerEngine(id, engine: IMatchingEngine)`.
  - `getEngine(id): IMatchingEngine`.
- `matching.service.ts` stops importing the concrete singleton; instead reads `session.matching_algorithm_id` (new column, default `'speed_networking_v1'`) and looks up via registry.
- Engine V1 self-registers on import as `'speed_networking_v1'`.
- Sessions table gets `matching_algorithm_id TEXT NOT NULL DEFAULT 'speed_networking_v1'`. Future event types pick a different ID.

**Tests:**
- Registry pinning: a fake test engine can be registered + invoked without touching matching.service.ts.
- Existing matching tests pass unchanged (Engine V1 still default).

**Note:** this is purely the SEAM. We do NOT build a second engine here. Stefan's Matching Engine 1.0 lands later through this seam.

---

## Phase 4 — Invite Flow Verification + Confirmed Registration

**Maps to item 5.**

**Pre-audit:**
- Re-verify the 404→magic flow against today's code (T0-4 atomic accept already shipped). Confirm whether the bug Stefan saw is still reproducible.
- Trace the navigation path from Accept POST to live-event page for race conditions.

**Architectural shape:**
- Invite accept response includes `participantStatus: 'registered'` confirmation.
- Client waits for socket-level `participant:registered_ack` event before navigating to the live page (not optimistic redirect).
- Live event page becomes resilient to mid-round entry: if state is `ROUND_ACTIVE`, render a "Round in progress, joining shortly" overlay instead of crashing.

**Tests:**
- Race test: accept invite during active round, verify graceful entry.
- Pinning: redirect happens only after server-confirmed participant row exists.

---

## Phase 5 — Identity Unification (one helper, avatars in breakout)

**Maps to item 9.**

**Architectural shape:**
- Extract `fallbackName(displayName, email, id)` from the 5 inline copies (`matching-flow.ts`, `participant-flow.ts` ×2, `host-actions.ts`, `chat-handlers.ts`) to `shared/src/identity/displayName.ts`. All call sites import from shared.
- LK token issuance includes `metadata: { displayName, avatarUrl }` (currently only displayName via `participant.name`).
- `VideoRoom.tsx` reads avatar from `participant.metadata` and renders avatar in tile when video is off.
- Autocomplete user search ("STE issue") audited — confirm it uses `encounter_history` corpus and that the corpus is sane post-Phase 2.

**Tests:**
- Pinning: only one `fallbackName` definition in the repo.
- Pinning: every LK token issuance call includes avatarUrl in metadata.

---

## Phase 6 — Mobile Responsiveness Pass

**Maps to items 6, 7.**

**Pre-audit:**
- Survey breakpoint counts per file (audit done: ChatPanel = 1, RatingPrompt minimal, RecapPage = 3).
- Identify the input components causing iOS auto-zoom (font-size < 16px).

**Architectural shape:**
- ChatPanel rewritten as a bottom-drawer on mobile (`<sm`), side-panel on desktop (`>=sm`). Peek mode: when chat is open on mobile, room video collapses to a 30vh strip on top, chat takes 70vh below.
- Top bar collapses banners (state, connection, broadcast, etc.) into a single rotating ticker on mobile.
- All `<input>` and `<textarea>` get `text-base` (16px) on mobile to kill iOS zoom.
- ChatPanel input bar respects keyboard with `env(keyboard-inset-height)`.

**Tests:**
- Visual snapshot tests at 360×640, 414×896, 768×1024, 1280×800.
- Pinning: ChatPanel has at least 4 mobile-specific breakpoints.

---

## Phase 7 — UI Polish (palette, nav, recap CTA)

**Maps to item 8.**

**Architectural shape:**
- Palette token sweep: `bg-[#292a2d]` → `bg-white text-[#1a1a2e]` for non-video-tile surfaces (rating screen, modals).
- `EventStateBanner` self-collapses when label is empty (no whitespace footprint).
- Recap CTA: persistent "View Recap" button in the live page footer once a round has completed.
- Breakout room display name uses the shared `fallbackName` (Phase 5 dependency).

**Tests:**
- Pinning: rating screen renders on white background.
- Pinning: recap CTA visible whenever `roundsCompleted >= 1`.

---

## Phase 8 — Host Action Receipts + Visibility

**Maps to item 10.**

**Architectural shape:**
- Every host action (`remove_from_room`, `move_to_room`, `bulk_create_breakouts`, etc.) emits `host:action_confirmed { action, target, timestamp, summary }` after success.
- `HostRoundDashboard` renders a transient toast for each receipt + an audit log strip showing the last 5 actions.
- `_emitHostDashboard` skips the 1s coalesce when triggered by a host action (immediate refresh).

**Tests:**
- Pinning: every host-action handler emits `host:action_confirmed`.
- Integration: host removes user from room, dashboard shows new state within 200ms.

---

## Cross-cutting rules (apply to every phase)

- TDD: pinning test first, then implementation.
- Keep `progress.md` updated after every commit.
- Push to BOTH staging AND main per global rule.
- After each phase deploy: `check whole` (Sentry server, Sentry client, Render deploy status, Render recent logs, Vercel, CI, DB consistency, Redis ping).
- If `check whole` shows any regression, fix-forward in the SAME phase; do not advance to the next phase with a yellow signal.
- Behavior preservation: every documented feature from commit `33e3f87` (current main HEAD) keeps working. Only the explicit changes below are user-visible.

## Out of scope (deliberately deferred)

- Matching Engine 1.0 algorithm itself (per Stefan + your "one of many" note).
- Threads / AI summaries / group communication redesign (Stefan's Layer 2).
- Render plan changes / horizontal scaling (Tier 2 plan, separate).
- Cosmetic-only redesigns not flagged in the 1st May doc.

## Rollback

Each phase = one independent commit. `git revert <sha>` + push reverses any phase. Phase 1 (state machine) is the most coupled — its revert plan is to re-enable the legacy direct-status writes (kept behind a feature flag during migration).
