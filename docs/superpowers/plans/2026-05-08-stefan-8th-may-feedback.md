# Stefan's 8 May review — full close-out plan

**Date:** 2026-05-08
**Owner:** Ali
**Status:** Plan, awaiting approval (RajaSkill 1.4 gate)
**Estimated effort:** 1.5–2 days, 4 sub-phases

## Evidence summary (Phase 5.1 check-hole pass)

- **Sentry server, last 24h:** 0 errors. ✅
- **Sentry client, last 24h:** 1 new `NegotiationError: negotiation timed out` at 12:40 UTC (LiveKit-side). 9 pre-existing client issues (all video transport, none new from today).
- **Render server, last 6h, level=50:** 0 errors. Test ran ~12:27–12:32 UTC.
- **Render warn-level traffic during the test:** burst of `/api/matching-templates` 404s and `/api/auth/session` 401s (route-not-found and unauth probes — not indicative of bugs).
- **Verdict:** No backend crashes during the test. The issues Stefan reported are all **state-synchronisation, presence, and UX** — exactly what the 8 May doc says.

---

## Audit findings (4 parallel Explore agents, evidence-based)

### Stefan #1 — Invite "Failed to accept" false negative

**Confirmed bug.** Two-line root cause:
- `server/src/services/invite/invite.service.ts:560` — idempotent re-acceptance returns `participantStatus: undefined` when the SELECT after the ON CONFLICT update returns 0 rows.
- `client/src/features/invites/InviteAcceptPage.tsx:103-106` — client throws a custom `Error("Registration not confirmed by server. Please retry.")` when `sid && !pStatus`. That error has no error code, falls through to the generic toast "Failed to accept invite."
- Backend has actually registered the user; the UI lies.

### Stefan #2 — Matching engine includes non-present users (Wazim case)

**Confirmed bug, two distinct gaps:**
- `server/src/services/matching/matching.service.ts:94-115` — `generateSessionSchedule` (pre-event plan, runs at Start Event) filters by `status NOT IN ('removed','left','no_show')` but **does not** filter by presence. Wazim registered but never connected → his row passed the filter → got into the pre-plan.
- `matching-flow.ts:1009-1021` — the dashboard's "eligible main-room count" query has the same gap. Host saw an inflated count.
- Per-round path (`generateSingleRound`) DOES use `presentUserIds` from `presenceMap` (matching-flow.ts:104) — that one was already fixed in Phase 7A.2. But the pre-plan path was missed.

### Stefan #4 — Frontend not reflecting backend (controls freeze, missing host UI)

**Confirmed bug, two root causes:**
- `client/src/hooks/useSessionSocket.ts` — `permissions:updated` event is emitted by the server (host-actions.ts:1531-1538) but **the client has no handler for it**. Result: a newly-promoted co-host's UI doesn't gain host buttons until the 30-second `session:state` periodic re-sync. Other clients see the cohost in the cohosts Set immediately (that handler exists), but the cohost themselves doesn't see their new powers.
- "Controls freeze / clicks stop": **modals are missing Esc handlers**. Invite modal, Room creation modal, HCC Move-to-room sub-modal, HCC windowed mode — none respond to Escape. Users press Esc, nothing happens, feel stuck.

### Stefan #5 — Control Center should be the single operational surface

**Architectural, not a bug.** Today, host actions live in three places:
- Bottom action bar (Start, Match People, Pause, +2 min, End Round, Room, bulk controls, Invite, Test mode, Control Center, End Event) — too many buttons.
- Control Center drawer/window (per-participant actions, per-room +2 min).
- Inline match-preview panel (swap, manual pair, regenerate).

Stefan's call: thin the bottom bar down to **essential hot actions only** (Start, End, Pause, +2 min during round); everything else moves into the Control Center.

### Stefan #6 — Drag/drop unstable; modals stuck

**Confirmed bug, but partly aspirational.** No actual drag-drop library is wired up — what's there is the click-name-to-swap pattern in match preview. The "stuck modals / can't close / can't scroll" is the same Esc-handler gap as #4. Recommendation: drop any drag aspiration, formalise the existing button-based actions (Move to room, Swap, Force Pair), fix the Esc handlers.

### Stefan #7 — Matching can produce invalid room structures

**Confirmed gaps:**
- `match-validator.service.ts:94-97` — validator checks "IDs are unique" but has no explicit self-match check. Schema has `CHECK no_self_match` (migration 001:222) so DB rejects, but only after we've already issued LiveKit tokens and emitted match:assigned events. Client gets a brief invalid state before rollback.
- `sessionWideActiveCheck` flag exists in the validator but is never set to `true` by any caller. So manual force-match can pair someone who's already in another active match in a different round.
- Bye accounting can drift when the helper that builds `byeParticipants` throws — client sees empty list but DB has unmatched users.

### Stefan #8 — Breakout chat broken

**Confirmed bug:**
- `chat-handlers.ts:142` — fallback room-scope query uses `status NOT IN ('cancelled','no_show')`, which still includes `'completed'` and `'reassigned'` matches. Result: when a round transitions, a chat message can be delivered to the OLD match's participants who have already moved on.
- Room messages don't always carry `roomId`; reactions on those messages fail to find the parent match.

