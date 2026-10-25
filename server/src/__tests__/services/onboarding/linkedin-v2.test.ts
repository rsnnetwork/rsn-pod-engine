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
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (...a: unknown[]) => mockQuery(...a),
}));

const mockSaveCandidate = jest.fn();
const mockSetState = jest.fn();
jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  __esModule: true,
  getEnrichmentState: jest.fn(),
  getCachedEnrichment: jest.fn(),
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

import { LINKEDIN_PROFILE_HELP, linkedinProfileUrl } from '@rsn/shared';
import {
  planLinkedinLookup, linkedinBlock, connectLinkedin, shownPrefill, prefillFrom, chosenFrom,
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
const state = (status: EnrichmentStatus, over: { startedAt?: string; completedAt?: string; lookupUrl?: string | null } = {}) => ({
  status, source: null, error: null, startedAt: null as string | null, completedAt: null as string | null,
  lookupUrl: null as string | null, ...over,
});

// The address is read by the one helper the request to join uses too (@rsn/shared, tested in full in
// linkedin-profile-url-shared.test.ts). Since 21 Oct 2026 the name keeps its capitals and its letters outside
// A to Z are stored encoded, as a browser copies them. Lookups compare addresses through linkedinSlug(),
// which ignores both, so this changes no lookup.
describe('linkedinProfileUrl, as onboarding v2 saves it: any profile form, one address', () => {
  it.each([
    'https://www.linkedin.com/in/jane-doe',
    'http://linkedin.com/in/jane-doe',
    'linkedin.com/in/jane-doe',
    'www.linkedin.com/in/jane-doe/',
    'https://uk.linkedin.com/in/jane-doe?trk=public_profile',
    'https://www.linkedin.com/in/jane-doe#experience',
    'https://m.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane-doe/details/experience/',
    '  linkedin.com/in/jane-doe  ',
    // What the live join form saved for someone who typed linkedin.com/in/jane-doe, carried onto their profile.
    'https://linkedin.com/in/linkedin.com/in/jane-doe',
  ])('%s', (input) => {
    expect(linkedinProfileUrl(input)).toBe(URL);
  });

  it('keeps the capitals the name was written with', () => {
    expect(linkedinProfileUrl('https://de.linkedin.com/in/Jane-Doe/')).toBe('https://www.linkedin.com/in/Jane-Doe');
    expect(linkedinProfileUrl('LINKEDIN.COM/IN/JANE-DOE')).toBe('https://www.linkedin.com/in/JANE-DOE');
  });

  it('keeps a slug with letters beyond English, encoded as a browser copies it', () => {
    expect(linkedinProfileUrl('https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller-123/'))
      .toBe('https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller-123');
    expect(linkedinProfileUrl('https://www.linkedin.com/in/jörg-müller-123'))
      .toBe('https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller-123');
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
    'linkedin.com/in/x',
    'https://www.linkedin.com:8080/in/jane-doe',
    'https://jane@www.linkedin.com/in/jane-doe',
  ])('refuses %j', (input) => {
    expect(linkedinProfileUrl(input)).toBeNull();
  });
});


// Fix round 1 (21 Oct 2026): which address a lookup ran for is RECORDED beside
// its state (lookupSlug, from inferred_profile.lastLookup), never guessed from
// the address on the member's row, which their own profile edit also writes.
describe('planLinkedinLookup: never a second paid lookup', () => {
  const base = { requestedSlug: 'jane-doe', lookupSlug: 'jane-doe' as string | null, usable: false, now: NOW };

  it('a lookup already running for that address: wait for it', () => {
    expect(planLinkedinLookup({ ...base, state: state('searching', { startedAt: ago(MIN) }) })).toBe('running');
  });

  it('a lookup running for another address, or one not recorded: this one goes after it', () => {
    expect(planLinkedinLookup({ ...base, lookupSlug: 'someone-else', state: state('searching', { startedAt: ago(MIN) }) })).toBe('queue');
    expect(planLinkedinLookup({ ...base, lookupSlug: null, state: state('searching', { startedAt: ago(MIN) }) })).toBe('queue');
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

  it('not found for an EARLIER address: the address now asked for is looked up', () => {
    // The review's path: A not found, B typed on the profile page (the row says B
    // before v2 ever sees it), then B posted in v2. B was never looked up.
    expect(planLinkedinLookup({ ...base, lookupSlug: 'jane-old', state: state('not_found', { completedAt: ago(MIN) }) })).toBe('start');
    expect(planLinkedinLookup({ ...base, lookupSlug: 'jane-old', state: state('failed', { completedAt: ago(MIN) }) })).toBe('start');
  });

  it('a state that does not say which address it was for answers for none', () => {
    expect(planLinkedinLookup({ ...base, lookupSlug: null, state: state('not_found', { completedAt: ago(MIN) }) })).toBe('start');
  });

  it('nothing ever looked up: start', () => {
    expect(planLinkedinLookup({ ...base, lookupSlug: null, state: state('none') })).toBe('start');
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
    expect(linkedinBlock(sources({ state: state('searching', { startedAt: ago(MIN), lookupUrl: URL }) }))).toEqual({ status: 'searching' });
  });

  it('found: the prefill, with Q4\'s likely answers', () => {
    expect(linkedinBlock(sources({ state: state('found', { lookupUrl: URL }), ownCache: found() }))).toEqual({
      status: 'found',
      prefill: {
        displayName: 'Jane Doe', photoUrl: 'https://media.licdn.com/jane.jpg', jobTitle: 'Founder & CEO',
        company: 'Vokt', industry: 'Software', location: 'Berlin, Germany',
        selfGuesses: ['self_founder_owner'], selfGuess: 'self_founder_owner',
      },
    });
  });

  it('partial when the page left the role out, and the guesses then come from the headline', () => {
    const thin = found({ confidence: 0.7 });
    thin.profile!.currentRole = null;
    const block = linkedinBlock(sources({ state: state('partial'), ownCache: thin }));
    expect(block.status).toBe('partial');
    expect(block.prefill?.jobTitle).toBeNull();
    expect(block.prefill?.selfGuesses).toEqual(['self_founder_owner']);
    expect(block.prefill?.selfGuess).toBe('self_founder_owner');
  });

  it('a result for an earlier address is not theirs', () => {
    const other = found({ requestedLinkedinUrl: 'https://www.linkedin.com/in/someone-else' });
    expect(linkedinBlock(sources({ state: state('found'), ownCache: other }))).toEqual({ status: 'none' });
  });

  it('the approval-time lookup counts when sign-in came before it finished', () => {
    expect(linkedinBlock(sources({ preload: { ...found(), provider: 'scrapingdog' } })).status).toBe('found');
  });

  it('not found and failed are said for the address they were for', () => {
    expect(linkedinBlock(sources({ state: state('not_found', { lookupUrl: URL }) }))).toEqual({ status: 'not_found' });
    expect(linkedinBlock(sources({ state: state('failed', { lookupUrl: URL }) }))).toEqual({ status: 'failed' });
    expect(linkedinBlock(sources({ state: state('searching', { startedAt: ago(10 * MIN), lookupUrl: URL }) }))).toEqual({ status: 'failed' });
  });

  it('and never about an address that was not looked up', () => {
    const earlier = 'https://www.linkedin.com/in/jane-old';
    expect(linkedinBlock(sources({ state: state('not_found', { lookupUrl: earlier }) }))).toEqual({ status: 'none' });
    expect(linkedinBlock(sources({ state: state('failed', { lookupUrl: earlier }) }))).toEqual({ status: 'none' });
    expect(linkedinBlock(sources({ state: state('searching', { startedAt: ago(10 * MIN), lookupUrl: earlier }) }))).toEqual({ status: 'none' });
    expect(linkedinBlock(sources({ state: state('not_found') }))).toEqual({ status: 'none' });
  });

  it('a result older than 90 days is not used', () => {
    expect(linkedinBlock(sources({ state: state('found', { lookupUrl: URL }), ownCache: found({ enrichedAt: ago(100 * DAY) }) }))).toEqual({ status: 'none' });
  });

  it('never carries a prefill without a usable result', () => {
    expect(linkedinBlock(sources({ state: state('found', { lookupUrl: URL }) }))).toEqual({ status: 'none' });
  });
});

// The 25 Oct review (ONB-03): LinkedIn suggests every answer to Q4 the member's own stated role supports, and
// never one read out of the rest of the page (a recommendation, a post), which is only a guess about them.
describe('prefillFrom: what LinkedIn suggests for Q4', () => {
  const withRole = (currentRole: string | null, over: Record<string, unknown> = {}) => {
    const r = found();
    Object.assign(r.profile!, { currentRole, headline: null, ...over });
    return r;
  };

  it('every answer the role supports, and the first as selfGuess for a screen that reads one', () => {
    const p = prefillFrom(withRole('Founder & CEO | Angel investor'));
    expect(p.selfGuesses).toEqual(['self_founder_owner', 'self_investor']);
    expect(p.selfGuess).toBe('self_founder_owner');
  });

  it('a role read from the rest of the page suggests nothing, though it still fills the title in for them to check', () => {
    const p = prefillFrom(withRole('Investor', { roleSource: 'inferred' }));
    expect(p.selfGuesses).toEqual([]);
    expect(p.selfGuess).toBeNull();
    expect(p.jobTitle).toBe('Investor');
  });

  it('with an inferred role, their own headline speaks, as when there is no role', () => {
    expect(prefillFrom(withRole('Investor', { roleSource: 'inferred', headline: 'Founder at Vokt' })).selfGuesses)
      .toEqual(['self_founder_owner']);
  });

  it('a stated role suggests, and so does one from an older result that never recorded its source', () => {
    expect(prefillFrom(withRole('Investor', { roleSource: 'stated' })).selfGuesses).toEqual(['self_investor']);
    expect(prefillFrom(withRole('Investor', { roleSource: undefined })).selfGuesses).toEqual(['self_investor']);
    expect(prefillFrom(withRole('Investor', { roleSource: null })).selfGuesses).toEqual(['self_investor']);
  });

  it('a manager is suggested as someone who leads, never as an advisor', () => {
    expect(prefillFrom(withRole('Engineering Manager')).selfGuesses).toEqual(['self_manager_leader']);
  });

  it('nothing to go on: no suggestions, and selfGuess is null', () => {
    const p = prefillFrom(withRole(null));
    expect(p.selfGuesses).toEqual([]);
    expect(p.selfGuess).toBeNull();
  });
});

// How the member chose on screen 2, read back from the stage the server recorded for it, so a choice made in one
// tab or on one device holds on every other.
describe('chosenFrom: the screen 2 choice, from its recorded stage', () => {
  it.each([
    ['linkedin_connected', 'linkedin'],
    ['linkedin_skipped', 'email'],
    [null, null],
    ['confirmed', null],
  ] as const)('%s is %s', (stage, chosen) => {
    expect(chosenFrom(stage)).toBe(chosen);
  });
});

describe('connectLinkedin', () => {
  /** What the member's row and their lookup look like right after this request saved the address. */
  let row: Record<string, unknown>;
  let current: { linkedin_url: string | null; display_name: string } | null;
  let updated: unknown[];
  beforeEach(() => {
    jest.clearAllMocks();
    row = {
      linkedin_url: URL, display_name: 'Jane Doe',
      enrichment_status: null, enrichment_started_at: null, enrichment_completed_at: null,
      lookup_url: null, enriched: null, preload: null,
    };
    current = { linkedin_url: URL, display_name: 'Jane Doe' };
    updated = [{ display_name: 'Jane Doe' }];
    mockQuery.mockImplementation((sql: string) => {
      if (/UPDATE users SET linkedin_url/.test(sql)) return Promise.resolve({ rows: updated });
      if (/lastLookup/.test(sql)) return Promise.resolve({ rows: [row] });
      if (/SELECT linkedin_url, display_name FROM users/.test(sql)) return Promise.resolve({ rows: current ? [current] : [] });
      return Promise.resolve({ rows: [] });
    });
    mockRun.mockResolvedValue(undefined);
    mockSaveCandidate.mockResolvedValue(undefined);
    mockSetState.mockResolvedValue(undefined);
  });
  const flush = () => new Promise(r => setImmediate(r));
  const lookedUp = (status: EnrichmentStatus, lookupUrl: string | null, at: string) => Object.assign(row, {
    enrichment_status: status,
    enrichment_started_at: status === 'searching' ? at : null,
    enrichment_completed_at: status === 'searching' ? null : at,
    lookup_url: lookupUrl,
  });

  it('refuses an address that is not a LinkedIn profile, and saves nothing', async () => {
    // AppError resets the prototype, so the class is checked by what it carries.
    await expect(connectLinkedin('u-1', 'https://example.com/jane')).rejects.toMatchObject({
      statusCode: 400, code: 'VALIDATION_ERROR', message: LINKEDIN_PROFILE_HELP, details: { url: [LINKEDIN_PROFILE_HELP] },
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a member that does not exist is a 404', async () => {
    updated = [];
    await expect(connectLinkedin('nope', URL)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('saves the address as one form and starts one lookup', async () => {
    const out = await connectLinkedin('u-1', 'uk.linkedin.com/in/jane-doe/?trk=x');
    expect(out.linkedinUrl).toBe(URL);
    expect(out.linkedin).toEqual({ status: 'searching' });
    expect(out.decision).toBe('start');
    const update = mockQuery.mock.calls.find(c => /UPDATE users SET linkedin_url/.test(c[0] as string))!;
    expect(update[1]).toEqual(['u-1', URL]);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith('u-1', { linkedinUrl: URL, fullName: 'Jane Doe' });
  });

  it('the address the live join form saved, with a LinkedIn address inside it, is saved as the member\'s own', async () => {
    const out = await connectLinkedin('u-1', 'https://linkedin.com/in/linkedin.com/in/jane-doe');
    expect(out.linkedinUrl).toBe(URL);
    const update = mockQuery.mock.calls.find(c => /UPDATE users SET linkedin_url/.test(c[0] as string))!;
    expect(update[1]).toEqual(['u-1', URL]);
    expect(mockRun).toHaveBeenCalledWith('u-1', { linkedinUrl: URL, fullName: 'Jane Doe' });
  });

  it('keeps the name\'s capitals, and the same name in other capitals is the same address: no second lookup', async () => {
    const out = await connectLinkedin('u-1', 'uk.linkedin.com/in/Jane-Doe/?trk=x');
    expect(out.linkedinUrl).toBe('https://www.linkedin.com/in/Jane-Doe');
    mockRun.mockClear();
    lookedUp('searching', 'https://www.linkedin.com/in/Jane-Doe', ago(MIN));
    expect((await connectLinkedin('u-1', URL)).decision).toBe('running');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('tells the member\'s screens when the lookup finishes', async () => {
    await connectLinkedin('u-1', URL);
    await flush();
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('the same address again while it runs: no second lookup', async () => {
    lookedUp('searching', URL, ago(MIN));
    const out = await connectLinkedin('u-1', URL);
    expect(out.decision).toBe('running');
    expect(out.linkedin).toEqual({ status: 'searching' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('the same address after it was found: no second lookup, and the prefill comes back', async () => {
    lookedUp('found', URL, ago(MIN));
    row.enriched = found();
    const out = await connectLinkedin('u-1', 'linkedin.com/in/jane-doe');
    expect(out.decision).toBe('reuse');
    expect(out.linkedin.status).toBe('found');
    expect(out.linkedin.prefill?.company).toBe('Vokt');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('the same address after it was not found: no second lookup', async () => {
    lookedUp('not_found', URL, ago(MIN));
    const out = await connectLinkedin('u-1', URL);
    expect(out).toMatchObject({ decision: 'done', linkedin: { status: 'not_found' } });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('not found for an earlier address, and the new one already typed on the profile page: it is looked up', async () => {
    // The row already says the new address (the profile edit wrote it, with no
    // lookup); the last lookup was for the old one.
    lookedUp('not_found', 'https://www.linkedin.com/in/jane-old', ago(MIN));
    const out = await connectLinkedin('u-1', URL);
    expect(out).toMatchObject({ decision: 'start', linkedin: { status: 'searching' } });
    expect(mockRun).toHaveBeenCalledWith('u-1', { linkedinUrl: URL, fullName: 'Jane Doe' });
  });

  it('a new address while another runs: looked up after it, not instead of it', async () => {
    lookedUp('searching', 'https://www.linkedin.com/in/old-me', ago(MIN));
    const order: string[] = [];
    mockRun.mockImplementation(async () => { order.push('run'); });
    const out = await connectLinkedin('u-1', URL);
    expect(out.decision).toBe('queue');
    await flush();
    expect(order).toEqual(['run', 'run']);
    expect(mockRun).toHaveBeenLastCalledWith('u-1', { linkedinUrl: URL, fullName: 'Jane Doe' });
  });

  it('changed twice while one runs: the follow-up looks up the address on the profile then', async () => {
    lookedUp('searching', 'https://www.linkedin.com/in/old-me', ago(MIN));
    const latest = 'https://www.linkedin.com/in/jane-doe-2';
    current = { linkedin_url: latest, display_name: 'Jane Doe' };
    await connectLinkedin('u-1', URL);
    await flush();
    expect(mockRun).toHaveBeenLastCalledWith('u-1', { linkedinUrl: latest, fullName: 'Jane Doe' });
  });

  it('removed while one ran: the follow-up looks nothing up', async () => {
    lookedUp('searching', 'https://www.linkedin.com/in/old-me', ago(MIN));
    current = { linkedin_url: null, display_name: 'Jane Doe' };
    await connectLinkedin('u-1', URL);
    await flush();
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('the approval-time lookup for that address is used instead of paying again, and recorded as for it', async () => {
    row.preload = { ...found(), provider: 'scrapingdog' };
    const out = await connectLinkedin('u-1', URL);
    expect(out.decision).toBe('reuse');
    expect(out.linkedin.status).toBe('found');
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockSaveCandidate).toHaveBeenCalledWith('u-1', expect.objectContaining({ requestedLinkedinUrl: URL }));
    expect(mockSetState).toHaveBeenCalledWith('u-1', expect.objectContaining({ status: 'found', source: 'scrapingdog', linkedinUrl: URL }));
  });

  it('a lookup that fails unexpectedly never surfaces as an error', async () => {
    mockRun.mockRejectedValue(new Error('boom'));
    await expect(connectLinkedin('u-1', URL)).resolves.toMatchObject({ decision: 'start' });
    await flush();
  });
});

describe('shownPrefill: the prefill the state shows, for the photo and the title', () => {
  beforeEach(() => jest.clearAllMocks());
  const answer = (r: Record<string, unknown>) => mockQuery.mockImplementation(() => Promise.resolve({ rows: [{
    linkedin_url: URL, display_name: 'Jane Doe', enrichment_status: 'found', enrichment_started_at: null,
    enrichment_completed_at: ago(MIN), lookup_url: URL, enriched: null, preload: null, ...r,
  }] }));

  it('the member\'s own fresh result for the address on the profile', async () => {
    answer({ enriched: found() });
    expect((await shownPrefill('u-1'))?.photoUrl).toBe('https://media.licdn.com/jane.jpg');
  });

  it('the approval-time result for that address', async () => {
    answer({ preload: { ...found(), provider: 'scrapingdog' } });
    expect((await shownPrefill('u-1'))?.jobTitle).toBe('Founder & CEO');
  });

  it('nothing for an earlier address, a stale result, or no address at all', async () => {
    answer({ enriched: found({ requestedLinkedinUrl: 'https://www.linkedin.com/in/someone-else' }) });
    expect(await shownPrefill('u-1')).toBeNull();
    answer({ enriched: found({ enrichedAt: ago(100 * DAY) }) });
    expect(await shownPrefill('u-1')).toBeNull();
    answer({ linkedin_url: null, enriched: found() });
    expect(await shownPrefill('u-1')).toBeNull();
  });
});
