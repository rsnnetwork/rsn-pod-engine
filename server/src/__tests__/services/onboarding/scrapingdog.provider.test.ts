jest.mock('../../../config', () => ({
  __esModule: true,
  default: {
    scrapingdogApiKey: 'test-key-do-not-leak',
    logLevel: 'silent',
    isDev: false,
    env: 'test',
  },
}));

import { scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';

/** Build a minimal fetch-like Response the provider only ever reads .status/.json() from. */
function mockResponse(status: number, body?: any): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe('scrapingdogProvider', () => {
  afterEach(() => {
    jest.useRealTimers();
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
    expect(outcome.result.sources).toEqual(['scrapingdog:jane-doe']);
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

  it('returns not_found on 404 and 400', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(404));
    const r1 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/nobody' });
    expect(r1).toEqual({ kind: 'not_found', reason: 'scrapingdog 404' });

    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse(400));
    const r2 = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/bad-request' });
    expect(r2).toEqual({ kind: 'not_found', reason: 'scrapingdog 400' });
  });

  it('retries on 202 up to maxAttempts then retry_exhausted', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(202));

    const promise = scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/slow-index' });

    // MAX_ATTEMPTS=6, RETRY_DELAY_MS=20_000 — the loop sleeps only BETWEEN attempts
    // (no sleep after the final 202), so 5 advances cover all 6 fetch attempts.
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(20_000);
    }

    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'retry_exhausted' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
    expect(calledUrl).toContain('linkId=john-doe');
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
