// ─── Enrichment Orchestrator — background job tests ─────────────────────────
//
// runEnrichment() is the fire-and-forget-safe job wired from POST
// /onboarding/enrich: it never throws, and always leaves the DB in a terminal
// (or cache-reflecting) enrichment state. Provider + repo + the Anthropic
// client are all mocked; the pure helpers (linkedinSlug, normalizeLinkedinUrl,
// applyMatchVerification) run for real via requireActual so the identity /
// verification behavior is exercised, not stubbed away.

const mockConfig: any = {
  enrichProvider: 'scrapingdog',
  scrapingdogApiKey: 'sd-key',
  anthropicApiKey: 'anthropic-key',
  onboardingChatModel: 'claude-haiku-4-5',
};

jest.mock('../../../config', () => ({
  __esModule: true,
  default: mockConfig,
}));

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  __esModule: true,
  getCachedEnrichment: jest.fn(),
  getEnrichmentState: jest.fn(),
  saveEnrichedCandidate: jest.fn(),
  setEnrichmentState: jest.fn(),
}));

jest.mock('../../../services/onboarding/providers/scrapingdog.provider', () => ({
  __esModule: true,
  scrapingdogProvider: { name: 'scrapingdog', enrich: jest.fn() },
}));

jest.mock('../../../services/onboarding/avatar.service', () => ({
  __esModule: true,
  captureAvatar: jest.fn(),
}));

