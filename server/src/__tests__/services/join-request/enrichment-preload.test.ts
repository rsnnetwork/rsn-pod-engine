// ─── The approval-time LinkedIn lookup says when it finds nothing, and tries once more later (12 Nov 2026) ────────
//
// `if (!result) return;` dropped every empty lookup without a word: six days of ScrapingDog answering "not stored yet,
// try again after 2-3 minutes" reached no log and no alert. Now every empty end is logged with the request id and the
// reason, and a "try again later" answer leaves ONE later attempt (enrichment_retries, migration 155).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  __esModule: true,
}));
jest.mock('../../../config', () => ({ __esModule: true, default: { enrichProvider: 'scrapingdog' } }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRunProvider = jest.fn();
jest.mock('../../../services/onboarding/providers/registry', () => {
  const actual = jest.requireActual('../../../services/onboarding/providers/registry');
  return {
    __esModule: true,
    resolveEnrichProvider: () => 'scrapingdog',
    runProvider: (...args: unknown[]) => mockRunProvider(...args),
    resultFromOutcome: actual.resultFromOutcome,
  };
});

import logger from '../../../config/logger';
import { preloadJoinRequestEnrichment } from '../../../services/join-request/enrichment-preload';
import { ENRICH_RETRY_DELAYS_MS, ENRICH_RETRY_DAILY_LIMIT } from '../../../services/onboarding/enrichment-retry.repo';

const warn = logger.warn as jest.Mock;
const REQUEST = { id: 'jr-1', fullName: 'Jane Doe', email: 'jane@example.com', linkedinUrl: 'https://www.linkedin.com/in/jane-doe' };
const inserts = () => mockQuery.mock.calls.filter((c) => /INSERT INTO enrichment_retries/.test(String(c[0])));
const writes = () => mockQuery.mock.calls.filter((c) => /UPDATE join_requests SET enriched/.test(String(c[0])));
const nothingLogs = () => warn.mock.calls.filter((c) => c[1] === 'join-request enrichment preload found nothing').map((c) => c[0]);

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [{ id: 'retry-1' }], rowCount: 1 });
  mockRunProvider.mockReset();
  warn.mockClear();
});

describe('a lookup that brings back nothing', () => {
  it('"not stored yet": logged with the request id and the reason, and ONE later attempt is scheduled for the same address', async () => {
    mockRunProvider.mockResolvedValue({ kind: 'retry_exhausted', notReady: true });

    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });

    expect(writes()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
    // Attempt 1, ten minutes on, within the daily limit.
    expect(inserts()[0][1]).toEqual(['jr-1', 'https://www.linkedin.com/in/jane-doe', 'Jane Doe', ENRICH_RETRY_DELAYS_MS[0] / 1000, ENRICH_RETRY_DAILY_LIMIT, 1]);
    expect(String(inserts()[0][0])).toMatch(/ON CONFLICT DO NOTHING/);
    expect(nothingLogs()).toEqual([expect.objectContaining({
      joinRequestId: 'jr-1', outcome: 'retry_exhausted', reason: 'not stored yet (asked to try again later)', retryScheduled: true,
    })]);
  });

  it.each([
    [{ kind: 'retry_exhausted' }, 'still 202 when the budget ran out'],
    [{ kind: 'retry_exhausted', rateLimited: true }, 'rate limited'],
    [{ kind: 'retry_exhausted', timedOut: true }, 'timed out (outcome unknown)'],
  ])('%o is a wait too: logged (%s) and retried once later', async (outcome, reason) => {
    mockRunProvider.mockResolvedValue(outcome);
    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });
    expect(inserts()).toHaveLength(1);
    expect(nothingLogs()).toEqual([expect.objectContaining({ joinRequestId: 'jr-1', reason, retryScheduled: true })]);
  });

  it.each([
    [{ kind: 'not_found', reason: 'scrapingdog 404' }, 'scrapingdog 404'],
    [{ kind: 'provider_error', reason: 'scrapingdog 500' }, 'scrapingdog 500'],
  ])('%o is an answer, not a wait: logged with its reason, no later attempt', async (outcome, reason) => {
    mockRunProvider.mockResolvedValue(outcome);
    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });
    expect(inserts()).toHaveLength(0);
    expect(nothingLogs()).toEqual([expect.objectContaining({ joinRequestId: 'jr-1', outcome: outcome.kind, reason, retryScheduled: false })]);
  });

  it('later attempt 1 asks for attempt 2, thirty minutes on', async () => {
    mockRunProvider.mockResolvedValue({ kind: 'retry_exhausted', notReady: true });

    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 1 });

    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1]).toEqual(['jr-1', 'https://www.linkedin.com/in/jane-doe', 'Jane Doe', ENRICH_RETRY_DELAYS_MS[1] / 1000, ENRICH_RETRY_DAILY_LIMIT, 2]);
    expect(ENRICH_RETRY_DELAYS_MS[1]).toBe(30 * 60 * 1000);
  });

  it('later attempt 2 asks for none (at most two later attempts)', async () => {
    mockRunProvider.mockResolvedValue({ kind: 'retry_exhausted', notReady: true });

    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 2 });

    expect(inserts()).toHaveLength(0);
    expect(nothingLogs()).toEqual([expect.objectContaining({ joinRequestId: 'jr-1', retryScheduled: false, attempt: 2 })]);
  });

  it('a retry that is already waiting is not doubled, and that is logged too', async () => {
    mockRunProvider.mockResolvedValue({ kind: 'retry_exhausted', notReady: true });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // ON CONFLICT DO NOTHING: nothing inserted

    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });

    expect(nothingLogs()).toEqual([expect.objectContaining({ retryScheduled: false })]);
  });

  it('a schedule that fails is logged and never throws into the approval', async () => {
    mockRunProvider.mockResolvedValue({ kind: 'retry_exhausted', notReady: true });
    mockQuery.mockRejectedValue(new Error('db down'));

    await expect(preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 })).resolves.toBeUndefined();
    expect(warn.mock.calls.some((c) => c[1] === 'enrichment: could not schedule the later lookup')).toBe(true);
  });
});

