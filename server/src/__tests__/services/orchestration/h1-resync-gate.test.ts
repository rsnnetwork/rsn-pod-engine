// ─── A resync answers only someone the event admits (H1, fix round 1) ────────────────────────────────
//
// session:resync answered any signed-in socket that named an event with its live roster (state:snapshot:
// names, roles, presence, status, round and timer). It now answers only a socket the event admits (the same
// check as the join), or one the join has already let into the room (someone over capacity). A removed member
// still gets the terminal bounce, and nobody else is minted a token, as before. When the admission read fails,
// a socket in the room is answered and one outside it is not.

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
jest.mock('../../../config', () => {
  const actual = jest.requireActual('../../../config') as { config: Record<string, unknown> };
  return { ...actual, config: { ...actual.config, snapshotEmitEnabled: true } };
});
const mintMock = jest.fn(async () => ({ token: 'tok-x', livekitUrl: 'wss://lk' }));
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: jest.fn(async () => ({ lobbyRoomId: 'lobby-1' })),
  generateLiveKitToken: (...args: unknown[]) => (mintMock as jest.Mock)(...args),
}));
const mockAdmission = jest.fn();
jest.mock('../../../services/session/session-access', () => ({
  eventRoomAdmission: (...args: unknown[]) => mockAdmission(...args),
  __esModule: true,
}));

import type { Socket } from 'socket.io';
import { SessionStatus } from '@rsn/shared';
import { writeCanonical } from '../../../services/orchestration/state/canonical-state';
import { handleResync, clearSnapshotLocationCache } from '../../../services/orchestration/state/state-snapshot';

const EVENT = 'event-9';
const ROOM = `session:${EVENT}`;
const MEMBER = 'member-1';

type Sent = { event: string; payload: { you?: { token?: string } } };
function page(userId: string, inRoom: boolean) {
  const sent: Sent[] = [];
  const socket = {
    data: { userId, role: 'member' },
    rooms: new Set(inRoom ? [ROOM] : []),
    emit: (event: string, payload: Sent['payload']) => { sent.push({ event, payload }); return true; },
  };
  return { socket: socket as unknown as Socket, sent };
}
const io = {} as Parameters<typeof handleResync>[0];

async function liveEventWithMember() {
  await writeCanonical({
    sessionId: EVENT, status: SessionStatus.LOBBY_OPEN, currentRound: 1, seq: 4, hostUserId: 'host-1',
    timer: { kind: 'round', endsAt: 1234 },
    participants: {
      [MEMBER]: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 4 },
    },
  } as unknown as Parameters<typeof writeCanonical>[0]);
}

beforeEach(async () => {
  store.clear();
  mintMock.mockClear();
  mockAdmission.mockReset();
  clearSnapshotLocationCache();
  await liveEventWithMember();
});

describe('session:resync', () => {
  it('a stranger asking gets no answer at all, and no token is minted', async () => {
    mockAdmission.mockResolvedValue('refused');
    const { socket, sent } = page('stranger-1', false);
    await handleResync(io, socket, { sessionId: EVENT, haveSeq: -1 });
    expect(sent).toEqual([]);
    expect(mintMock).not.toHaveBeenCalled();
    expect(mockAdmission).toHaveBeenCalledWith(EVENT, 'stranger-1', 'member');
  });

  it('a member gets the snapshot with a fresh token, as before', async () => {
    mockAdmission.mockResolvedValue('admitted');
    const { socket, sent } = page(MEMBER, true);
    await handleResync(io, socket, { sessionId: EVENT, haveSeq: 1 });
    expect(sent.map((s) => s.event)).toEqual(['state:snapshot']);
    expect(sent[0].payload.you?.token).toBe('tok-x');
  });

  it('a member whose page has not joined yet (the resync can arrive first) is answered: the event admits them', async () => {
    mockAdmission.mockResolvedValue('admitted');
    const { socket, sent } = page('newcomer-1', false);
    await handleResync(io, socket, { sessionId: EVENT, haveSeq: -1 });
    expect(sent.map((s) => s.event)).toEqual(['state:snapshot']);
  });

  it('a removed member is told they are removed, and no token is minted (unchanged)', async () => {
    mockAdmission.mockResolvedValue('removed');
    const { socket, sent } = page(MEMBER, true);
    await handleResync(io, socket, { sessionId: EVENT, haveSeq: 1 });
    expect(sent).toEqual([{ event: 'session:evicted', payload: { reason: 'removed_from_event' } }]);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('someone the join let in over capacity (in the room, no participant row) is answered, as today', async () => {
    mockAdmission.mockResolvedValue('refused');
    const { socket, sent } = page('overcap-1', true);
    await handleResync(io, socket, { sessionId: EVENT, haveSeq: -1 });
    expect(sent.map((s) => s.event)).toEqual(['state:snapshot']);
  });

  it('when the admission read fails, a socket in the room is answered and one outside it is not', async () => {
    mockAdmission.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    const inside = page(MEMBER, true);
    await handleResync(io, inside.socket, { sessionId: EVENT, haveSeq: 1 });
    expect(inside.sent.map((s) => s.event)).toEqual(['state:snapshot']);
    const outside = page('stranger-1', false);
    await handleResync(io, outside.socket, { sessionId: EVENT, haveSeq: -1 });
    expect(outside.sent).toEqual([]);
  });
});
