# SDD 04 — C4 round-lifecycle races + confirm/re-match lock + timer races

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

Cluster C4 (round-lifecycle races) from docs/AUDIT-2026-06-12-live-30-50-readiness.md, designed against branch june9-punchlist @ 3cf1187 with every cited location re-verified in code. Ship order (one fix per deploy, full local suite + headed prod smokes between, per the team's standing per-bug process): LCY-1 → LCY-2 → LCY-3 → LCY-4 → LCY-5 → LCY-6 → LCY-7 → LCY-8. All items are server-only: no migrations, no env vars, no render.yaml or client deploys required (LCY-4's new ROUND_START_FAILED error code rides the existing generic error-toast rail).

Key design decisions an implementer must not re-litigate without re-reading the verification: (1) GLOBAL LOCK ORDER = withMatchGenerationLock OUTSIDE, withSessionGuard INSIDE; never await the matchGen lock while holding the guard; fire-and-forget launches from guard-held contexts are allowed. Verified compliant at every existing acquisition (matching-flow.ts:228/810; participant-flow.ts:134 via void-launch at :590/:1182; host-actions.ts:114 via .catch() launches at :2109/:2185/:2307; participant-state-machine.ts:553); no current code holds matchGenLock and awaits the guard, so confirm-round becomes the first such site and is deadlock-free. Both locks are non-reentrant promise chains (session-state.ts:117-155) — the two documented deadlock traps are host-actions' direct endRatingWindow injection (orchestration.service.ts:142 must stay raw) and detectNoShows (must stay unguarded because it awaits the now-self-guarding maybeAutoEndEmptyRound at round-lifecycle.ts:1407). (2) Scope item 3 resolved as flip-ROUND_ACTIVE-after-batch-activation (root fix; restores the 'ROUND_ACTIVE ⇒ ≥1 active match' invariant by construction) rather than the age-heuristic. (3) Scope item 5 resolved as the synchronous status+round re-check, not a timer-generation token — sufficient because Node guarantees no interleave between the re-check and the clear/re-arm when no await sits between them; a token adds state with no extra guarantee in a single process. (4) Scope item 6 resolved as REMOVE the fallback: the shipped client starts rounds only via host:confirm_round (client/src/features/live/HostControls.tsx:155 is the only emitter; host:start_round has no client emitter), and locking the fallback would violate the lock order and hard-deadlock confirm (which holds matchGenLock while calling transitionToRound).

Deltas found vs the audit during verification: (a) the zero-matches fallback lives in round-lifecycle.ts:279-283, not matching-flow.ts as cited; (b) the batch-activate bug is broader than the room-failure path — getMatchesByRound returns ALL statuses, so Step 3 also resurrects 'cancelled' forensic rows kept by cancel-preview (Bug 25); LCY-4's startable-status filter closes that too; (c) the 3s all-rated grace timer (participant-flow.ts:1591) is a fourth unguarded timer the audit's line list omits — covered in LCY-1 via the orchestration.service.ts:163 injection switch.

Cross-cluster boundaries: M7 deploy-overlap double-driving (two processes owning one session during a Render deploy) is NOT closed here — all locks are per-process; LCY-3's idempotent increment narrows but does not eliminate cross-process double-increment. M3(b) (REST rating path missing io) belongs to the rating cluster; LCY-6 deliberately does not thread io through. M1/M4 (guard hold-time costs) are marginally affected by serializing confirm-round room creation under the guard — pre-existing behavior for host:start_round and accepted. Library check: no new APIs or dependencies needed (socket.io ^4.7 fetchSockets already in use per server/package.json; zero client changes).

---

## LCY-1 — Guard the normal-operation lifecycle timers and the maybeAutoEndEmptyRound chokepoint with withSessionGuard

**Priority:** P0

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/orchestration.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts`

### Problem

Only recovery/resume timers go through the guard-wrapped timerCallbacks (orchestration.service.ts:128-133). The timers armed during NORMAL operation call the lifecycle functions directly with no lock: the round timer (round-lifecycle.ts:481-483 → endRound), the 90s rating backstop (:737-742 → endRatingWindow), the CLOSING_LOBBY 10-min safety timer (:853-855 → completeSession), and the 3s all-rated grace timer (participant-flow.ts:1591-1595 → the injected endRatingWindow, which orchestration.service.ts:163 wires to the RAW function). Additionally every maybeAutoEndEmptyRound invocation effectively runs unguarded: the injected wrappers in participant-flow.ts:274-280 and host-actions.ts:93-97 are fire-and-forget (the promise escapes the caller's guard), and detectNoShows (round-lifecycle.ts:1407) awaits it from a raw unguarded setTimeout (:486-488). Result: a timer firing or an auto-end can interleave mid-await with a guarded host action or join on the same session — the C4 race family.

### Design

Contract to establish and document: transitionToRound / endRound / endRatingWindow / completeSession are GUARD-HELD functions — every caller must hold withSessionGuard for the session (host handlers already do; they keep calling the direct versions, per the existing comment at host-actions.ts:48-53). maybeAutoEndEmptyRound becomes the single self-guarding chokepoint for auto-end. Six edits:

(1) round-lifecycle.ts:481-483 — replace the raw arrow with the injected guarded callback: `startSegmentTimer(io, sessionId, activeSession.config.roundDurationSeconds, () => { if (_timerCallbacks) void _timerCallbacks.endRound(sessionId, roundNumber); else void endRound(io, sessionId, roundNumber); });` (the `else` branch keeps unit tests that import round-lifecycle without wiring working).
(2) round-lifecycle.ts:737-742 (rating backstop) — inside the existing setTimeout body, after nulling s.timer/s.timerEndsAt, call `_timerCallbacks.endRatingWindow(sessionId, roundNumber)` with the same null-fallback. Do NOT change RATING_BACKSTOP_MS, the clearSessionTimers call, or the manual-arm pattern (all pinned, see pins).
(3) round-lifecycle.ts:853-855 — `startSegmentTimer(io, sessionId, 600, () => { if (_timerCallbacks) void _timerCallbacks.completeSession(sessionId); else void completeSession(io, sessionId); });`
(4) orchestration.service.ts:163 — change the participant-flow injection to the guarded variant: `endRatingWindow: (sessionId, roundNumber) => timerCallbacks.endRatingWindow(sessionId, roundNumber),`. Safe: participant-flow's only call site of that wrapper is the 3s grace setTimeout at participant-flow.ts:1594, which fires on a fresh stack (no guard held). The host-actions injection at :142 MUST stay direct (host handlers hold the guard — re-acquiring would self-deadlock; withSessionGuard is non-reentrant).
(5) round-lifecycle.ts maybeAutoEndEmptyRound (:1257-1282) — import withSessionGuard from ../state/session-state and wrap the entire body (the activeSessions lookup, the ROUND_ACTIVE status check, the COUNT query, and the endRound call) in `return withSessionGuard(sessionId, async () => { ... })`. The status check now re-reads INSIDE the guard, so a queued auto-end that lands after a legitimate endRound sees ROUND_RATING and no-ops. All call sites stay as-is: the fire-and-forget wrappers (participant-flow.ts:274-280, host-actions.ts:93-97) never await, so a caller holding the guard cannot deadlock — the auto-end simply queues; detectNoShows' awaited call at :1407 is fine because detectNoShows runs unguarded.
Non-goal: do NOT wrap the detectNoShows setTimeout (:486-488) or its body in the guard — that would deadlock at :1407 with the now-guarded maybeAutoEndEmptyRound, and its participant transitions already go through the participant-state-machine chokepoint.
(6) session-state.ts — add a comment block above withSessionGuard/withMatchGenerationLock documenting the guard-held contract for the four lifecycle functions and the lock-ordering rule defined in LCY-2.

### Code sketch

````
// round-lifecycle.ts:481 (round timer)
startSegmentTimer(io, sessionId, activeSession.config.roundDurationSeconds, () => {
  if (_timerCallbacks) void _timerCallbacks.endRound(sessionId, roundNumber);
  else void endRound(io, sessionId, roundNumber); // unit-test fallback (deps not wired)
});

// round-lifecycle.ts:737 (rating backstop — keep clearSessionTimers + RATING_BACKSTOP_MS = 90_000)
activeSession.timer = setTimeout(() => {
  const s = activeSessions.get(sessionId) ?? activeSession;
  s.timer = null; s.timerEndsAt = null;
  if (_timerCallbacks) void _timerCallbacks.endRatingWindow(sessionId, roundNumber);
  else void endRatingWindow(io, sessionId, roundNumber);
}, RATING_BACKSTOP_MS);

// round-lifecycle.ts maybeAutoEndEmptyRound — self-guarding chokepoint
export async function maybeAutoEndEmptyRound(io: SocketServer, sessionId: string): Promise<void> {
  return withSessionGuard(sessionId, async () => {
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) return;
    if (activeSession.status !== SessionStatus.ROUND_ACTIVE) return; // re-read INSIDE guard
    try {
      const res = await query(...COUNT active matches for currentRound...);
      if (parseInt(res.rows[0]?.c || '0', 10) > 0) return;
      await endRound(io, sessionId, activeSession.currentRound); // guard already held
    } catch (err) { logger.error({ err, sessionId }, 'Error in maybeAutoEndEmptyRound'); }
  });
}

// orchestration.service.ts:163
injectParticipantDeps({
  ...,
  endRatingWindow: (sessionId, roundNumber) => timerCallbacks.endRatingWindow(sessionId, roundNumber),
  ...
});
````

### Tests to add

- New server/src/__tests__/services/orchestration/lcy1-lifecycle-timer-guards.test.ts — source pins: (a) the round-timer arm site in transitionToRound references `_timerCallbacks.endRound`; (b) the rating-backstop setTimeout body references `_timerCallbacks.endRatingWindow`; (c) the CLOSING_LOBBY startSegmentTimer callback references `_timerCallbacks.completeSession`; (d) maybeAutoEndEmptyRound body matches /withSessionGuard\(/; (e) orchestration.service.ts injectParticipantDeps block matches /endRatingWindow:\s*\(sessionId, roundNumber\)\s*=>\s*timerCallbacks\.endRatingWindow/.
- Behavioral (same file): seed activeSessions with status ROUND_ACTIVE and mock db/matching so endRound succeeds; fire maybeAutoEndEmptyRound twice concurrently (Promise.all) with the COUNT mock returning 0 both times — assert sessionService.updateSessionStatus(ROUND_RATING) was called exactly once (the second call serializes behind the first, re-reads ROUND_RATING inside the guard, and no-ops).
- Behavioral: while withSessionGuard is held open for session s (acquire manually with a deferred promise), call maybeAutoEndEmptyRound(io, s) un-awaited — assert it has NOT run its COUNT query until the guard is released, then runs.
- Headed Playwright prod smoke: 3-participant event, start round 1, have every participant click Leave Conversation within the same second while the round timer has <5s remaining (race the timer against auto-end). Assert: exactly one session:round_ended per round, every client lands in rating exactly once (no duplicate rating:window_open for the same match/partner), and the event proceeds to ROUND_TRANSITION normally.

### Acceptance criteria

- All three normal-operation timer arm sites in round-lifecycle.ts route through _timerCallbacks (source-assertable), and the participant-flow endRatingWindow injection at orchestration.service.ts:163 is the guarded timerCallbacks variant.
- maybeAutoEndEmptyRound acquires withSessionGuard before reading status; two concurrent invocations on an empty ROUND_ACTIVE round produce exactly one ROUND_RATING transition (assertable in the new behavioral test).
- No deadlock regression: host force-advance (host:start_round from ROUND_RATING) and force-close-rating still complete in <2s in the headed smoke (proves the direct injection at :142 was not touched).
- Full server test suite green locally, including phase2-locked-transitions, dr-arch-april-18-bugs, may25-live-fixes unmodified.

### Pinned tests to update

- NONE need edits, but three must be explicitly re-verified green because they pin this exact region: server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts (pins the timerCallbacks block text in orchestration.service.ts — the block is unchanged; only the injectParticipantDeps block below it changes), server/src/__tests__/services/orchestration/dr-arch-april-18-bugs.test.ts (source-pins maybeAutoEndEmptyRound: keep the ROUND_ACTIVE status check, the COUNT over status='active' matches, and the endRound( call inside the function body when wrapping in the guard), server/src/__tests__/services/may25-live-fixes.test.ts:175-188 (pins RATING_BACKSTOP_MS = 90_000, clearSessionTimers before arming, and the substring /endRatingWindow/ inside endRound — `_timerCallbacks.endRatingWindow` still matches).

### Risks

withSessionGuard is a non-reentrant promise-chain — any NEW awaited call of a guarded function from a guard-held context deadlocks that session until restart. The two known traps are documented in the design (host-actions must keep direct endRatingWindow at orchestration.service.ts:142; detectNoShows must stay unguarded). Guarding the timers also means a timer expiring during a long guarded operation (e.g. a 50-join burst, M1) fires late — intended serialization, but it widens timer latency tails; acceptable and strictly better than the race. The else-fallback branches keep behavior identical when deps are not wired (unit tests).

### Deploy notes

Server-only. No migration, no env var, no render.yaml change, no client change. Render zero-downtime overlap: both old and new instances are self-consistent (locks are per-process); cross-process double-driving is M7, owned by another cluster. Ship first in this cluster; run the FULL server suite locally before push (standing rule), then the headed smoke against prod.

---

## LCY-2 — handleHostConfirmRound under withMatchGenerationLock + withSessionGuard; define and document the global lock-ordering rule

**Priority:** P0
**Depends on:** LCY-1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/matching-flow.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts`