### Stefan #9 — Co-host system incomplete

Subset of #4 (the missing `permissions:updated` listener) plus a documentation gap. There are no written rules for: how many cohorts allowed (currently unbounded), can cohorts demote each other (no — only original host can), can cohorts override matches (yes — same buttons as host), etc.

### Stefan #10 — Test mode has no defined purpose → remove

**Confirmed.** Phase 7C.3 shipped this, but on the test no one could explain what it did. Per Stefan's rule: "if it can't be explained in one sentence, remove it." We'll remove the manual toggle and the auto-detection heuristic. The `session.config.testMode` column stays (additive, harmless), but no UI wires to it.

### Stefan #11 — Host view UX (compact mode, host pin)

**Confirmed gap:**
- `VideoRoom.tsx:115-284` — has `pinnedSid` state and click-to-pin, but no auto-pin. Stefan's spec: host + cohorts always get a reserved slot so the host can see the room and operate without losing their tile.

---

## What this plan IS NOT

- Not a rebuild of matching. Phase 2.5 (matching engine 1.0 spec) stands.
- Not a redesign of Control Center. The windowed UX from Phase 7C.5 stays; we're moving more controls **into** it, not rebuilding it.
- Not adding drag-and-drop. We commit to button-based interactions.
- Not removing test mode's DB column or migration — only the UI surface.

---

## Phased delivery

### Phase 8A — Server data-integrity fixes (~half day, server-only)

Closes Stefan #1 (invite), #2 (matching presence source), #7 (matching validation), #8 (chat scope).

**8A.1 — Invite acceptance returns authoritative status**
- `invite.service.ts:560` — default `participantStatus = 'registered'` when the SELECT misses (idempotent path).
- Add a single-line guard so the server response is always `{ success: true, participantStatus: <string> }` for any invite that resolved to a session participant.

**8A.2 — Pre-event plan filters by presence**
- `matching.service.ts:94-115` — accept a `presentUserIds: Set<string>` parameter on `generateSessionSchedule`, same shape as `generateSingleRound`. Caller (`handleHostStart`) passes `activeSession.presenceMap` keys. If 0 connected when host clicks Start, surface a clear error to the client ("No participants are currently in the main room").
- `matching-flow.ts:1009-1021` — dashboard's "eligible count" query gets a presence-aware version. Returns two numbers: `registered` (DB count) and `present` (presenceMap intersection). Client shows both: "5 in main room (out of 7 registered)".

**8A.3 — Matching validator hardening**
- `match-validator.service.ts:94-97` — add explicit self-match check pre-write. Cheap, defensive — schema already enforces, but failing fast is better than rolling back a transaction.
- Enable `sessionWideActiveCheck: true` in `host:force_match` handler. Prevents pairing someone who's already in an active match in any round of this session.
- `byeParticipants` array is built defensively — if helper throws, the dashboard emit still includes a count from a fallback query. No silent loss.

**8A.4 — Chat scope tighter**
- `chat-handlers.ts:142` — fallback room-scope query restricted to `status IN ('active', 'scheduled')`. Drops completed/reassigned matches.
- Every room-scope chat message guaranteed to carry a non-null `roomId` (line 162 fallback chain).

**Architectural pins:** ~10 new server pin tests across these files.

### Phase 8B — Client state-sync + modal hygiene (~half day, client-only)

Closes Stefan #4, parts of #6 + #9.

