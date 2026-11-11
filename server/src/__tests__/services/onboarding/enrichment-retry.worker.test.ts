// ─── The one later LinkedIn lookup (12 Nov 2026) ──────────────────────────────────────────────────────────────────
//
// enrichment-retry.worker.ts runs every minute: it drops rows left waiting a day, and, while lookups go to ScrapingDog,
// claims the due row (a DELETE under FOR UPDATE SKIP LOCKED, so several instances never run one twice) and runs it
// once with what the account says NOW, never scheduling another, then tells the member's screens.

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
const mockFanoutUser = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  __esModule: true,
  fanoutUserEntity: (...args: unknown[]) => mockFanoutUser(...args),
}));
const mockGetState = jest.fn();
jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  __esModule: true,
  getEnrichmentState: (...args: unknown[]) => mockGetState(...args),
}));
const mockProvider = jest.fn();
jest.mock('../../../services/onboarding/providers/registry', () => ({
  __esModule: true,
  resolveEnrichProvider: () => mockProvider(),
}));

import logger from '../../../config/logger';
import { processEnrichmentRetries } from '../../../services/onboarding/enrichment-retry.worker';
import { CLAIM_DUE_RETRIES_SQL, ENRICH_RETRY_BATCH, PURGE_STALE_RETRIES_SQL } from '../../../services/onboarding/enrichment-retry.repo';

const TYPO = 'https://www.linkedin.com/in/jane-dooe';
const FIXED = 'https://www.linkedin.com/in/jane-doe';
const requestJob = { id: 'r-1', join_request_id: 'jr-1', user_id: null, linkedin_url: FIXED, full_name: 'Jane Doe' };
const userJob = { id: 'r-2', join_request_id: null, user_id: 'u-9', linkedin_url: FIXED, full_name: 'Sam Lee' };
const requestRow = (over: Record<string, unknown> = {}) => ({
  id: 'jr-1', full_name: 'Jane Doe', email: 'jane@example.com', linkedin_url: FIXED, status: 'approved', has_result: false, user_id: null, ...over,
});
const memberRow = (over: Record<string, unknown> = {}) => ({ linkedin_url: FIXED, display_name: 'Sam Lee', status: 'active', ...over });

