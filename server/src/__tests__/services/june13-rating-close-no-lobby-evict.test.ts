// ─── June-13 (Stefan's event #2b) — rating-close sweep must not evict from lobby
//
// endRatingWindow runs a "clear stale breakout connections" sweep that evicts
// each present socket from their roomParticipants room. roomParticipants races
// to the LOBBY the instant a user (re)joins the main room on the status-change
// resync, so a fast returner could be evicted from the lobby they'd JUST landed
// in — UI shows the main room but they're in NO LiveKit room (no video). This
// is INTERMITTENT (a race), reproduced live: after a round, the partner
// leaves+rejoins during rating, and the participant who STAYED sometimes ends in
// no room while the rejoiner lands fine. The sweep now skips the lobby room.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

const read = (rel: string) => nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');

describe('June-13 — endRatingWindow eviction sweep never targets the lobby', () => {
  const src = read('services/orchestration/handlers/round-lifecycle.ts');

  it('guards the evictFromRoom sweep to BREAKOUT rooms only (skips lobbyRoomId)', () => {
    const i = src.indexOf('const rp = activeSession.roomParticipants?.get(uid)');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 900);
    // The eviction must be conditional on the room NOT being the lobby.
    expect(block).toMatch(/rp\?\.roomId\s*&&\s*rp\.roomId\s*!==\s*session\.lobbyRoomId/);
    expect(block).toMatch(/evictFromRoom\(uid, rp\.roomId\)/);
    // The old unconditional evict is gone.
    expect(block).not.toMatch(/if \(rp\?\.roomId\) await videoService\.evictFromRoom/);
  });
});
