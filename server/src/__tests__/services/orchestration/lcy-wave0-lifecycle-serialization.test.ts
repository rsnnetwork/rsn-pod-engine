// LCY-1..4 (audit C4) — lifecycle serialization. Source pins that lock the
// deadlock-sensitive structure in place: timer/auto-end guards, the confirm
// double-lock + global lock order, the act-after-lock FSM re-checks + idempotent
// increment, and the flip-after-activation ordering. These guard against silent
// regression of the locking contract (a wrong edit here re-opens the race or
// deadlocks the session) — the runtime behavior is proven by the existing
// behavioral suites (phase2-locked-transitions, dr-arch-april-18-bugs,
// may25-live-fixes) and the headed prod smoke.

import * as fs from 'fs';
import * as path from 'path';

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

const lifecycle = readSrc('services/orchestration/handlers/round-lifecycle.ts');
const matching = readSrc('services/orchestration/handlers/matching-flow.ts');
const orchestration = readSrc('services/orchestration/orchestration.service.ts');
const sessionState = readSrc('services/orchestration/state/session-state.ts');
const timerManager = readSrc('services/orchestration/handlers/timer-manager.ts');
const hostActions = readSrc('services/orchestration/handlers/host-actions.ts');

/** Slice the body of a named exported function up to the next top-level export. */
function fnBody(src: string, decl: string): string {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error(`not found: ${decl}`);
  const end = src.indexOf('\nexport ', idx + 1);
  return src.slice(idx, end === -1 ? src.length : end);
}

