// ─── App-level presence (8 Sep 2026, Ali; three states, pushed, 11 Nov 2026, Shirley Palmer's RSN 07) ─────
//
// "Online" means actually on the platform now: the client pings while the tab is foreground, we stamp a short-TTL
// Redis key, and presence reads that key. Since 11 Nov 2026 there are three states: online (the key), away (no key,
// a live socket), offline (no socket); a read that cannot tell leaves the member out (unknown, never "offline"). Each
// change is pushed to the member's conversation partners as user:<id>:presence, never across a block, and only on a
// change (SET NX), so the screens no longer poll.

const mockRedis = { set: jest.fn(), exists: jest.fn(), del: jest.fn(), expire: jest.fn(), mget: jest.fn() };
let redisNull = false;
/** The live sockets, as fetchSockets answers them across instances: each with its rooms and data. */
let mockSockets: Array<{ id: string; rooms: Set<string>; data: Record<string, unknown> }> = [];
let mockFetchFails = false;
let ioNull = false;
const mockIn = jest.fn();
const mockEmitEntities = jest.fn((..._a: unknown[]) => Promise.resolve(undefined));
const mockQuery = jest.fn();

jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => (redisNull ? null : mockRedis),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const fakeIo = {
  in: (rooms: string | string[]) => {
    mockIn(rooms);
    const wanted = new Set(Array.isArray(rooms) ? rooms : [rooms]);
    return {
      fetchSockets: () => (mockFetchFails
        ? Promise.reject(new Error('adapter timeout'))
        : Promise.resolve(mockSockets.filter((s) => [...s.rooms].some((r) => wanted.has(r))))),
    };
  },
};
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => (ioNull ? null : fakeIo),
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
}));
jest.mock('../../../db', () => ({ __esModule: true, query: (...a: unknown[]) => mockQuery(...a) }));

import {
  markActive, isActive, clearActive, presenceOf, presenceState, PRESENCE_TTL_SECONDS, PRESENCE_READ_MAX,
} from '../../../services/presence/presence.service';
import {
  presenceAudience, pushPresence, queuePresencePush, resetQueuedPresencePushes, PRESENCE_AUDIENCE_MAX, PRESENCE_PUSH_COALESCE_MS,
} from '../../../services/presence/presence-push';
import {
  onPresenceAway, onPresenceConnect, onPresenceDisconnect, onPresencePing, resetPresenceTimers, watchPresence,
  PRESENCE_EVENTS_PER_WINDOW,
} from '../../../services/presence/presence-socket';

/** Changes are told once they settle (PRESENCE_PUSH_COALESCE_MS); wait that long before reading what was told. */
const told = async () => {
  await new Promise((r) => setTimeout(r, PRESENCE_PUSH_COALESCE_MS + 30));
  await new Promise((r) => setImmediate(r));
};

const socket = (id: string, userId: string, foreground = false) => ({ id, rooms: new Set([id, `user:${userId}`]), data: { foreground } });

beforeEach(() => {
  redisNull = false;
  ioNull = false;
  mockFetchFails = false;
  mockSockets = [];
  mockIn.mockReset();
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.exists.mockReset().mockResolvedValue(1);
  mockRedis.del.mockReset().mockResolvedValue(1);
  mockRedis.expire.mockReset().mockResolvedValue(1);
  mockRedis.mget.mockReset().mockImplementation((...keys: string[]) => Promise.resolve(keys.map(() => null)));
  mockEmitEntities.mockClear();
  mockQuery.mockReset().mockResolvedValue({ rows: [{ partner_id: 'u-partner' }] });
  resetPresenceTimers();
  resetQueuedPresencePushes();
});

afterAll(() => resetPresenceTimers());

