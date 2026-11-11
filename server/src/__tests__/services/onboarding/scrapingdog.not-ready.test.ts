// ─── 12 Nov 2026: ScrapingDog's "not stored yet" answer, and every answer logged ──────────────────────────────────
//
// Since 6 Nov every lookup ended "retry exhausted" after 50.2 s and nothing was written. Seen live on 11 Nov (twice,
// same id, 3 minutes apart): after ~50 s ScrapingDog answers HTTP 400
//   {success:false, status:..., message:"The copy of this profile will be scraped and stored in our db, please try again after 2-3 minutes."}
// "try again" read as a rate limit, the backoff no longer fitted the budget, and the cached copy was skipped. And the
// live id took a new random casing on every call, so the copy ScrapingDog stored was never asked for again.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { scrapingdogApiKey: 'test-key-do-not-leak', logLevel: 'silent', isDev: false, env: 'test' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from '../../../config/logger';
import {
  scrapingdogProvider, lookupWindow, freshSlug, cachedBudgetAfter, scrubMessage, SCRAPE_TOTAL_MS, GAP_FILL_RESERVE_MS,
} from '../../../services/onboarding/providers/scrapingdog.provider';
import { PROVIDER_DEADLINE_MS } from '../../../services/onboarding/providers/deadline';

const mockResponse = (status: number, body?: unknown) => ({ status, json: async () => body } as unknown as Response);
const NOT_READY_BODY = {
  message: 'The copy of this profile will be scraped and stored in our db, please try again after 2-3 minutes.',
  success: false,
  status: 400,
};
const FULL = { fullName: 'Jane Doe', headline: 'CTO', experience: [{ position: 'CTO', company_name: 'Acme' }] };
const SLUG = 'jane-doe-1a2b3c';
const URL_IN = `https://www.linkedin.com/in/${SLUG}`;

const warn = logger.warn as jest.Mock;
/** The log lines the provider wrote for answers that were not a profile. */
const answerLogs = () => warn.mock.calls.filter((c) => c[1] === 'scrapingdog: lookup answered without a profile').map((c) => c[0]);

beforeEach(() => {
  warn.mockClear();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(500));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the documented endpoint', () => {
  it('asks /profile with type=profile, id and premium, and logs nothing for a profile on the first try', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, FULL));

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.scrapingdog.com/profile');
    expect(url.searchParams.get('type')).toBe('profile');
    expect(url.searchParams.get('premium')).toBe('true');
    expect(url.searchParams.get('id')?.toLowerCase()).toBe(SLUG);
    expect(url.searchParams.has('linkId')).toBe(false);
    expect(answerLogs()).toHaveLength(0);
  });
});

describe('the same live id inside a window', () => {
  it('two lookups in one 90-day window ask for the same id; the next window asks for another', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, FULL));
    await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    const ids = fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('id'));
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(freshSlug(SLUG, lookupWindow()));
    expect(ids[0]).not.toBe(SLUG); // still not the canonical form: that is the cached copy's id
  });

  it('the window changes every 90 days and not before', () => {
    const day = 24 * 60 * 60 * 1000;
    const start = lookupWindow(Date.UTC(2026, 10, 12)) * 90 * day;
    expect(lookupWindow(start)).toBe(lookupWindow(start + 90 * day - 1));
    expect(lookupWindow(start + 90 * day)).toBe(lookupWindow(start) + 1);
    expect(freshSlug(SLUG, lookupWindow(start))).not.toBe(freshSlug(SLUG, lookupWindow(start) + 1));
  });
});

