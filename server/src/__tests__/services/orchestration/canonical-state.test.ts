// server/src/__tests__/services/orchestration/canonical-state.test.ts
import { SessionStatus } from '@rsn/shared';

// Mock the redis client module so we control availability + capture writes.
const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
let redisHandle: any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => redisHandle,
}));

import {
  canonicalKey,
  readCanonical,
  writeCanonical,
  CanonicalSessionState,
} from '../../../services/orchestration/state/canonical-state';

const sample: CanonicalSessionState = {
  sessionId: 's1',
  status: SessionStatus.LOBBY_OPEN,
  currentRound: 0,
  seq: 1,
  hostUserId: 'host1',
  timer: null,
  participants: {
    u1: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1000, userSeq: 1 },
  },
};

beforeEach(() => { store.clear(); redisHandle = fakeRedis; jest.clearAllMocks(); });

describe('canonical-state', () => {
  it('uses the rsn:canonical: namespace (distinct from rsn:session:)', () => {
    expect(canonicalKey('s1')).toBe('rsn:canonical:s1');
  });

  it('round-trips a state document through Redis', async () => {
    await writeCanonical(sample);
    expect(fakeRedis.setex).toHaveBeenCalledWith('rsn:canonical:s1', 14400, expect.any(String));
    const read = await readCanonical('s1');
    expect(read).toEqual(sample);
  });

  it('readCanonical returns null when the key is missing', async () => {
    expect(await readCanonical('missing')).toBeNull();
  });

  it('no-ops gracefully when Redis is unavailable', async () => {
    redisHandle = null;
    await expect(writeCanonical(sample)).resolves.toBeUndefined();
    expect(await readCanonical('s1')).toBeNull();
  });
});
