// ─── App-level presence heartbeat (8 Sep 2026, Ali) ─────────────────────────
//
// "Online" means actually on the platform now: the client pings while the tab
// is foreground, we stamp a short-TTL Redis key, and presence reads that key.

const mockRedis = { set: jest.fn(), exists: jest.fn() };
let redisNull = false;

jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => (redisNull ? null : mockRedis),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { markActive, isActive, PRESENCE_TTL_SECONDS } from '../../../services/presence/presence.service';

beforeEach(() => {
  redisNull = false;
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.exists.mockReset().mockResolvedValue(1);
});

describe('markActive', () => {
  it('stamps a short-TTL presence key for the user', async () => {
    await markActive('u-1');
    expect(mockRedis.set).toHaveBeenCalledWith('presence:app:u-1', '1', 'EX', PRESENCE_TTL_SECONDS);
  });
  it('is a no-op when Redis is unavailable', async () => {
    redisNull = true;
    await expect(markActive('u-1')).resolves.toBeUndefined();
  });
});

describe('isActive', () => {
  it('is true when the presence key exists', async () => {
    mockRedis.exists.mockResolvedValue(1);
    expect(await isActive('u-1')).toBe(true);
  });
  it('is false when the key has expired', async () => {
    mockRedis.exists.mockResolvedValue(0);
    expect(await isActive('u-1')).toBe(false);
  });
  it('returns null (unknown) when Redis is down, so callers can fall back', async () => {
    redisNull = true;
    expect(await isActive('u-1')).toBeNull();
  });
});
