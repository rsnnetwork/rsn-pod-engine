// ─── The resync token rail names the same lobby as the REST rail in the Start gap (2 Nov 2026) ─────
//
// buildYou (state-snapshot.ts) minted a main-room token only when the event row held its lobby room id, so a
// resync answered inside the Start gap carried no token and left the page to the REST rail, which named
// `session-<id>`. Both rails now give the same answer while the event is live: the lobby every other path uses
// (`lobby-<id>`). Before Go Live and after the end the resync still mints nothing for the main room, as before
// (production's client only asks for a lobby token while the event is live).

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
const mintMock = jest.fn(async (_sid: string, _uid: string, roomId?: string) => ({
  token: `tok-${roomId}`, livekitUrl: 'wss://lk',
}));
const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  generateLiveKitToken: (...args: unknown[]) => (mintMock as jest.Mock)(...args),
}));
jest.mock('../../../services/session/session-access', () => ({
  eventRoomAdmission: jest.fn(async () => 'admitted'),
  __esModule: true,
}));

import type { Socket } from 'socket.io';
import { SessionStatus } from '@rsn/shared';
import { writeCanonical } from '../../../services/orchestration/state/canonical-state';
import { handleResync, clearSnapshotLocationCache } from '../../../services/orchestration/state/state-snapshot';

const EVENT = 'event-sc';
const MEMBER = 'member-1';
const LOBBY = `lobby-${EVENT}`;

type You = { token?: string; roomId?: string };
function page() {
  const sent: Array<{ event: string; payload: { you?: You } }> = [];
  const socket = {
    data: { userId: MEMBER, role: 'member' },
    rooms: new Set([`session:${EVENT}`]),
    emit: (event: string, payload: { you?: You }) => { sent.push({ event, payload }); return true; },
  };
  return { socket: socket as unknown as Socket, sent };
}
const io = {} as Parameters<typeof handleResync>[0];

async function canonical(status: string) {
  await writeCanonical({
    sessionId: EVENT, status, currentRound: 0, seq: 2, hostUserId: 'host-1',
    timer: { kind: 'none', endsAt: null },
    participants: {
      [MEMBER]: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 2 },
    },
  } as unknown as Parameters<typeof writeCanonical>[0]);
}

async function resyncYou(): Promise<You | undefined> {
  const { socket, sent } = page();
  await handleResync(io, socket, { sessionId: EVENT, haveSeq: -1 });
  expect(sent.map((s) => s.event)).toEqual(['state:snapshot']);
  return sent[0].payload.you;
}

beforeEach(() => {
  store.clear();
  mintMock.mockClear();
  mockGetSessionById.mockReset();
  clearSnapshotLocationCache();
});

describe('session:resync in the main room', () => {
  it('open with no lobby room id yet (the Start gap): mints the lobby token, the same room the REST rail names', async () => {
    await canonical(SessionStatus.LOBBY_OPEN);
    mockGetSessionById.mockResolvedValue({ id: EVENT, status: SessionStatus.LOBBY_OPEN, lobbyRoomId: null });
    const you = await resyncYou();
    expect(mintMock).toHaveBeenCalledWith(EVENT, MEMBER, LOBBY);
    expect(you).toMatchObject({ token: `tok-${LOBBY}`, roomId: LOBBY });
  });

  it('a round in progress with no lobby room id stored also mints the lobby', async () => {
    await canonical(SessionStatus.ROUND_ACTIVE);
    mockGetSessionById.mockResolvedValue({ id: EVENT, status: SessionStatus.ROUND_ACTIVE, lobbyRoomId: null });
    const you = await resyncYou();
    expect(you?.roomId).toBe(LOBBY);
  });

  it('the stored lobby room id is used as before', async () => {
    await canonical(SessionStatus.LOBBY_OPEN);
    mockGetSessionById.mockResolvedValue({ id: EVENT, status: SessionStatus.LOBBY_OPEN, lobbyRoomId: LOBBY });
    const you = await resyncYou();
    expect(you).toMatchObject({ token: `tok-${LOBBY}`, roomId: LOBBY });
  });

  it.each([SessionStatus.SCHEDULED, SessionStatus.COMPLETED, SessionStatus.CANCELLED])(
    'before Go Live or after the end (%s) it still mints no main-room token, as before',
    async (status) => {
      await canonical(status);
      mockGetSessionById.mockResolvedValue({ id: EVENT, status, lobbyRoomId: null });
      const you = await resyncYou();
      expect(mintMock).not.toHaveBeenCalled();
      expect(you?.token).toBeUndefined();
      expect(you?.roomId).toBeUndefined();
    },
  );
});
