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
  saveEnrichedCandidate: jest.fn(),
  setEnrichmentState: jest.fn(),
}));

jest.mock('../../../services/onboarding/providers/scrapingdog.provider', () => ({
  __esModule: true,
  scrapingdogProvider: { name: 'scrapingdog', enrich: jest.fn() },
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
import { getCachedEnrichment, saveEnrichedCandidate, setEnrichmentState } from '../../../services/onboarding/enrichment.repo';
import { scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';
import { enrichProfile, getClient, type EnrichResult, type EnrichedProfile } from '../../../services/onboarding/enrichment.service';
import { runEnrichment } from '../../../services/onboarding/enrichment.orchestrator';

const mockGetCachedEnrichment = getCachedEnrichment as jest.Mock;
const mockSaveEnrichedCandidate = saveEnrichedCandidate as jest.Mock;
const mockSetEnrichmentState = setEnrichmentState as jest.Mock;
const mockScrapingdogEnrich = scrapingdogProvider.enrich as jest.Mock;
const mockEnrichProfile = enrichProfile as jest.Mock;
const mockGetClient = getClient as jest.Mock;

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
    mockSetEnrichmentState.mockResolvedValue(undefined);
    mockSaveEnrichedCandidate.mockResolvedValue(undefined);
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

  it('not_found on null linkedinUrl: never calls the provider, error is "no linkedin url"', async () => {
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
});
