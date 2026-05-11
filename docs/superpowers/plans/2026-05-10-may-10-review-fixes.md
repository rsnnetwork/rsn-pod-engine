# 10 May review — execution plan

**Date:** 2026-05-10
**Source doc:** `assets/10th may - review .pdf`
**Audit pre-read:** five parallel Explore agents, every item grounded in actual file:line refs

The 18 items in the doc collapse into a small number of architectural patterns. Fixing those patterns once removes whole classes of regressions instead of patching individual symptoms. That is the only way the system stops "coming up with new issues every time we deploy."

---

## What the audit revealed

**Two of the items are already correctly implemented in code** and only need a regression test to lock them in:

- **#15 (statistics duplicates)** — `meeting_records.service.ts:129,164` already uses `COUNT(DISTINCT partner_id)` where `partner_id` is the user UUID, not display name. The duplicate-count symptom Stefan saw was the pre-Phase-2 path which is now dead.
- **#16 (no-repeat matching)** — `matching.engine.ts:51-178` builds a `usedPairs` set from all previous rounds in the same session and skips. `matching.service.ts:845-869` populates that from the matches table. The check exists.

The other 16 items resolve to **7 architectural batches**, listed below in execution order.

---

## Phase A — single source of truth for live participant state (items 1, 2, 3, 4, 17)

**Pattern:** "ghost users", "stale matching data", "cross-device inconsistency", "old lobby still open", and "registered only after going home" are all the same bug wearing different costumes — there is no single source of truth for who is in the event right now. The code reads three places and trusts whichever is fastest:
- `activeSession.presenceMap` (in-memory, lossy on restart, single-instance only)
- `activeSession.participantStates` (in-memory, kept in sync by the state machine)
- DB `session_participants.status` (slow, lags behind)

Matching reads from `presenceMap` AND DB and intersects. If a leave updates `presenceMap` but not DB before the host clicks Match, we get a ghost. Cross-device divergence is the same: each device's socket subscribes to per-user rooms with no per-device-per-session scoping, so devices see the same broadcasts but compute different local state from each. Orphan lobbies are the same: `completeSession` deletes from `activeSessions` but leaves `lobby_room_id` set in DB and the LiveKit room alive.

### A1 — collapse "active participants" to one read path

- `server/src/services/orchestration/handlers/matching-flow.ts:99-116` — drop the `presentUserIds` filter taken from `presenceMap`. Matching reads from DB with `status IN ('in_lobby', 'checked_in', 'registered')` only.
- `server/src/services/orchestration/state/participant-state-machine.ts` — every state transition is the chokepoint. It already calls `transitionParticipant()` which writes both DB and in-memory atomically. Add a guard: if a transition skips DB, log + alert.
- `server/src/services/orchestration/handlers/participant-flow.ts` — leave handler must complete the DB status update BEFORE clearing in-memory. This is a one-line reorder (await transitionParticipant(LEFT) before presenceMap.delete).

### A2 — per-user-per-session socket isolation