**8B.1 — `permissions:updated` listener**
- `useSessionSocket.ts` — register handler for `permissions:updated`. On receipt, trigger a `session:state` re-sync (or directly update the local user's effective role + capabilities). Newly-promoted co-hosts see host buttons within < 100ms.
- Add `'permissions:updated'` to `SOCKET_EVENTS` so cleanup unsubscribes it on unmount.

**8B.2 — Esc handlers for every modal**
- Single utility hook `useEscapeKey(onEscape, isOpen)` (~10 lines).
- Wire into Invite modal, Room modal, HCC Move-to-room sub-modal, HCC window mode. 4 call sites.

**8B.3 — Match preview swap UX clarity**
- The click-name-to-swap pattern in HostControls.tsx is real but underdocumented. Add a one-line hint when swap mode is active: "Click another name to swap with X" (already partly there, polish only).

### Phase 8C — UX architecture: Control Center as single surface (~half day, client refactor)

Closes Stefan #5, #11, parts of #6.

**8C.1 — Slim the host action bar**

Keep ONLY the **hot actions** in the bottom bar (visible during a round):
- Start Event (only before start)
- Match People → Confirm Matches → Confirm Round (round-start flow)
- Pause / Resume (during round)
- +2 min (during round)
- End Round (during round)
- End Event (always)
- Control Center (always, prominent)

Move into Control Center (a new "Actions" tab in the drawer, alongside the existing Participants + Rooms panes):
- Invite link / "Open invite link"
- Manual Room creation (the bulk-rooms modal)
- Bulk room operations (+2 all, End all, Set duration)
- Broadcast announcement
- Matching preview swap / regenerate / manual-pair (these stay reachable from Control Center > Actions OR appear inline as today during preview phase — the inline preview keeps swap/regenerate as it's the natural place; the Control Center "Actions" tab is for things hidden during normal play)

Bottom bar after slimming: ~5 buttons max instead of 10–12. Mobile already responsive (Phase 7C); slimming makes it cleaner.

**8C.2 — Auto-pin host + co-hosts in compact view**
- `VideoRoom.tsx` — compute `pinnedSids` from `hostUserId + cohosts` Set. In compact / pair / trio layouts, ensure host always gets a reserved tile.
- In the participants list (`Lobby.tsx`), host always renders first, cohorts next, then participants in join order. (Mostly true already — formalise.)

**8C.3 — Remove "Test mode" toggle**
- Remove the FlaskConical button from HostControls.
- Remove the `host:set_test_mode` socket event handler + wiring (server + shared types).
- Keep the `session-state-snapshot.service.ts` heuristic for now — it's harmless, but stop emitting `testMode: true` to the client banner. The banner component reads `state.testMode`; setting it to always `false` removes the surface without touching the column.
- Remove the new admin-action work? No — that was the email-approve feature, separate. Test-mode is just the v2 banner heuristic + manual toggle from Phase 7C.3. Both removed.
- 7C.3 architectural pins: delete the file. The migration that added `test_mode` to session config stays (additive, harmless).

### Phase 8D — Documentation + cleanup (~1 hour)

- New file `docs/co-host-rules.md` — written rules: "1 host. Up to 5 cohorts. Original host can promote/demote any participant; cohorts cannot promote/demote. Cohorts excluded from matching by default. Cohorts can: start/end rounds, manage breakouts, broadcast. Cohorts cannot: end the event, transfer ownership."
- `progress.md` — Phase 8 section.
- Remove dead code from the 7C.3 test-mode removal (matching pins, server handler, type).

---

## Architectural fit + scaling lens

- **Phase 4 (Redis) compatible:** every change uses DB or in-process state we already have. No new state.
- **No new socket events on the hot path:** 8B.1 reuses an existing event the server already emits but the client ignored.
- **No new tables, no new migrations.** All four sub-phases are server + client edits only.
- **No changes to LiveKit / video transport.** The test's NegotiationError is unrelated; that's a known LiveKit edge case (network-level).

## Mobile-responsive (per the RajaSkill rule)

Every UI edit in Phase 8B + 8C verified at 360 / 414 / 768 / 1024 px:
- Slimmed host bar: more breathing room on phones (positive).
- Control Center "Actions" tab: same responsive shell as the existing tabs.
- Auto-pinned host tile: works in compact/pair/trio layouts already; we're choosing which tile to pin, not changing the grid.

## Test plan (TDD red → green)

**~25 new pins:**
- 5 server pins for 8A.1–8A.4 (each: query shape, validator behaviour, response shape).
- 4 client pins for 8B.1–8B.2 (handler registered, Esc utility wired into 4 modals).
- 3 client pins for 8C.1 (button presence in Control Center > Actions tab; absence from bottom bar).
- 2 client pins for 8C.2 (auto-pin selection logic).
- 3 cleanup pins for 8C.3 (test-mode removal: button absent, handler absent, banner permanently off).

Plus ~6 behavioural tests for 8A (race-safety, presence-filter correctness).

## Pre-push gates (Phase 4)

- All tests green locally + CI.
- Server + client TypeScript clean.
- Migration check: 0 (no migrations this phase).
- Mobile-responsive check: I'll list every UI edit and verify at 360 px before commit.
- Browser walk on staging before claiming live.

## Rollback

- Each sub-phase is a separate commit. `git revert` on any one is clean.
- No DB changes → no schema rollback.
- Test-mode removal is purely UI — re-adding the button is a single revert.

## What this plan does NOT do

- Doesn't fix LiveKit NegotiationError (separate transport issue, low frequency).
- Doesn't add drag-and-drop (button-based stays).
- Doesn't redesign matching (engine 1.0 spec stands).
- Doesn't remove the `session.config.testMode` DB column (harmless, leave for future).

## Open questions before I start

1. **Bottom-bar slimming aggressiveness:** Stefan said "essential hot actions only". My read: keep Match-People + round controls + End Event. Move Invite + Room creation + Broadcast + bulk ops into Control Center > Actions. **Confirm before I refactor.**
2. **Auto-pin specifics:** Should host always get the **largest** tile in compact view, or just one of the visible slots? My default: largest in compact (1:1 layout puts host equal-size with the other person), but in trio/grid the host tile is reserved top-left without forced size. Confirm.
3. **Co-host limit:** I'll write "up to 5 cohorts" in the rules doc. Override if you want a different number (no enforcement code yet — happy to add a server-side check if you want).

If you say **"go"** with no other changes I'll proceed with the defaults under full RajaSkill discipline (audit done, plan written, TDD red→green, security gate, mobile-responsive verified at four widths, push staging then main, verify Render + Vercel + Sentry, browser walk before claiming done).