describe('markActive', () => {
  it('stamps a short-TTL key only when it is not there (SET NX), and says that was a change', async () => {
    expect(await markActive('u-1')).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith('rsn:presence:u-1', '1', 'EX', PRESENCE_TTL_SECONDS, 'NX');
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });
  it('a ping while already online only keeps the key alive, and is no change', async () => {
    mockRedis.set.mockResolvedValue(null);
    expect(await markActive('u-1')).toBe(false);
    expect(mockRedis.expire).toHaveBeenCalledWith('rsn:presence:u-1', PRESENCE_TTL_SECONDS);
  });
  it('the key lapsing between the SET and the EXPIRE (EXPIRE answers 0) is stamped again, and that is a change', async () => {
    mockRedis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    mockRedis.expire.mockResolvedValue(0);
    expect(await markActive('u-1')).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    expect(mockRedis.set).toHaveBeenLastCalledWith('rsn:presence:u-1', '1', 'EX', PRESENCE_TTL_SECONDS, 'NX');
  });
  it('is null (nothing stamped) when Redis is unavailable or fails', async () => {
    redisNull = true;
    expect(await markActive('u-1')).toBeNull();
    redisNull = false;
    mockRedis.set.mockRejectedValue(new Error('down'));
    expect(await markActive('u-1')).toBeNull();
  });
});

describe('isActive and clearActive', () => {
  it('isActive reads the key; null when Redis is down', async () => {
    mockRedis.exists.mockResolvedValue(0);
    expect(await isActive('u-1')).toBe(false);
    redisNull = true;
    expect(await isActive('u-1')).toBeNull();
  });
  it('clearActive deletes the key and says whether they were online', async () => {
    expect(await clearActive('u-1')).toBe(true);
    expect(mockRedis.del).toHaveBeenCalledWith('rsn:presence:u-1');
    mockRedis.del.mockResolvedValue(0);
    expect(await clearActive('u-1')).toBe(false);
    redisNull = true;
    expect(await clearActive('u-1')).toBeNull();
  });
});

describe('presenceOf: online, away, offline, or left out when unknown', () => {
  it('the key is online; a socket without the key is away; no socket is offline', async () => {
    mockRedis.mget.mockResolvedValue(['1', null, null]);
    mockSockets = [socket('s-b', 'u-b')];
    expect(await presenceOf(['u-a', 'u-b', 'u-c'])).toEqual({ 'u-a': 'online', 'u-b': 'away', 'u-c': 'offline' });
    expect(mockRedis.mget).toHaveBeenCalledWith('rsn:presence:u-a', 'rsn:presence:u-b', 'rsn:presence:u-c');
    // One socket lookup for everyone without the key, across instances.
    expect(mockIn).toHaveBeenCalledTimes(1);
    expect(mockIn).toHaveBeenCalledWith(['user:u-b', 'user:u-c']);
  });

  it('asks no socket when everyone has the key', async () => {
    mockRedis.mget.mockResolvedValue(['1']);
    expect(await presenceOf(['u-a'])).toEqual({ 'u-a': 'online' });
    expect(mockIn).not.toHaveBeenCalled();
  });

  it('with Redis down, a socket in front of the member is online and one behind is away', async () => {
    redisNull = true;
    mockSockets = [socket('s-a', 'u-a', true), socket('s-b', 'u-b', false)];
    expect(await presenceOf(['u-a', 'u-b', 'u-c'])).toEqual({ 'u-a': 'online', 'u-b': 'away', 'u-c': 'offline' });
  });

  it('a socket lookup that fails leaves the members it was asked about out (unknown), never offline', async () => {
    mockRedis.mget.mockResolvedValue(['1', null]);
    mockFetchFails = true;
    expect(await presenceOf(['u-a', 'u-b'])).toEqual({ 'u-a': 'online' });
  });

  it('with neither Redis nor a socket server nobody can be placed', async () => {
    redisNull = true;
    ioNull = true;
    expect(await presenceOf(['u-a'])).toEqual({});
    expect(await presenceState('u-a')).toBeNull();
  });

  it('asks about each member once, at most PRESENCE_READ_MAX, and nothing for an empty list', async () => {
    expect(await presenceOf([])).toEqual({});
    expect(mockRedis.mget).not.toHaveBeenCalled();
    await presenceOf(['u-a', 'u-a', '']);
    expect(mockRedis.mget).toHaveBeenCalledWith('rsn:presence:u-a');
    const many = Array.from({ length: PRESENCE_READ_MAX + 20 }, (_, i) => `u-${i}`);
    await presenceOf(many);
    expect(mockRedis.mget.mock.calls[1]).toHaveLength(PRESENCE_READ_MAX);
  });

  it('a socket in two tabs counts once, in front if either is', async () => {
    redisNull = true;
    mockSockets = [socket('s-1', 'u-a', false), socket('s-2', 'u-a', true)];
    expect(await presenceState('u-a')).toBe('online');
  });
});

