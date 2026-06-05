// ─── Workstream 2 — "Nobody waits alone" (27 May remaining work) ───────────
//
// Agreed spec (docs/superpowers/plans/2026-06-03-27may-remaining-work.md):
// a matching breakout needs ≥2 people; a room dropping below 2 ENDS for
// whoever remains. NO re-pairing — the findIsolatedParticipants auto-reassign
// paths (leave-conversation 5s timeout + disconnect-timeout) are REMOVED.
// The survivor goes rating → main room.
//
// Trigger timing:
//   - "Back to Main Room" button + host pull-back  → IMMEDIATE room end.
//   - Browser close / connection drop / Leave Event → 15s grace (partner sees
//     "waiting for partner…"); return within 15s → room resumes; else ends.
//
// Symmetric rating: rating:window_open gains a `reason` field
// ('partner_no_return' | 'late_return' | 'round_end' | 'early_leave') and the
// client renders copy per reason. emitRatingWindowOnce reports whether it
// emitted so callers can fall back to match:return_to_lobby for an
// already-rated survivor (never strand them in a dead room).
//
// This file pins the new contract. The old reassign contract pinned by
// phase-2-7-2-8-disconnect-and-fallback.test.ts has been re-pointed in the
// same commit (assertions kept, anchors moved to the revised flow).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

const pfSrc = () => readServer('services/orchestration/handlers/participant-flow.ts');
const haSrc = () => readServer('services/orchestration/handlers/host-actions.ts');

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('WS2 — no re-pairing anywhere', () => {
  it('participant-flow.ts no longer references findIsolatedParticipants', () => {
    expect(pfSrc()).not.toMatch(/findIsolatedParticipants/);
  });

  it('handleLeaveConversation has no deferred reassign (no setTimeout, no match:reassigned)', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleLeaveConversation');
    expect(fn).not.toMatch(/match:reassigned/);
    expect(fn).not.toMatch(/setTimeout\(/);
    expect(fn).not.toMatch(/INSERT INTO matches/);
  });

  it('the disconnect grace expiry never INSERTs a new match and never emits bye_round', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    expect(fn).not.toMatch(/INSERT INTO matches/);
    expect(fn).not.toMatch(/match:bye_round/);
    expect(fn).not.toMatch(/match:reassigned/);
  });
});

