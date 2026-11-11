// ─── 12 Nov 2026: ScrapingDog's "not stored yet" answer, one call per lookup, and every answer logged ─────────────
//
// Since 6 Nov every lookup ended "retry exhausted" after 50.2 s and nothing was written. Seen live on 11 Nov: after
// ~50 s ScrapingDog answers HTTP 400
//   {success:false, status:..., message:"The copy of this profile will be scraped and stored in our db, please try again after 2-3 minutes."}
// The 12 Nov backfill showed that only the plain slug is ever served from ScrapingDog's store (2 of 5 plain slugs
// ~12 minutes later, 0 of 5 scrambled-casing ids), so a lookup is now ONE call for the plain slug: at most one answer
// ScrapingDog can bill (a 200 or a 404); a 202 or a rate limit is the same request sent again.

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
  scrapingdogProvider, scrubMessage, SCRAPE_TOTAL_MS, GAP_FILL_RESERVE_MS,
} from '../../../services/onboarding/providers/scrapingdog.provider';
import { PROVIDER_DEADLINE_MS } from '../../../services/onboarding/providers/deadline';

const mockResponse = (status: number, body?: unknown) => ({ status, json: async () => body } as unknown as Response);
const NOT_READY_BODY = {
  message: 'The copy of this profile will be scraped and stored in our db, please try again after 2-3 minutes.',
  success: false,
  status: 400,
};
const FULL = { fullName: 'Jane Doe', headline: 'CTO', experience: [{ position: 'CTO', company_name: 'Acme' }] };
const THIN = { fullName: 'Jane Doe', headline: '', experience: [] };
const SLUG = 'jane-doe-1a2b3c';
const URL_IN = `https://www.linkedin.com/in/Jane-Doe-1A2B3C/`;

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

describe('one call, the documented endpoint, the plain slug', () => {
  it('asks /profile with type=profile, the lower-case slug as id, and premium; logs nothing for a profile', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, FULL));

    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });

    expect(out.kind).toBe('found');
    if (out.kind === 'found') expect(out.result.sources).toEqual([`scrapingdog:${SLUG}`]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.scrapingdog.com/profile');
    expect(url.searchParams.get('type')).toBe('profile');
    expect(url.searchParams.get('premium')).toBe('true');
    expect(url.searchParams.get('id')).toBe(SLUG);
    expect(url.searchParams.has('linkId')).toBe(false);
    expect(answerLogs()).toHaveLength(0);
  });

  it.each([
    ['a full profile', mockResponse(200, FULL), 'found'],
    ['a thin profile', mockResponse(200, THIN), 'partial'],
    ['an empty body', mockResponse(200, {}), 'not_found'],
    ['a 404', mockResponse(404), 'not_found'],
    ['"not stored yet"', mockResponse(400, NOT_READY_BODY), 'retry_exhausted'],
    ['a 500', mockResponse(500), 'provider_error'],
  ])('%s: exactly one call, so at most one answer ScrapingDog can bill', async (_what, answer, kind) => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer);
    const out = await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    expect(out.kind).toBe(kind);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 202 re-sent until a profile: the same request each time, and only the last answer is billable', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(202))
      .mockResolvedValueOnce(mockResponse(202))
      .mockResolvedValueOnce(mockResponse(200, FULL));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await promise).kind).toBe('found');

    expect(new Set(fetchMock.mock.calls.map((c) => String(c[0]))).size).toBe(1);
    const answers = await Promise.all(fetchMock.mock.results.map((r) => r.value as Promise<Response>));
    expect(answers.filter((a) => a.status === 200 || a.status === 404)).toHaveLength(1);
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

    expect((await promise).kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(answerLogs()).toEqual([
      expect.objectContaining({ provider: 'scrapingdog', status: 202, attempt: 1, elapsedMs: expect.any(Number) }),
    ]);
  });

  it('202 for ever: bounded by the 60 s budget (attempts at 0, 15, 30, 45 s), retry_exhausted, every 202 logged', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(202));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(15_000);

    expect(await promise).toEqual({ kind: 'retry_exhausted' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(answerLogs().map((l) => `${l.status}:${l.attempt}`)).toEqual(['202:1', '202:2', '202:3', '202:4']);
  });
});

describe('"not stored yet, try again after 2-3 minutes"', () => {
  it('is not a rate limit: one call, nothing re-sent, the outcome says notReady, logged with the message', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(400, NOT_READY_BODY));

    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'retry_exhausted', notReady: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(answerLogs()).toEqual([expect.objectContaining({ status: 400, attempt: 1, message: NOT_READY_BODY.message })]);
  });

  it('a real rate limit is still a wait inside the budget, then retry_exhausted rateLimited', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(429, { success: false, message: 'Too many requests, please wait.' }));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    for (const ms of [5_000, 10_000, 15_000, 20_000, 25_000]) await jest.advanceTimersByTimeAsync(ms);

    expect(await promise).toEqual({ kind: 'retry_exhausted', rateLimited: true });
    expect(fetchMock).toHaveBeenCalledTimes(5); // 0, 5, 15, 30, 50 s; the next would start at 75 s
  });
});

