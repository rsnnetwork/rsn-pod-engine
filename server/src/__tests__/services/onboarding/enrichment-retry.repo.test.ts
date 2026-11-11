// ─── Scheduling the one later lookup: a member's latest address wins (12 Nov 2026, review I1) ──────────────────────
//
// A member who typed a wrong address and corrected it within the ten minutes used to keep the typo's waiting row
// (ON CONFLICT DO NOTHING): the typo was looked up later and the corrected address never got its retry. A member's row
// is now replaced by the latest schedule; a join request (whose address never changes) keeps its first. The upsert
// itself was run on PGlite (workspace/scratch/2026-11-12-enrich/pglite-155.mjs: the typo row becomes the corrected one).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  scheduleEnrichmentRetry, purgeStaleEnrichmentRetries, ENRICH_RETRY_DELAY_MS,
  SCHEDULE_USER_RETRY_SQL, SCHEDULE_REQUEST_RETRY_SQL, PURGE_STALE_RETRIES_SQL,
} from '../../../services/onboarding/enrichment-retry.repo';

const TYPO = 'https://www.linkedin.com/in/jane-dooe';
const FIXED = 'https://www.linkedin.com/in/jane-doe';

beforeEach(() => mockQuery.mockReset().mockResolvedValue({ rows: [{ id: 'row-1' }], rowCount: 1 }));

it('a member\'s schedule is an upsert on their row: the typo, then the corrected address, leaves the corrected one waiting', async () => {
  expect(await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: TYPO, fullName: 'Jane' })).toBe(true);
  expect(await scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED, fullName: 'Jane' })).toBe(true);

  expect(mockQuery.mock.calls.map((c) => c[0])).toEqual([SCHEDULE_USER_RETRY_SQL, SCHEDULE_USER_RETRY_SQL]);
  expect(mockQuery.mock.calls[1][1]).toEqual(['u-1', FIXED, 'Jane', ENRICH_RETRY_DELAY_MS / 1000]);
  expect(SCHEDULE_USER_RETRY_SQL).toMatch(/DO UPDATE SET linkedin_url = EXCLUDED\.linkedin_url/);
  expect(SCHEDULE_USER_RETRY_SQL).toMatch(/run_at = EXCLUDED\.run_at/);
});

it('a request\'s schedule keeps its first row (its address does not change)', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'row-1' }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect(await scheduleEnrichmentRetry({ joinRequestId: 'jr-1' }, { linkedinUrl: FIXED, fullName: 'Jane' })).toBe(true);
  expect(await scheduleEnrichmentRetry({ joinRequestId: 'jr-1' }, { linkedinUrl: FIXED, fullName: 'Jane' })).toBe(false);
  expect(mockQuery.mock.calls.map((c) => c[0])).toEqual([SCHEDULE_REQUEST_RETRY_SQL, SCHEDULE_REQUEST_RETRY_SQL]);
  expect(mockQuery.mock.calls[0][1]).toEqual(['jr-1', FIXED, 'Jane', 600]);
});

it('never throws: a failed schedule is false', async () => {
  mockQuery.mockRejectedValue(new Error('db down'));
  await expect(scheduleEnrichmentRetry({ userId: 'u-1' }, { linkedinUrl: FIXED })).resolves.toBe(false);
});

it('the purge drops rows a day past their time', async () => {
  mockQuery.mockResolvedValue({ rows: [], rowCount: 3 });
  expect(await purgeStaleEnrichmentRetries()).toBe(3);
  expect(mockQuery).toHaveBeenCalledWith(PURGE_STALE_RETRIES_SQL, [24]);
});
