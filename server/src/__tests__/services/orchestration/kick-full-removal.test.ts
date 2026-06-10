// #4 (June-10 debrief) — a kick must remove the participant EVERYWHERE, not just
// from matching. TESTEVENT (c624b66a): "Stefan Avivson @ JACK" was status=removed
// but the kick path made zero LiveKit eviction calls, so his camera/mic kept
// flowing in the room. This pins the eviction + room-tracking cleanup in the
// host-remove handler (Ship A: the eject core).
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const serverSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');

describe('#4 Ship A — kick fully removes a participant from the SFU', () => {
  const hostActions = serverSrc('services/orchestration/handlers/host-actions.ts');
  const start = hostActions.indexOf('export async function handleHostRemoveParticipant(');
  const fn = hostActions.slice(start, hostActions.indexOf('\nexport ', start + 1));

  it('the kick handler evicts the user from LiveKit (the missing piece)', () => {
    expect(fn).toMatch(/evictFromRoom\(/);
  });

  it('it evicts from the lobby/main room', () => {
    expect(fn).toMatch(/lobbyRoomId\(/);
  });

  it('it evicts from the active breakout room too (room_id captured from the kicked match)', () => {
    // room_id must be selected from the kicked match so we can evict the breakout.
    expect(fn).toMatch(/room_id/);
  });

  it('it clears the in-memory room-participant tracking so the host dashboard stops showing them connected', () => {
    expect(fn).toMatch(/roomParticipants[?]?\.delete\(/);
  });

  it('it still marks the participant removed in the DB (unregistered + barred from self re-entry)', () => {
    expect(fn).toMatch(/ParticipantStatus\.REMOVED/);
  });
});
