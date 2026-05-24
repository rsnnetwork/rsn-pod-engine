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

  it('client re-registers presence on return to foreground (visibilitychange / focus / online)', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    expect(src).toMatch(/resyncPresenceOnReturn/);
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/addEventListener\(\s*['"]focus['"]/);
    expect(src).toMatch(/addEventListener\(\s*['"]online['"]/);
    // re-registers via the same session:join the reconnect handler uses
    const i = src.indexOf('resyncPresenceOnReturn =');
    expect(src.slice(i, i + 400)).toMatch(/session:join/);
  });
});
