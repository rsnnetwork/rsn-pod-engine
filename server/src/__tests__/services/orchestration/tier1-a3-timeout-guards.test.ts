// Tier-1 A3 — session-end guards on deferred callbacks
//
// Every setTimeout in the orchestration handlers captures `io`,
// `activeSession`, participant arrays, and imported configs in its
// closure. If a host ends the session during the delay, the callback
// still fires and operates on stale data — emitting to disconnected
// sockets, touching DB rows whose parent session is gone, etc.
//
// The fix pattern is minimal and surgical: first line of every deferred
// async callback is an `activeSessions.get(sessionId)` check with an
// early return on miss. Timer-manager's managed timer and the existing
// `disconnectTimeouts` registry already handle their own lifecycles —
// this test covers the one-off setTimeouts that don't.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../services/orchestration/handlers', relPath),
    'utf8',
  );
}

describe('Tier-1 A3 — deferred-callback session-end guards', () => {
  describe('host-actions.ts host-remove partner-return', () => {
    const src = readSource('host-actions.ts');

    it('WS2 — the partner-return is now inline (the deferred 5s flow this guard protected is gone)', () => {
      // Pre-WS2 a "Server-side 5s timeout" deferred the partner's rating and
      // needed an activeSessions guard against the session ending mid-delay.
      // WS2 made host pull-back an IMMEDIATE room end (survivor → rating →
      // main inside the handler itself), so there is no deferred callback
      // left to guard. Pin the removal so the unguarded-timeout pattern
      // can't silently come back.
      expect(src).not.toMatch(/Server-side 5s timeout/);
      const fnStart = src.indexOf('export async function handleHostRemoveFromRoom');
      expect(fnStart).toBeGreaterThan(-1);
      const fn = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 1));
      expect(fn).not.toMatch(/setTimeout\([\s\S]*?,\s*5000\)/);
      expect(fn).toMatch(/endRoomEarlyForSurvivors\(/);
    });
  });

  describe('other orchestration deferred callbacks are already guarded', () => {
    it('host-actions host:create_breakout setTimeout guards session + ROUND_ACTIVE status', () => {
      const src = readSource('host-actions.ts');
      // This is the host:create_breakout re-matching after 5 s delay.
      expect(src).toMatch(/setTimeout\(async \(\) => \{[\s\S]{0,300}?const s = activeSessions\.get\(sessionId\)/);
      expect(src).toMatch(/if \(!s \|\| s\.status !== SessionStatus\.ROUND_ACTIVE\)/);
    });

    it('participant-flow match-end grace setTimeout guards on currentSession (was: auto-reassign 5s)', () => {
      // WS2 — the 5s auto-reassign timer is gone; the surviving deferred
      // callback is the shared 15s match-end grace, which must keep the
      // same session-ended guard pattern.
      const src = readSource('participant-flow.ts');
      expect(src).toMatch(/setTimeout\(async \(\) => \{[\s\S]{0,200}?const currentSession = activeSessions\.get\(sessionId\)/);
      // One of these guard blocks must early-return on null
      expect(src).toMatch(/if \(!currentSession\) return/);
    });

    it('participant-flow disconnect 15s setTimeout registers into disconnectTimeouts for cancellation', () => {
      const src = readSource('participant-flow.ts');
      // Has its own registry — cleared from disconnectTimeouts at the top
      // of the callback + on reconnect.
      expect(src).toMatch(/disconnectTimeouts\.delete\(timeoutKey\)/);
    });

    it('round-lifecycle detectNoShows guards on activeSession.status === ROUND_ACTIVE', () => {
      const src = readSource('round-lifecycle.ts');
      // The noShowTimeout schedules detectNoShows, which itself guards.
      expect(src).toMatch(/export async function detectNoShows\([\s\S]{0,200}?const activeSession = activeSessions\.get\(sessionId\)/);
      expect(src).toMatch(/if \(!activeSession \|\| activeSession\.status !== SessionStatus\.ROUND_ACTIVE\) return/);
    });
  });
});