describe('LCY-1 — normal-operation timers + maybeAutoEndEmptyRound are guarded', () => {
  const transition = fnBody(lifecycle, 'export async function transitionToRound');
  const endRound = fnBody(lifecycle, 'export async function endRound');
  const endRating = fnBody(lifecycle, 'export async function endRatingWindow');
  const autoEnd = fnBody(lifecycle, 'export async function maybeAutoEndEmptyRound');

  it('the round timer fires through the guard-wrapped _timerCallbacks.endRound', () => {
    expect(transition).toMatch(/_timerCallbacks\.endRound\(sessionId, roundNumber\)/);
  });

  it('the 90s rating backstop fires through _timerCallbacks.endRatingWindow', () => {
    expect(endRound).toMatch(/_timerCallbacks\.endRatingWindow\(sessionId, roundNumber\)/);
  });

  it('the CLOSING_LOBBY 10-min safety timer fires through _timerCallbacks.completeSession', () => {
    expect(endRating).toMatch(/_timerCallbacks\.completeSession\(sessionId\)/);
  });

  it('maybeAutoEndEmptyRound self-guards (withSessionGuard) and re-reads status INSIDE', () => {
    expect(autoEnd).toMatch(/withSessionGuard\(sessionId, async \(\) => \{/);
    // the ROUND_ACTIVE check must sit inside the guard wrapper
    const guardIdx = autoEnd.indexOf('withSessionGuard');
    const statusIdx = autoEnd.indexOf('!== SessionStatus.ROUND_ACTIVE');
    expect(statusIdx).toBeGreaterThan(guardIdx);
  });

  it('participant-flow endRatingWindow is injected as the GUARDED timerCallbacks variant', () => {
    expect(orchestration).toMatch(/endRatingWindow:\s*\(sessionId, roundNumber\)\s*=>\s*timerCallbacks\.endRatingWindow\(sessionId, roundNumber\)/);
  });

  it('host-actions endRatingWindow injection stays DIRECT (host already holds the guard)', () => {
    expect(orchestration).toMatch(/endRatingWindow:\s*\(ioServer, sessionId, roundNumber\)\s*=>\s*endRatingWindow\(ioServer, sessionId, roundNumber\)/);
  });

  it('session-state documents the guard-held contract + global lock-ordering rule', () => {
    expect(sessionState).toMatch(/GUARD-HELD CONTRACT/);
    expect(sessionState).toMatch(/GLOBAL LOCK-ORDERING RULE/);
    expect(sessionState).toMatch(/withMatchGenerationLock FIRST \(outer\)/);
  });
});

describe('LCY-2 — handleHostConfirmRound under both locks + regenerate state re-check', () => {
  const confirm = fnBody(matching, 'export async function handleHostConfirmRound');
  const regenerate = fnBody(matching, 'export async function handleHostRegenerateMatches');

  it('confirm acquires withMatchGenerationLock BEFORE withSessionGuard (global order)', () => {
    const genIdx = confirm.indexOf('withMatchGenerationLock(');
    const guardIdx = confirm.indexOf('withSessionGuard(');
    expect(genIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(genIdx);
  });

  it('confirm verifies host BEFORE the lock and AGAIN inside (TOCTOU)', () => {
    const firstVerify = confirm.indexOf('verifyHost(');
    const genIdx = confirm.indexOf('withMatchGenerationLock(');
    const secondVerify = confirm.indexOf('verifyHost(', genIdx);
    expect(firstVerify).toBeGreaterThan(-1);
    expect(firstVerify).toBeLessThan(genIdx);     // pre-lock fast reject
    expect(secondVerify).toBeGreaterThan(genIdx); // re-verify after lock wait
  });

  it('regenerate refuses (INVALID_STATE) when the round already has active/completed rows, before the wipe DELETE', () => {
    const recheckIdx = regenerate.indexOf("m.status === 'active' || m.status === 'completed'");
    const deleteIdx = regenerate.indexOf('DELETE FROM matches');
    expect(recheckIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(recheckIdx); // re-check sits before the wipe
  });
});

describe('LCY-3 — act-after-lock FSM re-checks + idempotent rounds_completed', () => {
  const endRound = fnBody(lifecycle, 'export async function endRound');
  const endRating = fnBody(lifecycle, 'export async function endRatingWindow');

  it('endRound re-checks canTransitionSession after clearCanonicalBreakoutByMatch, before the round_ended broadcast', () => {
    const clearIdx = endRound.indexOf('clearCanonicalBreakoutByMatch');
    const recheckIdx = endRound.indexOf('canTransitionSession', clearIdx);
    const broadcastIdx = endRound.indexOf("emit('session:round_ended'");
    const flipIdx = endRound.indexOf('activeSession.status = SessionStatus.ROUND_RATING');
    expect(recheckIdx).toBeGreaterThan(clearIdx);
    expect(recheckIdx).toBeLessThan(broadcastIdx); // suppresses the duplicate broadcast too
    expect(broadcastIdx).toBeLessThan(flipIdx);
  });

  it('endRound increments rounds_completed at most once per round (roundsCompletedApplied guard)', () => {
    expect(endRound).toMatch(/roundsCompletedApplied/);
    // tier1-a2 pin: exactly ONE textual incrementRoundsCompletedBatch in endRound
    const occurrences = (endRound.match(/incrementRoundsCompletedBatch/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('endRatingWindow skips a stale round (currentRound !== roundNumber)', () => {
    expect(endRating).toMatch(/activeSession\.currentRound !== roundNumber/);
  });

  it('endRatingWindow re-checks ROUND_RATING after the multi-await gap', () => {
    // two ROUND_RATING checks: the FIX-3D entry guard + the LCY-3 act-after-gap
    const occurrences = (endRating.match(/!== SessionStatus\.ROUND_RATING/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('LCY-4 — flip ROUND_ACTIVE only AFTER batch-activation; clean abort', () => {
  const transition = fnBody(lifecycle, 'export async function transitionToRound');

  it('the batch-activate UPDATE precedes the ROUND_ACTIVE status flip (invariant by construction)', () => {
    const activateIdx = transition.indexOf("UPDATE matches SET status = 'active'");
    const flipIdx = transition.indexOf('activeSession.status = SessionStatus.ROUND_ACTIVE');
    expect(activateIdx).toBeGreaterThan(-1);
    expect(flipIdx).toBeGreaterThan(activateIdx);
  });

  it('matches are filtered to startable rows (scheduled/active) so cancelled rows are never resurrected', () => {
    expect(transition).toMatch(/\.filter\(m => m\.status === 'scheduled' \|\| m\.status === 'active'\)/);
  });

  it('aborts cleanly (ROUND_START_FAILED) on zero startable matches / all rooms failed', () => {
    expect(transition).toMatch(/abortRoundStart\(io, activeSession, sessionId, roundNumber\)/);
    expect(lifecycle).toMatch(/function abortRoundStart\(/);
    expect(lifecycle).toMatch(/code: 'ROUND_START_FAILED'/);
    expect(lifecycle).toMatch(/emit\('session:matching_cancelled'/);
  });

  it('transitionToRound returns Promise<boolean> across all five declarations', () => {
    expect(lifecycle).toMatch(/export async function transitionToRound\([\s\S]*?\): Promise<boolean>/);
    expect(timerManager).toMatch(/transitionToRound: \(sessionId: string, roundNumber: number\) => Promise<boolean>/);
    // matching-flow: module-level let + deps type
    expect((matching.match(/transitionToRound[^\n]*Promise<boolean>/g) || []).length).toBeGreaterThanOrEqual(2);
    // host-actions: module-level let + deps type
    expect((hostActions.match(/transitionToRound[^\n]*Promise<boolean>/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('confirm clears pendingRoundNumber only on a true (successful) start', () => {
    const confirm = fnBody(matching, 'export async function handleHostConfirmRound');
    expect(confirm).toMatch(/const started = await _transitionToRound/);
    const startedIdx = confirm.indexOf('const started = await _transitionToRound');
    const clearIdx = confirm.indexOf('activeSession.pendingRoundNumber = null', startedIdx);
    expect(clearIdx).toBeGreaterThan(startedIdx); // clear is gated behind `if (started)`
  });
});