describe('who is told (presenceAudience)', () => {
  it('is the member\'s conversation partners, with every blocked pair left out, bounded', async () => {
    mockQuery.mockResolvedValue({ rows: [{ partner_id: 'u-x' }, { partner_id: 'u-y' }] });
    expect(await presenceAudience('u-a')).toEqual(['u-x', 'u-y']);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('FROM dm_conversations c WHERE (c.user_a_id = $1 OR c.user_b_id = $1)');
    expect(flat).toContain('AND NOT EXISTS ( SELECT 1 FROM user_blocks b WHERE (b.blocker_id = c.user_a_id AND b.blocked_id = c.user_b_id) OR (b.blocker_id = c.user_b_id AND b.blocked_id = c.user_a_id))');
    expect(flat).toContain('LIMIT $2');
    expect(params).toEqual(['u-a', PRESENCE_AUDIENCE_MAX]);
  });

  it('pushPresence sends user:<id>:presence to exactly them; nothing when there is nobody, or no socket server', async () => {
    await pushPresence('u-a');
    expect(mockEmitEntities).toHaveBeenCalledWith(fakeIo, ['u-partner'], ['user:u-a:presence']);
    mockEmitEntities.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
    await pushPresence('u-a');
    expect(mockEmitEntities).not.toHaveBeenCalled();
    ioNull = true;
    await pushPresence('u-a');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('a failing read never throws: presence is not worth a failure', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(pushPresence('u-a')).resolves.toBeUndefined();
  });
});

describe('the sockets (presence-socket.ts): told only on a change', () => {
  const io = fakeIo as never;

  it('connecting does NOT mark anyone online; the member\'s first socket is a change (offline to away), a second is not', async () => {
    mockSockets = [socket('s-1', 'u-a')];
    await onPresenceConnect(io, 'u-a');
    expect(mockRedis.set).not.toHaveBeenCalled();
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
    mockSockets.push(socket('s-2', 'u-a'));
    await onPresenceConnect(io, 'u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
  });

  it('a ping marks the socket in front and is pushed only when it turned them online', async () => {
    const s = { data: { foreground: false } as Record<string, unknown> };
    await onPresencePing(s as never, 'u-a');
    expect(s.data.foreground).toBe(true);
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
    mockRedis.set.mockResolvedValue(null); // already online: the key is only kept alive
    await onPresencePing(s as never, 'u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
  });

  it('without Redis, a socket coming to the front is the change (pushed once)', async () => {
    redisNull = true;
    const s = { data: { foreground: false } as Record<string, unknown> };
    await onPresencePing(s as never, 'u-a');
    await onPresencePing(s as never, 'u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
  });

  it('away: the key goes and the change is pushed, unless another of their tabs is in front', async () => {
    const me = socket('s-1', 'u-a', true);
    mockSockets = [me, socket('s-2', 'u-a', true)];
    await onPresenceAway(io, me as never, 'u-a');
    expect(me.data.foreground).toBe(false);
    expect(mockRedis.del).not.toHaveBeenCalled(); // the other tab keeps them online
    await told();
    expect(mockEmitEntities).not.toHaveBeenCalled();
    mockSockets = [me, socket('s-2', 'u-a', false)];
    await onPresenceAway(io, me as never, 'u-a');
    expect(mockRedis.del).toHaveBeenCalledWith('rsn:presence:u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
  });

  it('away when they were not online anyway sends nothing', async () => {
    mockRedis.del.mockResolvedValue(0);
    const me = socket('s-1', 'u-a');
    mockSockets = [me];
    await onPresenceAway(io, me as never, 'u-a');
    await told();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('the last socket closing is offline at once (pushed); one of several closing leaves them away only when none is in front', async () => {
    mockSockets = [];
    await onPresenceDisconnect(io, 'u-a');
    expect(mockRedis.del).toHaveBeenCalledWith('rsn:presence:u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);

    mockRedis.del.mockClear();
    mockSockets = [socket('s-2', 'u-a', true)];
    await onPresenceDisconnect(io, 'u-a');
    expect(mockRedis.del).not.toHaveBeenCalled();
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);

    mockSockets = [socket('s-2', 'u-a', false)];
    await onPresenceDisconnect(io, 'u-a');
    expect(mockRedis.del).toHaveBeenCalledWith('rsn:presence:u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(2);
  });

  it('a key that lapses with no word from the tab (a frozen tab) is still told, just after the TTL', async () => {
    jest.useFakeTimers();
    try {
      const s = { data: { foreground: false } as Record<string, unknown> };
      const flush = () => new Promise(jest.requireActual('timers').setImmediate);
      await onPresencePing(s as never, 'u-a');
      jest.advanceTimersByTime(PRESENCE_PUSH_COALESCE_MS);
      await flush();
      expect(mockEmitEntities).toHaveBeenCalledTimes(1);
      mockRedis.exists.mockResolvedValue(0);
      jest.advanceTimersByTime((PRESENCE_TTL_SECONDS + 2) * 1000);
      await flush();
      expect(mockRedis.exists).toHaveBeenCalledWith('rsn:presence:u-a');
      jest.advanceTimersByTime(PRESENCE_PUSH_COALESCE_MS);
      await flush();
      expect(mockEmitEntities).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('watchPresence: a connection starts behind (not in front), and a burst of presence events is cut off', async () => {
    const handlers: Record<string, () => void> = {};
    const s = { id: 's-1', data: {} as Record<string, unknown>, on: (event: string, fn: () => void) => { handlers[event] = fn; } };
    mockSockets = [socket('s-1', 'u-a')];
    watchPresence(fakeIo as never, s as never, 'u-a');
    expect(s.data.foreground).toBe(false);
    expect(Object.keys(handlers).sort()).toEqual(['presence:away', 'presence:ping']);
    mockRedis.set.mockResolvedValue(null);
    for (let i = 0; i < PRESENCE_EVENTS_PER_WINDOW * 3; i += 1) handlers['presence:ping']();
    await new Promise((r) => setImmediate(r));
    // The connect counted as one; then pings up to the window's allowance; the rest were ignored.
    expect(mockRedis.set).toHaveBeenCalledTimes(PRESENCE_EVENTS_PER_WINDOW - 1);
  });
});

describe('changes in one moment are told once (fix round 1, M-3)', () => {
  it('a connection\'s first socket (away) and its first ping (online) reach the partners as ONE push', async () => {
    mockSockets = [socket('s-1', 'u-a')];
    await onPresenceConnect(fakeIo as never, 'u-a');
    await onPresencePing({ data: { foreground: false } } as never, 'u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
    expect(mockEmitEntities).toHaveBeenCalledWith(fakeIo, ['u-partner'], ['user:u-a:presence']);
  });

  it('queuePresencePush twice in the window is one push; a later change is its own', async () => {
    queuePresencePush('u-a');
    queuePresencePush('u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
    queuePresencePush('u-a');
    await told();
    expect(mockEmitEntities).toHaveBeenCalledTimes(2);
  });
});