describe('a 202', () => {
  it('202 then 200: the same request is sent again 15 s later, and the 202 is logged', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(202, { message: 'Your request is accepted and the scraping is still going on.' }))
      .mockResolvedValueOnce(mockResponse(200, FULL));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    await jest.advanceTimersByTimeAsync(15_000);
    const out = await promise;

    expect(out.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(String(fetchMock.mock.calls[1][0]));
    expect(answerLogs()).toEqual([
      expect.objectContaining({ provider: 'scrapingdog', call: 'live', status: 202, attempt: 1, elapsedMs: expect.any(Number) }),
    ]);
  });

  it('202 for ever: bounded by the budgets (three live, three cached), retry_exhausted, every 202 logged', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(202));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    for (let i = 0; i < 8; i++) await jest.advanceTimersByTimeAsync(15_000);
    const out = await promise;

    expect(out).toEqual({ kind: 'retry_exhausted' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const logs = answerLogs();
    expect(logs).toHaveLength(6);
    expect(logs.map((l) => `${l.call}:${l.attempt}`)).toEqual(['live:1', 'live:2', 'live:3', 'cached:1', 'cached:2', 'cached:3']);
    expect(logs.every((l) => l.status === 202)).toBe(true);
  });
});

describe('"not stored yet, try again after 2-3 minutes"', () => {
  it('is not a rate limit: one live attempt, the cached copy is still asked, and the outcome says notReady', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(400, NOT_READY_BODY));

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out).toEqual({ kind: 'retry_exhausted', notReady: true });
    // One live call (asking again inside the call cannot help), then the cached copy once.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('id')).toBe(SLUG);
    expect(answerLogs()).toEqual([
      expect.objectContaining({ call: 'live', status: 400, attempt: 1, message: NOT_READY_BODY.message }),
      expect.objectContaining({ call: 'cached', status: 400, attempt: 1, message: NOT_READY_BODY.message }),
    ]);
  });

  it('a cached copy that is ready answers when the live id is not stored yet', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const id = new URL(String(input)).searchParams.get('id');
      return id === SLUG ? mockResponse(200, FULL) : mockResponse(400, NOT_READY_BODY);
    });

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out.kind).toBe('found');
    if (out.kind === 'found') expect(out.result.sources).toEqual([`scrapingdog:${SLUG}`]);
  });

  it('a real rate limit still skips the cached copy (the 3 Sep behaviour is kept)', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(429, { success: false, message: 'Too many requests, please wait.' }));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    for (const ms of [5_000, 10_000, 15_000, 20_000, 25_000]) await jest.advanceTimersByTimeAsync(ms);

    expect(await promise).toEqual({ kind: 'retry_exhausted', rateLimited: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('4xx, 5xx and network failures are logged', () => {
  it.each([
    [400, undefined, 'scrapingdog 400'],
    [403, { message: 'Forbidden' }, 'scrapingdog 403'],
    [500, undefined, 'scrapingdog 500'],
    [503, { message: 'Service Unavailable' }, 'scrapingdog 503'],
  ])('HTTP %i → provider_error, logged with its status', async (status, body, reason) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(status, body));

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out).toEqual({ kind: 'provider_error', reason });
    expect(answerLogs()[0]).toEqual(expect.objectContaining({ call: 'live', status, attempt: 1 }));
  });

  it('a 404 is logged too (not_found)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(404));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'not_found', reason: 'scrapingdog 404' });
    expect(answerLogs()[0]).toEqual(expect.objectContaining({ status: 404 }));
  });

  it('a network failure is logged as status 0, its message without the key', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect failed for test-key-do-not-leak'));

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out.kind).toBe('provider_error');
    expect(answerLogs()[0]).toEqual(expect.objectContaining({ status: 0, attempt: 1, message: 'connect failed for [redacted]' }));
  });

  it('no log line carries the API key or the slug', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(202, { message: `accepted test-key-do-not-leak ${SLUG}` }))
      .mockResolvedValueOnce(mockResponse(400, NOT_READY_BODY))
      .mockResolvedValue(mockResponse(500));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    await jest.advanceTimersByTimeAsync(15_000);
    await promise;

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('test-key-do-not-leak');
    // Not even when ScrapingDog's own message names it, in the live id's scrambled casing or the canonical one.
    expect(logged.toLowerCase()).not.toContain(SLUG);
    expect(answerLogs()[0].message).toBe('accepted [redacted] [profile]');
    for (const l of answerLogs()) {
      expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(['attempt', 'call', 'elapsedMs', 'provider', 'status']));
      expect(l).not.toHaveProperty('linkId');
      expect(l).not.toHaveProperty('url');
    }
  });
});

