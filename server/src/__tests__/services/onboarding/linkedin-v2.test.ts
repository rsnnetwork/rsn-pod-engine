// ─── Onboarding v2, screen 2: "Continue with LinkedIn" ───────────────────────
//
// The member's own profile link goes through the existing ScrapingDog lookup,
// which fills in role, company and industry for them to correct (Ali, 21 Oct).
// The lookup is paid, so it is idempotent: never a second one while one is
// running or after one finished for that address. The lookup itself is mocked
// here; the cache rule (isFreshCacheHit) is the real one.

const mockConfig: Record<string, unknown> = {
  enrichProvider: 'scrapingdog', scrapingdogApiKey: '', anthropicApiKey: '', onboardingChatModel: 'x',
};
jest.mock('../../../config', () => ({ __esModule: true, default: mockConfig }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: (c: { query: typeof mockClientQuery }) => unknown) => cb({ query: mockClientQuery }),
}));

const mockGetState = jest.fn();
const mockGetCached = jest.fn();
const mockSaveCandidate = jest.fn();
const mockSetState = jest.fn();
jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  __esModule: true,
  getEnrichmentState: (...a: unknown[]) => mockGetState(...a),
  getCachedEnrichment: (...a: unknown[]) => mockGetCached(...a),
  saveEnrichedCandidate: (...a: unknown[]) => mockSaveCandidate(...a),
  setEnrichmentState: (...a: unknown[]) => mockSetState(...a),
}));
jest.mock('../../../services/onboarding/avatar.service', () => ({
  __esModule: true, captureAvatar: jest.fn(), hasAvatar: jest.fn(), tryGravatar: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/onboarding/stage-events.repo', () => ({
  __esModule: true, record: jest.fn().mockResolvedValue(undefined), sanitizeErrorMessage: (e: unknown) => String(e),
}));

const mockRun = jest.fn();
jest.mock('../../../services/onboarding/enrichment.orchestrator', () => ({
  __esModule: true,
  ...jest.requireActual('../../../services/onboarding/enrichment.orchestrator'),
  runEnrichment: (...a: unknown[]) => mockRun(...a),
}));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/fanout', () => ({
  __esModule: true, fanoutUserEntity: (...a: unknown[]) => mockFanout(...a),
}));

import {
  normaliseLinkedinProfileUrl, planLinkedinLookup, linkedinBlock, connectLinkedin, LINKEDIN_URL_MESSAGE,
} from '../../../services/onboarding/linkedin-v2';
import type { EnrichResult } from '../../../services/onboarding/enrichment.service';
import type { EnrichmentStatus } from '../../../services/onboarding/enrichment.repo';

const URL = 'https://www.linkedin.com/in/jane-doe';
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const found = (over: Partial<EnrichResult> = {}): EnrichResult => ({
  profile: {
    fullName: 'Jane Doe', headline: 'Founder at Vokt', currentRole: 'Founder & CEO', currentCompany: 'Vokt',
    industry: 'Software', location: 'Berlin, Germany', summary: null, pastRoles: [], education: [], skills: [],
    likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [], questionsToVerify: [],
    linkedinUrl: URL, photoUrl: 'https://media.licdn.com/jane.jpg',
  },
  confidence: 0.95, sources: ['scrapingdog:jane-doe:live'], foundLinkedinUrl: URL, requestedLinkedinUrl: URL,
  enrichedAt: ago(DAY),
  ...over,
});
const state = (status: EnrichmentStatus, over: { startedAt?: string; completedAt?: string } = {}) => ({
  status, source: null, error: null, startedAt: null as string | null, completedAt: null as string | null, ...over,
});

describe('normaliseLinkedinProfileUrl: any profile form, one address', () => {
  it.each([
    'https://www.linkedin.com/in/jane-doe',
    'http://linkedin.com/in/jane-doe',
    'linkedin.com/in/jane-doe',
    'www.linkedin.com/in/jane-doe/',
    'https://uk.linkedin.com/in/jane-doe?trk=public_profile',
    'https://de.linkedin.com/in/Jane-Doe/',
    'LINKEDIN.COM/IN/JANE-DOE',
    'https://www.linkedin.com/in/jane-doe#experience',
    'https://m.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane-doe/details/experience/',
    '  linkedin.com/in/jane-doe  ',
  ])('%s', (input) => {
    expect(normaliseLinkedinProfileUrl(input)).toBe(URL);
  });

  it('keeps a slug with letters beyond English', () => {
    expect(normaliseLinkedinProfileUrl('https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller-123/'))
      .toBe('https://www.linkedin.com/in/jörg-müller-123');
  });

  it.each([
    '',
    'jane-doe',
    'https://example.com/in/jane-doe',
    'https://linkedin.com.evil.example/in/jane-doe',
    'https://notlinkedin.com/in/jane-doe',
    'https://evil.example/?next=linkedin.com/in/jane-doe',
    'https://www.linkedin.com/company/vokt',
    'https://www.linkedin.com/in/',
    'ftp://linkedin.com/in/jane-doe',
    'javascript:alert(1)//linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane doe',
    'https://www.linkedin.com/in/<script>',
  ])('refuses %j', (input) => {
    expect(normaliseLinkedinProfileUrl(input)).toBeNull();
  });
});

