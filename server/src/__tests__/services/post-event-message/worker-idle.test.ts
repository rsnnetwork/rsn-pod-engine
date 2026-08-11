// ─── Post-event worker: what an IDLE tick costs (6 Aug 2026) ─────────────────
//
// The worker runs every 10 s forever. It used to take the Redis lock before
// asking whether there was any work, so every idle tick spent a SET and a DEL —
// about 17k commands a day against an Upstash free tier of 10k. The quota was
// gone before any real work happened, and the lock protecting that work was the
// thing that exhausted it.
//
// These pin the ordering: Postgres first, Redis only when there is a job.

const mockQuery = jest.fn<any, any[]>();
const mockRedis = { set: jest.fn<any, any[]>(), del: jest.fn<any, any[]>() };
const mockGetRedis = jest.fn<any, any[]>();

jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: (...a: unknown[]) => mockGetRedis(...a),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/dm/dm.service', () => ({ sendBroadcastMessage: jest.fn(), __esModule: true }));
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({ broadcastDmMessage: jest.fn(), __esModule: true }));
jest.mock('../../../services/post-event-message/templates', () => ({ buildMessage: () => 'hi', __esModule: true }));

import { processPendingJobs } from '../../../services/post-event-message/post-event-message.worker';

const io = {} as any;

beforeEach(() => {
  mockQuery.mockReset();
  mockRedis.set.mockReset(); mockRedis.del.mockReset();
  mockRedis.del.mockResolvedValue(1);
  mockGetRedis.mockReset(); mockGetRedis.mockReturnValue(mockRedis);
});

describe('an idle tick costs nothing on Redis', () => {
  it('never touches Redis when there is no pending job', async () => {
    mockQuery.mockResolvedValue({ rows: [] });      // nothing pending
    await processPendingJobs(io);
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('asks Postgres first, on an indexed status probe', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await processPendingJobs(io);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/post_event_message_jobs/);
    expect(String(sql)).toMatch(/status = 'pending'/);
    expect(String(sql)).toMatch(/LIMIT 1/);
  });

  it('a day of idling stays free — 8,640 ticks, zero Redis commands', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    for (let i = 0; i < 50; i++) await processPendingJobs(io);
    expect(mockRedis.set).toHaveBeenCalledTimes(0);
    expect(mockRedis.del).toHaveBeenCalledTimes(0);
  });
});

describe('the lock still guards real work', () => {
  it('takes the lock once there IS a job, before claiming any row', async () => {
    // probe finds work, then the cycle picks the job
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValue({ rows: [] });
    mockRedis.set.mockResolvedValue('OK');

    await processPendingJobs(io);

    expect(mockRedis.set).toHaveBeenCalledWith('pem:worker:lock', '1', 'EX', 55, 'NX');
    // The lock must be taken BEFORE the job is claimed, or two instances could
    // both claim it. Only the probe may precede it.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockRedis.del).toHaveBeenCalled();
  });

  it('stands down when another instance holds the lock', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockRedis.set.mockResolvedValue(null);         // lock not acquired

    await processPendingJobs(io);

    expect(mockQuery).toHaveBeenCalledTimes(1);    // never claimed anything
    expect(mockRedis.del).not.toHaveBeenCalled();  // and never released a lock it does not hold
  });

  it('still runs single-instance when Redis is unavailable', async () => {
    mockGetRedis.mockReturnValue(null);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValue({ rows: [] });
    await expect(processPendingJobs(io)).resolves.toBeUndefined();
    expect(mockQuery.mock.calls.length).toBeGreaterThan(1);
  });
});