describe('the 150 s deadline (a request retry, or an approval, never hangs the worker)', () => {
  const FOUND = {
    kind: 'found',
    photoUrl: null,
    result: {
      profile: { fullName: 'Jane Doe', headline: 'CTO', currentRole: 'CTO', currentCompany: 'Acme', pastRoles: [], skills: [] },
      confidence: 0.95, sources: ['scrapingdog:jane-doe:live'],
      foundLinkedinUrl: 'https://www.linkedin.com/in/jane-doe', requestedLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      enrichedAt: '2026-11-12T10:00:00.000Z',
    },
  };
  afterEach(() => jest.useRealTimers());

  it('a lookup that never answers ends at 150 s, logged, with no retry scheduled', async () => {
    jest.useFakeTimers();
    mockRunProvider.mockReturnValue(new Promise(() => {}));

    const run = preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });
    await jest.advanceTimersByTimeAsync(150_000);
    await run;

    expect(writes()).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
    expect(nothingLogs()).toEqual([expect.objectContaining({ joinRequestId: 'jr-1', outcome: 'provider_error', reason: 'provider deadline of 150s reached' })]);
  });

  it('a profile that arrives after the deadline is still kept, only on a request that has none yet', async () => {
    jest.useFakeTimers();
    let answer!: (o: unknown) => void;
    mockRunProvider.mockReturnValue(new Promise((r) => { answer = r; }));

    const run = preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });
    await jest.advanceTimersByTimeAsync(150_000);
    await run;
    expect(writes()).toHaveLength(0);

    answer(FOUND);
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(writes()).toHaveLength(1);
    expect(String(writes()[0][0])).toMatch(/WHERE id = \$2 AND enriched IS NULL/);
    expect(writes()[0][1][1]).toBe('jr-1');
  });
});

describe('a lookup that finds the person', () => {
  it('keeps the result on the request with the provider, schedules nothing and logs no "nothing"', async () => {
    mockRunProvider.mockResolvedValue({
      kind: 'found',
      photoUrl: null,
      result: {
        profile: { fullName: 'Jane Doe', headline: 'CTO', currentRole: 'CTO', currentCompany: 'Acme', pastRoles: [], skills: [] },
        confidence: 0.95, sources: ['scrapingdog:jane-doe:live'],
        foundLinkedinUrl: 'https://www.linkedin.com/in/jane-doe', requestedLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
        enrichedAt: '2026-11-12T10:00:00.000Z',
      },
    });

    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });

    expect(writes()).toHaveLength(1);
    expect(writes()[0][1][1]).toBe('jr-1');
    expect(JSON.parse(String(writes()[0][1][0]))).toMatchObject({ provider: 'scrapingdog', confidence: 0.95 });
    expect(inserts()).toHaveLength(0);
    expect(nothingLogs()).toHaveLength(0);
  });

  it('no log line names the applicant: no name, email or address, only ids and reasons', async () => {
    mockRunProvider.mockResolvedValue({ kind: 'retry_exhausted', notReady: true });
    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });
    mockRunProvider.mockResolvedValue({ kind: 'provider_error', reason: 'scrapingdog 500' });
    await preloadJoinRequestEnrichment(REQUEST, { retryAttempt: 0 });

    const logged = JSON.stringify([...warn.mock.calls, ...(logger.info as jest.Mock).mock.calls]);
    for (const personal of ['Jane Doe', 'jane@example.com', 'jane-doe', 'linkedin.com']) expect(logged).not.toContain(personal);
  });

  it('no LinkedIn on the request: no lookup, nothing logged as missing', async () => {
    await preloadJoinRequestEnrichment({ ...REQUEST, linkedinUrl: null }, { retryAttempt: 0 });
    expect(mockRunProvider).not.toHaveBeenCalled();
    expect(nothingLogs()).toHaveLength(0);
  });
});