### Problem

handleHostConfirmRound (matching-flow.ts:576-618) — the PRIMARY start-round path; the client only emits host:confirm_round (client/src/features/live/HostControls.tsx:155) — runs with NO lock at all: not withSessionGuard (unlike handleHostStartRound, host-actions.ts:458) and not withMatchGenerationLock (unlike generate/regenerate at matching-flow.ts:228/810). Confirm racing Re-match lets handleHostRegenerateMatches' unconditional `DELETE FROM matches WHERE session_id=$1 AND round_number=$2` (matching-flow.ts:842-845 and :862) wipe a round that confirm just activated — participants sit in LiveKit rooms with no backing match rows — or lets confirm start a round from a half-rewritten plan. Confirm also races timers and joins because it mutates session state outside the guard.

### Design

GLOBAL LOCK-ORDERING RULE (document above the two lock helpers in session-state.ts:94-155): when both locks are needed, acquire withMatchGenerationLock FIRST (outer) and withSessionGuard SECOND (inner). NEVER await withMatchGenerationLock while holding withSessionGuard. Launching a matchGen-locked task fire-and-forget (un-awaited) from a guard-held context is allowed (it queues; the holder never blocks). Rationale for this order: the guard gates joins/leaves/ratings — holding it while waiting up to 60s for an in-flight matching run (the engine timeout, matching-flow.ts:59) would freeze the session, which is exactly what the dedicated lock was created to avoid (session-state.ts:97-108).

Audit of every existing acquisition (verified in code, all compliant with the rule):
- matching-flow.ts:228 (handleHostGenerateMatches), :810 (handleHostRegenerateMatches) — matchGenLock only.
- participant-flow.ts:134 (runRepair) — matchGenLock only; launched un-awaited via `void maybeRepairFutureRounds` from the guard-held join (:590) and leave (:1182) handlers — compliant.
- host-actions.ts:114 (maybeRepairFutureRounds) — matchGenLock only; all call sites (:2109, :2185, :2307) are `.catch()` fire-and-forget from guard-held handlers, plus unguarded REST cohost routes — compliant.
- participant-state-machine.ts:553 (reconciler) — matchGenLock only, from the unguarded 30s tick — compliant.
- No existing code awaits sessionGuard while holding matchGenLock; confirm becomes the first and only such site, which is safe because no sessionGuard holder ever awaits matchGenLock.
- Known pre-existing gap to note in the comment, NOT fix here: handleHostStart (host-actions.ts:294) awaits generateSessionSchedule (:411) inside the guard WITHOUT the matchGen lock.

Edits:
(1) matching-flow.ts — import withSessionGuard from '../state/session-state'. Restructure handleHostConfirmRound: pre-lock fast `verifyHost` reject (existing pattern, matching-flow.ts:218-221), then `return withMatchGenerationLock(data.sessionId, () => withSessionGuard(data.sessionId, async () => { <existing body, including a post-lock verifyHost re-check per the TOCTOU pattern at :230-234> }));`. Inside the body keep the pendingRoundNumber check, the timer clear (:596-599), the _transitionToRound call, and FIX 3A clear-after-success.
(2) handleHostRegenerateMatches — post-lock state re-check to close the confirm-first/re-match-second residue: immediately after `beforeMatches` is computed (:831), insert `if (beforeMatches.some(m => m.status === 'active' || m.status === 'completed')) { socket.emit('error', { code: 'INVALID_STATE', message: 'That round has already started — nothing to re-match.' }); return; }`. This restores the 'preview rounds contain only scheduled/cancelled rows' invariant the wipe-DELETE comment (:835-841) assumes.
Note: transitionToRound (called inside confirm's guard) must never acquire matchGenLock — confirm already holds it and the lock is non-reentrant. The zero-matches fallback inside transitionToRound therefore stays UNLOCKED until LCY-7 removes it (under the confirm path it is serialized by confirm's own matchGenLock anyway).

### Code sketch

