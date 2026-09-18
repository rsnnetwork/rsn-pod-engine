jest.mock('../../../config', () => ({
  __esModule: true,
  default: {
    scrapingdogApiKey: 'test-key-do-not-leak',
    logLevel: 'silent',
    isDev: false,
    env: 'test',
  },
}));

import fs from 'fs';
import path from 'path';
import { scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';

const REAL_PROFILE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../fixtures/scrapingdog-profile.json'), 'utf-8'),
);

/** Build a minimal fetch-like Response the provider only ever reads .status/.json() from. */
function mockResponse(status: number, body?: any): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe('scrapingdogProvider', () => {
  // 14 Sep 2026: the provider now makes a second (cached-copy) call when the
  // live page is thin or failed. A test that queues one response must never
  // let that second call reach the real network: default every fetch to a
  // 500 and let each test queue its own responses on top.
  beforeEach(() => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(500));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('maps a 200 profile to EnrichResult with confidence 0.95 and echoes the requested URL', async () => {
    const raw = {
      fullName: 'Jane Doe',
      headline: 'VP of Engineering',
      industry: 'Software',
      location: 'Berlin, Germany',
      about: 'Builds distributed systems.',
      experience: [
        { position: 'VP of Engineering', company_name: 'Acme Corp', duration: '2022 - Present' },
        { title: 'Engineering Manager', company: 'Beta Inc', duration: '2019 - 2022' },
      ],
      education: [{ school: 'MIT' }],
      skills: ['Go', 'Kubernetes'],
      profile_photo: 'https://cdn.example.com/jane.jpg',
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, raw));

    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'linkedin.com/in/jane-doe' });

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') throw new Error('expected found');
    expect(outcome.result.confidence).toBe(0.95);
    expect(outcome.result.requestedLinkedinUrl).toBe('https://www.linkedin.com/in/jane-doe');
    expect(outcome.result.foundLinkedinUrl).toBe('https://www.linkedin.com/in/jane-doe');
    expect(outcome.photoUrl).toBe('https://cdn.example.com/jane.jpg');
    expect(outcome.result.profile?.fullName).toBe('Jane Doe');
    expect(outcome.result.profile?.currentRole).toBe('VP of Engineering');
    expect(outcome.result.profile?.currentCompany).toBe('Acme Corp');
    expect(outcome.result.profile?.pastRoles).toHaveLength(1);
    expect(outcome.result.profile?.pastRoles[0]).toContain('Engineering Manager');
    expect(outcome.result.profile?.pastRoles[0]).toContain('Beta Inc');
    expect(outcome.result.profile?.photoUrl).toBe('https://cdn.example.com/jane.jpg');
    expect(outcome.result.sources).toEqual(['scrapingdog:jane-doe:live']);
  });

  // 14 Sep 2026 (Shradha): LinkedIn's guest view masks entries it will not
  // show ("******* *******") and leaves every position blank. A masked entry
  // is not a past role, and never the current company either.
  it('drops experience entries LinkedIn masked with asterisks', async () => {
    const raw = {
      fullName: 'Shradha Adhikari', headline: '', about: '', location: '',
      experience: [
        { position: '', company_name: '******* *******', starts_at: '', ends_at: '', duration: '' },
        { position: '', company_name: 'Raw Speed Networking | RSN', starts_at: '', ends_at: '', duration: '' },
        { position: '', company_name: 'misterraw', starts_at: '', ends_at: '', duration: '' },
        { position: '*****', company_name: '', starts_at: '', ends_at: '', duration: '' },
      ],
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, raw));

    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari' });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') throw new Error('expected partial');
    expect(outcome.result.profile?.currentCompany).toBe('Raw Speed Networking | RSN');
    expect(outcome.result.profile?.currentRole).toBeNull();
    expect(outcome.result.profile?.pastRoles).toEqual(['at misterraw']);
    expect(outcome.missing).toEqual(['headline', 'currentRole']);
  });

  it('returns partial with missing[] when headline/experience are absent', async () => {
    const raw = { fullName: 'Sam Lee', location: 'NYC', experience: [] };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, raw));

    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/sam-lee' });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') throw new Error('expected partial');
    expect(outcome.result.confidence).toBe(0.7);
    expect(outcome.missing.sort()).toEqual(['currentCompany', 'currentRole', 'headline'].sort());
    expect(outcome.result.profile?.headline).toBeNull();
    expect(outcome.result.profile?.currentRole).toBeNull();
    expect(outcome.result.profile?.currentCompany).toBeNull();
  });

  it('returns not_found when a 200 body is null (no usable profile signal)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, null));
    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/null-body' });
    expect(outcome).toEqual({ kind: 'not_found', reason: 'empty profile body' });
  });

  it('returns not_found when a 200 body is an empty array', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, []));
    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/empty-array' });
    expect(outcome).toEqual({ kind: 'not_found', reason: 'empty profile body' });
  });

  it('returns not_found when a 200 body is an empty object', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, {}));
    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/empty-object' });
    expect(outcome).toEqual({ kind: 'not_found', reason: 'empty profile body' });
  });

  it('tolerates a non-array experience field and maps pastRoles as empty', async () => {
    const raw = { fullName: 'Alex Kim', headline: 'Product Lead', experience: 'not-an-array' };
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, raw));

    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/alex-kim' });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') throw new Error('expected partial');
    expect(outcome.result.profile?.pastRoles).toEqual([]);
    expect(outcome.result.profile?.fullName).toBe('Alex Kim');
  });

  it('skips a null entry inside experience without crashing', async () => {
    const raw = {
      fullName: 'Jordan Park',
      headline: 'Design Lead',
      experience: [
        { position: 'Designer', company_name: 'Curr Co' },
        null,
        { position: 'Junior Designer', company_name: 'Old Co', duration: '2018 - 2020' },
      ],
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, raw));

    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/jordan-park' });

    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') throw new Error('expected found');
    expect(outcome.result.profile?.currentRole).toBe('Designer');
    expect(outcome.result.profile?.pastRoles).toHaveLength(1);
    expect(outcome.result.profile?.pastRoles[0]).toContain('Junior Designer');
  });

  it('returns not_found on a pure 404/410 (no success:false body)', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(404));
    const r1 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/nobody' });
    expect(r1).toEqual({ kind: 'not_found', reason: 'scrapingdog 404' });

    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(410));
    const r2 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/gone' });
    expect(r2).toEqual({ kind: 'not_found', reason: 'scrapingdog 410' });
  });

  it('returns provider_error on a plain 400 (request/plan problem now that premium is always sent, not "profile unavailable")', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(400));
    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/bad-request' });
    expect(outcome).toEqual({ kind: 'provider_error', reason: 'scrapingdog 400' });
  });

  it('classifies a success:false body as provider_error regardless of HTTP status, never not_found (quota exhaustion is not "this person doesn\'t exist")', async () => {
    const quotaBody = {
      message: 'Free pack allows 4 LinkedIn calls only. Upgrade or contact info@scrapingdog.com.',
      success: false,
    };

    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, quotaBody));
    const r1 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/quota-200' });
    expect(r1.kind).toBe('provider_error');
    if (r1.kind === 'provider_error') expect(r1.reason).toContain('Free pack');

    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(400, quotaBody));
    const r2 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/quota-400' });
    expect(r2.kind).toBe('provider_error');
    if (r2.kind === 'provider_error') expect(r2.reason).toContain('Free pack');
  });

  // 3 Sep 2026: three real members enriched at once on the Lite plan (2
  // concurrent LinkedIn scrapes); the third got "Too many requests" and was
  // marked failed as though the plan were exhausted. A rate limit is a wait.
  it('a "Too many requests" body is retried with backoff, not treated as a plan error', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(200, { success: false, message: 'Too many requests, please wait.' }))
      .mockResolvedValueOnce(mockResponse(429, { success: false, message: 'Too many requests, please wait.' }))
      .mockResolvedValueOnce(mockResponse(200, { fullName: 'Jane Doe', headline: 'CTO', experience: [{ position: 'CTO', company_name: 'X' }] }));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/burst-third' });
    await jest.advanceTimersByTimeAsync(5_000);   // after attempt 1
    await jest.advanceTimersByTimeAsync(10_000);  // after attempt 2 (grows per attempt)

    const outcome = await promise;
    expect(outcome.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a transient "Something went wrong. Try again" body is retried like a rate limit', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(200, { success: false, message: 'Something went wrong. Try again or use premium=true.' }))
      .mockResolvedValueOnce(mockResponse(200, { fullName: 'Mateusz Giera', headline: 'Founder', experience: [{ position: 'Founder', company_name: 'X' }] }));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/transient' });
    await jest.advanceTimersByTimeAsync(5_000);

    const outcome = await promise;
    expect(outcome.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a rate limit that never clears ends as retry_exhausted (rate limited), never not_found, and skips the cached copy', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(200, { success: false, message: 'Too many requests, please wait.' }));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/burst-forever' });
    // Backoff is 5s × attempt: attempts land at 0s, 5s, 15s, 30s; the next
    // would start at 50s, past the 45s live budget, so it never fires.
    for (const ms of [5_000, 10_000, 15_000, 20_000, 25_000]) await jest.advanceTimersByTimeAsync(ms);

    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'retry_exhausted', rateLimited: true });
    // The cached-copy call would be rate limited too: no fifth call.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('requests premium=true (not private=true) and URL-encodes a unicode slug', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(200, { fullName: 'Claus', headline: 'Eng', experience: [{ position: 'Eng', company_name: 'X' }] }));

    await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/claus-sønderskov-51b2943' });

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl.toLowerCase()).toContain('linkid=claus-s%c3%b8nderskov-51b2943');
    expect(calledUrl).toContain('premium=true');
    expect(calledUrl).not.toContain('private=true');
  });

  it('maps the real captured fixture (Ali Hamza) to partial with the confirmed field shape', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(200, REAL_PROFILE_FIXTURE));

    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/ali-hamza-web-seo' });

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') throw new Error('expected partial');
    expect(outcome.missing.sort()).toEqual(['currentRole', 'headline'].sort());
    expect(outcome.result.profile?.fullName).toBe('Ali Hamza');
    expect(outcome.result.profile?.currentCompany).toBe('RankViz Pvt Limited');
    expect(outcome.result.profile?.photoUrl).toMatch(/^https:\/\/media\.licdn\.com\//);
    // 14 Sep 2026: the fixture's third entry is LinkedIn's masked "**** ***** ****"; it is not a past role.
    expect(outcome.result.profile?.pastRoles).toEqual(['at webgrower']);
    expect(outcome.result.profile?.education).toHaveLength(2);
  });

  // 18 Sep 2026 (Shradha): ScrapingDog answered 202 to every attempt for six
  // minutes while she sat on the wait page that promises "less than a minute",
  // and the cached copy of her page was never read because the exhausted live
  // scrape was treated like a rate limit. A live scrape now has a 45s budget
  // (no new attempt once it is spent) and a timed-out live scrape still reads
  // the cached copy.
  it('stops retrying 202s once the live budget is spent and still reads the cached copy', async () => {
    jest.useFakeTimers();
    const cachedBody = {
      fullName: 'Shradha Adhikari', headline: '', about: '',
      experience: [{ position: '', company_name: 'Raw Speed Networking | RSN' }],
    };
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      // The live scrape goes through the scrambled-case linkId; the cached copy through the canonical slug.
      return url.includes('linkId=shradhadhikari&') ? mockResponse(200, cachedBody) : mockResponse(202);
    });

    const promise = scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari' });
    // RETRY_DELAY_MS=20_000: live attempts at 0s, 20s and 40s; the fourth would start at 60s, past the budget.
    for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(20_000);

    const outcome = await promise;
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') throw new Error('expected partial');
    expect(outcome.result.profile?.currentCompany).toBe('Raw Speed Networking | RSN');
    expect(outcome.result.sources).toEqual(['scrapingdog:shradhadhikari']);
    expect(fetchMock).toHaveBeenCalledTimes(4); // three live attempts + the cached copy
  });

  it('a 202 loop with no cached copy either ends as retry_exhausted after the budget, not after six attempts', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(202));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/slow-index' });
    for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(20_000);

    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'retry_exhausted' });
    // Three live attempts inside the 45s budget, then one cached-copy attempt (also 202, its own 20s budget allows one more).
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('a single fetch never runs past the live hard cap', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(200, { fullName: 'Jane Doe', headline: 'CTO', experience: [{ position: 'CTO', company_name: 'X' }] }));

    await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/jane-doe' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns provider_error on network failure and 5xx', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
    const r1 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/flaky' });
    expect(r1).toEqual({ kind: 'provider_error', reason: 'ECONNRESET' });

    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(500));
    const r2 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/serverdown' });
    expect(r2).toEqual({ kind: 'provider_error', reason: 'scrapingdog 500' });
  });

  it('derives the slug from a full URL with query params and trailing slash', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse(200, { fullName: 'John Doe', headline: 'Eng', experience: [{ position: 'Eng', company_name: 'X' }] }));

    const outcome = await scrapingdogProvider.enrich({
      linkedinUrl: 'https://www.linkedin.com/in/John-Doe/?utm_source=share&utm_medium=member',
    });

    expect(outcome.kind).toBe('found');
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl.toLowerCase()).toContain('linkid=john-doe');
    if (outcome.kind === 'found') {
      expect(outcome.result.requestedLinkedinUrl).toBe('https://www.linkedin.com/in/john-doe');
    }
  });

  it('never echoes the API key in a provider_error reason', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fetch failed for test-key-do-not-leak'));
    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/leak-check' });
    expect(outcome.kind).toBe('provider_error');
    if (outcome.kind === 'provider_error') {
      expect(outcome.reason).not.toContain('test-key-do-not-leak');
    }
  });
});
