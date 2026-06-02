// #16 (24 May 2026, pre-event hardening) — the matcher must include everyone
// who is VISIBLY in the main room, even after rounds 2/3/4 and even if their
// control socket blipped (backgrounded tab, phone call, screen lock).
//
// Root cause: matcher eligibility reads DB status driven by the 15s socket
// heartbeat, which the OS throttles/suspends in the background. The authoritative
// "who is visibly here" signal is LiveKit's own room roster (the video
// connection that renders the host's tiles), which survives backgrounding.
//
// Fix 1 (server): handleHostGenerateMatches reconciles the LiveKit main-room
//   roster into the present-user set before clearing stale 'disconnected'.
//   Fail-open (own try/catch + timeout) so a LiveKit error never blocks matching.
// Fix 2 (client): on return to foreground (visibilitychange/focus/online) the
//   client re-emits session:join so the server re-registers them immediately.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}
function fnSlice(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  return src.slice(start, src.indexOf('\nexport ', start + 1));
}

describe('#16 — matcher includes everyone visibly in the main room (LiveKit roster reconcile)', () => {
  const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');
  const genFn = fnSlice(flowSrc, 'export async function handleHostGenerateMatches');

  it('reconciles the LiveKit main-room roster into the present set before matching', () => {
    expect(genFn).toMatch(/listParticipants/);
    expect(genFn).toMatch(/lobbyRoomId/);
    // roster userIds feed the same present set that clears stale 'disconnected'
    expect(genFn).toMatch(/presentUserIds\.add\(p\.userId\)/);
  });

  it('the LiveKit roster query is fail-open — own try/catch + timeout, never blocks matching', () => {
    // A LiveKit failure must not abort the existing socket/heartbeat reconcile.
    expect(genFn).toMatch(/listParticipants[\s\S]{0,500}catch/);
    expect(genFn).toMatch(/Promise\.race|timeout/i);
  });

  it('#5 — recap returns is_manual and renders a separate Manual rooms section', () => {
    const ratingSrc = readServer('services/rating/rating.service.ts');
    expect(ratingSrc).toMatch(/is_manual[\s\S]{0,30}AS "isManual"/);
    const sharedSrc = nodeFs.readFileSync(nodePath.join(__dirname, '../../../../shared/src/types/match.ts'), 'utf8');
    expect(sharedSrc).toMatch(/isManual: boolean/);
    const sc = readClient('features/live/SessionComplete.tsx');
    const rp = readClient('features/sessions/RecapPage.tsx');
    expect(sc).toMatch(/Manual rooms/);
    expect(sc).toMatch(/c\.isManual/);
    expect(rp).toMatch(/Manual rooms/);
    expect(rp).toMatch(/c\.isManual/);
  });

  it('client re-registers presence on return to foreground (visibilitychange / focus / online)', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    expect(src).toMatch(/resyncPresenceOnReturn/);
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/addEventListener\(\s*['"]focus['"]/);
    expect(src).toMatch(/addEventListener\(\s*['"]online['"]/);
    // 24 May (#2/#6 fix) — the foreground resync must be heartbeat-ONLY: it must
    // NOT emit session:join (which re-runs handleJoinSession's in_round→main
    // reset + rating-replay, the cause of "Saif in two places" + skip re-prompt).
    const i = src.indexOf('resyncPresenceOnReturn =');
    // 25 May (A) — on return the client RE-REGISTERS via session:join so a
    // dropped user is matchable again (revert of the heartbeat-only attempt that
    // left present people unmatched). Safe: skips recorded (#6) + active-match guard (#B).
    expect(src.slice(i, i + 1000)).toMatch(/emit\(\s*['"]session:join/);
  });
});