````
export async function handleHostConfirmRound(io: SocketServer, socket: Socket, data: { sessionId: string }): Promise<void> {
  // Fast reject before queuing on either lock (existing generate/regenerate pattern).
  if (!await verifyHost(socket, data.sessionId)) return;
  // LOCK ORDER (global rule): matchGenerationLock OUTSIDE, sessionGuard INSIDE.
  return withMatchGenerationLock(data.sessionId, () =>
    withSessionGuard(data.sessionId, async () => {
      try {
        if (!await verifyHost(socket, data.sessionId)) return; // TOCTOU re-verify after lock wait
        const activeSession = activeSessions.get(data.sessionId);
        if (!activeSession) { socket.emit('error', { code: 'INVALID_STATE', ... }); return; }
        if (!activeSession.pendingRoundNumber) { socket.emit('error', { code: 'INVALID_STATE', ... }); return; }
        if (activeSession.timer) { clearTimeout(activeSession.timer); activeSession.timer = null; }
        const roundNumber = activeSession.pendingRoundNumber;
        await _transitionToRound(io, data.sessionId, roundNumber!);
        activeSession.pendingRoundNumber = null;   // FIX 3A: only after success (LCY-4 makes this conditional)
        persistSessionState(data.sessionId, activeSession);
      } catch (err: any) {
        logger.error({ err }, 'Error confirming round');
        socket.emit('error', { code: 'CONFIRM_ROUND_FAILED', message: err.message });
      }
    }));
}

// handleHostRegenerateMatches — insert after beforeMatches (:831), before the wipe DELETE (:842)
if (beforeMatches.some(m => m.status === 'active' || m.status === 'completed')) {
  socket.emit('error', { code: 'INVALID_STATE', message: 'That round has already started — nothing to re-match.' });
  return;
}
````

### Tests to add

