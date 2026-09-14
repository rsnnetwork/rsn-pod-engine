// ─── Cached enrichment → status (14 Sep 2026) ────────────────────────────────
//
// Shradha's approval-time preload cached a ScrapingDog payload with no
// headline, no role and no About. The live path calls that "partial"
// (missing[] is non-empty), but every place that REFLECTS a cached result
// (the orchestrator's 90-day cache hit, the /enrich route, the login
// copy-forward) mapped confidence alone, and 0.7 reads as "found". The same
// blob told the member two different stories depending on the path.
//
// statusFromResult is the one mapping for a cached result: confidence still
// decides not_found/partial below 0.6, and a "found" is downgraded to partial
// when the profile is hollow. It never upgrades.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { enrichProvider: 'scrapingdog', scrapingdogApiKey: 'k', anthropicApiKey: 'a', onboardingEnrichModel: 'm', onboardingEnrichFallbackModel: '' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { EnrichResult, EnrichedProfile } from '../../../services/onboarding/enrichment.service';
import { statusFromConfidence, statusFromResult } from '../../../services/onboarding/providers/registry';

const URL = 'https://www.linkedin.com/in/shradhadhikari';
const profile = (over: Partial<EnrichedProfile> = {}): EnrichedProfile => ({
  fullName: 'Shradha Adhikari', headline: 'Writer at VOKT', currentRole: 'Writer', currentCompany: 'VOKT',
  industry: null, location: null, summary: null, pastRoles: [], education: [], skills: [],
  likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [], questionsToVerify: [],
  linkedinUrl: URL, photoUrl: null, ...over,
});
const result = (p: EnrichedProfile | null, confidence: number): EnrichResult => ({
  profile: p, confidence, sources: ['scrapingdog:shradhadhikari'], foundLinkedinUrl: URL, requestedLinkedinUrl: URL, enrichedAt: new Date().toISOString(),
});

describe('statusFromResult', () => {
  it('a full profile at high confidence is found', () => {
    expect(statusFromResult(result(profile(), 0.95))).toBe('found');
  });

  it('a hollow profile (empty headline and role) at 0.7 is partial, not found', () => {
    expect(statusFromResult(result(profile({ headline: '', currentRole: '' }), 0.7))).toBe('partial');
    expect(statusFromResult(result(profile({ headline: null, currentRole: null, currentCompany: null }), 0.95))).toBe('partial');
  });

  it('confidence still decides below the found line, exactly as before', () => {
    expect(statusFromResult(result(profile(), 0.4))).toBe('partial');
    expect(statusFromResult(result(profile(), 0.2))).toBe('not_found');
    expect(statusFromResult(result(null, 0.95))).toBe('partial');
    expect(statusFromResult(null)).toBe('not_found');
  });

  it('never upgrades what confidence alone would say', () => {
    const order = ['not_found', 'partial', 'found'];
    for (const c of [0, 0.15, 0.34, 0.35, 0.59, 0.6, 0.95]) {
      expect(order.indexOf(statusFromResult(result(profile(), c)))).toBeLessThanOrEqual(order.indexOf(statusFromConfidence(c)));
    }
  });
});