- Add helper `userSessionRoom(sessionId, userId)` in `session-state.ts`.
- All emits that are user-specific *and* session-scoped (rating window, match assignment, registration ack, kick) switch from `userRoom(userId)` to `userSessionRoom(sessionId, userId)`.
- Keep `userRoom(userId)` for global notifications (DMs, bell, friend requests).
- On session join, sockets explicitly join `userSessionRoom`. On disconnect, they leave it.
- Fixes: cross-device inconsistency (#4), reduces invite-flow flakiness (#1) because the registration-ack event now reaches both mobile + desktop.

### A3 — invite registration ack via socket, not just refetch

- `server/src/services/invite/invite.service.ts` `acceptInvite` already returns participantStatus. Augment: on success, also emit `participant:registered { sessionId, userId }` to `userSessionRoom(sessionId, userId)`.
- `client/src/features/invites/InviteAcceptPage.tsx` — after navigate, the live page mounts and immediately joins `userSessionRoom`; the next session-state snapshot includes the user. No more "registered only after going home."
- `client/src/hooks/useSessionSocket.ts` — on join, server sends an immediate `session:state` snapshot. The page lands with fresh state in one round trip.

### A4 — orphan-orchestrator cleanup on session end

- `server/src/services/session/session.service.ts` `updateSessionStatus(COMPLETED|CANCELLED)` — atomically null `lobby_room_id` in the same UPDATE.
- `server/src/services/orchestration/handlers/round-lifecycle.ts:712-760` `completeSession` — `await cleanupLiveKitRooms()` BEFORE `activeSessions.delete()`.
- `server/src/services/orchestration/orchestration.service.ts:154-169` TTL reaper — also call LiveKit cleanup, not just `activeSessions.delete()`.
- New periodic job (or extend the reaper) — find `sessions WHERE status='completed' AND lobby_room_id IS NOT NULL AND ended_at < NOW() - 1h`, tear down those LiveKit rooms.

**Files:** ~7. **Tests:** 4 new — ghost-user repro, late-join repro, cross-device repro, orphan-lobby repro. Mocks via existing transaction test patterns.

---

## Phase B — permission model unification (items 7, 18)

**Pattern:** the codebase has a unified `effective-role.service.ts` (`getEffectiveRole`, `canActAsHost` allows `pod_admin >= cohost`) which is the right design. But it isn't used everywhere. Two specific drift points:

- `server/src/services/orchestration/handlers/host-actions.ts:1462-1597` — `handleAssignCohost`, `handleRemoveCohost`, `handlePromoteCohost` use the direct check `session.hostUserId === hostId`, blocking co-hosts from delegating. Other host actions in the same file use `verifyHost` which goes through `canActAsHost` and accepts co-hosts.
- `client/src/features/live/LiveSessionPage.tsx:68-70` — `isHost = isOriginalHost || isCohost`. Super_admin (Stefan) doesn't pass either gate even though server-side he has full power. So he can't see HostControls and can't open the Control Center.

### B1 — co-host can do co-host actions, original host keeps promote-only

- `host-actions.ts:1462,1522` (assign/remove cohost) — switch to `verifyHost` so co-hosts can manage co-hosts. Original host retains everything.
- `host-actions.ts:1584` `handlePromoteCohost` (transfer ownership) — keep original-host-only. This is the irreversible "give the room away" action.
- Document the rule: cohost rank can do everything host can, except transfer ownership.

### B2 — super_admin sees host UI

- `client/src/features/live/LiveSessionPage.tsx:68-70` — `const isHost = isOriginalHost || isCohost || isSuperAdmin`.
- `isSuperAdmin` derived from `useAuthStore().user.role === 'super_admin'`.
- Apply same gate everywhere that previously only checked `isOriginalHost || isCohost` (HostControls mount, HostControlCenter button, host-only menu items in AppLayout).

### B3 — security audit pass

- Grep every `host:*` socket handler. Anything without `verifyHost` is either a bug or needs explicit comment ("this action is intentionally open to participants because X").
- Run the existing `routes.test.ts` suite to confirm REST routes already enforce `verifyHostOrAdmin`.

**Files:** ~5. **Tests:** 3 new — cohost-can-assign-cohost, super-admin-sees-host-ui, original-host-only-can-promote.

---

## Phase C — chat: breakout filter fix + mobile polish (items 13, 14)

**Pattern:** the smoking-gun bug. Server emits chat with `roomId = LiveKit-room-id` (e.g. `"session-abc-round-1-host-xyz"`). Client filters the message store by `currentMatchId = DB-match-record-uuid`. They are completely different identifier spaces and will never match. Result: chat sends fine, server stores fine, server fans out fine, server emits to the right user-rooms — but the moment the client renders, the filter at `ChatPanel.tsx:90` discards the message because `msg.roomId !== currentMatchId`. This is silent failure.

### C1 — fix the filter

- `client/src/stores/sessionStore.ts` — when `match:assigned` arrives, store BOTH `currentMatchId` (the DB match UUID) AND `currentRoomId` (the LiveKit room id). The room id IS in the payload — we just don't keep it.
- `client/src/features/live/ChatPanel.tsx:90` — filter by `msg.roomId === currentRoomId` instead. Single source of truth: the LiveKit room id.
- Also strip the dead `(msg as any).matchId` fallback — it was never set server-side.

### C2 — mobile chat polish

- `client/src/features/live/LiveSessionPage.tsx:220-242` — replace the abrupt `hidden sm:flex` with a sliding panel using CSS transition (`translate-y-full → 0` over 200ms ease-out). Content stays visible during transition.
- Reaction picker (`ChatPanel.tsx:279`) — add viewport bounds check (`position: fixed` with `right: max(0, viewport - menu_width)`) so it never clips off-screen.
- FAB button position (`bottom-20 right-4`) — verify it doesn't overlap chat input on iOS keyboard. Use `env(safe-area-inset-bottom)` so it sits above the keyboard.
- Message bubble `max-w-[85%]` → `max-w-[88%]` on screens <360px so small-phone messages aren't cramped.
- Confirm 44px tap targets on send button + reaction buttons.

**Files:** ~3. **Tests:** 1 server snapshot pinning the chat-message shape (server includes roomId field), 1 client unit asserting the filter compares the right field.

---

## Phase D — visible UI batch (items 5, 8, 10)

Three small but visible bugs. Ship as one batch.

### D1 — test mode banner gate (#5)

- `server/src/services/session/session-state-snapshot.service.ts:160-220` — keep heuristic detection but only set `testMode: true` if either:
  - `session.config.testModeExplicit === true` (admin opted in), OR
  - `session.config.testModeExplicit !== false && process.env.NODE_ENV !== 'production'`
- Default for new sessions: `testModeExplicit: false`.
- Heuristic still runs in dev for safety, never appears in prod unless deliberate.

### D2 — HCC scroll (#8)

- `client/src/features/live/HostControlCenter.tsx:407-459` — wrap participants `<ul>` in `<div className="overflow-y-auto max-h-full">`. Use `flex-1 min-h-0` on the parent grid cell so flex correctly limits children.
- Verify on 375px and 768px and 1024px widths.

### D3 — participant count format (#10)

- `client/src/features/live/Lobby.tsx:644-653, 869-874` — exclude both host AND co-hosts from participant count. Format: `"X participants and Y hosts"` (never "5 + host" silent).
- `Lobby.tsx:675-678` — already excludes co-hosts but text is confusing. Change to `"Participants (5) · Hosts (2)"`.
- Helper function `formatParticipantHeader({ participants, hostUserId, cohosts })` to keep this DRY.

**Files:** ~3. **Tests:** 1 server unit asserting testMode is false when explicit:false even if heuristic fires; 1 client unit asserting count function output for various role mixes.

---

## Phase E — video layout: host or active speaker big, not self (item 12)

### E1 — speaker-aware tile selection

- `client/src/features/live/VideoRoom.tsx:217-234` (desktop grid) — add `useActiveSpeakers()` from `@livekit/components-react`. Compute `bigTileParticipantId` = host (if in room) > active speaker > pinned > first remote > self (only if alone).
- Self-tile renders as PIP/small unless explicitly pinned by user click.
- Mobile 1:1 layout already correct (audit confirmed — partner big, self PIP). No change needed there.
- Click-to-pin overrides the auto selection until cleared.

**Files:** ~1. **Tests:** 1 unit asserting bigTile selection priority order with mocked participants array.

---

## Phase F — verify items already implemented (items 15, 16)

Audit suggests these work. Verify with regression tests that would fail if anyone re-introduces the old bug. No production-code change expected.

### F1 — duplicate-name dedup test (#15)

- New test: insert meeting_records for one session where two encounters share the same `display_name` but different `partner_id`. Call `getMeetingCounts`. Assert `unique_people === 2`. If existing implementation still works, test passes; if a future refactor groups by name it fails.

### F2 — no-repeat-pair test (#16)

- New test: in a 3-round session, generate round 1, persist matches, generate round 2, generate round 3. Assert no `(a,b)` pair appears in more than one round. Use the same matching engine entry point used in production.

If either test fails, fix the underlying code path then.

**Files:** 2 new tests, 0 production code (expected).

---

## Phase G — host visibility modes (item 11) — NEW FEATURE

Modes: `big_speaker | normal | producer | hidden`. Big_speaker forces the big tile; producer is excluded from matching pool entirely; hidden is not rendered in any participant view.

### G1 — data model

- New migration `059_session_cohost_visibility.sql`:
  ```sql
  CREATE TYPE host_visibility_mode AS ENUM ('big_speaker', 'normal', 'producer', 'hidden');
  ALTER TABLE session_cohosts ADD COLUMN visibility_mode host_visibility_mode NOT NULL DEFAULT 'normal';
  ALTER TABLE sessions ADD COLUMN host_visibility_mode host_visibility_mode NOT NULL DEFAULT 'normal';
  ```
- Reuses `session_cohosts` for cohosts (one row per cohost) and `sessions` for the original host (single value).

### G2 — server endpoint + socket event

- `POST /sessions/:id/host-visibility { userId, mode }` — gated by `verifyHost`. Updates row, broadcasts `host:visibility_changed { userId, mode }` to the session room.
- `participant-flow.ts` participant-state computation — exclude `producer` and `hidden` from the matching pool. They join the session like anyone else but are never paired.

### G3 — client UI

- `HostControlCenter.tsx` — dropdown next to "Make co-host" with the four modes. Tooltip explaining each.
- `VideoRoom.tsx` — `big_speaker` mode pins that user's tile big regardless of speaker detection (overrides Phase E logic). `hidden` users not rendered in any tile or participant list. `producer` rendered with a small "Producer" badge but excluded from matching displays.
- `Lobby.tsx` — producer/hidden hosts not counted in participant count (Phase D already separates hosts).

**Files:** ~6. **Tests:** 4 — migration applies cleanly; endpoint enforces auth; matching excludes producer; client renders modes correctly.

---

## Ship strategy

One commit per phase. Each commit:
1. Code change.
2. New tests added (TDD: failing test first where I can repro; for refactor-style fixes, characterization test).
3. Local server jest pass on affected files.
4. Local client tsc + build clean.
5. Commit on staging.
6. Push staging → watch CI green.
7. Fast-forward to main → push → watch CI green.
8. Watch Render + Vercel deploy live.
9. Quick post-deploy smoke (health, key URLs, Sentry).

**No phase merges to main until its CI is green AND the previous phase is live in production.** This is what "no more new issues every deploy" looks like — small, verified, observable.

After all phases ship, one final pass:
- Full server test suite (1100+ tests).
- Mobile-responsive walkthrough on actual mobile (or DevTools mobile emulation if can't reach a device).
- Sentry + Render + Vercel + DB + Redis check (the "check whole" routine).
- Send Stefan a 4-5 line plain-English changelog mapping each of his 18 items to its commit SHA.

## Risk + rollback

- Each phase is independent. If Phase E (video layout) breaks something, Phase F still rolls forward.
- Every change is a `git revert` away — no irreversible migrations except G1 which is additive (`ADD COLUMN ... DEFAULT`) and safe.
- The `lobby_room_id = NULL` part of A4 is the only DB write that affects existing rows; it only nulls rows where `status = 'completed'` so it cannot affect a live session.
- LiveKit cleanup is idempotent — retrying is safe.

## What I am NOT doing

- Not opening this as a PR; pushing to staging+main per project convention (memory: push-both rule).
- Not bundling multiple phases into one commit. Each phase is reviewable separately.
- Not making style-only changes outside the scope of these 18 items. Resisting the urge to "while I'm here" anything.
- Not pre-emptively implementing things Stefan hasn't asked for (e.g. recording, transcription).

## Estimate

7 phases × ~30-60 min each ≈ 4-7 hours of focused work. Sequential because each phase verifies the previous before next. I'll report after each phase ships, not at the end.

## Approval

Reply "go" and I execute end-to-end without further questions, reporting after each phase. Reply with adjustments and I'll revise the plan.