describe('planLinkedinLookup: never a second paid lookup', () => {
  const base = { requestedSlug: 'jane-doe', previousSlug: 'jane-doe', usable: false, now: NOW };

  it('a lookup already running for that address: wait for it', () => {
    expect(planLinkedinLookup({ ...base, state: state('searching', { startedAt: ago(MIN) }) })).toBe('running');
  });

  it('a lookup running for another address: this one goes after it', () => {
    expect(planLinkedinLookup({ ...base, previousSlug: 'someone-else', state: state('searching', { startedAt: ago(MIN) }) })).toBe('queue');
    expect(planLinkedinLookup({ ...base, previousSlug: null, state: state('searching', { startedAt: ago(MIN) }) })).toBe('queue');
  });

  it('a result for that address already: use it', () => {
    expect(planLinkedinLookup({ ...base, usable: true, state: state('found', { completedAt: ago(DAY) }) })).toBe('reuse');
  });

  it('that address was looked up and not found: that is the answer', () => {
    expect(planLinkedinLookup({ ...base, state: state('not_found', { completedAt: ago(DAY) }) })).toBe('done');
  });

  it('a failure is retried, but not straight away', () => {
    expect(planLinkedinLookup({ ...base, state: state('failed', { completedAt: ago(2 * MIN) }) })).toBe('done');
    expect(planLinkedinLookup({ ...base, state: state('failed', { completedAt: ago(11 * MIN) }) })).toBe('start');
  });

  it('a lookup that never finished does not block a new one', () => {
    expect(planLinkedinLookup({ ...base, state: state('searching', { startedAt: ago(4 * MIN) }) })).toBe('start');
  });

  it('a new address, or nothing ever looked up: start', () => {
    expect(planLinkedinLookup({ ...base, previousSlug: 'someone-else', state: state('not_found', { completedAt: ago(DAY) }) })).toBe('start');
    expect(planLinkedinLookup({ ...base, previousSlug: null, state: state('none') })).toBe('start');
  });

  it('a not-found result older than 90 days may be looked up again', () => {
    expect(planLinkedinLookup({ ...base, state: state('not_found', { completedAt: ago(91 * DAY) }) })).toBe('start');
  });
});

describe('linkedinBlock: what the screens are told', () => {
  const sources = (over: Record<string, unknown> = {}) => ({
    currentUrl: URL, state: state('none'), ownCache: null, preload: null, now: NOW, ...over,
  });

  it('no LinkedIn address: none', () => {
    expect(linkedinBlock(sources({ currentUrl: null, ownCache: found() }))).toEqual({ status: 'none' });
  });

  it('searching while a lookup runs', () => {
    expect(linkedinBlock(sources({ state: state('searching', { startedAt: ago(MIN) }) }))).toEqual({ status: 'searching' });
  });

  it('found: the prefill, with Q4\'s likeliest answer', () => {
    expect(linkedinBlock(sources({ state: state('found'), ownCache: found() }))).toEqual({
      status: 'found',
      prefill: {
        displayName: 'Jane Doe', photoUrl: 'https://media.licdn.com/jane.jpg', jobTitle: 'Founder & CEO',
        company: 'Vokt', industry: 'Software', location: 'Berlin, Germany', selfGuess: 'self_founder_owner',
      },
    });
  });

  it('partial when the page left the role out, and the guess then comes from the headline', () => {
    const thin = found({ confidence: 0.7 });
    thin.profile!.currentRole = null;
    const block = linkedinBlock(sources({ state: state('partial'), ownCache: thin }));
    expect(block.status).toBe('partial');
    expect(block.prefill?.jobTitle).toBeNull();
    expect(block.prefill?.selfGuess).toBe('self_founder_owner');
  });

  it('a result for an earlier address is not theirs', () => {
    const other = found({ requestedLinkedinUrl: 'https://www.linkedin.com/in/someone-else' });
    expect(linkedinBlock(sources({ state: state('found'), ownCache: other }))).toEqual({ status: 'none' });
  });

  it('the approval-time lookup counts when sign-in came before it finished', () => {
    expect(linkedinBlock(sources({ preload: { ...found(), provider: 'scrapingdog' } })).status).toBe('found');
  });

  it('not found and failed are said as they are, and a lookup that never finished is failed', () => {
    expect(linkedinBlock(sources({ state: state('not_found') }))).toEqual({ status: 'not_found' });
    expect(linkedinBlock(sources({ state: state('failed') }))).toEqual({ status: 'failed' });
    expect(linkedinBlock(sources({ state: state('searching', { startedAt: ago(10 * MIN) }) }))).toEqual({ status: 'failed' });
  });

  it('a result older than 90 days is not used', () => {
    expect(linkedinBlock(sources({ state: state('found'), ownCache: found({ enrichedAt: ago(100 * DAY) }) }))).toEqual({ status: 'none' });
  });

  it('never carries a prefill without a usable result', () => {
    expect(linkedinBlock(sources({ state: state('found') }))).toEqual({ status: 'none' });
  });
});

