// ─── Workstream 2 — Leave Event mid-round gets the 15s partner grace ───────
//
// Pre-fix: handleLeaveSession set the leaver to LEFT immediately and never
// touched their active match — the partner sat orphaned in a dead breakout
// until something else (round end, manual leave) rescued them.
//
// New contract (agreed spec): "Leave event" behaves like a connection drop
// for the PARTNER's sake — partner sees "waiting for partner…" for 15s;
// if the leaver rejoins within the grace the room resumes (the rejoin path
// cancels the timeout via disconnectTimeouts + reconnectedAt guard); else
// the room ends for the survivor (rating → main, no re-pairing).
//
// The leaver themselves still goes LEFT immediately (Phase A1 contract,
// pinned by phase-a-state-sync-architecture.test.ts) — the grace is about
// the match, not the leaver's roster status.

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

describe('WS2 — Leave Event mid-round grace', () => {
  const src = () => readServer('services/orchestration/handlers/participant-flow.ts');

  it('handleLeaveSession schedules the shared 15s match-end grace when mid-round', () => {
    const fn = sliceFn(src(), 'export async function handleLeaveSession');
    expect(fn).toMatch(/scheduleMatchEndGrace\(/);
    expect(fn).toMatch(/SessionStatus\.ROUND_ACTIVE/);
  });

  it('handleLeaveSession notifies the partner(s) so the client shows the waiting state', () => {
    const fn = sliceFn(src(), 'export async function handleLeaveSession');
    expect(fn).toMatch(/match:partner_disconnected/);
  });

  it('handleLeaveSession still marks the leaver LEFT immediately (Phase A1 contract intact)', () => {
    const fn = sliceFn(src(), 'export async function handleLeaveSession');
    expect(fn).toMatch(/ParticipantStatus\.LEFT/);
    expect(fn).toMatch(/maybeRepairFutureRounds\(io,\s*data\.sessionId,\s*'left'\)/);
  });

  it('handleLeaveSession match lookup covers all three slots (trio leave-event)', () => {
    const fn = sliceFn(src(), 'export async function handleLeaveSession');
    expect(fn).toMatch(/participant_c_id\s*=\s*\$2/);
  });

  it('the grace path does NOT clear canonical breakout location before the timeout decides (resume must work)', () => {
    const fn = sliceFn(src(), 'export async function handleLeaveSession');
    expect(fn).not.toMatch(/clearCanonicalBreakoutByMatch/);
    expect(fn).not.toMatch(/clearCanonicalLocationToMain/);
  });
});
