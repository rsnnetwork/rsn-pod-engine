// ─── Scheduling the later lookups (12 Nov 2026) ─────────────────────────────────────────────────────────────────
//
// Review I1: a member's latest address wins (an upsert on their waiting row). Migration 156: up to two later attempts
// per lookup (at +10 minutes, then 30 minutes after that), and at most three scheduled per request or member in any
// 24 hours, in the same statement as the row (the log). The SQL itself ran on PGlite (pglite-156.mjs): the bound, the
// upsert resetting the attempt, the log, the purge, twice-run migration.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  // The schedule runs its lock and its statement on one transaction client: the same mock sees both, in order.
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  scheduleEnrichmentRetry, purgeStaleEnrichmentRetries, nextRetryAttempt,
  ENRICH_MAX_RETRIES, ENRICH_RETRY_DELAYS_MS, ENRICH_RETRY_DAILY_LIMIT,
  SCHEDULE_USER_RETRY_SQL, SCHEDULE_REQUEST_RETRY_SQL, PURGE_STALE_RETRIES_SQL, PURGE_RETRY_LOG_SQL, SCHEDULE_LOCK_SQL, scheduleLockKey,
} from '../../../services/onboarding/enrichment-retry.repo';

const TYPO = 'https://www.linkedin.com/in/jane-dooe';
const FIXED = 'https://www.linkedin.com/in/jane-doe';
const flat = (s: string) => s.replace(/\s+/g, ' ');
/** The schedule statements, without the advisory lock taken before each. */
const stmts = () => mockQuery.mock.calls.filter((c) => c[0] !== SCHEDULE_LOCK_SQL);

beforeEach(() => mockQuery.mockReset().mockResolvedValue({ rows: [{ id: 'row-1' }], rowCount: 1 }));

describe('the attempts', () => {
  it('two later attempts, at +10 minutes and 30 minutes after that (0, +10, +40), three a day at most', () => {
    expect(ENRICH_MAX_RETRIES).toBe(2);
    expect(ENRICH_RETRY_DELAYS_MS).toEqual([10 * 60 * 1000, 30 * 60 * 1000]);
    expect(ENRICH_RETRY_DAILY_LIMIT).toBe(3);
    expect(nextRetryAttempt(0)).toBe(1);
    expect(nextRetryAttempt(1)).toBe(2);
    expect(nextRetryAttempt(2)).toBeNull();
  });

  it.each([[1, 600], [2, 1800]])('attempt %i is scheduled %i s on', async (attempt, secs) => {
    await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED, fullName: 'Jane' }, attempt);
    expect(stmts()[0][1]).toEqual(['u-1', FIXED, 'Jane', secs, 3, attempt]);
  });

  it.each([0, 3, 1.5])('attempt %p is refused without touching the database', async (attempt) => {
    expect(await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED }, attempt)).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('a member', () => {
  it('the schedule is an upsert on their row: the typo, then the corrected address, leaves the corrected one, back at attempt 1', async () => {
    expect(await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: TYPO, fullName: 'Jane' }, 2)).toBe(true);
    expect(await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED, fullName: 'Jane' })).toBe(true);

    expect(stmts().map((c) => c[0])).toEqual([SCHEDULE_USER_RETRY_SQL, SCHEDULE_USER_RETRY_SQL]);
    expect(stmts()[1][1]).toEqual(['u-1', FIXED, 'Jane', 600, 3, 1]);
    expect(flat(SCHEDULE_USER_RETRY_SQL)).toContain(
      'DO UPDATE SET linkedin_url = EXCLUDED.linkedin_url, full_name = EXCLUDED.full_name, run_at = EXCLUDED.run_at, attempt = EXCLUDED.attempt',
    );
  });

  it('the 24-hour bound and the log live in the same statement as the row', () => {
    const s = flat(SCHEDULE_USER_RETRY_SQL);
    expect(s).toContain("SELECT count(*) < $5 AS ok FROM enrichment_retry_log WHERE user_id = $1 AND created_at > NOW() - interval '24 hours'");
    expect(s).toContain('FROM allowed WHERE ok');
    expect(s).toContain('INSERT INTO enrichment_retry_log (user_id) SELECT $1 FROM ins');
  });

  it('a refused schedule (the bound reached) is false', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED })).toBe(false);
  });
});