/** The claim hands back `due`; the request read `request`; the member read `member`. */
function db(due: unknown[], opts: { request?: unknown; member?: unknown } = {}) {
  mockQuery.mockImplementation((sql: string) => {
    if (/DELETE FROM enrichment_retries\s+WHERE id IN/.test(sql)) return Promise.resolve({ rows: due, rowCount: due.length });
    if (/DELETE FROM enrichment_retries WHERE run_at </.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (/FROM join_requests jr/.test(sql)) return Promise.resolve({ rows: opts.request ? [opts.request] : [], rowCount: opts.request ? 1 : 0 });
    if (/FROM users WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: opts.member ? [opts.member] : [], rowCount: opts.member ? 1 : 0 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}
const claims = () => mockQuery.mock.calls.filter((c) => String(c[0]) === CLAIM_DUE_RETRIES_SQL);

beforeEach(() => {
  mockQuery.mockReset();
  mockRunEnrichment.mockReset().mockResolvedValue(undefined);
  mockPreload.mockReset().mockResolvedValue(undefined);
  mockFanoutUser.mockReset().mockResolvedValue(undefined);
  mockGetState.mockReset().mockResolvedValue({ status: 'failed', source: 'scrapingdog', error: 'not stored yet, retrying later', startedAt: null, completedAt: null });
  mockProvider.mockReset().mockReturnValue('scrapingdog');
  (logger.warn as jest.Mock).mockClear();
});

describe('each tick', () => {
  it('drops rows left waiting a day, then claims ONE due row (oldest first, FOR UPDATE SKIP LOCKED)', async () => {
    db([]);
    await processEnrichmentRetries();
    expect(String(mockQuery.mock.calls[0][0])).toBe(PURGE_STALE_RETRIES_SQL);
    expect(mockQuery.mock.calls[0][1]).toEqual([24]);
    expect(claims()).toHaveLength(1);
    const [sql, params] = claims()[0];
    expect(sql).toMatch(/run_at <= NOW\(\)/);
    expect(sql).toMatch(/ORDER BY run_at/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    // One at a time: a deploy while it runs can lose only the row it took; the rest wait for the next tick.
    expect(ENRICH_RETRY_BATCH).toBe(1);
    expect(params).toEqual([1]);
  });

  it.each(['claude_web', 'none'])('with ENRICH_PROVIDER=%s nothing is claimed or run (rows wait; no Anthropic spend, no state rewritten)', async (provider) => {
    mockProvider.mockReturnValue(provider);
    db([userJob], { member: memberRow() });
    await processEnrichmentRetries();
    expect(claims()).toHaveLength(0);
    expect(mockRunEnrichment).not.toHaveBeenCalled();
    expect(mockPreload).not.toHaveBeenCalled();
  });

  it('a tick that finds the last one still running does nothing', async () => {
    let release!: () => void;
    db([userJob], { member: memberRow() });
    mockRunEnrichment.mockImplementation(() => new Promise<void>((r) => { release = r; }));

    const first = processEnrichmentRetries();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await processEnrichmentRetries();
    release();
    await first;

    expect(claims()).toHaveLength(1);
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
  });

  it('a retry that throws is logged and the tick still ends', async () => {
    db([userJob], { member: memberRow() });
    mockRunEnrichment.mockRejectedValueOnce(new Error('boom'));
    await expect(processEnrichmentRetries()).resolves.toBeUndefined();
    expect((logger.warn as jest.Mock).mock.calls.some((c) => c[0]?.retryId === 'r-2' && c[1] === 'enrichment retry failed (non-fatal)')).toBe(true);
    await expect(processEnrichmentRetries()).resolves.toBeUndefined(); // the guard was released
  });
});

describe('a member\'s own lookup', () => {
  it('runs with the address on their profile NOW, never scheduling another, and tells their screens', async () => {
    db([userJob], { member: memberRow() });
    await processEnrichmentRetries();
    expect(mockRunEnrichment).toHaveBeenCalledWith('u-9', { linkedinUrl: FIXED, fullName: 'Sam Lee', scheduleRetry: false });
    expect(mockFanoutUser).toHaveBeenCalledWith('u-9');
    expect(mockFanoutUser.mock.invocationCallOrder[0]).toBeGreaterThan(mockRunEnrichment.mock.invocationCallOrder[0]);
  });

  it('a typo corrected after the retry was scheduled: the corrected address is looked up, never the typo', async () => {
    db([{ ...userJob, linkedin_url: TYPO }], { member: memberRow({ linkedin_url: FIXED }) });
    await processEnrichmentRetries();
    expect(mockRunEnrichment).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichment.mock.calls[0][1].linkedinUrl).toBe(FIXED);
  });

  it('a profile without an address (the older onboarding does not save the one it looks up) uses the scheduled one', async () => {
    db([userJob], { member: memberRow({ linkedin_url: null }) });
    await processEnrichmentRetries();
    expect(mockRunEnrichment.mock.calls[0][1].linkedinUrl).toBe(FIXED);
  });

  it.each([
    ['closed', memberRow({ status: 'deactivated' })],
    ['suspended', memberRow({ status: 'suspended' })],
    ['deleted', undefined],
  ])('a %s account: no lookup (nobody needs it), no fanout', async (_what, member) => {
    db([userJob], { member });
    await processEnrichmentRetries();
    expect(mockRunEnrichment).not.toHaveBeenCalled();
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });

  it.each(['found', 'partial'])('a member whose state is %s already: no second lookup', async (status) => {
    mockGetState.mockResolvedValue({ status, source: 'scrapingdog', error: null, startedAt: null, completedAt: null });
    db([userJob], { member: memberRow() });
    await processEnrichmentRetries();
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  it('the fanout follows a lookup that failed again too (the screen leaves "searching")', async () => {
    db([userJob], { member: memberRow() });
    mockRunEnrichment.mockResolvedValue(undefined); // the orchestrator wrote failed; it never throws
    await processEnrichmentRetries();
    expect(mockFanoutUser).toHaveBeenCalledWith('u-9');
  });
});

describe('an approval-time lookup', () => {
  it('with no account yet: the request is looked up again, never scheduling another', async () => {
    db([requestJob], { request: requestRow() });
    await processEnrichmentRetries();
    expect(mockPreload).toHaveBeenCalledWith(
      { id: 'jr-1', fullName: 'Jane Doe', email: 'jane@example.com', linkedinUrl: FIXED },
      { scheduleRetry: false },
    );
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  it('when the applicant has an account by now: their own lookup runs with their profile\'s CURRENT address, then their screens are told', async () => {
    db([requestJob], { request: requestRow({ user_id: 'u-7', linkedin_url: TYPO }), member: memberRow({ linkedin_url: FIXED, display_name: 'Jane D' }) });
    await processEnrichmentRetries();
    expect(mockRunEnrichment).toHaveBeenCalledWith('u-7', { linkedinUrl: FIXED, fullName: 'Jane D', scheduleRetry: false });
    expect(mockFanoutUser).toHaveBeenCalledWith('u-7');
    expect(mockPreload).not.toHaveBeenCalled();
  });

  it.each([
    ['already has its result', requestRow({ has_result: true })],
    ['is no longer approved', requestRow({ status: 'declined' })],
    ['is gone', undefined],
  ])('a request that %s: nothing runs (no paid lookup)', async (_what, request) => {
    db([requestJob], { request });
    await processEnrichmentRetries();
    expect(mockPreload).not.toHaveBeenCalled();
    expect(mockRunEnrichment).not.toHaveBeenCalled();
  });

  it('the request read only takes an ACTIVE account with the same email, in any letter case', async () => {
    db([requestJob], { request: requestRow() });
    await processEnrichmentRetries();
    const sql = String(mockQuery.mock.calls.find((c) => /FROM join_requests jr/.test(String(c[0])))![0]);
    expect(sql).toMatch(/LOWER\(u\.email\) = LOWER\(jr\.email\)/);
    expect(sql).toMatch(/u\.status::text = 'active'/);
  });
});

it('no log line written by the worker names anyone: ids and states only', async () => {
  db([requestJob], { request: requestRow({ user_id: 'u-7' }), member: memberRow({ status: 'suspended' }) });
  await processEnrichmentRetries();
  db([userJob], { member: memberRow() });
  await processEnrichmentRetries();
  const logged = JSON.stringify([...(logger.info as jest.Mock).mock.calls, ...(logger.warn as jest.Mock).mock.calls]);
  for (const personal of ['Jane Doe', 'Sam Lee', 'jane@example.com', 'jane-doe', 'linkedin.com']) expect(logged).not.toContain(personal);
});
