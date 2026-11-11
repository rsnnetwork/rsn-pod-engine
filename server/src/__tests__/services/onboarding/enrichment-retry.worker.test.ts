// ─── The one later LinkedIn lookup (12 Nov 2026) ──────────────────────────────────────────────────────────────────
//
// enrichment-retry.worker.ts runs every minute: it claims the due rows of enrichment_retries (a DELETE under FOR UPDATE
// SKIP LOCKED, so several instances never run one twice) and runs each once, never scheduling another.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRunEnrichment = jest.fn();
jest.mock('../../../services/onboarding/enrichment.orchestrator', () => ({
  __esModule: true,
  runEnrichment: (...args: unknown[]) => mockRunEnrichment(...args),
}));
const mockPreload = jest.fn();
jest.mock('../../../services/join-request/enrichment-preload', () => ({
  __esModule: true,
  preloadJoinRequestEnrichment: (...args: unknown[]) => mockPreload(...args),
}));

import logger from '../../../config/logger';
import { processEnrichmentRetries } from '../../../services/onboarding/enrichment-retry.worker';
import { CLAIM_DUE_RETRIES_SQL, ENRICH_RETRY_BATCH } from '../../../services/onboarding/enrichment-retry.repo';

const URL_IN = 'https://www.linkedin.com/in/jane-doe';
const requestJob = { id: 'r-1', join_request_id: 'jr-1', user_id: null, linkedin_url: URL_IN, full_name: 'Jane Doe' };
const userJob = { id: 'r-2', join_request_id: null, user_id: 'u-9', linkedin_url: URL_IN, full_name: 'Sam Lee' };
const requestRow = (over: Record<string, unknown> = {}) => ({
  id: 'jr-1', full_name: 'Jane Doe', email: 'jane@example.com', linkedin_url: URL_IN, status: 'approved', has_result: false, user_id: null, ...over,
});

/** The claim hands back `due`; the request read hands back `row`. */
function db(due: unknown[], row?: unknown) {
  mockQuery.mockImplementation((sql: string) => {
    if (/DELETE FROM enrichment_retries/.test(sql)) return Promise.resolve({ rows: due, rowCount: due.length });
    if (/FROM join_requests jr/.test(sql)) return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRunEnrichment.mockReset().mockResolvedValue(undefined);
  mockPreload.mockReset().mockResolvedValue(undefined);
  (logger.warn as jest.Mock).mockClear();
});

describe('the claim', () => {
  it('deletes the due rows it takes, oldest first, under FOR UPDATE SKIP LOCKED, a small batch at a time', async () => {
    db([]);
    await processEnrichmentRetries();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe(CLAIM_DUE_RETRIES_SQL);
    expect(sql).toMatch(/DELETE FROM enrichment_retries/);
    expect(sql).toMatch(/run_at <= NOW\(\)/);
    expect(sql).toMatch(/ORDER BY run_at/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(params).toEqual([ENRICH_RETRY_BATCH]);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
    expect(mockPreload).not.toHaveBeenCalled();
  });

  it('a tick that finds the last one still running does nothing', async () => {
    let release!: () => void;
    db([userJob]);
    mockRunEnrichment.mockImplementation(() => new Promise<void>((r) => { release = r; }));

    const first = processEnrichmentRetries();
    await new Promise((r) => setImmediate(r));
    await processEnrichmentRetries();
    release();
    await first;

    expect(mockQuery.mock.calls.filter((c) => /DELETE FROM enrichment_retries/.test(String(c[0])))).toHaveLength(1);
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
  });
});

describe('a member\'s own lookup', () => {
  it('runs again through the orchestrator for the same address, and never schedules another', async () => {
    db([userJob]);
    await processEnrichmentRetries();
    expect(mockRunEnrichment).toHaveBeenCalledWith('u-9', { linkedinUrl: URL_IN, fullName: 'Sam Lee', scheduleRetry: false });
  });
});

describe('an approval-time lookup', () => {
  it('with no account yet: the request is looked up again, never scheduling another', async () => {
    db([requestJob], requestRow());
    await processEnrichmentRetries();
    expect(mockPreload).toHaveBeenCalledWith(
      { id: 'jr-1', fullName: 'Jane Doe', email: 'jane@example.com', linkedinUrl: URL_IN },
      { scheduleRetry: false },
    );
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  it('when the applicant has an account by now: their own lookup runs (a result on the request would never reach them)', async () => {
    db([requestJob], requestRow({ user_id: 'u-7' }));
    await processEnrichmentRetries();
    expect(mockRunEnrichment).toHaveBeenCalledWith('u-7', { linkedinUrl: URL_IN, fullName: 'Jane Doe', scheduleRetry: false });
    expect(mockPreload).not.toHaveBeenCalled();
  });

  it.each([
    ['already has its result', requestRow({ has_result: true })],
    ['is no longer approved', requestRow({ status: 'declined' })],
    ['is gone', undefined],
  ])('a request that %s: nothing runs (no paid lookup)', async (_what, row) => {
    db([requestJob], row);
    await processEnrichmentRetries();
    expect(mockPreload).not.toHaveBeenCalled();
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  it('the request read only takes an ACTIVE account with the same email, in any letter case', async () => {
    db([requestJob], requestRow());
    await processEnrichmentRetries();
    const sql = String(mockQuery.mock.calls.find((c) => /FROM join_requests jr/.test(String(c[0])))![0]);
    expect(sql).toMatch(/LOWER\(u\.email\) = LOWER\(jr\.email\)/);
    expect(sql).toMatch(/u\.status::text = 'active'/);
  });
});

it('one retry that throws does not stop the next, and is logged', async () => {
  db([userJob, { ...userJob, id: 'r-3', user_id: 'u-10' }]);
  mockRunEnrichment.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

  await expect(processEnrichmentRetries()).resolves.toBeUndefined();

  expect(mockRunEnrichment).toHaveBeenCalledTimes(2);
  expect((logger.warn as jest.Mock).mock.calls.some((c) => c[0]?.retryId === 'r-2' && c[1] === 'enrichment retry failed (non-fatal)')).toBe(true);
});
