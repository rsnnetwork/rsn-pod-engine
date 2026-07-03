// 3 Jul live test (Stefan "THE TEST") — a reconnecting participant showed up
// in TWO rooms at once: their tile appeared in the main room AND a breakout.
// The LiveKit sweep DETECTED this ("participant in unexpected room") but was
// observability-only — nothing cleared the stale membership.
//
// Server safety net (this file): the sweep now REMOVES a participant from a
// breakout room that is NOT their canonical room, enforcing one-active-room.
// CRITICAL SAFETY: it NEVER removes from the lobby room — a fast returner
// races the lobby at round-end and evicting them there is the 13-Jun / 14-Jun
// "no video after round" bug. The lobby-lingering case (Ali's own: canonical
// breakout, stale tile in main) is fixed client-side (leave old room before
// joining new).
import { SessionStatus } from '@rsn/shared';

const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _t: number, v: string) => { store.set(k, v); return 'OK'; }),
};
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => fakeRedis }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const evictFromRoom = jest.fn(async (_userId: string, _roomId: string) => {});
jest.mock('../../../services/video/video.service', () => ({
  evictFromRoom: (userId: string, roomId: string) => evictFromRoom(userId, roomId),
  __esModule: true,
}));

import { writeCanonical } from '../../../services/orchestration/state/canonical-state';
import { reconcileRoomRoster } from '../../../services/orchestration/state/livekit-sweep';

const LOBBY = 'lobby-s1';
const doc = (participants: any) => ({
  sessionId: 's1', status: SessionStatus.ROUND_ACTIVE, currentRound: 1, seq: 10,
  hostUserId: 'h', timer: null, participants,
});
const breakout = (roomId: string, matchId: string) => ({
  role: 'participant', connState: 'connected',
  location: { type: 'breakout', roomId, matchId }, lastSeenAt: 1, userSeq: 1,
});
const main = () => ({
  role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 1,
});

beforeEach(() => { store.clear(); evictFromRoom.mockClear(); });

describe('reconcileRoomRoster — one-active-room enforcement', () => {
  it('removes a participant lingering in a STALE breakout (not their canonical room)', async () => {
    // u1 canonical = main, but LiveKit still lists them in an old breakout room.
    await writeCanonical(doc({ u1: main() }) as any);
    await reconcileRoomRoster('s1', 'bk-old', [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).toHaveBeenCalledWith('u1', 'bk-old');
  });

  it('removes from a breakout that is not the one they are canonically in', async () => {
    // u1 canonical = breakout bk-new, but still lingering in bk-old.
    await writeCanonical(doc({ u1: breakout('bk-new', 'm-new') }) as any);
    await reconcileRoomRoster('s1', 'bk-old', [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).toHaveBeenCalledWith('u1', 'bk-old');
  });

  it('removes from the lobby DURING AN ACTIVE ROUND when canonical is a breakout (Ali dual-tile)', async () => {
    // Ali's exact case: mid round-1 he was canonically in a breakout but his
    // stale lobby membership left his tile visible in the main room. During an
    // active round he has no business in the lobby → safe to clear it there.
    await writeCanonical({ ...doc({ u1: breakout('bk-x', 'm-x') }), status: SessionStatus.ROUND_ACTIVE } as any);
    await reconcileRoomRoster('s1', LOBBY, [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).toHaveBeenCalledWith('u1', LOBBY);
  });

  it('does NOT remove from the lobby during ROUND_TRANSITION even if canonical still says breakout (13-Jun returner race)', async () => {
    // At round-end returners legitimately land in the lobby while a late
    // heartbeat may still read breakout — evicting them there is the 13-Jun bug.
    await writeCanonical({ ...doc({ u1: breakout('bk-x', 'm-x') }), status: SessionStatus.ROUND_TRANSITION } as any);
    await reconcileRoomRoster('s1', LOBBY, [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).not.toHaveBeenCalled();
  });

  it('does not remove a participant who IS in their canonical breakout', async () => {
    await writeCanonical(doc({ u1: breakout('bk-x', 'm-x') }) as any);
    await reconcileRoomRoster('s1', 'bk-x', [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).not.toHaveBeenCalled();
  });

  it('does not remove a participant who IS in the lobby and belongs in main', async () => {
    await writeCanonical(doc({ u1: main() }) as any);
    await reconcileRoomRoster('s1', LOBBY, [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).not.toHaveBeenCalled();
  });

  it('never removes a kicked (removed) participant via the sweep', async () => {
    await writeCanonical(doc({ u1: { ...main(), connState: 'removed' } }) as any);
    await reconcileRoomRoster('s1', 'bk-old', [{ userId: 'u1' }], LOBBY);
    expect(evictFromRoom).not.toHaveBeenCalled();
  });
});
