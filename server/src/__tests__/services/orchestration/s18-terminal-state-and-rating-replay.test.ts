// ─── S18 — half-ended event + lost trio rating form (live-test 2026-06-06,
// event b1) ──────────────────────────────────────────────────────────────────
//
// Render log, 14:35:14 UTC (3 s after End Event wrote ended_at + sent the
// recap emails): {"from":"completed","to":"round_rating","msg":"Invalid
// session status transition — allowing as safety fallback"}. An in-flight
// round-end (participant left → empty round → endRound) re-broadcast
// round_rating over the COMPLETED event: Ali Hamzaa was on the recap page
// while waseem sat stranded in the main room with a recap email in his inbox.
//
// Two locks now close it:
//   1. updateSessionStatus REFUSES any transition out of a terminal state
//      (completed/cancelled) — DB layer.
//   2. completeSession flips the IN-MEMORY status to COMPLETED before its
//      first await, so endRound's C2 guard (canTransitionSession) refuses
//      during the 2–5 s LiveKit-cleanup window where the activeSessions
//      entry still exists.
//
// Plus the third member of the S14 slot-only family: the rating-phase
// reconnect REPLAY rebuilt partners from the slots (no departed union) and
// bailed if ANY rating existed — a socket blip during the window overwrote a
// trio survivor's 2-partner form with a 1-partner one (saif got 1 form, the
// others got 2). Partners now union departed_user_ids and filter to the
// still-unrated edges.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S18 — terminal session states are terminal', () => {
  it('updateSessionStatus refuses transitions out of completed/cancelled', () => {
    const fn = sliceFn(readServer('services/session/session.service.ts'), 'export async function updateSessionStatus');
    expect(fn).toMatch(/TERMINAL = \[SessionStatus\.COMPLETED, SessionStatus\.CANCELLED\]/);
    expect(fn).toMatch(/Refused status transition out of a terminal session state/);
    // The refusal RETURNS (row untouched) instead of falling through to the
    // lax "allow as safety fallback" branch.
    const refuseIdx = fn.indexOf('Refused status transition');
    const returnIdx = fn.indexOf('return getSessionById(sessionId)', refuseIdx);
    const fallbackIdx = fn.indexOf('allowing as safety fallback');
    expect(returnIdx).toBeGreaterThan(refuseIdx);
    expect(returnIdx).toBeLessThan(fallbackIdx);
  });

  it('completeSession flips the in-memory status BEFORE its first await', () => {
    const fn = sliceFn(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function completeSession');
    const flipIdx = fn.indexOf('activeSession.status = SessionStatus.COMPLETED');
    expect(flipIdx).toBeGreaterThan(-1);
    // The flip happens before the try block (i.e. before any awaited work).
    const tryIdx = fn.indexOf('try {');
    expect(flipIdx).toBeLessThan(tryIdx);
    // And before the first await in the function body.
    const firstAwait = fn.indexOf('await ');
    expect(flipIdx).toBeLessThan(firstAwait);
  });

  it('endRound still C2-guards on canTransitionSession (refuses from COMPLETED)', () => {
    const fn = sliceFn(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function endRound');
    expect(fn).toMatch(/canTransitionSession\(activeSession\.status, SessionStatus\.ROUND_RATING\)/);
  });
});

describe('S18 — rating-phase reconnect replay (the third slot-only site)', () => {
  const replayBlock = () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');
    const i = src.indexOf('const ratingReplayStatuses');
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + 4000);
  };

  it('partner list unions departed_user_ids (not slots only)', () => {
    expect(replayBlock()).toMatch(/userMatch\.departedUserIds \?\? \[\]/);
  });

  it('filters to UNRATED edges instead of bailing on any existing rating', () => {
    const block = replayBlock();
    expect(block).toMatch(/SELECT to_user_id FROM ratings WHERE match_id = \$1 AND from_user_id = \$2/);
    expect(block).toMatch(/!ratedTo\.has\(id\)/);
    expect(block).toMatch(/partnerIds\.length > 0 && !skipped/);
    // The old "any rating exists → no replay" guard is gone.
    expect(block).not.toMatch(/existingRating/);
  });
});
