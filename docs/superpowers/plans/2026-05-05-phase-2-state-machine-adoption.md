# Phase 2 — State Machine Adoption

**Date:** 2026-05-05
**Estimated effort:** 3–5 days
**Risk:** Medium. Touches the state-mutation surface across 8+ files. Each sub-phase is independently shippable so a regression in one cluster doesn't poison the others.
**Production DB ops:** None. State-machine writes go through the same DB path as today; we just route them through the chokepoint.
**Why this phase exists:** Stefan's 5th May doc #1 + #13 + the Matching Spec §12 both call out the same problem: "leave-and-rejoin" is currently the only reliable way to fix wedged states. The fix is to enforce the existing state machine as the **single legal write path** for every participant state change, then add a reconciler that auto-corrects drift instead of waiting for a user to manually rejoin.

---

## What's already done (do not re-do)

The state machine spine is **already built** at `server/src/services/orchestration/state/participant-state-machine.ts`:

- `ParticipantState` enum with all 11 states (the 8 Stefan listed + 3 pseudo-states for richer host-dashboard surfaces)
- `transitionParticipant(sessionId, userId, toState, opts)` — single legal write path
- `LEGAL_TRANSITIONS` table — validated state machine, illegal transitions are rejected with a logged warning, not silently allowed
- `getParticipantState(sessionId, userId)` — O(1) read from the canonical in-memory map
- `liftFromDbStatus()` — bootstrap helper to put DB rows back into the in-memory map
- `bootstrapStatesFromDb()` — for warming the map on session start
- `snapshotParticipantStates()` — for host dashboard + reconciliation
- DB projection on every transition with field handling for `joined_at`, `left_at`, `current_room_id`, `is_no_show`
- Tests pinning the architecture at `__tests__/services/orchestration/phase1-state-machine-spine.test.ts`

What's NOT done is **enforcement** — most of the codebase still writes status directly to the DB or mutates `presenceMap` / `roomParticipants` without going through the chokepoint. So the spine exists but is bypassed.

---

## Audit results — actual call-site count (verified 2026-05-05)

### Direct `UPDATE session_participants` writes (9 sites)

| # | Location | What it does | Migrate? |
|---|---|---|---|
| 1 | `identity.service.ts:755` | `SET status='removed'` on identity merge | **Migrate → REMOVED** |
| 2 | `participant-flow.ts:225` | `SET status='in_lobby'` on rejoin | **Migrate → IN_MAIN_ROOM** |
| 3 | `round-lifecycle.ts:561` | `SET status='in_lobby'` on round end | **Migrate → IN_MAIN_ROOM** |
| 4 | `round-lifecycle.ts:1024` | bulk `SET is_no_show=TRUE` | **Migrate → NO_SHOW (bulk)** |
| 5 | `round-lifecycle.ts:1041` | single `SET is_no_show=TRUE` | **Migrate → NO_SHOW** |
| 6 | `session.service.ts:293` | `SET status='registered'` on re-register | **Migrate → REGISTERED** |
| 7 | `session.service.ts:561` | generic dynamic `SET status=…` (likely `updateParticipantStatus`, which already delegates) | **Verify, not re-migrate** |
| 8 | `session.service.ts:568` | `SET rounds_completed = rounds_completed + 1` | **Keep — not a state mutation** |
| 9 | `session.service.ts:602` | TBD — inspect during execution | **Inspect** |

**Net work: 6 sites to migrate, 1 to verify, 2 to leave untouched.**

### Shadow state stores still mutated outside the chokepoint

- `presenceMap`: 7 mutation sites in `participant-flow.ts` + `host-actions.ts`
- `roomParticipants`: 4 mutation sites in `participant-flow.ts`
- `manuallyLeftRound`: 4 mutation sites in `participant-flow.ts` + `host-actions.ts`
- `disconnectTimeouts`: 7 mutation sites (these are timer handles, **not state** — leave alone)

**Net work for shadow stores: introduce a thin `setPresence(sessionId, userId, presence)` and `setRoom(sessionId, userId, roomId)` API behind the same module that transitionParticipant lives in, and migrate the existing call sites. `manuallyLeftRound` stays as-is for now (it's a per-session flag, not a participant state) but documented as a follow-up for Phase 2.7.**

### Reconciler / recovery surface (already partially built)

- `recoverActiveSessions(io)` runs on server boot — restores active sessions from DB / Redis
- `bootstrapStatesFromDb()` exists but isn't called from boot path (verify and wire if missing)
- **No periodic reconciler** runs during normal operation — this is the gap

---

## Sub-phase plan

Each sub-phase is one commit, independently shippable, independently revertable.

### Sub-phase 2A — `identity.service.ts` + `session.service.ts` (~3 hours)

**Goal:** migrate the simplest 2 sites first to validate the migration pattern.

- `identity.service.ts:755` — replace direct UPDATE with `transitionParticipant(sessionId, userId, ParticipantState.REMOVED, { persistToDb: true })`. Note: identity merge can target multiple sessions for one user, so iterate over `getActiveSessionsForUser(userId)` and call transition per session. For sessions that are not in `activeSessions` (already ended), keep the direct DB write — the chokepoint is only meaningful while a session is live.
- `session.service.ts:293` — replace direct UPDATE with `transitionParticipant(..., REGISTERED)`. If the session isn't yet in `activeSessions` (event hasn't started), keep the direct DB write — no in-memory state to maintain yet.
- `session.service.ts:561` and `:568` — confirm these are `updateParticipantStatus` (already delegates) and `rounds_completed` (not state). No change needed; document.
- `session.service.ts:602` — read it, decide. If status-touching, migrate.

