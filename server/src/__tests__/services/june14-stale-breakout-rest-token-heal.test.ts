// ─── June-14 — stale-breakout heal on the REST /token rail ───────────────────
//
// Stefan + Ali live test: after a round ends (timer OR host/co-host Skip
// Ratings), participants could be left stuck connecting to the round's now-DEAD
// breakout room — UI shows the main room but they are in NO live room, refresh
// does not fix it, and the browser console shows `invalid token: revoked`.
//
// Root cause: generateLiveKitToken (the REST /token fallback the client's
// VideoRoom uses to re-mint a token) authorised a requested breakout `roomId`
// by MEMBERSHIP only — never checking the match was still ACTIVE. When a round
// ends the match is set 'completed' and LiveKit auto-deletes the empty room, so
// a token minted for that dead room walked the client into a deleted room →
// revoked → retry → (multi-tab) 429 storm → stranded. The June-13 handleResync
// heal covered the SOCKET rail; the REST rail was missed.
//
// And the host/cohost branch granted ANY room in the session unconditionally —
// so a CO-HOST (Ali made Waseem a co-host before the final round) got a token
// for their own dead breakout too. The fix gates EVERY breakout grant on an
// active match and falls back to the lobby otherwise — for members AND
// host/cohosts alike.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function sliceFn(src: string, marker: string): string {
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  const end = src.indexOf('\nexport ', i + 1);
  return src.slice(i, end === -1 ? i + 6000 : end);
}

describe('June-14 — REST /token never mints a token for a dead breakout', () => {
  const svc = () => readServer('services/session/session.service.ts');

  it('generateLiveKitToken gates a breakout grant on the match being ACTIVE', () => {
    const fn = sliceFn(svc(), 'export async function generateLiveKitToken');
    // An active-match lookup guards the breakout branch.
    expect(fn).toMatch(/FROM matches WHERE session_id = \$1 AND room_id = \$2 AND status = 'active'/);
    // No active match → fall back to lobby (the heal), logged for observability.
    expect(fn).toMatch(/stale-breakout heal/);
    expect(fn).toMatch(/activeMatch\.rows\.length === 0/);
  });

  it('the active-match gate wraps BOTH the host/cohost and the member branch', () => {
    const fn = sliceFn(svc(), 'export async function generateLiveKitToken');
    const activeIdx = fn.indexOf("status = 'active'");
    const hostBranchIdx = fn.indexOf('isHostOrCohost');
    const memberBranchIdx = fn.indexOf('memberOfRoom');
    expect(activeIdx).toBeGreaterThan(-1);
    expect(hostBranchIdx).toBeGreaterThan(-1);
    expect(memberBranchIdx).toBeGreaterThan(-1);
    // The active-match check runs BEFORE (and therefore guards) both the
    // host/cohost unconditional grant and the member-of-room grant — a co-host's
    // own stale breakout is just as dead as a participant's.
    expect(activeIdx).toBeLessThan(hostBranchIdx);
    expect(activeIdx).toBeLessThan(memberBranchIdx);
  });

  it('still defaults to the lobby room and keeps the removed-member gate', () => {
    const fn = sliceFn(svc(), 'export async function generateLiveKitToken');
    // Default grant remains the lobby; security/membership checks are intact.
    expect(fn).toMatch(/let roomName = lobbyRoomName/);
    expect(fn).toMatch(/status !== 'removed'/);
    expect(fn).toMatch(/ForbiddenError\('User is not a participant in this event'\)/);
  });
});