describe('WS2 — deliberate exits end the room immediately', () => {
  it('handleLeaveConversation pair path ends the room for the survivor inline (no waiting state)', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleLeaveConversation');
    // The survivor flow routes through the shared early-end helper.
    expect(fn).toMatch(/endRoomEarlyForSurvivors\(/);
    // A deliberate exit is not a "waiting for partner" situation.
    expect(fn).not.toMatch(/match:partner_disconnected/);
  });

  it("the leaver's own rating form carries reason 'early_leave'", () => {
    const fn = sliceFn(pfSrc(), 'export async function handleLeaveConversation');
    expect(fn).toMatch(/reason:\s*'early_leave'/);
  });

  it('host pull-back partner return is immediate — the 5s deferred partner flow is gone', () => {
    const fn = sliceFn(haSrc(), 'export async function handleHostRemoveFromRoom');
    expect(fn).not.toMatch(/Server-side 5s timeout/);
    expect(fn).not.toMatch(/setTimeout\([\s\S]*?,\s*5000\)/);
    expect(fn).toMatch(/endRoomEarlyForSurvivors\(/);
    // Pull-back is deliberate — partner goes straight to rating, no waiting banner.
    expect(fn).not.toMatch(/match:partner_disconnected/);
  });
});

describe('WS2 — 15s grace machinery (shared by disconnect + leave-event)', () => {
  it('scheduleMatchEndGrace exists, fires at 15000ms, and registers into disconnectTimeouts', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    expect(fn).toMatch(/setTimeout\([\s\S]*?,\s*15000\)/);
    expect(fn).toMatch(/disconnectTimeouts\.set\(timeoutKey/);
    expect(fn).toMatch(/disconnectTimeouts\.delete\(timeoutKey\)/);
  });

  it('grace expiry keeps the FIX-3C reconnectedAt guard (return within 15s → room resumes)', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    expect(fn).toMatch(/reconnectedAt\s*>\s*disconnectedAt/);
    expect(fn).toMatch(/match:partner_reconnected/);
  });

  it('grace expiry demotes via demoteParticipantFromMatch (trio-aware) instead of an inline terminal UPDATE', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    expect(fn).toMatch(/demoteParticipantFromMatch/);
    expect(fn).not.toMatch(/UPDATE matches SET status = \$2/);
    // The duration/ratings-based terminal decision is preserved as the demote arg.
    expect(fn).toMatch(/Determine terminal status based on actual conversation state/);
  });

  it('grace expiry trio branch keeps survivors talking (participant_left, no rating yet)', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    const trioStart = fn.indexOf('if (matchStillActive)');
    expect(trioStart).toBeGreaterThan(-1);
    const trioEnd = fn.indexOf('return;', trioStart);
    const trioBody = fn.slice(trioStart, trioEnd);
    expect(trioBody).toMatch(/match:participant_left/);
    expect(trioBody).not.toMatch(/endRoomEarlyForSurvivors/);
  });

  it('grace expiry pair branch ends the room for the survivor via the shared helper', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    expect(fn).toMatch(/endRoomEarlyForSurvivors\(/);
    expect(fn).toMatch(/clearCanonicalBreakoutByMatch/);
  });

  it('grace expiry still never auto-LEFTs the disconnected user (M1 21 May contract)', () => {
    const fn = sliceFn(pfSrc(), 'function scheduleMatchEndGrace');
    expect(fn).toMatch(/M1 fix \(21 May Ali\)/);
    expect(fn).not.toMatch(/transitionParticipant\([^)]*ParticipantState\.LEFT/);
    expect(fn).not.toMatch(/maybeRepairFutureRounds\(io,\s*sessionId,\s*'left'\)/);
  });

  it('handleDisconnect match lookup covers trio slot C (pre-fix only A/B were checked)', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleDisconnect');
    const findIdx = fn.indexOf('m.participantAId === userId');
    expect(findIdx).toBeGreaterThan(-1);
    const findBlock = fn.slice(findIdx, findIdx + 200);
    expect(findBlock).toMatch(/m\.participantCId === userId/);
  });

  it('handleDisconnect mid-round path schedules the shared grace (no inline duplicate)', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleDisconnect');
    expect(fn).toMatch(/scheduleMatchEndGrace\(/);
    expect(fn).not.toMatch(/INSERT INTO matches/);
  });

  it('handleDisconnect notifies ALL surviving partners (trio gets the waiting state too)', () => {
    const fn = sliceFn(pfSrc(), 'export async function handleDisconnect');
    expect(fn).toMatch(/for\s*\(const\s+\w+\s+of\s+survivorIds\)[\s\S]{0,200}match:partner_disconnected/);
  });
});

