// ─── June-10 live event — "Skip Ratings" snapped desktop users back into the
// rating form ────────────────────────────────────────────────────────────────
//
// Symptom (Waseem + saif, desktop): host pressed Skip Ratings; everyone was
// pulled to the main room, then desktop users reverted to the rating form a
// moment later. Mobile did not. R3 ended up cancelled and 0 ratings recorded.
//
// Root cause — two layers let a CLOSED rating window re-open on a reconnect:
//   1. Server: the session:join rating REPLAY re-emitted rating:window_open
//      whenever the session was in ROUND_RATING *or* ROUND_TRANSITION *or*
//      CLOSING_LOBBY. But the latter two are precisely the post-close states
//      (Skip Ratings / 90s backstop / all-rated already closed the window).
//      Waseem's multi-tab "Rejoin here" fired a fresh session:join during
//      ROUND_TRANSITION → server replayed the form. Replay is now gated to
//      ROUND_RATING only (the window is genuinely open there).
//   2. Client: the rating:window_open handler set phase='rating' with no
//      lastRatedRound guard (unlike the round_rating-status handler). A late
//      or replayed open for a round whose window already CLOSED for this
//      client must be ignored. roundNumber is absent on the early-leave
//      prompts (still an active round), so those are unaffected.
//
// Both layers are pinned so the revert cannot silently return.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServerSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClientSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

describe('June-10 — Skip Ratings must not re-open a closed rating window', () => {
  describe('Server — reconnect rating replay is gated to an OPEN window', () => {
    const replayDecl = () => {
      const src = readServerSource('services/orchestration/handlers/participant-flow.ts');
      const i = src.indexOf('const ratingReplayStatuses');
      expect(i).toBeGreaterThan(-1);
      // Just the array literal on that declaration line.
      return src.slice(i, src.indexOf('\n', i));
    };

    it('replays only while the window is genuinely OPEN (ROUND_RATING)', () => {
      expect(replayDecl()).toMatch(/SessionStatus\.ROUND_RATING/);
    });

    it('does NOT replay during ROUND_TRANSITION (window already closed)', () => {
      expect(replayDecl()).not.toMatch(/SessionStatus\.ROUND_TRANSITION/);
    });

    it('does NOT replay during CLOSING_LOBBY (window already closed)', () => {
      expect(replayDecl()).not.toMatch(/SessionStatus\.CLOSING_LOBBY/);
    });
  });

  describe('Client — rating:window_open honours a closed round (lastRatedRound)', () => {
    const handler = () => {
      const src = readClientSource('hooks/useSessionSocket.ts');
      const i = src.indexOf("socket.on('rating:window_open'");
      expect(i).toBeGreaterThan(-1);
      const end = src.indexOf("socket.on('rating:window_closed'", i);
      return src.slice(i, end === -1 ? i + 4000 : end);
    };

    it('ignores an open for a round whose window already closed for this client', () => {
      const fn = handler();
      // Guard mirrors the round_rating-status handler: roundNumber present and
      // <= lastRatedRound → the window for that round already closed → bail.
      expect(fn).toMatch(/data\.roundNumber[\s\S]{0,80}lastRatedRound/);
      expect(fn).toMatch(/return;/);
    });
  });
});