describe('connectLinkedin', () => {
  let previousUrl: string | null;
  beforeEach(() => {
    jest.clearAllMocks();
    previousUrl = null;
    mockClientQuery.mockImplementation((sql: string) => (
      /FOR UPDATE/.test(sql)
        ? Promise.resolve({ rows: [{ linkedin_url: previousUrl, display_name: 'Jane Doe' }] })
        : Promise.resolve({ rows: [] })
    ));
    mockQuery.mockResolvedValue({ rows: [] }); // no approval-time lookup
    mockGetState.mockResolvedValue(state('none'));
    mockGetCached.mockResolvedValue(null);
    mockRun.mockResolvedValue(undefined);
    mockSaveCandidate.mockResolvedValue(undefined);
    mockSetState.mockResolvedValue(undefined);
  });
  const flush = () => new Promise(r => setImmediate(r));

  it('refuses an address that is not a LinkedIn profile, and saves nothing', async () => {
    // AppError resets the prototype, so the class is checked by what it carries.
    await expect(connectLinkedin('u-1', 'https://example.com/jane')).rejects.toMatchObject({
      statusCode: 400, code: 'VALIDATION_ERROR', message: LINKEDIN_URL_MESSAGE, details: { url: [LINKEDIN_URL_MESSAGE] },
    });
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('saves the address as one form and starts one lookup', async () => {
    const out = await connectLinkedin('u-1', 'uk.linkedin.com/in/Jane-Doe/?trk=x');
    expect(out.linkedinUrl).toBe(URL);
    expect(out.linkedin).toEqual({ status: 'searching' });
    expect(out.decision).toBe('start');
    const update = mockClientQuery.mock.calls.find(c => /UPDATE users SET linkedin_url/.test(c[0] as string))!;
    expect(update[1]).toEqual(['u-1', URL]);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith('u-1', { linkedinUrl: URL, fullName: 'Jane Doe' });
  });

  it('tells the member\'s screens when the lookup finishes', async () => {
    await connectLinkedin('u-1', URL);
    await flush();
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('the same address again while it runs: no second lookup', async () => {
    previousUrl = URL;
    mockGetState.mockResolvedValue(state('searching', { startedAt: ago(MIN) }));
    const out = await connectLinkedin('u-1', URL);
    expect(out.decision).toBe('running');
    expect(out.linkedin).toEqual({ status: 'searching' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('the same address after it was found: no second lookup, and the prefill comes back', async () => {
    previousUrl = URL;
    mockGetState.mockResolvedValue(state('found', { completedAt: ago(MIN) }));
    mockGetCached.mockResolvedValue(found());
    const out = await connectLinkedin('u-1', 'linkedin.com/in/jane-doe');
    expect(out.decision).toBe('reuse');
    expect(out.linkedin.status).toBe('found');
    expect(out.linkedin.prefill?.company).toBe('Vokt');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('the same address after it was not found: no second lookup', async () => {
    previousUrl = URL;
    mockGetState.mockResolvedValue(state('not_found', { completedAt: ago(MIN) }));
    const out = await connectLinkedin('u-1', URL);
    expect(out).toMatchObject({ decision: 'done', linkedin: { status: 'not_found' } });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a new address while another runs: looked up after it, not instead of it', async () => {
    previousUrl = 'https://www.linkedin.com/in/old-me';
    mockGetState.mockResolvedValue(state('searching', { startedAt: ago(MIN) }));
    const order: string[] = [];
    mockRun.mockImplementation(async () => { order.push('run'); });
    const out = await connectLinkedin('u-1', URL);
    expect(out.decision).toBe('queue');
    await flush();
    expect(order).toEqual(['run', 'run']);
    expect(mockRun).toHaveBeenLastCalledWith('u-1', { linkedinUrl: URL, fullName: 'Jane Doe' });
  });

  it('the approval-time lookup for that address is used instead of paying again', async () => {
    previousUrl = URL;
    mockQuery.mockResolvedValue({ rows: [{ enriched: { ...found(), provider: 'scrapingdog' } }] });
    const out = await connectLinkedin('u-1', URL);
    expect(out.decision).toBe('reuse');
    expect(out.linkedin.status).toBe('found');
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockSaveCandidate).toHaveBeenCalledWith('u-1', expect.objectContaining({ requestedLinkedinUrl: URL }));
    expect(mockSetState).toHaveBeenCalledWith('u-1', expect.objectContaining({ status: 'found', source: 'scrapingdog' }));
  });

  it('a lookup that fails unexpectedly never surfaces as an error', async () => {
    mockRun.mockRejectedValue(new Error('boom'));
    await expect(connectLinkedin('u-1', URL)).resolves.toMatchObject({ decision: 'start' });
    await flush();
  });
});