- New server/src/__tests__/services/orchestration/lcy2-confirm-round-locks.test.ts — source pins: (a) handleHostConfirmRound slice matches withMatchGenerationLock( BEFORE withSessionGuard( (index comparison, same style as match-generation-lock.test.ts:121-133); (b) verifyHost appears before the lock AND again inside it; (c) handleHostRegenerateMatches contains the active/completed re-check between beforeMatches and the DELETE.
- Behavioral (real lock helpers, mocked verifyHost/matching service): start a fake regenerate that holds withMatchGenerationLock for 50ms and records 'regen-done'; concurrently invoke handleHostConfirmRound — assert the injected transitionToRound spy runs strictly after 'regen-done' (serialization), and that a session with pendingRoundNumber=null emits INVALID_STATE without ever calling transitionToRound.
- Behavioral: with a session whose round rows are status 'active', call handleHostRegenerateMatches — assert NO DELETE query was issued and the socket got INVALID_STATE.
- Headed Playwright prod smoke: host opens Match People preview, then clicks Re-match and Start (confirm) in rapid succession (and the reverse order in a second run). Assert: the started round has every participant in a live room with a backing match row (host dashboard shows N active rooms = N match rows), no participant gets match:assigned for a room that then 404s, and a Re-match clicked after the round started returns the 'already started' error toast instead of silently rewriting.

### Acceptance criteria

- handleHostConfirmRound acquires withMatchGenerationLock then withSessionGuard in that order (source-pinned) and re-verifies host privileges inside the locks.
- Confirm racing Re-match in either order never leaves an active round with deleted/zero match rows: the behavioral serialization test and the headed smoke both pass.
- handleHostRegenerateMatches refuses (INVALID_STATE, no DELETE issued) when the resolved round contains any active/completed match row.
- session-state.ts contains the documented global lock-ordering rule; full server suite green.

### Pinned tests to update

- server/src/__tests__/services/orchestration/match-generation-lock.test.ts — no existing assertion breaks (it pins generate/regenerate/repair, all untouched); EXTEND it (or the new lcy2 file) with the confirm-round pin so the lock can't regress.
- server/src/__tests__/services/may23-round3-rematch-endevent-fixes.test.ts and server/src/__tests__/services/matching/phase-1-greedy-completeness.test.ts pin handleHostRegenerateMatches content via fnSlice (excludePairKeys, regenerate:true, replanRoundsAfterPreviewEdit) — the inserted re-check does not remove any pinned substring; re-verify green.
- server/src/__tests__/services/socket-events.test.ts lists 'host:confirm_round' registration — unchanged.

### Risks

Confirm now waits for any in-flight generation (worst case 60s engine timeout) before starting the round — the host sees a delayed start instead of a corrupted one; typical repairs are <2s. Deadlock risk is the core concern: eliminated by the documented order plus the verified fact that no matchGenLock holder ever awaits sessionGuard; any future code violating the rule re-introduces it — hence the source-pinned order test. The regenerate re-check adds one early-return path; its message surfaces through the existing error-toast rail.

### Deploy notes

Server-only. No migration/env/client changes. Deploy after LCY-1 (one fix per deploy). The lock-order comment in session-state.ts ships in this same commit so the rule and its first enforcement land together.

---

## LCY-3 — Act-after-lock FSM re-checks in endRound/endRatingWindow + idempotent rounds_completed increment

**Priority:** P0
**Depends on:** LCY-1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts`

### Problem

endRound's FSM precondition (round-lifecycle.ts:524) is check-then-act across a multi-await gap: between the check and the status flip at :560 sit the complete-matches UPDATE (:531) and clearCanonicalBreakoutByMatch (:542-546). Two endRound entries that both pass the check double-flip, double-emit round_ended/rating fanout, and double-run incrementRoundsCompletedBatch (:705) — rounds_completed inflates and recap math drifts. endRatingWindow (:754-862) has the same shape: its status check (:763) is followed by many awaits before the ROUND_TRANSITION/CLOSING_LOBBY writes, and it never validates roundNumber against currentRound, so a stale fire for round N can run the close logic while the session is rating round N+1 (using N in finalizeRoundRatings and the 'more rounds' comparison).

### Design

LCY-1 makes all entry points serialized, so within one process the re-checks are belt-and-braces; they also convert any future unguarded caller from a corruption into a logged no-op.
(1) endRound — insert a second FSM re-check immediately BEFORE the status flip at :560 (synchronous with it, no await in between): `if (!canTransitionSession(activeSession.status, SessionStatus.ROUND_RATING)) { logger.warn(..., 'endRound: status changed mid-flight — aborting before flip'); return; }`. Everything that mutates global state for the rating phase (status writes, broadcasts, rating fanout, increment, chokepoint returns, backstop arm) stays AFTER this point; the only work a refused second run has already done is the idempotent complete-matches UPDATE (WHERE status='active' — second run matches zero rows) and the idempotent canonical breakout clear.
(2) endRound — defense-in-depth before the backstop arm (:734-742): skip arming if `activeSession.status !== SessionStatus.ROUND_RATING` (cheap synchronous check; under full serialization it cannot differ, but it makes the invariant local).
(3) endRound — idempotent increment: add `roundsCompletedApplied?: Set<number>` to the ActiveSession interface (session-state.ts:14-73; in-memory only, deliberately NOT persisted to Redis — a restart re-running endRound is already prevented by the DB status FSM in updateSessionStatus). Around :705: `if (!(activeSession.roundsCompletedApplied ??= new Set()).has(roundNumber)) { await sessionService.incrementRoundsCompletedBatch(sessionId, attendanceCounts); activeSession.roundsCompletedApplied.add(roundNumber); }`. Keep exactly ONE textual occurrence of incrementRoundsCompletedBatch inside endRound (pinned).
(4) endRatingWindow — extend the entry guard at :762-767 with a stale-round check: after the status check add `if (activeSession.currentRound !== roundNumber) { logger.warn(..., 'endRatingWindow: stale roundNumber — skipping'); return; }`. Safe for every live caller: the backstop passes the round it ended (== currentRound during rating), host force-advance/force-close pass activeSession.currentRound, #11 passes currentRound.
(5) endRatingWindow — act-after-gap re-check: one re-check `if (activeSession.status !== SessionStatus.ROUND_RATING) return;` placed just after the endRequested block (:794-798), synchronous with the :801 if/else entry so it covers both the ROUND_TRANSITION (:803) and CLOSING_LOBBY (:836) status writes.

### Code sketch

````
// endRound — immediately before the flip at :560 (no awaits between this and the flip)
if (!canTransitionSession(activeSession.status, SessionStatus.ROUND_RATING)) {
  logger.warn({ sessionId, currentStatus: activeSession.status, roundNumber },
    'endRound: status changed during pre-flip awaits — aborting (act-after-lock)');
  return;
}
activeSession.status = SessionStatus.ROUND_RATING;
...

// endRound — idempotent increment at :705
activeSession.roundsCompletedApplied ??= new Set<number>();
if (!activeSession.roundsCompletedApplied.has(roundNumber)) {
  await sessionService.incrementRoundsCompletedBatch(sessionId, attendanceCounts);
  activeSession.roundsCompletedApplied.add(roundNumber);
}

// endRatingWindow — entry guard extension at :767
if (activeSession.currentRound !== roundNumber) {
  logger.warn({ sessionId, roundNumber, currentRound: activeSession.currentRound },
    'endRatingWindow: stale round — skipping');
  return;
}

// endRatingWindow — single act-after-gap re-check after the endRequested block (:798)
if (activeSession.status !== SessionStatus.ROUND_RATING) {
  logger.warn({ sessionId, roundNumber }, 'endRatingWindow: status changed mid-flight — aborting');
  return;
}
````

### Tests to add

- New server/src/__tests__/services/orchestration/lcy3-act-after-lock.test.ts — behavioral, mocked db/session/matching services in the style of phase2-locked-transitions.test.ts: (a) make the complete-matches query mock yield (await a deferred) and flip the session status to COMPLETED while endRound is mid-await — assert updateSessionStatus(ROUND_RATING) is never called and no rating:window_open is emitted; (b) call endRound twice on a session whose status is reset to ROUND_ACTIVE between calls but with the same roundNumber — assert incrementRoundsCompletedBatch called exactly once (the roundsCompletedApplied set); (c) endRatingWindow with roundNumber=1 while currentRound=2 — assert finalizeRoundRatings is NOT called and status is untouched.
- Source pin in the same file: endRound contains a second canTransitionSession( occurrence after the 'UPDATE matches SET status' text and before 'activeSession.status = SessionStatus.ROUND_RATING'; endRatingWindow contains 'currentRound !== roundNumber'.
- Headed Playwright prod smoke: 4-participant event; during ROUND_ACTIVE the host clicks End Round (force path) at the same moment the round timer expires (use a 35s round). Assert each participant receives exactly one rating form per partner, recap 'rounds completed' equals the real number of rounds attended (check the recap page after event end), and no duplicate session:round_ended appears in the client console log.

### Acceptance criteria

- A second endRound entering after the first flipped status performs zero status writes, zero rating emits, zero increments (behavioral test a/b).
- endRatingWindow invoked with a stale roundNumber (≠ currentRound) is a logged no-op (test c).
- rounds_completed for every participant equals rounds actually attended in the headed smoke recap.
- tier1-a2 pin still green: exactly one textual incrementRoundsCompletedBatch occurrence inside endRound; full suite green.

### Pinned tests to update

- server/src/__tests__/services/orchestration/tier1-a2-rounds-completed-batch.test.ts:57-60 pins that 'incrementRoundsCompletedBatch' appears EXACTLY ONCE inside endRound — the idempotency wrapper must keep a single textual occurrence (guard with the Set around the one call, as sketched).
- server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts endRound behavioral pins (ROUND_ACTIVE→ROUND_RATING; ROUND_RATING→no-op) — unaffected by design but re-verify: the new re-check sits after mocked awaits that resolve synchronously with status unchanged in those fixtures.
- server/src/__tests__/services/orchestration/s20-recap-departed-and-zombies.test.ts and canonical-100-shipC.test.ts pin endRound content (attendanceCounts union, Ship-C clear-before-broadcast ordering) — insertions must not reorder those blocks; re-verify green.

### Risks

Low blast radius — all additions are early-return guards plus one Set. The roundsCompletedApplied set is per-process: a deploy-overlap second instance (M7, other cluster) could still double-increment cross-process; the DB-level FSM in updateSessionStatus blocks most of that window but not all — flag, don't fix here. Placement discipline matters: the re-checks must have NO await between them and the writes they protect, or they reintroduce the gap they close.

### Deploy notes

Server-only. No migration/env/client changes. Deploy after LCY-1 (the re-checks assume serialized entry points to be meaningful rather than merely defensive).

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** The act-after-lock re-check is placed 'immediately BEFORE the status flip at :560', but endRound already emits emitHostDashboard (round-lifecycle.ts:551) and the session:round_ended broadcast (round-lifecycle.ts:554-557) BEFORE line 560. The spec's claim that 'the only work a refused second run has already done is the idempotent complete-matches UPDATE and the idempotent canonical breakout clear' is false: a refused duplicate has already double-broadcast session:round_ended. So the stated purpose ('converts any future unguarded caller from a corruption into a logged no-op') and the headed-smoke assertion 'exactly one session:round_ended per round' are NOT delivered by the re-check itself — they hold only because LCY-1 serializes in-process callers. The last await before the flip is clearCanonicalBreakoutByMatch (:542-546); everything from :551 to :560 is synchronous.

*Required action:* Place the re-check immediately after the clearCanonicalBreakoutByMatch block (after :546) and before the dashboard emit at :551 — it stays synchronous with the flip (no await between :551 and :560) and additionally suppresses the duplicate session:round_ended broadcast. Update the source pin accordingly: the second canTransitionSession( occurrence should appear after the clearCanonicalBreakoutByMatch text and before the round_ended emit, not between the broadcast and the flip.

---

## LCY-4 — transitionToRound: flip ROUND_ACTIVE only AFTER matches are batch-activated; clean abort on zero startable matches

**Priority:** P0
**Depends on:** LCY-1, LCY-2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/matching-flow.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/timer-manager.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/host-actions.ts`

### Problem

transitionToRound flips status to ROUND_ACTIVE (in-memory + DB + canonical, round-lifecycle.ts:266-274) BEFORE matches are loaded/generated (:278-283), before LiveKit rooms are created (Step 2, seconds at 30-50 scale), and before matches are batch-activated (Step 3, :341-353). In that window the architectural invariant 'ROUND_ACTIVE ⇒ ≥1 active match' is false, so any kick/leave firing maybeAutoEndEmptyRound sees ROUND_ACTIVE + 0 active matches and fires endRound → the session lands in ROUND_RATING while transitionToRound keeps walking people into breakouts and re-writes canonical locations after they were cleared (the ghost-room pattern re-armed via ordering; audit C4 worst interleaving). A wholesale failure (zero matches, all rooms failed) currently leaves the session wedged in ROUND_ACTIVE.

### Design

Chosen option: FLIP STATUS AFTER BATCH-ACTIVATION (not the 'ignore young rounds' heuristic) — it restores the invariant by construction instead of special-casing one consumer; with LCY-1's guarded maybeAutoEndEmptyRound the auto-end now finds status still LOBBY_OPEN/ROUND_TRANSITION during room creation and correctly no-ops. The fire-and-forget call at participant-flow.ts:274-280 needs no further change: it queues on the guard (LCY-1) and the status it reads post-flip is accurate.
Edits to transitionToRound (round-lifecycle.ts:228-505):
(1) Keep the top FSM precondition (:241-245) as the act-gate (callers hold the guard per LCY-1, so the status cannot change under us).
(2) MOVE the block at :251-274 (bonus-round bump + currentRound/status/manuallyLeftRound mutation + updateSessionStatus + updateCanonicalSessionStatus + current_round UPDATE + persistSessionState) to AFTER Step 3's batch-activate UPDATE (:353) and BEFORE Step 4 (name lookup). Order within the moved block unchanged — keeps the canonical write adjacent to the in-memory assignment (Phase 3 convention).
(3) Load matches first (existing :278 getMatchesByRound) and FILTER to startable rows: `matches = all.filter(m => m.status === 'scheduled' || m.status === 'active')` — excludes 'cancelled' forensic rows kept by cancel-preview (Bug 25, matching-flow.ts:950-965) which the current code would otherwise resurrect to 'active' ('active' is included so a retry after a partial failure re-enters cleanly). The zero-matches fallback at :279-283 stays in place until LCY-7.
(4) Abort path: if after generation/filter `matches.length === 0`, OR after Step 2 every match was cancelled (activatable set empty): emit `io.to(userRoom(activeSession.hostUserId)).emit('error', { code: 'ROUND_START_FAILED', message: 'No startable matches for this round — open Match People and generate a new preview.' })` plus `io.to(sessionRoom(sessionId)).emit('session:matching_cancelled', { sessionId })` (existing client handler clears the preparing overlay), log, and return WITHOUT flipping status — session stays in LOBBY_OPEN/ROUND_TRANSITION and the host can retry.
(5) Contract change: transitionToRound returns Promise<boolean> — true iff, at return, activeSession.status === ROUND_ACTIVE && activeSession.currentRound === roundNumber (covers both 'started now' and the FSM-duplicate 'already active' no-op as success); false on abort or caught error (the catch at :502-504 returns false). Update the three type declarations together: TimerCallbacks.transitionToRound in timer-manager.ts:19, injectMatchingFlowDeps deps type (matching-flow.ts:51-55), injectHostActionDeps transitionToRound member (host-actions.ts:72-79) — all to Promise<boolean>. Promise<boolean> is NOT assignable to Promise<void> in TS, so these must change in the same commit; orchestration.service.ts wiring text is unchanged (arrow bodies already return the call), keeping the phase2 source pin intact.
(6) handleHostConfirmRound (after LCY-2): `const started = await _transitionToRound(io, data.sessionId, roundNumber!); if (started) { activeSession.pendingRoundNumber = null; persistSessionState(...); } else { socket.emit('error', { code: 'CONFIRM_ROUND_FAILED', message: 'Round did not start — try Match People again.' }); }` — preserves FIX 3A (pending kept on failure, host can retry). handleHostStartRound (host-actions.ts:543) similarly emits START_ROUND_FAILED when false.

### Code sketch

````
export async function transitionToRound(io, sessionId, roundNumber): Promise<boolean> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return false;
  try {
    if (!canTransitionSession(activeSession.status, SessionStatus.ROUND_ACTIVE)) {
      // duplicate start: success iff this exact round is the active one
      return activeSession.status === SessionStatus.ROUND_ACTIVE && activeSession.currentRound === roundNumber;
    }
    // 1. load + (until LCY-7) generate; FILTER startable rows
    let matches = (await matchingService.getMatchesByRound(sessionId, roundNumber))
      .filter(m => m.status === 'scheduled' || m.status === 'active');
    ...fallback generation (LCY-7 removes)...
    if (matches.length === 0) return abortRoundStart(io, activeSession, sessionId, roundNumber); // returns false
    // 2. Step 1 bookkeeping + Step 2 room creation (cancels failures — LCY-5 tracks failedMatchIds)
    // 3. Step 3 batch-activate UPDATE
    if (activatableMatchIds.length === 0) return abortRoundStart(...); // every room failed
    // 4. >>> MOVED FLIP <<< (bonus bump, currentRound, status, manuallyLeftRound.clear,
    //    updateSessionStatus, updateCanonicalSessionStatus, current_round UPDATE, persistSessionState)
    activeSession.currentRound = roundNumber;
    activeSession.status = SessionStatus.ROUND_ACTIVE;
    ...
    // 5. Steps 4-6 (names, match:assigned, statuses), byes, broadcasts, timers — unchanged order
    return true;
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error transitioning to round');
    return false;
  }
}

function abortRoundStart(io, activeSession, sessionId, roundNumber): false {
  logger.error({ sessionId, roundNumber }, 'Round start aborted — no startable matches');
  io.to(userRoom(activeSession.hostUserId)).emit('error', { code: 'ROUND_START_FAILED', message: '...' });
  io.to(sessionRoom(sessionId)).emit('session:matching_cancelled', { sessionId });
  return false;
}
````

### Tests to add

- New server/src/__tests__/services/orchestration/lcy4-flip-after-activation.test.ts — behavioral with a journaling db mock (records query SQL in order) and mocked videoService/matchingService: (a) one scheduled match → the `UPDATE matches SET status = 'active'` journal entry occurs BEFORE updateSessionStatus(ROUND_ACTIVE); (b) maybeAutoEndEmptyRound invoked concurrently while transitionToRound is awaiting a deferred createMatchRoom — assert it does NOT call endRound (status still pre-flip); (c) getMatchesByRound returns only a 'cancelled' row → transitionToRound resolves false, updateSessionStatus never called, host userRoom got ROUND_START_FAILED, room got session:matching_cancelled; (d) duplicate call while ROUND_ACTIVE for the same round resolves true without writes.
- Source pin: within transitionToRound, the index of "UPDATE matches SET status = 'active'" is LESS THAN the index of 'activeSession.status = SessionStatus.ROUND_ACTIVE'.
- Headed Playwright prod smoke: 6-participant event; host starts a round and within the same second one participant is kicked and one closes the tab (churn inside the start window). Assert: the round reaches ROUND_ACTIVE with all surviving pairs in rooms, the session never bounces to ROUND_RATING during the start, and a second run where the preview is cancelled before confirm shows the host an actionable error with the session still in transition (Match People still works).

### Acceptance criteria

- The DB/canonical/in-memory ROUND_ACTIVE flip happens strictly after the batch-activate UPDATE (source-pinned + journal-order test).
- At no observable instant is session status ROUND_ACTIVE with zero active match rows for currentRound (behavioral test b; headed smoke shows no spurious ROUND_RATING bounce during round start under churn).
- Zero startable matches → no status change, host receives ROUND_START_FAILED, participants' 'preparing' overlay clears, pendingRoundNumber preserved so confirm can be retried.
- transitionToRound returns true on started/already-active and false on abort/error; confirm clears pendingRoundNumber only on true. Full suite green including phase2 pins.

### Pinned tests to update

- server/src/__tests__/services/orchestration/phase2-locked-transitions.test.ts 'transitionToRound is a no-op when already ROUND_ACTIVE' — still passes (top FSM gate; updateSessionStatus not called) but now returns true; no edit expected, re-verify.
- server/src/__tests__/services/phase-may18-bug22-extra-round.test.ts and may23 bonus-round pins reference the jsonb_set bonus bump inside transitionToRound — the bump MOVES with the flip block but stays inside the same function; substring/fnSlice pins keep matching; update only if a pin asserts the bump precedes match loading.
- server/src/__tests__/services/orchestration/phase0-room-assignment-server-canonical.test.ts (setRoomAssignment before match:assigned), phase4-eviction-lobby.test.ts (evictMatchedFromLobby call), dashboard-refresh-on-transition.test.ts (loose emitHostDashboard pins) — Step 4-6 internal order unchanged; re-verify.
- server/src/__tests__/services/orchestration/host-force-advance-rating.test.ts injects transitionToRound spies typed via `as any` — compiles unchanged with the Promise<boolean> signature; re-verify.

### Risks

Largest-blast-radius item in the cluster: the moved block must carry ALL seven statements together (missing the canonical write or persistSessionState would desync Redis recovery). During room creation the session now reports its previous status — clients keep the session:matching_preparing overlay instead of an early ROUND_ACTIVE; the host dashboard reads currentRound from the same activeSession so there is no torn state, but verify the dashboard copes with currentRound advancing later. Late joiners during the (now pre-ROUND_ACTIVE) creation window register as lobby joiners — behaviorally same as today since match:assigned was always post-creation. The boolean return ripples through exactly three type declarations — compile-enforced.

### Deploy notes

Server-only. No migration/env change. The new ROUND_START_FAILED error code rides the existing generic 'error' socket rail the client already toasts — no client deploy required (a nicer client message can follow independently). Deploy after LCY-2; if feasible run the 20-browser canonical-state load harness against a preview before the prod push, plus the headed smoke.

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** pinnedTestsToUpdate claims the bonus-bump move is pin-safe ('substring/fnSlice pins keep matching; update only if a pin asserts the bump precedes match loading'). It is not: server/src/__tests__/services/phase-may18-bug22-extra-round.test.ts:30-35 pins the bump inside a FIXED 2500-character window from the start of transitionToRound (`const block = lifecycleSrc.slice(idx, idx + 2500)`), asserting /roundNumber\s*>\s*\(activeSession\.config\.numberOfRounds/, /numberOfRounds:\s*roundNumber/, and /jsonb_set\([\s\S]{0,160}'\{numberOfRounds\}'/. Moving the bump to after Step 3's batch-activate (~line 353, roughly 7000 characters into the function) pushes all three patterns out of the window — three assertions fail. The spec's acceptance ('Full suite green including phase2 pins') is unreachable without editing this test, which the spec says needs no edit.

*Required action:* Add phase-may18-bug22-extra-round.test.ts to LCY-4's pinnedTestsToUpdate with a concrete edit: convert the 2500-char window to a full-function slice (indexOf('export async function transitionToRound') → next '\nexport'), preserving the three substring assertions. The companion test at :38-45 (CLOSING_LOBBY block in matching-flow) is unaffected.

**[NIT]** 'The boolean return ripples through exactly three type declarations' undercounts. Besides timer-manager.ts:19, matching-flow.ts:51-55 (deps type), and host-actions.ts:69 (deps member — the spec cites :72-79, which is actually the endRatingWindow/emitHostDashboard members), the MODULE-LEVEL injected-fn variables must also change: matching-flow.ts:45 `let _transitionToRound: ((io, sessionId, roundNumber) => Promise<void>) | null` and host-actions.ts:45 (same shape). `() => Promise<boolean>` is not assignable to `() => Promise<void>` in TS, so `_transitionToRound = deps.transitionToRound` and `const started = await _transitionToRound(...)` / `if (started)` fail to compile until those two `let` types are updated. Compile-enforced, so it cannot ship broken, but an implementer told 'exactly three' will be confused by the extra errors.

*Required action:* Amend LCY-4 edit (5) to list five declarations: timer-manager.ts:19, matching-flow.ts:45 and :52, host-actions.ts:45 and :69 — all to Promise<boolean>.

---

## LCY-5 — Room-creation-failure path: cancelled matches stay cancelled (exclude from batch-activate, match:assigned, IN_ROUND, eviction)

**Priority:** P1
**Depends on:** LCY-4

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`

### Problem

In transitionToRound Step 2 (round-lifecycle.ts:308-338), a match whose LiveKit room fails twice is set to status='cancelled' and its participants get match:bye_round. But Step 3 (:341-353) batch-activates ALL loaded matches — including the just-cancelled ones — flipping them back to 'active'; Step 6 (:381-422) then emits match:assigned to their participants (overriding the bye with a room that does not exist), marks them IN_ROUND, and evictMatchedFromLobby (:425) kicks them out of the lobby video. Verified in current code: `matchIds = matches.map(m => m.id)` with no exclusion.

### Design

All inside transitionToRound; builds on LCY-4's structure (filtered `matches`, flip after activation).
(1) Step 2: collect failures — `const failedMatchIds = new Set<string>(); const byeSentUserIds = new Set<string>();` and in the existing `if (!success)` branch (:323-331) add `failedMatchIds.add(match.id)`, add each affected pid to byeSentUserIds, and DELETE each affected pid from matchedUserIds (the bye is already emitted there — keep it as the single bye for these users).
(2) Define `const startable = matches.filter(m => !failedMatchIds.has(m.id));` after Step 2 completes.
(3) Step 3: build updateCases/matchIds from `startable` only — cancelled rows keep status='cancelled' (row already carries the audit trail; no room_id rewrite).
(4) Abort check (from LCY-4): if `startable.length === 0` → abortRoundStart (no flip).
(5) Step 6 loop: iterate `startable` instead of `matches`. Consequences of the matchedUserIds deletion in (1): (a) evictMatchedFromLobby no longer evicts the affected users (they stay in the lobby room they are watching); (b) the odd-count bye loop (:433-441) would now match them — skip anyone in `byeSentUserIds` there so they do not receive a second bye with the wrong 'odd number' reason; (c) no IN_ROUND status update is queued for them (they remain in_lobby and are matchable next round). Use the same pid extraction as Step 1 (participantAId/B/C) so trio C-slots are covered.
(6) Keep the per-batch emitHostDashboard (:337) and the cancellation log untouched (loosely pinned by dashboard-refresh-on-transition.test.ts).

### Code sketch

````
// Step 2 failure branch (inside the results loop)
if (!success) {
  await query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [match.id]);
  failedMatchIds.add(match.id);
  const affected = [match.participantAId, match.participantBId, match.participantCId].filter(Boolean);
  for (const uid of affected) {
    byeSentUserIds.add(uid);
    matchedUserIds.delete(uid);          // not in-round: no eviction, no IN_ROUND
    io.to(userRoom(uid)).emit('match:bye_round', { roundNumber });
  }
}

const startable = matches.filter(m => !failedMatchIds.has(m.id));
if (startable.length === 0) return abortRoundStart(io, activeSession, sessionId, roundNumber);

// Step 3 — activate only startable
const matchIds = startable.map(m => m.id);
... `WHERE id = ANY($1)` with matchIds ...

// Step 6 — emit only for startable
for (const match of startable) { ...setRoomAssignment + match:assigned + IN_ROUND... }

// Bye loop — single bye per user
if (!matchedUserIds.has(p.user_id) && !byeSentUserIds.has(p.user_id)) { emit match:bye_round(...odd count...); }
````

### Tests to add

- New server/src/__tests__/services/orchestration/lcy5-cancelled-stays-cancelled.test.ts — behavioral: mock createMatchRoom to reject twice for match A and succeed for match B (2 matches, 4 users). Assert: (a) the batch-activate UPDATE's id array contains only B; (b) match:assigned emitted only to B's two users; (c) A's users each received exactly ONE match:bye_round; (d) updateParticipantStatus(IN_ROUND) never called for A's users; (e) evictMatchedFromLobby invoked with only B's users; (f) the query journal shows no UPDATE touching A after its cancellation.
- Edge test: ALL rooms fail → transitionToRound returns false, status not flipped, every user got exactly one bye, host got ROUND_START_FAILED.
- Headed Playwright prod smoke (failure injection is impractical against real LiveKit — if a preview env with a video-service fault flag exists, run there; otherwise run the no-regression variant on prod): start a 3-pair round; assert every match:assigned roomId is joinable, nobody receives both a bye and an assignment for the same round, and the host dashboard active-room count equals assigned matches.

### Acceptance criteria

- A match cancelled in Step 2 remains status='cancelled' through the end of transitionToRound (no later UPDATE touches it).
- Participants of a cancelled match: exactly one bye, no match:assigned, no IN_ROUND transition, not evicted from the lobby, and they appear in the next round's eligible set.
- All-rooms-failed degenerates to the LCY-4 abort (no flip, host error).
- Full suite green; dashboard/dr-arch source pins unaffected.

### Pinned tests to update

- server/src/__tests__/services/orchestration/dashboard-refresh-on-transition.test.ts:83-92 — loose pin (transitionToRound contains emitHostDashboard) — unaffected; re-verify.
- server/src/__tests__/services/orchestration/phase0-room-assignment-server-canonical.test.ts — pins setRoomAssignment before the per-pid emits inside the Step 6 loop; loop body unchanged, only its iteration source (startable) changes; re-verify.

### Risks

Behavioral change for affected users: previously they (incorrectly) got a phantom room assignment; now they correctly sit out with a bye — the designed WS2 semantics (no mid-round re-pairing). matchedUserIds deletion cannot strand a user who is also in another startable match: the DB partial-unique index (migration 041) forbids double-booking within a round. Bookkeeping must reuse the exact pid extraction from Step 1 or a trio C-slot could be missed.

### Deploy notes

Server-only, no migration/env/client changes. Deploy after LCY-4 (same code region; sequencing avoids conflicting edits).

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** The risk note says 'matchedUserIds deletion cannot strand a user who is also in another startable match: the DB partial-unique index (migration 041) forbids double-booking within a round.' Migration 041 (041_active_only_match_uniqueness.sql) creates per-slot unique indexes WHERE status = 'active' only. Under the LCY-4 ordering, Step 2 failures occur while rows are still 'scheduled', where the index imposes nothing — two scheduled rows containing the same user in one round are not DB-forbidden. The actual protection is that the Step-3 batch-activate UPDATE would throw on the 041 index if such rows existed (plus the engine/swap validation never producing them), not prevention at row-creation time.

*Required action:* Reword the rationale: 'a double-booked user cannot reach two ACTIVE matches — the 041 active-only unique index makes Step 3's batch-activate fail loudly — and the generator/swap validation never emits double-booked scheduled rows.' No code change needed.

---

## LCY-6 — checkAllRatingsCompleteByUserId: status+round re-check immediately before the timer clear/re-arm (no token needed)

**Priority:** P1
**Depends on:** LCY-1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/participant-flow.ts`

### Problem

checkAllRatingsCompleteByUserId (participant-flow.ts:1469-1600) snapshots activeSession at entry (status ROUND_RATING), then performs several awaits (getMatchesByRound :1501, the rated-edges query :1529, optional fetchSockets :1545). If the rating window closes meanwhile (90s backstop, host force-close) and the host starts the NEXT round, activeSession.timer now holds the NEW round's segment timer — and the early-close block (:1579-1595) clears it unconditionally and re-arms a 3s grace that fires endRatingWindow for the OLD round. The next round's timer is silently cancelled: the round never auto-ends (audit M3(c)). The 3s grace callback (:1591-1595) has the same staleness hole at fire time.

### Design

Chosen option: SYNCHRONOUS RE-CHECK, not a timer-generation token. Correctness argument: Node's single-threaded event loop guarantees nothing interleaves between an await-resume and the next await; placing the re-check with ZERO awaits between it and the clear/re-arm makes the check-act pair atomic. A generation token adds state for no additional guarantee in a single process (these timers are in-memory; there is no cross-process timer to fence). Two edits:
(1) At the top of the `if (anyEligible && allSettled)` block (insert at :1573, before the log at :1574): `const live = activeSessions.get(sessionId); if (!live || live.status !== SessionStatus.ROUND_RATING || live.currentRound !== roundNumber) return;` — and use `live` (not the entry-time `activeSession` reference) for the timer clear and re-arm below, matching the existing `activeSessions.get(sid) ?? activeSession` defensive pattern from timer-manager.ts:68-84.
(2) Inside the 3s grace callback (:1591-1595), before calling endRatingWindow: `const s = activeSessions.get(sid) ?? live; s.timer = null; if (s.status !== SessionStatus.ROUND_RATING || s.currentRound !== rn) return; endRatingWindow(sid, rn);`. (After LCY-1 this endRatingWindow is the guard-wrapped timerCallbacks variant, and after LCY-3 endRatingWindow itself refuses stale rounds — this check just avoids a pointless guard acquisition and keeps the invariant local.)
Call-path coverage note: handleRatingSubmit invokes this under withSessionGuard (:1400-1405); handleRatingSkip (:1430) and the REST notifyRatingSubmitted (:1437-1439) invoke it UNGUARDED — the synchronous re-check is what protects those paths today. Threading io/the guard through the REST rating path is M3(b), owned by the rating cluster — do not bundle it here.

### Code sketch

````
if (anyEligible && allSettled) {
  // Act-after-await re-check: everything between here and the re-arm is synchronous,
  // so the state cannot change under us (single-threaded event loop).
  const live = activeSessions.get(sessionId);
  if (!live || live.status !== SessionStatus.ROUND_RATING || live.currentRound !== roundNumber) {
    logger.info({ sessionId, roundNumber }, 'all-rated close skipped — window already advanced');
    return;
  }
  if (live.timer) { clearTimeout(live.timer); live.timer = null; live.timerEndsAt = null; }
  const sid = sessionId, rn = roundNumber;
  live.timer = setTimeout(() => {
    const s = activeSessions.get(sid) ?? live;
    s.timer = null;
    if (s.status !== SessionStatus.ROUND_RATING || s.currentRound !== rn) return; // stale fire
    endRatingWindow(sid, rn);
  }, 3000);
}
````

### Tests to add

- Extend server/src/__tests__/services/orchestration/stuck-at-rating.test.ts (it already drives checkAllRatingsCompleteByUserId with mocked db + injected endRatingWindow spy): (a) new case — after arranging an all-settled round, flip the fixture session to status ROUND_ACTIVE / currentRound 4 with a sentinel timer object BEFORE invoking the check; assert the sentinel timer is untouched (not cleared) and the endRatingWindow spy is never called; (b) new case — let the check arm the 3s grace, then flip status to ROUND_TRANSITION before advancing fake timers by 3000ms; assert the spy is not called.
- Existing cases in stuck-at-rating.test.ts pin the happy path (timer armed, spy called with (SID, 3), non-blocking leavers, all-skip close) — they must stay green unmodified (fixtures keep status=ROUND_RATING and matching currentRound, so the re-check passes).
- Headed Playwright prod smoke: 4-participant event with 30s rating window; all users rate while the host simultaneously clicks Force-Close Rating, then immediately Match People + Start for round 2. Assert round 2's countdown reaches 0 and the round auto-ends into rating (the historical failure mode was round 2 never ending because its timer was silently cancelled).

### Acceptance criteria

- The early-close block never clears activeSession.timer when status ≠ ROUND_RATING or currentRound ≠ the round it evaluated (new tests a/b).
- A 3s grace timer that fires after the window advanced is a no-op (spy not called).
- In the headed smoke, round 2 auto-ends on schedule after a force-close + immediate restart sequence in round 1.
- All pre-existing stuck-at-rating assertions pass unmodified.

### Pinned tests to update

- server/src/__tests__/services/orchestration/stuck-at-rating.test.ts — extended, not weakened: all existing assertions (timer non-null, spy called with (SID, 3), leavers don't block, all-skip closes) remain pinned as-is.

### Risks

Minimal — two early-return guards. The one subtlety is operating on the LIVE map entry rather than the entry-time reference (the M2/Phase-6 orphaned-reference pattern already used by startSegmentTimer); clearing an orphaned ref's timer while the map holds a new object would leak the real timer.

### Deploy notes

Server-only. No migration/env/client changes. Ships independently after LCY-1 (works without it too, but the grace-fire then still calls the unguarded endRatingWindow).

---

## LCY-7 — Remove transitionToRound's zero-matches on-the-fly generation fallback (surface ROUND_START_FAILED to the host)

**Priority:** P2
**Depends on:** LCY-4

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`

### Problem

transitionToRound's fallback (round-lifecycle.ts:279-283 — NOTE: the audit cites matching-flow.ts, but the code verifiably lives in round-lifecycle.ts) calls matchingService.generateSingleRound(sessionId, roundNumber, [activeSession.hostUserId]) when no matches exist: it excludes ONLY the director (co-hosts and acting-hosts become matchable — getAllHostIds exists for exactly this, host-actions.ts:155+), applies NO presence gating (absent registered users get matched → guaranteed no-shows burning partners' rounds), and runs OUTSIDE the match-generation lock (can interleave with a repair).

### Design

RECOMMENDATION: REMOVE the fallback rather than harden it. Reasons: (a) the shipped client starts rounds only via host:confirm_round (verified: HostControls.tsx:155 is the only emitter; host:start_round has no client emitter), which requires a preview (pendingRoundNumber) — matches always exist on that path; pre-event planning (generateSessionSchedule at event start, host-actions.ts:386-417) covers timer/recovery transitions with 'scheduled' rows; the fallback is reachable only in degenerate states where silently matching the wrong people is worse than failing visibly. (b) Hardening it would require awaiting withMatchGenerationLock INSIDE the session guard — a direct violation of the LCY-2 global lock order and a REAL deadlock with confirm, which holds matchGenLock while calling transitionToRound (the lock is non-reentrant). (c) LCY-4 already gives zero-matches a clean, host-actionable abort (ROUND_START_FAILED + session:matching_cancelled + no status flip + pendingRoundNumber preserved by confirm).
Edit: delete lines :279-283 (`if (matches.length === 0) { generateSingleRound...; matches = getMatchesByRound(...); }`), leaving the LCY-4 filter + abort as the sole zero-matches handling. Keep a comment at the deletion site explaining why (host must generate via Match People; recovery relies on the pre-plan; locking the fallback would deadlock confirm) so it is not reintroduced.
If the team overrules removal, the fallback variant must use getAllHostIds + getPresentUserIds AND be launched fire-and-forget under withMatchGenerationLock with the round started only on a SUBSEQUENT confirm — i.e. it stops being a fallback and becomes an error path anyway. Removal is strictly simpler.

### Code sketch

````
// round-lifecycle.ts — transitionToRound, replacing :279-283
let matches = (await matchingService.getMatchesByRound(sessionId, roundNumber))
  .filter(m => m.status === 'scheduled' || m.status === 'active');
// On-the-fly fallback REMOVED (June 2026): it excluded only the director, ignored
// presence, and ran outside the match-generation lock (and locking it here would
// deadlock host:confirm_round, which holds that lock while calling us). Every
// supported start path arrives with pre-generated rows (confirm requires a preview;
// event start pre-plans all rounds). Zero startable matches aborts via
// abortRoundStart — the host re-generates with Match People.
if (matches.length === 0) return abortRoundStart(io, activeSession, sessionId, roundNumber);
````

### Tests to add

- New pin in the lcy4 test file (or a small lcy7 file): transitionToRound's function slice does NOT match /generateSingleRound\(/ (verified by grep: no existing test pins the fallback's existence — all generateSingleRound pins target matching-flow.ts and matching.service.ts).
- Behavioral: getMatchesByRound returns [] → transitionToRound resolves false, generateSingleRound mock never called, host userRoom received ROUND_START_FAILED, session status unchanged.
- Headed Playwright prod smoke: host cancels the preview, then (via a stale second host tab or devtools socket emit) fires host:confirm_round — assert the error toast appears, the session stays in transition, and Match People → Start works normally afterward.

### Acceptance criteria

- No call to generateSingleRound remains anywhere in round-lifecycle.ts (grep-clean, source-pinned).
- Confirm on a round with no startable rows produces CONFIRM_ROUND_FAILED + ROUND_START_FAILED and a retryable session state (preview can be regenerated and started).
- No behavioral change on the normal confirm path (preview rows exist); full suite green with zero pin updates.

### Pinned tests to update

- None — grep across server/src/__tests__ confirms no test pins generateSingleRound inside round-lifecycle.ts. Run the full suite to confirm (standing rule).

### Risks

Removes an implicit recovery behavior: a timer-driven transition after a restart where the pre-plan was never generated (planning failure is logged non-fatal at event start) now aborts instead of silently generating. That is the correct trade — the abort is visible and recoverable via Match People; the silent generation matched co-hosts and absent users. Flag in the deploy message so live-ops knows the new failure mode reads ROUND_START_FAILED.

### Deploy notes

Server-only. No migration/env/client changes. Deploy after LCY-4 (depends on its abort path). P2 — schedule after the P0/P1 chain.

---

## LCY-8 — endRatingWindow cannot wedge the session: non-fatal finalize + self-rearming retry on failure

**Priority:** P2
**Depends on:** LCY-1, LCY-3

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`

### Problem

endRatingWindow clears ALL session timers up front (round-lifecycle.ts:769) and only then runs its critical path. If finalizeRoundRatings (:773) or any later query throws, the catch (:859-861) merely logs: status stays ROUND_RATING with no timer and no backstop — the session is wedged until the host notices and force-closes (which may hit the same throwing query). Confirmed in code: nothing re-arms after the catch.

### Design

Two layers, both inside endRatingWindow:
(1) Make finalizeRoundRatings non-fatal: wrap :773 in its own try/catch (log error, continue). Finalization is bookkeeping — encounter rows are re-covered by the idempotent finalizeSessionEncounters at completeSession (:1021-1023); the status transition is what users are waiting on.
(2) Self-rearming retry in the outer catch: if the session still exists and status is still ROUND_RATING, arm a one-shot 15s retry through the guarded callback (same manual-arm pattern as the 90s backstop at :735-742, including setting timerEndsAt and calling persistSessionState so the retry survives a restart via the recovery timer path). endRatingWindow is idempotent on re-entry (status + stale-round guards from LCY-3), so repeated retries are safe; they recur every 15s until the dependency recovers — by design, since the alternative is a permanently wedged event. Constant `const RATING_CLOSE_RETRY_MS = 15_000;` defined next to the function.
Do NOT move the clearSessionTimers call (:769) — clearing before work is intentional (it cancels the backstop that invoked us); the retry replaces it on failure.

### Code sketch

````
// :773 — finalize becomes non-fatal
try {
  await ratingService.finalizeRoundRatings(sessionId, roundNumber);
} catch (err) {
  logger.error({ err, sessionId, roundNumber },
    'finalizeRoundRatings failed — continuing with the transition (encounters re-covered at event end)');
}

// outer catch (:859) — wedge-proofing
} catch (err) {
  logger.error({ err, sessionId, roundNumber }, 'Error ending rating window');
  const s = activeSessions.get(sessionId);
  if (s && s.status === SessionStatus.ROUND_RATING) {
    const RATING_CLOSE_RETRY_MS = 15_000;
    s.timerEndsAt = new Date(Date.now() + RATING_CLOSE_RETRY_MS);
    s.timer = setTimeout(() => {
      const cur = activeSessions.get(sessionId) ?? s;
      cur.timer = null; cur.timerEndsAt = null;
      if (_timerCallbacks) void _timerCallbacks.endRatingWindow(sessionId, roundNumber);
      else void endRatingWindow(io, sessionId, roundNumber);
    }, RATING_CLOSE_RETRY_MS);
    persistSessionState(sessionId, s).catch(() => {});
    logger.warn({ sessionId, roundNumber }, 'endRatingWindow failed — retry armed in 15s');
  }
}
````

### Tests to add

- New server/src/__tests__/services/orchestration/lcy8-rating-window-wedge.test.ts — behavioral with mocks: (a) finalizeRoundRatings rejects → session still transitions to ROUND_TRANSITION (updateSessionStatus called, rating:window_closed emitted); (b) updateSessionStatus rejects once → after the catch, activeSession.timer is non-null and timerEndsAt ≈ now+15s; advance fake timers 15s with updateSessionStatus now resolving → session reaches ROUND_TRANSITION (retry heals); (c) status flipped to CLOSING_LOBBY by another path before the catch runs → no retry armed.
- Source pin: endRatingWindow contains RATING_CLOSE_RETRY_MS and a try/catch around finalizeRoundRatings.
- Headed Playwright prod smoke (failure injection not possible on prod — run the no-regression variant): full 2-round event; assert every rating window closes within ratingWindow+90s worst case, the event reaches CLOSING_LOBBY, and Render logs show zero 'retry armed' warnings during the run.

### Acceptance criteria

- A finalizeRoundRatings failure no longer blocks the ROUND_RATING → ROUND_TRANSITION/CLOSING_LOBBY transition (test a).
- Any thrown error in endRatingWindow's critical path leaves the session with a live 15s retry timer instead of a wedged timer-less ROUND_RATING (test b), and the retry self-heals once the dependency recovers.
- No retry is armed when the session already advanced (test c).
- Full suite green; backstop pins in may25-live-fixes untouched.

### Pinned tests to update

- server/src/__tests__/services/may25-live-fixes.test.ts — pins endRound's backstop block (90_000, clearSessionTimers) which is untouched; its /endRatingWindow/ pins are substring-loose; re-verify.
- server/src/__tests__/services/orchestration/host-force-advance-rating.test.ts — drives endRatingWindow via injected spies, not the real function; unaffected; re-verify.

### Risks

An infinite 15s retry loop during a sustained DB outage emits repeated log warnings — desirable signal; the retry uses the guarded callback so it cannot stack with a concurrent host force-close (LCY-1 guarantees serialization). Making finalize non-fatal means a transiently-failed finalize leaves that round's encounter rows to the event-end sweep — recap 'people met' is computed from matches, not encounters, so the user-visible recap is unaffected; cross-event no-repeat matching could miss one round's history until event end (accepted, logged).

### Deploy notes

Server-only. No migration/env/client changes. Deploy after LCY-3 (relies on endRatingWindow's idempotent re-entry guards). P2 — last in the cluster chain.

## Reviewer-verified facts (safe to rely on)

- Branch/commit: RSN-dev is on june9-punchlist @ 3cf1187, matching the spec's clusterNotes; docs/AUDIT-2026-06-12-live-30-50-readiness.md exists.
- LCY-1 symbol reality: all cited sites verified — raw round timer (round-lifecycle.ts:481-483 → endRound), rating backstop (:734-742, RATING_BACKSTOP_MS=90_000, manual setTimeout), CLOSING_LOBBY 600s timer (:853-855 → completeSession), detectNoShows raw setTimeout (:486-488) and awaited maybeAutoEndEmptyRound (:1407), maybeAutoEndEmptyRound (:1257-1282), guarded timerCallbacks (orchestration.service.ts:128-133), direct host-actions endRatingWindow injection (:142 exactly, comment host-actions.ts:48-53), participant-flow injection (:163).
- LCY-1 timer inventory is COMPLETE: every other arm site already routes through guarded callbacks — recovery (round-lifecycle.ts:150-153, :212-214), resume (host-actions.ts:704-711), extend (:1888-1890), REST resume (:2548-2550) all use getTimerCallbackForState(_timerCallbacks). The participant-flow injected endRatingWindow wrapper (:261-269) has exactly one call site (:1594, the 3s grace), as claimed.
- LCY-1 deadlock audit: every maybeAutoEndEmptyRound caller is fire-and-forget (.catch wrappers participant-flow.ts:274-280 used at :413/:1749; host-actions.ts:93-99 used at :966/:1643/:1843) except detectNoShows :1407, which runs from an unguarded setTimeout — wrapping maybeAutoEndEmptyRound in withSessionGuard is deadlock-free as designed. room-end-early.ts mentions it only in a comment, no call.
- LCY-2 lock-order audit verified: matching-flow.ts contains NO withSessionGuard usage; all matchGen-lock bodies (matching-flow.ts:228/:810, participant-flow runRepair :134 with void-launches at :590/:1182, host-actions maybeRepairFutureRounds :114 with .catch() launches at :2109/:2185/:2307, participant-state-machine.ts:553) never acquire the session guard. handleHostConfirmRound (matching-flow.ts:576-618) currently holds neither lock; regenerate's wipe DELETEs at :842-845 and :862, beforeMatches :831, Bug-25 cancel keeps 'cancelled' rows (:950-965), 60s engine timeout :59, verifyHost pre/post-lock pattern :221/:230-234 — all as cited. Both locks are non-reentrant promise chains (session-state.ts:117-155).
- LCY-4/LCY-5 problem reality confirmed: transitionToRound flips status/DB/canonical at :266-274 BEFORE match load (:278-283 fallback generateSingleRound exists exactly as cited in round-lifecycle.ts, not matching-flow.ts), Step 3 batch-activates ALL loaded matches (matchIds = matches.map at :346, no exclusion of Step-2 cancellations at :322-331), getMatchesByRound (matching.service.ts:653-667) returns ALL statuses with the status column — so cancelled-row resurrection is real.
- Pinned tests verified compatible where the spec claims: tier1-a2-rounds-completed-batch.test.ts:57-60 counts 'incrementRoundsCompletedBatch' EXACTLY once in endRound (the Set wrapper keeps one occurrence); s20 pins /incrementRoundsCompletedBatch\(sessionId, attendanceCounts\)/ preserved; may25-live-fixes.test.ts:172-189 pins (no startSegmentTimer within 60 chars of endRatingWindow, activeSession.timer = setTimeout, RATING_BACKSTOP_MS = 90_000, clearSessionTimers) all survive the _timerCallbacks.endRatingWindow edit; phase2-locked-transitions.test.ts pins only a 600-char window from 'const timerCallbacks' (orchestration.service.ts:163 change is outside it) and its behavioral fixtures still pass under LCY-3/LCY-4 semantics; dr-arch-april-18-bugs maybeAutoEndEmptyRound fn-slice pins (ROUND_ACTIVE check, status='active' count, endRound() survive the guard wrap; stuck-at-rating fixtures keep status=ROUND_RATING/currentRound=3 so LCY-6's re-checks pass all existing cases; host-force-advance-rating.test.ts passes its whole deps object `as any` (line 106) so Promise<boolean> compiles; match-generation-lock.test.ts:121-133 uses the index-comparison style cited; socket-events.test.ts:26 lists 'host:confirm_round'; may23/phase-1-greedy fnSlice pins on handleHostRegenerateMatches (excludePairKeys, regenerate:true, replanRoundsAfterPreviewEdit, REMATCH_NO_ALTERNATIVE) are purely additive-safe.
- LCY-7 claims verified: client/src has exactly one host:confirm_round emitter (HostControls.tsx:155) and ZERO host:start_round emitters; no test anywhere pins generateSingleRound inside round-lifecycle.ts (phase-2-5-pre-event-planning pins target handleHostGenerateMatches in matching-flow.ts and matching.service.ts only); getAllHostIds exists (host-actions.ts:166).
- Client/deploy reality: session:matching_cancelled has a server emit (matching-flow.ts:968) and a client handler that clears the preparing overlay (useSessionSocket.ts:538-540); the generic socket 'error' rail toasts unknown codes with fallthrough (useSessionSocket.ts:1089+), so ROUND_START_FAILED needs no client deploy. All eight items are server-only — no migrations, env vars, or socket events removed/renamed.
- Library reality: server/package.json pins socket.io ^4.7.0 (fetchSockets already used at round-lifecycle.ts:1308, participant-flow.ts:1545), pg ^8.12.0, express-rate-limit ^7.1.0; the spec introduces no new library APIs; `??=` already used in the codebase (participant-flow.ts:1423). The claim that Promise<boolean> is not assignable to Promise<void> (forcing the compile ripple) is correct TS behavior.
- LCY-8 supporting claims verified: endRatingWindow clears all timers up front (:769), finalizeRoundRatings at :773, log-only catch at :859-861 with nothing re-armed; completeSession runs idempotent finalizeSessionEncounters (:1021-1023); recap peopleMet is computed from matches, not encounter rows (sendRecapEmails :1112-1131); completeSession flips in-memory status synchronously pre-await (:891) so a failed #11 path cannot arm a spurious retry.