describe('WS2 — survivor early-end helper (room-end-early.ts)', () => {
  const reSrc = () => readServer('services/orchestration/handlers/room-end-early.ts');

  it('exports endRoomEarlyForSurvivors', () => {
    expect(reSrc()).toMatch(/export async function endRoomEarlyForSurvivors/);
  });

  it("cancelled (<30s) rooms are not ratable — survivors return to main with NO rating form", () => {
    // A 15-second aborted room is not a real conversation: prompting a
    // rating is noise and the ratings service only accepts cancelled-match
    // ratings within a 30s grace anyway. The grace expiry passes
    // ratable=false and the helper short-circuits to match:return_to_lobby.
    const src = reSrc();
    expect(src).toMatch(/ratable: boolean/);
    const nrIdx = src.indexOf('if (!ratable)');
    expect(nrIdx).toBeGreaterThan(-1);
    const nrBlock = src.slice(nrIdx, src.indexOf('return;', nrIdx));
    expect(nrBlock).toMatch(/match:return_to_lobby/);
    expect(nrBlock).not.toMatch(/emitRatingWindowOnce/);
    // The grace expiry derives ratability from the terminal status.
    const pf = pfSrc();
    expect(pf).toMatch(/terminalStatus === 'completed',?\s*\n?\s*\)/);
  });

  it("opens the survivor's rating window with reason 'partner_no_return' via the dedup helper", () => {
    expect(reSrc()).toMatch(/emitRatingWindowOnce/);
    expect(reSrc()).toMatch(/'partner_no_return'/);
  });

  it('falls back to match:return_to_lobby when the rating window is dedup-skipped (never strand the survivor)', () => {
    expect(reSrc()).toMatch(/match:return_to_lobby/);
  });

  it('returns the survivor to IN_LOBBY status', () => {
    expect(reSrc()).toMatch(/ParticipantStatus\.IN_LOBBY/);
  });

  it('emitRatingWindowOnce reports whether it actually emitted (boolean) so the fallback can fire', () => {
    const stateSrc = readServer('services/orchestration/state/session-state.ts');
    const fnStart = stateSrc.indexOf('export async function emitRatingWindowOnce');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = stateSrc.slice(fnStart, stateSrc.indexOf('\nexport', fnStart + 1));
    expect(fn).toMatch(/Promise<boolean>/);
    expect(fn).toMatch(/return false/);
    expect(fn).toMatch(/return true/);
  });
});

describe('WS2 — rating reason rides the wire', () => {
  it("shared rating:window_open payload declares the reason union", () => {
    const evSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../shared/src/types/events.ts'), 'utf8',
    );
    const line = evSrc.slice(evSrc.indexOf("'rating:window_open'"), evSrc.indexOf("'rating:window_closed'"));
    expect(line).toMatch(/reason\?:/);
    expect(line).toMatch(/'partner_no_return'/);
    expect(line).toMatch(/'late_return'/);
    expect(line).toMatch(/'round_end'/);
    expect(line).toMatch(/'early_leave'/);
  });

  it('shared events declare match:participant_left (emitted since Phase 3 but never typed)', () => {
    const evSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../shared/src/types/events.ts'), 'utf8',
    );
    expect(evSrc).toMatch(/'match:participant_left':/);
  });

  it("round-end bulk emit tags reason 'round_end'", () => {
    const rlSrc = readServer('services/orchestration/handlers/round-lifecycle.ts');
    const emitIdx = rlSrc.indexOf("emit('rating:window_open'");
    expect(emitIdx).toBeGreaterThan(-1);
    expect(rlSrc.slice(emitIdx, emitIdx + 600)).toMatch(/reason:\s*'round_end'/);
  });

  it("rejoin replay during rating phase tags reason 'round_end'", () => {
    const src = pfSrc();
    const replayIdx = src.indexOf('ratingReplayStatuses');
    const emitIdx = src.indexOf("emit('rating:window_open'", replayIdx);
    expect(emitIdx).toBeGreaterThan(replayIdx);
    expect(src.slice(emitIdx, emitIdx + 600)).toMatch(/reason:\s*'round_end'/);
  });
});

describe('WS2 — late returner gets the form on rejoin', () => {
  it("ROUND_ACTIVE rejoin with no active match replays an unrated early-ended match as 'late_return'", () => {
    const fn = sliceFn(pfSrc(), 'export async function handleJoinSession');
    expect(fn).toMatch(/'late_return'/);
    // Dedup + skip guards must gate the late replay like the rating-phase replay.
    const lateIdx = fn.indexOf("'late_return'");
    const windowBack = fn.slice(Math.max(0, lateIdx - 2500), lateIdx);
    expect(windowBack).toMatch(/ratingSkips/);
  });
});
