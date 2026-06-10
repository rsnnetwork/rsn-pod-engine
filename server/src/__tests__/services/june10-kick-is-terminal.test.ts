// ─── June-10 live event — a kicked user reverted back into the main room ──────
//
// Symptom (Haseem/Waseem): host kicked them; they saw the recap ("you have been
// kicked") plus a "connected from another device — reconnect here" toast, then
// within ~5s reverted back into the MAIN ROOM. Their socket/LiveKit pulled them
// back in — they weren't really gone.
//
// Root cause: "removed" was not TERMINAL on the client.
//   - host:participant_removed set phase='complete' (recap) but no sticky flag,
//     so a later event could move phase back to 'lobby'.
//   - The server's removed-user rejoin bounce emitted a BARE session:evicted,
//     which the client treats as a duplicate-tab eviction → phase='lobby' +
//     "reconnect here". That remounts <LiveKitRoom> and re-joins the main room
//     with the still-valid LiveKit token (eviction does not revoke the token).
//
// Fix (kicked == out, terminally, recap only; re-entry only via a fresh invite):
//   1. Server tags the removed-user rejoin bounce: session:evicted carries
//      reason 'removed_from_event'.
//   2. Client store gains a sticky `removedFromEvent`; setPhase is LOCKED to
//      'complete' once it is set — nothing can move a kicked user back to the
//      lobby/main room.
//   3. host:participant_removed sets removedFromEvent + drops the LiveKit token;
//      session:evicted with reason 'removed_from_event' (or the sticky flag) is
//      terminal recap, never the "reconnect here" lobby path.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServerSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClientSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

describe('June-10 — a kicked user is terminally removed (no revert to main room)', () => {
  describe('Server — the removed-user rejoin bounce is tagged terminal', () => {
    const flow = () => readServerSource('services/orchestration/handlers/participant-flow.ts');
    it('emits session:evicted with reason removed_from_event on a removed rejoin', () => {
      const src = flow();
      const i = src.indexOf("regErr?.code === 'REMOVED_FROM_EVENT'");
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 700);
      expect(block).toMatch(/session:evicted'[\s\S]{0,120}reason:\s*'removed_from_event'/);
    });
  });

  describe('Client store — removedFromEvent is sticky and locks the phase', () => {
    const store = () => readClientSource('stores/sessionStore.ts');
    it('declares a removedFromEvent flag + setter', () => {
      const src = store();
      expect(src).toMatch(/removedFromEvent:\s*boolean/);
      expect(src).toMatch(/setRemovedFromEvent:/);
    });
    it('setPhase refuses to leave complete once removedFromEvent is set', () => {
      const src = store();
      const i = src.indexOf('setPhase: (phase)');
      expect(i).toBeGreaterThan(-1);
      const line = src.slice(i, src.indexOf('\n', i));
      expect(line).toMatch(/removedFromEvent/);
      expect(line).toMatch(/'complete'/);
    });
  });

  describe('Client socket — kick is terminal; evicted honours the terminal state', () => {
    const sock = () => readClientSource('hooks/useSessionSocket.ts');
    it('host:participant_removed sets the sticky flag and drops the LiveKit token', () => {
      const src = sock();
      const i = src.indexOf("socket.on('host:participant_removed'");
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 800);
      expect(block).toMatch(/setRemovedFromEvent\(true\)/);
      expect(block).toMatch(/setLiveKitToken\(null/);
      expect(block).toMatch(/setPhase\('complete'\)/);
    });
    it('session:evicted is terminal recap for a removed user, not the lobby path', () => {
      const src = sock();
      const i = src.indexOf("socket.on('session:evicted'");
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, i + 900);
      expect(block).toMatch(/removed_from_event|removedFromEvent/);
      expect(block).toMatch(/setPhase\('complete'\)/);
    });
  });
});