**Tests:** new architectural pin in `phase-2-state-machine-adoption.test.ts`:
- Grep `identity.service.ts` for direct `UPDATE session_participants SET status` — must be 0 (or guarded by an "if no active session" branch)
- Grep `session.service.ts:293` area for transitionParticipant call

### Sub-phase 2B — `participant-flow.ts` status writes (~4 hours)

**Goal:** migrate the rejoin-to-lobby path. This is the highest-traffic state mutation.

- `participant-flow.ts:225` — replace direct UPDATE with `transitionParticipant(..., IN_MAIN_ROOM)`. The `joined_at = COALESCE(...)` field projection already lives inside the chokepoint, so this drops cleanly.
- While in this file, **also migrate the inline `presenceMap.set` / `presenceMap.delete` calls** at lines 108, 173, 487, 529, 1152, 1392 to a new helper `setPresence(sessionId, userId, presence | null)` exported from the state module. Same migration pattern: chokepoint with validation + DB projection.

**Tests:**
- Grep `participant-flow.ts` for direct `UPDATE session_participants SET status` — must be 0 (or guarded)
- Grep `participant-flow.ts` for direct `presenceMap.set` / `presenceMap.delete` — must be 0 (or guarded)
- Architectural pin: every status mutation in this file calls `transitionParticipant`

### Sub-phase 2C — `round-lifecycle.ts` status writes (~4 hours)

**Goal:** migrate the round-end and no-show paths. These run at scheduled timer boundaries so any regression here surfaces fast.

- `round-lifecycle.ts:561` — replace UPDATE with `transitionParticipant(..., IN_MAIN_ROOM)` for each user being returned to lobby on round end.
- `round-lifecycle.ts:1024` (bulk no-show) — iterate user list, call `transitionParticipant(..., NO_SHOW)` per user. Chokepoint correctly sets `is_no_show=TRUE` via the existing branch in `transitionParticipant`. For bulk efficiency, expose a `transitionParticipantsBulk(sessionId, userIds, toState, opts)` if the per-row DB writes become a hot path; otherwise straight loop is fine for current load.
- `round-lifecycle.ts:1041` — single no-show, same pattern.

**Tests:**
- Grep `round-lifecycle.ts` for direct `UPDATE session_participants SET (status|is_no_show)` — must be 0
- Architectural pin: round-end calls `transitionParticipant(..., IN_MAIN_ROOM)` for every match participant

### Sub-phase 2D — `roomParticipants` migration (~3 hours)

**Goal:** route breakout-room moves through a chokepoint that mirrors the state-machine pattern.

- New helper `setRoom(sessionId, userId, roomId)` in the state module: writes to in-memory `roomParticipants`, projects `current_room_id` to DB, also calls `transitionParticipant(..., IN_BREAKOUT, { currentRoomId: roomId })` so room placement and state stay coupled.
- Migrate `participant-flow.ts:580, 625, 636, 648` to use the new helper.

**Tests:**
- Grep `participant-flow.ts` for direct `roomParticipants.set` / `roomParticipants.delete` — must be 0
- New pin: `setRoom` is the only path that mutates `roomParticipants`

### Sub-phase 2E — Periodic reconciler (~5 hours)

**Goal:** auto-heal state drift so users never need to leave-and-rejoin.