jest.mock('../../../services/onboarding/stage-events.repo', () => ({
  __esModule: true,
  record: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../services/onboarding/enrichment.service', () => {
  const actual = jest.requireActual('../../../services/onboarding/enrichment.service');
  return {
    __esModule: true,
    ...actual,
    enrichProfile: jest.fn(),
    getClient: jest.fn(),
  };
});

import logger from '../../../config/logger';
import { getCachedEnrichment, getEnrichmentState, saveEnrichedCandidate, setEnrichmentState } from '../../../services/onboarding/enrichment.repo';
import { scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';
import { enrichProfile, getClient, type EnrichResult, type EnrichedProfile } from '../../../services/onboarding/enrichment.service';
import { captureAvatar } from '../../../services/onboarding/avatar.service';
import { record as recordStageEvent } from '../../../services/onboarding/stage-events.repo';
import { runEnrichment } from '../../../services/onboarding/enrichment.orchestrator';

const mockGetCachedEnrichment = getCachedEnrichment as jest.Mock;
const mockGetEnrichmentState = getEnrichmentState as jest.Mock;
const mockSaveEnrichedCandidate = saveEnrichedCandidate as jest.Mock;
const mockSetEnrichmentState = setEnrichmentState as jest.Mock;
const mockScrapingdogEnrich = scrapingdogProvider.enrich as jest.Mock;
const mockEnrichProfile = enrichProfile as jest.Mock;
const mockGetClient = getClient as jest.Mock;
const mockCaptureAvatar = captureAvatar as jest.Mock;
const mockRecordStageEvent = recordStageEvent as jest.Mock;

/** Find a recorded stage-event call by stage name (there may be several calls per run). */
function stageCall(stage: string) {
  return mockRecordStageEvent.mock.calls.find((c) => c[1] === stage);
}

const REQ_URL = 'https://www.linkedin.com/in/jane-doe';

function baseProfile(over: Partial<EnrichedProfile> = {}): EnrichedProfile {
  return {
    fullName: 'Jane Doe', headline: 'VP Eng', currentRole: 'VP Eng', currentCompany: 'Acme',
    industry: 'Software', location: 'Berlin', summary: null, pastRoles: [], education: [],
    skills: [], likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [],
    questionsToVerify: [], linkedinUrl: REQ_URL, photoUrl: null, ...over,
  };
}

function foundResult(over: Partial<EnrichResult> = {}): EnrichResult {
  return {
    profile: baseProfile(),
    confidence: 0.95,
    sources: ['scrapingdog:jane-doe'],
    foundLinkedinUrl: REQ_URL,
    requestedLinkedinUrl: REQ_URL,
    enrichedAt: new Date().toISOString(),
    ...over,
  };
}

function lastStateCall() {
  return mockSetEnrichmentState.mock.calls[mockSetEnrichmentState.mock.calls.length - 1];
}

describe('runEnrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.enrichProvider = 'scrapingdog';
    mockConfig.scrapingdogApiKey = 'sd-key';
    mockConfig.anthropicApiKey = 'anthropic-key';
    mockGetCachedEnrichment.mockResolvedValue(null);
    mockGetEnrichmentState.mockResolvedValue({ status: 'none', source: null, error: null, startedAt: null, completedAt: null });
    mockSetEnrichmentState.mockResolvedValue(undefined);
    mockSaveEnrichedCandidate.mockResolvedValue(undefined);
    mockCaptureAvatar.mockResolvedValue(true);
    mockRecordStageEvent.mockResolvedValue(undefined);
    // Default: extras pass "succeeds" with no extra fields (keeps most tests
    // from needing to think about the extras call at all).
    mockGetClient.mockReturnValue({
      messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] }) },
    });
  });

  // ─── Terminal transitions via the provider ─────────────────────────────────

  it('found: saves the candidate and marks enrichment_status=found', async () => {
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    expect(mockSaveEnrichedCandidate).toHaveBeenCalledTimes(1);
    expect(mockSaveEnrichedCandidate.mock.calls[0][0]).toBe('u1');
    const [, params] = lastStateCall();
    expect(params).toMatchObject({ status: 'found', source: 'scrapingdog' });
  });

  it('partial: saves the candidate and marks enrichment_status=partial', async () => {
    mockScrapingdogEnrich.mockResolvedValue({
      kind: 'partial', result: foundResult({ confidence: 0.7 }), photoUrl: null, missing: ['headline'],
    });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    expect(mockSaveEnrichedCandidate).toHaveBeenCalledTimes(1);
    const [, params] = lastStateCall();
    expect(params).toMatchObject({ status: 'partial', source: 'scrapingdog' });
  });

  it('not_found via provider: no save, marks enrichment_status=not_found with the provider reason', async () => {
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'not_found', reason: 'scrapingdog 404' });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    expect(mockSaveEnrichedCandidate).not.toHaveBeenCalled();
    const [, params] = lastStateCall();
    expect(params).toMatchObject({ status: 'not_found', error: 'scrapingdog 404', source: 'scrapingdog' });
  });

  it('(c) not_found on null linkedinUrl + no cache: never calls the provider, error is "no linkedin url"', async () => {
    // mockGetCachedEnrichment defaults to null (beforeEach) — no cache at all,
    // so there is nothing to recover an identity from.
    await runEnrichment('u1', { linkedinUrl: null });

    expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
    expect(mockSaveEnrichedCandidate).not.toHaveBeenCalled();
    const [, params] = lastStateCall();
    expect(params).toMatchObject({ status: 'not_found', error: 'no linkedin url' });
  });

  it('failed on provider_error: marks enrichment_status=failed with the reason', async () => {
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'provider_error', reason: 'scrapingdog 500' });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    const [, params] = lastStateCall();
    expect(params).toMatchObject({ status: 'failed', error: 'scrapingdog 500', source: 'scrapingdog' });
  });

  it('failed on retry_exhausted: marks enrichment_status=failed', async () => {
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'retry_exhausted' });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    const [, params] = lastStateCall();
    expect(params.status).toBe('failed');
    expect(typeof params.error).toBe('string');
    expect(params.error.length).toBeGreaterThan(0);
  });

  it('provider "none": marks not_found without calling any provider, no forced error text', async () => {
    mockConfig.enrichProvider = 'none';

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
    expect(mockEnrichProfile).not.toHaveBeenCalled();
    const [, params] = lastStateCall();
    expect(params.status).toBe('not_found');
    expect(params.error).not.toBe('no linkedin url');
  });

  // ─── 90-day cache ───────────────────────────────────────────────────────────

  describe('90-day cache', () => {
    it('fresh cache + same slug: no provider call, state reflects the cached outcome', async () => {
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ confidence: 0.95, requestedLinkedinUrl: REQ_URL }));

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
      expect(mockSaveEnrichedCandidate).not.toHaveBeenCalled();
      const [, params] = lastStateCall();
      expect(params.status).toBe('found');
    });

    it('fresh cache with mid-range confidence maps to partial', async () => {
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ confidence: 0.4, requestedLinkedinUrl: REQ_URL }));

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
      const [, params] = lastStateCall();
      expect(params.status).toBe('partial');
    });

    it('stale cache (>90 days old) re-runs the provider', async () => {
      const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ enrichedAt: stale, requestedLinkedinUrl: REQ_URL }));
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
    });

    it('cache for a different LinkedIn URL re-runs the provider', async () => {
      mockGetCachedEnrichment.mockResolvedValue(
        foundResult({ requestedLinkedinUrl: 'https://www.linkedin.com/in/someone-else' }),
      );
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
    });

    it('cache with confidence 0 is ignored (re-runs the provider)', async () => {
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ confidence: 0 }));
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Cache-first identity resolution (fresh cache must beat a null URL) ────
  // Regression coverage for the critical review finding: the cache check now
  // runs BEFORE the no-URL branch, so an empty POST body (linkedinUrl: null)
  // can never downgrade a fresh cached found/partial to not_found.
  describe('cache-first identity resolution (empty-body input)', () => {
    it('(a) empty input + fresh cache: no provider call, state lands/stays found', async () => {
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ confidence: 0.95, requestedLinkedinUrl: REQ_URL }));

      await runEnrichment('u1', { linkedinUrl: null, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
      expect(mockSaveEnrichedCandidate).not.toHaveBeenCalled();
      const [, params] = lastStateCall();
      expect(params.status).toBe('found');
    });

    // Behavior refinement (b): the cached requestedLinkedinUrl is itself a
    // recoverable identity anchor. A stale cache means we can't trust the
    // CONTENT anymore, but we can still trust WHO it was about — so re-enrich
    // against that URL instead of forcing not_found just because this call's
    // body happened to carry no URL.
    it('(b) empty input + stale cache WITH a recoverable requestedLinkedinUrl: re-enriches against it', async () => {
      const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ enrichedAt: stale, requestedLinkedinUrl: REQ_URL }));
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: null, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
      expect(mockScrapingdogEnrich.mock.calls[0][0]).toMatchObject({ linkedinUrl: REQ_URL });
      const [, params] = lastStateCall();
      expect(params.status).toBe('found');
    });

    it('(b) empty input + stale cache with NO recoverable URL: not_found ("no linkedin url")', async () => {
      const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ enrichedAt: stale, requestedLinkedinUrl: null }));

      await runEnrichment('u1', { linkedinUrl: null, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
      const [, params] = lastStateCall();
      expect(params).toMatchObject({ status: 'not_found', error: 'no linkedin url' });
    });
  });

  // ─── Extras pass (facts-grounded, no-tools Haiku call) ─────────────────────

  describe('facts-grounded extras pass', () => {
    it('merges likelyWantsToMeet/likelyOffers/conversationStarters/questionsToVerify on success', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });
      const create = jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            likelyWantsToMeet: ['founders'],
            likelyOffers: ['intros'],
            conversationStarters: ['Saw you worked at Acme!'],
            questionsToVerify: ['Still VP Eng?'],
          }),
        }],
      });
      mockGetClient.mockReturnValue({ messages: { create } });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 800 });
      const saved = mockSaveEnrichedCandidate.mock.calls[0][1] as EnrichResult;
      expect(saved.profile?.likelyWantsToMeet).toEqual(['founders']);
      expect(saved.profile?.conversationStarters).toEqual(['Saw you worked at Acme!']);
    });

    it('extras failure does not fail the enrichment — proceeds to found/saved', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });
      mockGetClient.mockReturnValue({ messages: { create: jest.fn().mockRejectedValue(new Error('anthropic down')) } });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockSaveEnrichedCandidate).toHaveBeenCalledTimes(1);
      const [, params] = lastStateCall();
      expect(params.status).toBe('found');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('extras pass is skipped for not_found/failed outcomes', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'not_found', reason: 'scrapingdog 404' });
      const create = jest.fn();
      mockGetClient.mockReturnValue({ messages: { create } });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(create).not.toHaveBeenCalled();
    });

    it('extras pass is skipped for the claude_web legacy path — no double-spend, legacy hint fields untouched', async () => {
      mockConfig.enrichProvider = 'claude_web';
      const legacyResult = foundResult({
        confidence: 0.9,
        profile: baseProfile({
          likelyWantsToMeet: ['investors'],
          likelyOffers: ['mentorship'],
          conversationStarters: ['Ask about their last raise'],
          questionsToVerify: ['Still leading Eng?'],
        }),
      });
      mockEnrichProfile.mockResolvedValue(legacyResult);
      const create = jest.fn();
      mockGetClient.mockReturnValue({ messages: { create } });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(create).not.toHaveBeenCalled();
      const saved = mockSaveEnrichedCandidate.mock.calls[0][1] as EnrichResult;
      expect(saved.profile?.likelyWantsToMeet).toEqual(['investors']);
      expect(saved.profile?.likelyOffers).toEqual(['mentorship']);
      expect(saved.profile?.conversationStarters).toEqual(['Ask about their last raise']);
      expect(saved.profile?.questionsToVerify).toEqual(['Still leading Eng?']);
    });
  });

  // ─── Concurrency guards ─────────────────────────────────────────────────────

  describe('concurrency guards', () => {
    it('same-user concurrent calls: the second joins the in-flight run — only one provider call', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      // Called back-to-back, synchronously — the in-flight Map entry from the
      // first call is set before the second call's lookup runs, so it joins
      // rather than starting a second attempt.
      const p1 = runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
      const p2 = runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      await Promise.all([p1, p2]);

      expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
    });

    it('stale "searching" (older than 5 minutes) is treated as crashed and re-runs', async () => {
      const staleStart = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      mockGetEnrichmentState.mockResolvedValue({
        status: 'searching', source: 'scrapingdog', error: null, startedAt: staleStart, completedAt: null,
      });
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
    });

    it('fresh "searching" (within 5 minutes) skips — no provider call, no state write', async () => {
      const freshStart = new Date(Date.now() - 60 * 1000).toISOString();
      mockGetEnrichmentState.mockResolvedValue({
        status: 'searching', source: 'scrapingdog', error: null, startedAt: freshStart, completedAt: null,
      });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
      expect(mockSetEnrichmentState).not.toHaveBeenCalled();
    });
  });

  // ─── Never throws ───────────────────────────────────────────────────────────

  it('never throws: an unexpected provider rejection still resolves and lands in a failed state', async () => {
    mockScrapingdogEnrich.mockRejectedValue(new Error('unexpected crash'));

    await expect(runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' })).resolves.toBeUndefined();

    const [, params] = lastStateCall();
    expect(params.status).toBe('failed');
  });

  it('never throws: a repo write failure during the terminal transition is swallowed', async () => {
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });
    mockSetEnrichmentState.mockRejectedValue(new Error('db down'));

    await expect(runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' })).resolves.toBeUndefined();
  });

  // ─── Unknown provider config value ──────────────────────────────────────────

  it('unknown/typo\'d enrichProvider value falls back to scrapingdog (with a warning)', async () => {
    mockConfig.enrichProvider = 'scrapingdogg'; // typo
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    expect(mockScrapingdogEnrich).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    const [, params] = lastStateCall();
    expect(params.source).toBe('scrapingdog');
  });

  // ─── claude_web legacy delegation ───────────────────────────────────────────

  it('claude_web: delegates to the legacy enrichProfile() path, never touches scrapingdog', async () => {
    mockConfig.enrichProvider = 'claude_web';
    mockEnrichProfile.mockResolvedValue(foundResult({ confidence: 0.8 }));

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    expect(mockEnrichProfile).toHaveBeenCalledTimes(1);
    expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
    expect(mockSaveEnrichedCandidate).toHaveBeenCalledTimes(1);
    const [, params] = lastStateCall();
    expect(params).toMatchObject({ status: 'found', source: 'claude_web' });
  });

  it('claude_web: mid confidence maps to partial, low confidence maps to not_found', async () => {
    mockConfig.enrichProvider = 'claude_web';

    mockEnrichProfile.mockResolvedValueOnce(foundResult({ confidence: 0.5 }));
    await runEnrichment('u2', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
    expect(lastStateCall()[1]).toMatchObject({ status: 'partial' });

    mockEnrichProfile.mockResolvedValueOnce(foundResult({ confidence: 0.1 }));
    await runEnrichment('u3', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
    expect(lastStateCall()[1]).toMatchObject({ status: 'not_found' });
  });

  // ─── applyMatchVerification pass-through (A6) ──────────────────────────────

  it('A6: a scrapingdog result passes through applyMatchVerification unchanged (found === requested slug)', async () => {
    const result = foundResult({ confidence: 0.95, foundLinkedinUrl: REQ_URL, requestedLinkedinUrl: REQ_URL });
    mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result, photoUrl: null });

    await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

    const saved = mockSaveEnrichedCandidate.mock.calls[0][1] as EnrichResult;
    expect(saved.confidence).toBe(0.95);
    expect(saved.requestedLinkedinUrl).toBe(REQ_URL);
  });

  // ─── A7: LinkedIn photo capture wiring ──────────────────────────────────────
  // captureAvatar is fire-and-forget from the orchestrator's point of view —
  // it's kicked from the found/partial branch but never awaited, and a
  // rejection must never change (or delay) the enrichment's own terminal
  // state. See avatar.service.test.ts for captureAvatar's own behavior.
  describe('A7: photo capture wiring', () => {
    it('found outcome with a photoUrl triggers captureAvatar(userId, photoUrl)', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: 'https://cdn.example.com/jane.jpg' });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockCaptureAvatar).toHaveBeenCalledWith('u1', 'https://cdn.example.com/jane.jpg');
    });

    it('partial outcome with a photoUrl also triggers captureAvatar', async () => {
      mockScrapingdogEnrich.mockResolvedValue({
        kind: 'partial', result: foundResult({ confidence: 0.7 }), photoUrl: 'https://cdn.example.com/jane.jpg', missing: ['headline'],
      });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockCaptureAvatar).toHaveBeenCalledWith('u1', 'https://cdn.example.com/jane.jpg');
    });

    it('photoUrl null: skips captureAvatar entirely', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockCaptureAvatar).not.toHaveBeenCalled();
    });

    it('not_found/failed outcomes never call captureAvatar', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'not_found', reason: 'scrapingdog 404' });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockCaptureAvatar).not.toHaveBeenCalled();
    });

    it('captureAvatar rejecting does not change the enrichment terminal state (fire-and-forget-safe)', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: 'https://cdn.example.com/jane.jpg' });
      mockCaptureAvatar.mockRejectedValue(new Error('avatar capture blew up'));

      await expect(runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' })).resolves.toBeUndefined();

      const [, params] = lastStateCall();
      expect(params).toMatchObject({ status: 'found', source: 'scrapingdog' });
      expect(mockSaveEnrichedCandidate).toHaveBeenCalledTimes(1);
    });

    it('captureAvatar returning false (a handled download failure) does not change the enrichment terminal state', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: 'https://cdn.example.com/jane.jpg' });
      mockCaptureAvatar.mockResolvedValue(false);

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const [, params] = lastStateCall();
      expect(params).toMatchObject({ status: 'found', source: 'scrapingdog' });
    });

    // ─── E1: photo_captured / photo_failed stage-event telemetry ────────────
    describe('E1: photo capture stage events', () => {
      it('a successful capture records photo_captured with a duration_ms', async () => {
        mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: 'https://cdn.example.com/jane.jpg' });
        mockCaptureAvatar.mockResolvedValue(true);

        await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
        await new Promise((r) => setImmediate(r));

        const call = stageCall('photo_captured');
        expect(call).toBeDefined();
        expect(call![0]).toBe('u1');
        expect(typeof call![3]).toBe('number');
      });

      it('captureAvatar resolving false records photo_failed', async () => {
        mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: 'https://cdn.example.com/jane.jpg' });
        mockCaptureAvatar.mockResolvedValue(false);

        await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
        await new Promise((r) => setImmediate(r));

        expect(stageCall('photo_failed')).toBeDefined();
        expect(stageCall('photo_captured')).toBeUndefined();
      });

      it('captureAvatar rejecting records photo_failed with the error message as reason', async () => {
        mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: 'https://cdn.example.com/jane.jpg' });
        mockCaptureAvatar.mockRejectedValue(new Error('avatar capture blew up'));

        await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
        await new Promise((r) => setImmediate(r));

        const call = stageCall('photo_failed');
        expect(call).toBeDefined();
        expect(call![2]).toMatchObject({ reason: 'avatar capture blew up' });
      });

      it('photoUrl null: no photo stage event at all', async () => {
        mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

        await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });
        await new Promise((r) => setImmediate(r));

        expect(stageCall('photo_captured')).toBeUndefined();
        expect(stageCall('photo_failed')).toBeUndefined();
      });
    });
  });

  // ─── E1: enrichment stage-event telemetry ──────────────────────────────────
  // record() is fire-and-forget from the orchestrator's point of view (mirrors
  // captureAvatar/markInProgress elsewhere): a stage-event write must never be
  // able to affect the enrichment outcome it's describing.
  describe('E1: enrichment stage-event telemetry', () => {
    it('enrich_started fires when the searching state is written, detail={provider}', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const call = stageCall('enrich_started');
      expect(call).toBeDefined();
      expect(call![0]).toBe('u1');
      expect(call![2]).toEqual({ provider: 'scrapingdog' });
    });

    it('enrich_found fires on a found terminal transition with a duration_ms', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const call = stageCall('enrich_found');
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ provider: 'scrapingdog' });
      expect(typeof call![3]).toBe('number');
    });

    it('enrich_partial fires on a partial terminal transition', async () => {
      mockScrapingdogEnrich.mockResolvedValue({
        kind: 'partial', result: foundResult({ confidence: 0.7 }), photoUrl: null, missing: ['headline'],
      });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(stageCall('enrich_partial')).toBeDefined();
    });

    it('enrich_not_found fires with reason "no linkedin url" when nothing is resolvable', async () => {
      await runEnrichment('u1', { linkedinUrl: null });

      const call = stageCall('enrich_not_found');
      expect(call).toBeDefined();
      expect(call![2]).toMatchObject({ reason: 'no linkedin url' });
    });

    it('enrich_not_found fires with the provider\'s reason on a provider not_found', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'not_found', reason: 'scrapingdog 404' });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const call = stageCall('enrich_not_found');
      expect(call![2]).toMatchObject({ provider: 'scrapingdog', reason: 'scrapingdog 404' });
    });

    it('enrich_not_found fires (no forced reason) when the resolved provider is "none"', async () => {
      mockConfig.enrichProvider = 'none';

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const call = stageCall('enrich_not_found');
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ provider: 'none' });
    });

    it('enrich_failed fires with the provider\'s reason on a provider_error', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'provider_error', reason: 'scrapingdog 500' });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const call = stageCall('enrich_failed');
      expect(call![2]).toMatchObject({ provider: 'scrapingdog', reason: 'scrapingdog 500' });
    });

    it('enrich_failed fires on an unexpected orchestrator crash, reason = the error message', async () => {
      mockScrapingdogEnrich.mockRejectedValue(new Error('unexpected crash'));

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      const call = stageCall('enrich_failed');
      expect(call).toBeDefined();
      expect(call![2]).toMatchObject({ reason: 'unexpected crash' });
    });

    it('a fresh cache hit still records the enrich_* stage matching the cached outcome (no enrich_started, no provider call)', async () => {
      mockGetCachedEnrichment.mockResolvedValue(foundResult({ confidence: 0.95, requestedLinkedinUrl: REQ_URL }));

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockScrapingdogEnrich).not.toHaveBeenCalled();
      expect(stageCall('enrich_started')).toBeUndefined();
      expect(stageCall('enrich_found')).toBeDefined();
    });

    it('the fresh "searching" concurrency short-circuit records no stage event at all', async () => {
      const freshStart = new Date(Date.now() - 60 * 1000).toISOString();
      mockGetEnrichmentState.mockResolvedValue({
        status: 'searching', source: 'scrapingdog', error: null, startedAt: freshStart, completedAt: null,
      });

      await runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' });

      expect(mockRecordStageEvent).not.toHaveBeenCalled();
    });

    it('never throws: a rejecting stage-event record() call cannot surface (repo contract — mocked here as a rejection to prove the orchestrator does not await/depend on it)', async () => {
      mockScrapingdogEnrich.mockResolvedValue({ kind: 'found', result: foundResult(), photoUrl: null });
      mockRecordStageEvent.mockRejectedValue(new Error('telemetry db down'));

      await expect(runEnrichment('u1', { linkedinUrl: REQ_URL, fullName: 'Jane Doe' })).resolves.toBeUndefined();

      const [, params] = lastStateCall();
      expect(params).toMatchObject({ status: 'found' });
    });
  });
});
