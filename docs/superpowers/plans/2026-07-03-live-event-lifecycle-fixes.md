# RSN live-event lifecycle fixes — post-mortem of "THE TEST" (3 Jul 2026)

Status: **INVESTIGATION COMPLETE — awaiting Ali's scope answers before implementation.**
Author: evidence-based post-mortem (DB + Render logs + code audit). No fix code written yet.

## The event under investigation

- Session **"THE TEST"** `9699bada-e9ba-4bcb-bf4d-e1f937f84f0c`, host Stefan (`im@mister-raw.com`)
- Pod **"The testing pod"** `aa43328d-1646-4fe3-99ba-9f808e5cf685`
- 9 participants (Stefan on 4 accounts + Ali + Shraddha + others), 3 rounds configured, 60s rounds
- Started 13:32:39 UTC, force-ended 13:44:03 UTC. **Never advanced past round 1.**
- DO NOT DELETE — this is the evidence row. (Ali's earlier solo test "bb"/pod "Ali Hamza" was a *different* event, already deleted per his request.)

## Evidence timeline (Render logs, UTC)

- 13:38:23 Host confirmed round → 13:38:26 **Round 1 started** (4 pairs, match rooms created)
- 13:38:49 / 13:39:04 / 13:39:19 `LiveKit sweep: participant in unexpected room (observability only — no action)` for `c52d876d` (alihamza891840) — **canonically in a breakout, LiveKit shows him ALSO in the lobby room = dual membership**
- 13:39:26 **Round 1 ended → ROUND_RATING**
- 13:39:35 all ratings in → 13:39:38 **"Rating window closed → ROUND_TRANSITION (waiting for host)"**
- 13:39:2x–13:41:xx **reconnect storm**: repeated `User joined session` + `transitionParticipant: illegal transition rejected` + `updateParticipantStatus: state machine rejected, falling back to legacy DB write (checked_in)` for the SAME users (stefan `6264c644`, sa `ec60d117`, host `4164c7ed`, etc.) every few seconds
- 13:39:32 onward every 30s `reconcileSessionStates: drift detected — converging DB to in-memory` (persistent DB↔memory divergence)
- 13:42:34 round 2 + 3 matches persisted (DB) but **stayed `status=scheduled`, `room_id=null` — never activated**
- 13:44:03 event force-ended; `cs@redmitbarn.dk` left in non-terminal **`disconnected`** (never resolved to `left`)

## Root causes mapped to Stefan's 6 priorities

All of #1–#4 are facets of **one subsystem**: canonical room-state ↔ LiveKit membership ↔ client resync, destabilised by mobile reconnect churn.

### #1 Stuck users after breakout (return-to-main fails)
- After a round: `round-lifecycle.ts:895-938` → `ROUND_TRANSITION`, emits `session:status_changed`; **return to main room depends entirely on each client receiving that broadcast → pulling `session:resync` → `handleResync` minting a fresh lobby token.**
- A client that misses the broadcast (mobile reconnect storm) or whose resync returns a stale breakout location never re-renders the main room. No server-side safety net forces them back.
- Fix direction: make return-to-main **not** depend on a single socket broadcast — server-authoritative "you belong in the lobby now" that the client polls/reconciles (mirrors the S27 "4 delivery rails" pattern already used for start-of-event). Add a reconcile that, on ROUND_TRANSITION, actively converges every non-removed participant's canonical location to the lobby.

### #4 Duplicate presence across rooms (in two rooms at once)
- `livekit-sweep.ts:63-67` **detects** the mismatch (`participant in unexpected room`) but is deliberately **observability-only — no action**.
- Root: with `ROOM_EVICTION_ENABLED=false` (correct — true caused the 14-Jun permanent-stuck bug, see `reference_room_eviction_flag`), nothing server-side clears the stale **breakout** LiveKit membership after a round, and the client doesn't reliably disconnect the breakout room before joining the lobby → lingering dual membership.
- Fix direction (delicate): a **targeted** removal of a participant from a room that is NOT their canonical room — breakout-only, never the lobby (respect the June-13 "never evict from lobby" rule at `round-lifecycle.ts:921-930`), using LiveKit `removeParticipant` for the specific stale room only, NOT the token-revoking full eviction sweep. Plus a client-side guard: fully disconnect the breakout LiveKit room on transition before joining the next room. One-active-room-state invariant enforced on both ends.

### #2 Session did not close properly / stale live session
- `cs@redmitbarn.dk` ended `disconnected` (non-terminal). `reconcileSessionStates` shows persistent DB↔memory drift.
- On `completeSession`, non-terminal participants (`disconnected`, `connected`, `in_round`) must be swept to a terminal state; and the in-memory/Redis session blob must be torn down so a later refresh can't recover a "live" session that already ended.
- Fix direction: terminal-state sweep in `completeSession`; verify Redis session key + activeSessions entry are cleared on completion (tie to the "old live session did not close" refresh symptom).

### #3 Refresh recovery
- On refresh mid-event the client recovers session state; if it reads a stale/ended session it shows the "old live session" instead of the correct current room (or main room if between rounds).
- Fix direction: refresh recovery must gate on the **live server stream** (session status + canonical location freshness), never a flag that resets on reload (see `feedback_refresh_survivable_state`). Confirm `handleResync` returns the authoritative current location and the client renders it, including the "event already ended" case.

### #5 Mobile background upload/change ("stopped seeing myself, only saw 'upload an image'")
- Code: `client/src/features/live/BackgroundPanel.tsx`, `BgCameraPublisher.tsx`.
- Hypothesis (unverified — needs mobile repro): selecting/uploading a background tears down or hides the local camera track and the self-view is replaced by the upload placeholder; likely a mobile-only track-republish or file-input handling gap. Confirm on real device.

### #6 Mobile layout / orientation
- Code: `client/src/features/live/Lobby.tsx`, `VideoRoom.tsx`, `index.css`.
- Portrait↔landscape flip produces a broken layout. Needs responsive audit at 360/390/414/768 + orientation flip, safe-area insets, tile grid reflow.

## Implementation progress (branch `fix/live-event-lifecycle`, off main afc907c)

- ✅ **#1 stuck-after-rating** — commit 8ed5e0f. Rail 1: `endRatingWindow` proactively `emitStateSnapshot` on ROUND_TRANSITION. Rail 2: `healStrandedBreakoutLocations` on the periodic sweep. 6 unit tests green.
- ✅ **#4 dual-room** — commit 9e90261. Sweep removes a participant from a non-canonical room: any stale breakout always; the lobby only during an ACTIVE round when canonical is a breakout (Ali's case), never during transition/rating (13-Jun rule). 7 unit tests green.
- ✅ **#2 session cleanup** — commit 9f04f73. `handleDisconnect` guards the DISCONNECTED write on non-completed status so a completed session's participant can't be flipped back to non-terminal (the cs@ disconnect race). Guard test green.
- ✅ **#3 refresh recovery** — NO new code. Covered by: existing "Issue 9" client teardown (LiveSessionPage.tsx:124 → refresh of a completed session routes to recap) + #1's heal/resync rails (mid-event refresh recovers to correct room) + #2 (session reliably reaches 'completed'). To be verified in the headed test, not separately coded.
- ⏳ **#5 iOS background** — pending (frontend: BackgroundPanel/BgCameraPublisher).
- ⏳ **#6 mobile orientation** — pending (frontend: Lobby/VideoRoom/index.css).
- ⏳ **Headed multi-user verification** — MANDATORY before deploy (Stefan's bar). Not yet run.
- Typecheck clean after each; full suite + headed run pending before ship. NOTHING deployed.

## Ali's answers (confirmed 3 Jul)

1. **Scope**: fix ALL six — core to the event working.
2. **Round advance**: host did NOT start round 2 — he was waiting because participants were **stuck after the rating screen** and never returned to main. So round-2 activation itself was never exercised; the true bug is the ROUND_RATING → back-to-main hand-off (#1).
3. **Dual-room**: Ali on phone with bad signal, reconnecting. On reconnect he correctly re-entered the breakout (host had started round 1), but the **host still saw his tile in the main room** — his stale main-room LiveKit membership was never cleared. Own tile in both.
4. **Mobile**: iOS (Safari/WebKit) for the background bug.

## Code-confirmed root causes (updated)

- **#1 stuck-after-rating**: `emitStateSnapshot` (pushes each participant their main-room `you` + lobby token) is called from ONE site only — `matching-flow.ts:1660` (host-dashboard emit). It is **never called at round-end / rating-close / ROUND_TRANSITION**. Return-to-main depends solely on the client self-initiating a resync off `session:status_changed`; a flapping/backgrounded client misses it → stuck. The stale-breakout→main heal (`state-snapshot.ts:214`) also only fires on client resync. `SNAPSHOT_EMIT_ENABLED=true` in prod (rail is live, just under-triggered). FIX: proactively `emitStateSnapshot` at endRound (after clear-to-main) and at endRatingWindow→ROUND_TRANSITION; add stale-breakout→main healing to the periodic reconciler so disconnected/reconnecting users self-heal within one tick without a manual resync.
- **#4 dual-room**: `livekit-sweep.ts:63-67` detects "participant in unexpected room" but is observability-only. With `ROOM_EVICTION_ENABLED=false` (keep it false), nothing clears the stale membership. FIX: targeted `removeParticipant` from a room that is NOT the participant's canonical room — breakout rooms only, never the lobby (13-Jun rule) — plus client-side disconnect-old-room-before-join guard.

## Proposed approach once scoped

- Branch strategy: confirm (likely new `fix/live-lifecycle` branch → staging → main, per repo convention).
- TDD per fix; each backend fix gets a failing test first.
- **Verification bar (Stefan's explicit requirement): real multi-user desktop+mobile flow, not a clean single-user test.** Headed Playwright: ≥4 simulated participants, run 2+ full rounds incl. breakout→main return, a mid-event refresh, and a forced reconnect; assert one-active-room invariant, everyone back in main between rounds, clean terminal states on end. Mobile bugs verified on real device widths + orientation flip.
- One-bug-per-deploy discipline; `/checkhole` after each.

## Guardrails / do-not-break

- Keep `ROOM_EVICTION_ENABLED=false`. Do NOT re-enable the full eviction sweep (14-Jun permanent-stuck).
- Never evict from the lobby room (13-Jun rule).
- `removed` = terminal, `left` = recoverable — do not conflate (see `feedback_test_legitimate_path_not_just_abuse`).