- New function `reconcileSessionStates(sessionId)` in the state module:
  1. Read `session_participants` from DB for the session
  2. For each row, compare to in-memory `participantStates`
  3. If they disagree (e.g., DB says `in_round` but memory says `IN_MAIN_ROOM`), the in-memory copy wins (it's authoritative per the spine doc) — but log the divergence with full detail so we can hunt the root cause. Also persist memory → DB to converge.
  4. Read `presenceMap` and `roomParticipants` — confirm they agree with `participantStates` for the same set of users. If not, fix via the helpers.
  5. Emit host dashboard if any reconciliation actually changed something.
- Wire into `orchestration.service.ts`:
  - **On join**: already partially happens via `bootstrapStatesFromDb` — verify and add explicit reconcile call after `setupParticipantSocketHandlers`.
  - **On reconnect**: same.
  - **Periodically**: `setInterval(..., 30_000)` per active session, scoped to the session's existence (cleared when session ends or on server shutdown).

**Tests:**
- Synthetic divergence test: poison the `participantStates` map for one user, call `reconcileSessionStates`, assert the divergence is detected and corrected.
- Synthetic stale presenceMap test: same shape.
- Pin: `reconcileSessionStates` is exported from the state module and registered as a per-session interval in orchestration setup.

### Sub-phase 2F — CI guard against regression (~2 hours)

**Goal:** make it physically impossible for a future commit to add a new direct `UPDATE session_participants SET status` without breaking CI.

- New top-level test `phase-2-no-bypass.test.ts`:
  ```
  Across all .ts files in services/ (excluding the state module and __tests__),
  the regex /UPDATE session_participants[\s\S]*?SET[\s\S]*?(status|is_no_show|current_room_id)/
  must match in 0 files.
  ```
- If a future caller genuinely needs to bypass (e.g., a one-off admin script), they add an inline `// state-machine-bypass: <reason>` comment that the test allow-lists.

---

## Sequence

1. Code Sub-phase 2A → tests → push staging → CI green → push main → CI green → verify Render/Vercel/Sentry
2. Repeat for 2B, 2C, 2D, 2E in that order.
3. Sub-phase 2F closes the door at the end.
4. After 2F merges, run a Sentry sweep for the 30-min window post-deploy to confirm no state-machine warnings (`illegal transition`, `no active session`) spiked.
5. Final progress.md entry summarising the whole phase + verification evidence.

---

## Verification gate (before declaring Phase 2 done)

1. ☐ `cd server && npx tsc --noEmit` — clean
2. ☐ `cd server && npx jest` — all green (current 980 + new 2A/2B/2C/2D/2E/2F pins)
3. ☐ `cd client && npx tsc --noEmit` — clean (no client changes expected, but verify)
4. ☐ `cd client && npm run build` — clean
5. ☐ Phase 2 grep guard: 0 direct `UPDATE session_participants SET status` outside the state module
6. ☐ Phase 2 grep guard: 0 direct `presenceMap.set/.delete` outside the state module
7. ☐ Phase 2 grep guard: 0 direct `roomParticipants.set/.delete` outside the state module
8. ☐ `reconcileSessionStates` reachable from orchestration boot path AND from a per-session interval
9. ☐ Server boots cleanly, recovery completes for any active session
10. ☐ CI staging green for each sub-phase commit
11. ☐ CI main green for each sub-phase commit
12. ☐ Render: status=live at the latest pushed SHA after each sub-phase
13. ☐ Vercel: Production Ready
14. ☐ Sentry rsn-api: 0 new "illegal transition" warnings in last 30 min after each push
15. ☐ Sentry rsn-api: 0 new "no active session" warnings post-deploy
16. ☐ Manual reconcile test in staging: poison a participant state, wait 30 s, confirm auto-correction in logs
17. ☐ progress.md updated

---

## Risks & rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| A migrated call site uses a transition not in `LEGAL_TRANSITIONS` and gets rejected | Medium | Add the missing transitions to the table BEFORE migrating call sites; tests pin the table |
| Bulk no-show migration generates per-row DB writes and slows the round-end timer | Low | Bulk transition helper if profiling shows it; otherwise the existing per-row count is small (≤30 per round) |
| Reconciler interval leaks if session cleanup forgets to clear it | Low | Tie the interval to session lifecycle — clear in `endSession` and `recoverActiveSessions` shutdown paths; test both |
| Reconciler races a real transition mid-tick | Low | Reconciler reads in-memory FIRST, treats memory as authoritative, only fixes DB to match — won't clobber a legit live transition |
| The grep-guard test breaks on legitimate one-off bypass (e.g. admin migration script) | Trivial | Allow-list pattern in the guard with explicit comment marker |
| Identity merge migrate breaks because targeted session isn't in `activeSessions` | Low | Branch: if session live, use chokepoint; else direct DB write (state machine has nothing to maintain when session is dead) |

**Rollback for any sub-phase:** `git revert <SHA>` reverses the migration for that cluster only; the previous direct-DB writes return. The state machine spine stays in place. No data migration involved.

---

## What is NOT in this phase

- Pre-event session planning (Phase 2.5 — separate plan)
- Future-only repair logic (Phase 2.7 — separate plan)
- `manuallyLeftRound` migration (deferred to Phase 2.7 since it's a per-session flag, not a participant state)
- Test-mode UX (Phase 5)
- Any client-side change (Phase 2 is server-side only)

---

## What "perfect this time" means specifically for Phase 2

1. After Phase 2, **every** participant-state change in production goes through `transitionParticipant`. There is no shortcut.
2. State drift no longer requires a user to leave-and-rejoin. The reconciler catches drift within 30 s and auto-corrects.
3. Illegal transitions are visible in Sentry as warnings — we will see attempted bad transitions and can debug them, instead of letting them silently corrupt state.
4. CI fails any future PR that adds a direct status-write bypass. The architecture is enforced by tests, not by hope.
5. Any "Claus is in two places at once" / "Wazeem missing from matching" / "main room and breakout simultaneously" bug becomes mechanically impossible because the chokepoint validates transitions.