describe('a request', () => {
  it('keeps its first row (its address does not change), bounded and logged the same way', async () => {
    let n = 0;
    mockQuery.mockImplementation(async (sql: string) => (sql === SCHEDULE_LOCK_SQL ? { rows: [], rowCount: 1 }
      : n++ === 0 ? { rows: [{ id: 'row-1' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    expect(await scheduleEnrichmentRetry({ joinRequestId: 'jr-1' }, { linkedinUrl: FIXED, fullName: 'Jane' })).toBe(true);
    expect(await scheduleEnrichmentRetry({ joinRequestId: 'jr-1' }, { linkedinUrl: FIXED, fullName: 'Jane' })).toBe(false);
    expect(stmts().map((c) => c[0])).toEqual([SCHEDULE_REQUEST_RETRY_SQL, SCHEDULE_REQUEST_RETRY_SQL]);
    expect(stmts()[0][1]).toEqual(['jr-1', FIXED, 'Jane', 600, 3, 1]);
    const s = flat(SCHEDULE_REQUEST_RETRY_SQL);
    expect(s).toContain('ON CONFLICT DO NOTHING');
    expect(s).toContain('WHERE join_request_id = $1 AND created_at > NOW() - interval \'24 hours\'');
    expect(s).toContain('INSERT INTO enrichment_retry_log (join_request_id) SELECT $1 FROM ins');
  });
});

it('never throws: a failed schedule is false', async () => {
  mockQuery.mockRejectedValue(new Error('db down'));
  await expect(scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED })).resolves.toBe(false);
});

it('the purge drops waiting rows a day past their time, and log rows after 48 hours', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 }).mockResolvedValueOnce({ rows: [], rowCount: 9 });
  expect(await purgeStaleEnrichmentRetries()).toBe(3);
  expect(mockQuery).toHaveBeenNthCalledWith(1, PURGE_STALE_RETRIES_SQL, [24]);
  expect(mockQuery).toHaveBeenNthCalledWith(2, PURGE_RETRY_LOG_SQL, [48]);
});

// Review M5: the 24-hour bound is strict. Two schedulers for the same member or request at the same moment are counted
// one after the other: each takes a transaction-scoped advisory lock on that subject before its statement, on the same
// transaction client, released at commit. Run for real on PGlite (pglite-156.mjs: lock, statement, commit).
describe('the advisory lock', () => {
  it.each([
    [{ userId: 'u-1' }, 'enrich-retry:user:u-1', SCHEDULE_USER_RETRY_SQL],
    [{ joinRequestId: 'jr-1' }, 'enrich-retry:request:jr-1', SCHEDULE_REQUEST_RETRY_SQL],
  ] as const)('%o: the lock on %s comes first, then the statement, in one transaction', async (subject, key, statement) => {
    await scheduleEnrichmentRetry(subject, { linkedinUrl: FIXED });
    expect(mockQuery.mock.calls.map((c) => c[0])).toEqual([SCHEDULE_LOCK_SQL, statement]);
    expect(mockQuery.mock.calls[0][1]).toEqual([key]);
    expect(scheduleLockKey(subject)).toBe(key);
  });

  it('is the transaction-scoped kind (released at commit, never held past the statement)', () => {
    expect(SCHEDULE_LOCK_SQL).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
  });

  it('a member and a request never share a key', () => {
    expect(scheduleLockKey({ userId: 'x' })).not.toBe(scheduleLockKey({ joinRequestId: 'x' }));
  });
});