describe('the time budget', () => {
  it('the one call takes at most 100 s, which keeps a 50 s gap-fill reserve inside the 150 s deadline', () => {
    expect(SCRAPE_TOTAL_MS).toBe(100_000);
    expect(GAP_FILL_RESERVE_MS).toBe(50_000);
    expect(SCRAPE_TOTAL_MS + GAP_FILL_RESERVE_MS).toBeLessThanOrEqual(PROVIDER_DEADLINE_MS);
  });

  it('the first fetch may take the whole 100 s (a "not stored yet" takes ~50 s)', async () => {
    const timeouts = jest.spyOn(AbortSignal, 'timeout');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, FULL));
    await scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    expect(timeouts.mock.calls[0][0]).toBe(100_000);
  });
});

// Re-review N3: a call cut at its hard cap brought no answer: the outcome is unknown, not "no such profile".
describe('a call cut at its 100 s hard cap', () => {
  it('moves the clock through the cut: retry_exhausted timedOut (one later attempt), logged, at 100 s', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 12, 10) });
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
      return c.signal;
    });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_, reject) => {
      const signal = (init as RequestInit).signal!;
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const started = Date.now();
    let settled: unknown;
    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN }).then((o) => { settled = o; return o; });

    await jest.advanceTimersByTimeAsync(99_999);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);

    expect(await promise).toEqual({ kind: 'retry_exhausted', timedOut: true });
    expect(Date.now() - started).toBe(100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(answerLogs()).toEqual([expect.objectContaining({ status: 0, attempt: 1, message: 'The operation was aborted due to timeout' })]);
  });

  it('a network error that is not a cut stays provider_error (an answer, not a wait)', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'provider_error', reason: 'socket hang up' });
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
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'provider_error', reason });
    expect(answerLogs()[0]).toEqual(expect.objectContaining({ status, attempt: 1 }));
  });

  it('a 404 is logged too (not_found)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(404));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'not_found', reason: 'scrapingdog 404' });
    expect(answerLogs()[0]).toEqual(expect.objectContaining({ status: 404 }));
  });

  it('a network failure is logged as status 0, its message without the key', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect failed for test-key-do-not-leak'));
    expect((await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).kind).toBe('provider_error');
    expect(answerLogs()[0]).toEqual(expect.objectContaining({ status: 0, attempt: 1, message: 'connect failed for [redacted]' }));
  });
});

describe('reasons and log messages never carry the key or the profile', () => {
  it('scrubs the id plain, in any casing, and percent-encoded (a full URL echo), and the key', () => {
    const id = 'claus-sønderskov-51b2943';
    const msg = `Failed for https://www.linkedin.com/in/${encodeURIComponent(id)} (CLAUS-SØNDERSKOV-51B2943) key test-key-do-not-leak`;
    expect(scrubMessage(msg, id)).toBe('Failed for https://www.linkedin.com/in/[profile] ([profile]) key [redacted]');
  });

  it('a success:false body that names the profile returns a reason without it', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, { success: false, message: `Profile ${SLUG} is private` }));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'provider_error', reason: 'Profile [profile] is private' });
  });

  it('no log line carries the API key or the slug, and each carries status, attempt and elapsed only', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(202, { message: `accepted test-key-do-not-leak ${SLUG.toUpperCase()}` }))
      .mockResolvedValueOnce(mockResponse(400, NOT_READY_BODY));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: URL_IN });
    await jest.advanceTimersByTimeAsync(15_000);
    await promise;

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('test-key-do-not-leak');
    expect(logged.toLowerCase()).not.toContain(SLUG);
    expect(answerLogs()[0].message).toBe('accepted [redacted] [profile]');
    for (const l of answerLogs()) {
      expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(['attempt', 'elapsedMs', 'provider', 'status']));
      expect(l).not.toHaveProperty('linkId');
      expect(l).not.toHaveProperty('url');
    }
  });
});

// ─── Review M2: a 200 whose body cannot be read is never "no such profile" ────────────────────────────────────────
describe('a 200 whose body cannot be read', () => {
  const unreadable = (status: number, err: Error) => ({ status, json: async () => { throw err; } } as unknown as Response);

  it('cut while the body was read (the 100 s signal fired after the headers): retry_exhausted timedOut, one call', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValue(unreadable(200, new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'retry_exhausted', timedOut: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('not JSON at all: provider_error (an answer we could not read), logged, never not_found', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(unreadable(200, new SyntaxError('Unexpected token < in JSON')));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'provider_error', reason: 'scrapingdog 200 with an unreadable body' });
    expect(answerLogs()).toEqual([expect.objectContaining({ status: 200, attempt: 1, message: 'the answer could not be read' })]);
  });

  it('an unreadable body on a non-200 keeps its status verdict, as before', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(unreadable(500, new SyntaxError('Unexpected end of JSON input')));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: URL_IN })).toEqual({ kind: 'provider_error', reason: 'scrapingdog 500' });
  });
});
