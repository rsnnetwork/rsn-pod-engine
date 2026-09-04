// ─── runProvider gap fill (3 Sep 2026) ───────────────────────────────────────
//
// The gap fill (web search fills the headline/role ScrapingDog leaves empty)
// first lived in the onboarding orchestrator. The approval-time preload in
// join-request.service calls runProvider DIRECTLY, so an approved member's
// card was cached role-less before they ever logged in, and the 90-day cache
// then kept it that way. The fill now lives in runProvider so every caller
// gets it: onboarding, the admin refresh, and approval.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { enrichProvider: 'scrapingdog', scrapingdogApiKey: 'k', anthropicApiKey: 'a', onboardingEnrichModel: 'm', onboardingEnrichFallbackModel: '' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/onboarding/providers/scrapingdog.provider', () => ({
  __esModule: true,
  scrapingdogProvider: { name: 'scrapingdog', enrich: jest.fn() },
}));
jest.mock('../../../services/onboarding/enrichment.service', () => {
  const actual = jest.requireActual('../../../services/onboarding/enrichment.service');
  return { __esModule: true, ...actual, enrichProfile: jest.fn() };
});

import { scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';
import { enrichProfile, type EnrichResult, type EnrichedProfile } from '../../../services/onboarding/enrichment.service';
import { runProvider } from '../../../services/onboarding/providers/registry';

const mockScrape = scrapingdogProvider.enrich as jest.Mock;
const mockWeb = enrichProfile as jest.Mock;
const URL = 'https://www.linkedin.com/in/ali-hamza';

const profile = (over: Partial<EnrichedProfile> = {}): EnrichedProfile => ({
  fullName: 'Ali Hamza', headline: null, currentRole: null, currentCompany: 'Asepticware',
  industry: null, location: null, summary: 'As a Senior Team Lead at Asepticware, I…', pastRoles: [], education: [],
  skills: [], likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [], questionsToVerify: [],
  linkedinUrl: URL, photoUrl: null, ...over,
});
const result = (p: EnrichedProfile, over: Partial<EnrichResult> = {}): EnrichResult => ({
  profile: p, confidence: 0.7, sources: ['scrapingdog:ali-hamza'], foundLinkedinUrl: URL, requestedLinkedinUrl: URL,
  enrichedAt: new Date().toISOString(), ...over,
});

beforeEach(() => { mockScrape.mockReset(); mockWeb.mockReset(); });

describe('runProvider(scrapingdog) fills what the scrape left empty', () => {
  it('a role-less partial becomes found with the web headline, role, industry, location and fuller summary', async () => {
    mockScrape.mockResolvedValue({ kind: 'partial', result: result(profile()), photoUrl: null, missing: ['headline', 'currentRole'] });
    mockWeb.mockResolvedValue(result(profile({
      headline: 'Full Stack Engineer | Project Manager', currentRole: 'Senior Team Lead', currentCompany: 'Raw Speed Networking',
      industry: 'Software', location: 'Islamabad', summary: 'As a Senior Team Lead at Asepticware, I oversee full stack development.', skills: ['React'],
    }), { confidence: 0.92, sources: ['https://www.linkedin.com/in/ali-hamza'] }));

    const out = await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'Ali Hamza' });

    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    expect(out.result.profile).toMatchObject({
      headline: 'Full Stack Engineer | Project Manager', currentRole: 'Senior Team Lead',
      currentCompany: 'Asepticware',            // the scraped fact stays
      industry: 'Software', location: 'Islamabad', skills: ['React'],
      summary: 'As a Senior Team Lead at Asepticware, I oversee full stack development.',
    });
    expect(out.result.confidence).toBe(0.95);
    expect(out.result.sources).toEqual(expect.arrayContaining(['scrapingdog:ali-hamza', 'https://www.linkedin.com/in/ali-hamza']));
    expect(mockWeb).toHaveBeenCalledWith(expect.objectContaining({ linkedinUrl: URL, fullName: 'Ali Hamza' }));
  });

  it('a web result the identity check rejects (different slug) changes nothing', async () => {
    mockScrape.mockResolvedValue({ kind: 'partial', result: result(profile()), photoUrl: null, missing: ['headline', 'currentRole'] });
    mockWeb.mockResolvedValue(result(profile({ currentRole: 'CEO' }), { confidence: 0.9, foundLinkedinUrl: 'https://www.linkedin.com/in/someone-else' }));

    const out = await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'Ali Hamza' });
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') expect(out.result.profile!.currentRole).toBeNull();
  });

  it('a web result that cannot identify the person (confidence 0) changes nothing', async () => {
    mockScrape.mockResolvedValue({ kind: 'partial', result: result(profile()), photoUrl: null, missing: ['headline', 'currentRole'] });
    mockWeb.mockResolvedValue({ profile: null, confidence: 0, sources: [], foundLinkedinUrl: null, requestedLinkedinUrl: URL, enrichedAt: null });

    const out = await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'Malik Ahmed' });
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') expect(out.result.profile!.currentRole).toBeNull();
  });

  it('a complete scrape, or a partial that already has a role, never spends a web call', async () => {
    mockScrape.mockResolvedValueOnce({ kind: 'found', result: result(profile({ headline: 'CTO', currentRole: 'CTO' }), { confidence: 0.95 }), photoUrl: null });
    await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'X' });
    mockScrape.mockResolvedValueOnce({ kind: 'partial', result: result(profile({ headline: 'CTO', currentRole: 'CTO', currentCompany: null })), photoUrl: null, missing: ['currentCompany'] });
    await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'X' });
    expect(mockWeb).not.toHaveBeenCalled();
  });

  it('a web failure keeps the scraped partial', async () => {
    mockScrape.mockResolvedValue({ kind: 'partial', result: result(profile()), photoUrl: null, missing: ['headline', 'currentRole'] });
    mockWeb.mockRejectedValue(new Error('search down'));
    const out = await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'Ali Hamza' });
    expect(out.kind).toBe('partial');
  });

  it('not_found and provider errors pass through untouched', async () => {
    mockScrape.mockResolvedValue({ kind: 'not_found', reason: 'scrapingdog 404' });
    expect(await runProvider('scrapingdog', { linkedinUrl: URL, fullName: 'X' })).toEqual({ kind: 'not_found', reason: 'scrapingdog 404' });
    expect(mockWeb).not.toHaveBeenCalled();
  });
});
