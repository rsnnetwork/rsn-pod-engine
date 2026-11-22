// ─── users.last_seen_at from the foreground ping (22 Nov 2026) ───────────────────────────────────────────────
//
// The notification email gate tells "was on REASON since this happened" from users.last_seen_at. A ping comes every 25
// seconds from each tab in front of its member, so the stamp is written at most once a minute per member, never awaited,
// and a failed write is tried again on the next ping.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
jest.mock('../../../config/logger', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }, __esModule: true }));

import { STAMP_EVERY_MS, __resetLastSeenForTests, dueForStamp, noteSeen } from '../../../services/presence/last-seen';

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  __resetLastSeenForTests();
});

describe('the last-seen stamp', () => {
  it('is due for a member never stamped, and again a minute after the last', () => {
    expect(dueForStamp(undefined, 1000)).toBe(true);
    expect(dueForStamp(1000, 1000 + STAMP_EVERY_MS - 1)).toBe(false);
    expect(dueForStamp(1000, 1000 + STAMP_EVERY_MS)).toBe(true);
  });

  it('writes once for a burst of pings, then again after a minute', async () => {
    noteSeen('ana', 0);
    noteSeen('ana', 25_000);
    noteSeen('ana', 50_000);
    await settle();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith('UPDATE users SET last_seen_at = NOW() WHERE id = $1', ['ana']);
    noteSeen('ana', 60_000);
    await settle();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('each member on their own', async () => {
    noteSeen('ana', 0);
    noteSeen('bo', 0);
    await settle();
    expect(mockQuery.mock.calls.map((c) => c[1][0])).toEqual(['ana', 'bo']);
  });

  it('a failed write never throws, and the next ping tries again', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    expect(() => noteSeen('ana', 0)).not.toThrow();
    await settle();
    await settle();
    noteSeen('ana', 1000);
    await settle();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
