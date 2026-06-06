// ─── S19 — ending the EVENT is the director's call alone (Ali, 6 Jun) ──────
//
// In live-test b1 a CO-HOST's end action completed the event: recap emails
// went out and participants hit the recap page mid-test. Product rule:
//   - the event ends (recap page + recap emails) ONLY when the director
//     ends it (platform super_admin keeps an emergency override);
//   - co-hosts may still start/end ROUNDS — those paths never complete
//     the session;
//   - co-hosts see the End Event button DISABLED with "Only the host can
//     end the event".

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S19 — server: handleHostEnd director gate', () => {
  const fn = () => sliceFn(readServer('services/orchestration/handlers/host-actions.ts'), 'export async function handleHostEnd');

  it('computes wouldCompleteEvent = endEvent OR the fall-through completion path', () => {
    expect(fn()).toMatch(/wouldCompleteEvent = !!data\.endEvent\s*\n\s*\|\| !\(activeSession && \(activeSession\.status === SessionStatus\.ROUND_ACTIVE/);
  });

  it('refuses non-director completion with a distinct DIRECTOR_ONLY error', () => {
    expect(fn()).toMatch(/if \(wouldCompleteEvent && !isDirector && !isSuperAdmin\)/);
    expect(fn()).toMatch(/code: 'DIRECTOR_ONLY', message: 'Only the host can end the event'/);
  });

  it('director check resolves from the active session, falling back to the DB row', () => {
    expect(fn()).toMatch(/activeSession\?\.hostUserId/);
    expect(fn()).toMatch(/SELECT host_user_id FROM sessions WHERE id = \$1/);
  });

  it('the gate sits AFTER verifyHost (co-hosts still pass for round-only paths)', () => {
    const f = fn();
    const verifyIdx = f.indexOf('verifyHost(socket, data.sessionId)');
    const gateIdx = f.indexOf('wouldCompleteEvent');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(verifyIdx);
    // And BEFORE the ROUND_ACTIVE branch, so endEvent:true is gated there too.
    const roundActiveIdx = f.indexOf('activeSession.status === SessionStatus.ROUND_ACTIVE) {');
    expect(gateIdx).toBeLessThan(roundActiveIdx);
  });
});

describe('S19 — client: End Event disabled for non-directors', () => {
  const src = () => readClient('features/live/HostControls.tsx');

  it('isDirector compares the auth user to the session hostUserId', () => {
    expect(src()).toMatch(/isDirector = !!user\?\.id && user\.id === directorUserId/);
  });

  it('the End Event button is disabled for non-directors with the why', () => {
    const s = src();
    const idx = s.indexOf('End Event\n');
    const block = s.slice(Math.max(0, idx - 700), idx);
    expect(block).toMatch(/onClick=\{endEvent\}/);
    expect(block).toMatch(/disabled=\{!isDirector\}/);
    expect(block).toMatch(/Only the host can end the event/);
  });
});