// ─── Review I3: the second call gets only the time left; the gap fill keeps 45 s of the 150 s deadline ────────────
describe('the time budget across both calls', () => {
  it('both calls together take at most 105 s, which keeps a 45 s gap-fill reserve inside the 150 s deadline', () => {
    expect(SCRAPE_TOTAL_MS).toBe(105_000);
    expect(GAP_FILL_RESERVE_MS).toBe(45_000);
    expect(SCRAPE_TOTAL_MS + GAP_FILL_RESERVE_MS).toBeLessThanOrEqual(PROVIDER_DEADLINE_MS);
  });

  it.each([
    [0, { budgetMs: 40_000, hardCapMs: 55_000 }],
    [50_000, { budgetMs: 40_000, hardCapMs: 55_000 }],
    [75_000, { budgetMs: 30_000, hardCapMs: 30_000 }],
    [95_000, { budgetMs: 10_000, hardCapMs: 10_000 }],
    [95_001, null],
    [120_000, null],
  ])('after a live call of %i ms the cached call gets %o', (elapsed, budget) => {
    expect(cachedBudgetAfter(elapsed)).toEqual(budget);
  });

  it('a live call that took 75 s for a thin page: the cached call is cut at the 30 s left, never its own 55 s', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 12, 10) });
    const timeouts = jest.spyOn(AbortSignal, 'timeout');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const id = new URL(String(input)).searchParams.get('id');
      if (id !== SLUG) { jest.setSystemTime(Date.now() + 75_000); return mockResponse(200, { fullName: 'Jane Doe', headline: '', experience: [] }); }
      return mockResponse(200, FULL);
    });

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    // The cached copy still filled the gaps (the current company stays the live page's, by design).
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') expect(out.result.profile?.headline).toBe('CTO');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeouts.mock.calls[1][0]).toBeLessThanOrEqual(30_000);
    expect(timeouts.mock.calls[0][0]).toBe(80_000);
  });

  it('a live call that took 100 s: no cached call at all (a thin page is returned as it is, inside the reserve)', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 12, 10) });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 100_000);
      return mockResponse(200, { fullName: 'Jane Doe', headline: '', experience: [] });
    });

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out.kind).toBe('partial');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Review I4: the cached call's "not stored yet" counts when the live call brought nothing ──────────────────────
describe('the verdict when neither call brought a profile', () => {
  const cachedNotReady = (live: () => Promise<Response>) =>
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new URL(String(input)).searchParams.get('id') === SLUG ? mockResponse(400, NOT_READY_BODY) : live());

  it.each([
    ['a 5xx', async () => mockResponse(503)],
    ['a timeout', async () => { throw new Error('The operation was aborted due to timeout'); }],
    ['an empty 200', async () => mockResponse(200, {})],
  ])('live %s + cached "not stored yet" → retry_exhausted notReady (so the later attempt is scheduled)', async (_what, live) => {
    cachedNotReady(live);
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'retry_exhausted', notReady: true });
  });

  it('a live 404 still means the profile does not exist, whatever the cached call says', async () => {
    cachedNotReady(async () => mockResponse(404));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'not_found', reason: 'scrapingdog 404' });
  });

  it('live 5xx + cached 5xx: the live failure stands, no retry asked for', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(500));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'provider_error', reason: 'scrapingdog 500' });
  });
});

// ─── Review M6: a returned reason (stored as the member's error, logged upstream) carries no profile id ───────────
describe('reasons and log messages never carry the profile', () => {
  it('scrubs the id plain, in any casing, and percent-encoded (a full URL echo), and the key', () => {
    const id = 'claus-sønderskov-51b2943';
    const msg = `Failed for https://www.linkedin.com/in/${encodeURIComponent(id)} (CLAUS-SØNDERSKOV-51B2943) key test-key-do-not-leak`;
    const out = scrubMessage(msg, id);
    expect(out).toBe('Failed for https://www.linkedin.com/in/[profile] ([profile]) key [redacted]');
  });

  it('a success:false body that names the profile returns a reason without it', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, { success: false, message: `Profile ${SLUG} is private` }));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    expect(out).toEqual({ kind: 'provider_error', reason: 'Profile [profile] is private' });
  });
});
