// ─── When the stronger model is worth paying for (7 Sep 2026) ────────────────
//
// The Anthropic balance ran dry on 7 Sep. About 60 of the 91 enrichment runs
// since the 3 Sep top-up had escalated to Sonnet, and nearly all of them
// because the cheap pass honestly answered "I cannot identify this person"
// (confidence 0), which also sat below the 0.6 threshold. Sonnet then ran the
// same three searches for the same answer at ten times the price. The rule
// now: escalate only when the cheap pass FOUND the person but scored weakly.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { anthropicApiKey: 'k', onboardingEnrichModel: 'haiku', onboardingEnrichFallbackModel: 'sonnet', llmBalanceAlertTo: 'dev@rsn.network' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: (...a: unknown[]) => mockCreate(...a) } })),
}));
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  sendLlmBalanceAlertEmail: jest.fn().mockResolvedValue({ sent: true }),
}));

import { enrichProfile, shouldEscalate, type EnrichResult } from '../../../services/onboarding/enrichment.service';

const URL = 'https://www.linkedin.com/in/ali-hamza';
const answer = (j: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(j) }] });
const person = (over: Record<string, unknown> = {}) => ({
  fullName: 'Ali Hamza', headline: 'MLOps Engineer', currentRole: 'MLOps Engineer', currentCompany: 'Fjord Analytics',
  linkedinUrl: URL, confidence: 0.4, sources: [URL], ...over,
});
const nobody = () => ({ fullName: null, headline: null, currentRole: null, linkedinUrl: null, confidence: 0, sources: [] });
const modelsUsed = () => mockCreate.mock.calls.map((c) => c[0].model);

beforeEach(() => { mockCreate.mockReset(); });

describe('enrichProfile spends the stronger model only when the cheap pass found the person but scored weakly', () => {
  it('nobody found on the cheap pass: one call, no second model', async () => {
    mockCreate.mockResolvedValueOnce(answer(nobody()));
    const r = await enrichProfile({ fullName: 'Waseem Ahmed', linkedinUrl: 'https://www.linkedin.com/in/waseem-ahmed' });
    expect(r.profile?.fullName ?? null).toBeNull();
    expect(r.confidence).toBe(0);
    expect(modelsUsed()).toEqual(['haiku']);
  });

  it('the right person, weakly scored: the stronger model gets one try and wins when it does better', async () => {
    mockCreate.mockResolvedValueOnce(answer(person({ confidence: 0.4 })));
    mockCreate.mockResolvedValueOnce(answer(person({ confidence: 0.9, industry: 'Software' })));
    const r = await enrichProfile({ fullName: 'Ali Hamza', linkedinUrl: URL });
    expect(modelsUsed()).toEqual(['haiku', 'sonnet']);
    expect(r.confidence).toBe(0.9);
    expect(r.profile?.industry).toBe('Software');
  });

  it('a different person than the URL asked for: the identity check decided, no second model', async () => {
    mockCreate.mockResolvedValueOnce(answer(person({ confidence: 0.9, linkedinUrl: 'https://www.linkedin.com/in/someone-else' })));
    const r = await enrichProfile({ fullName: 'Ali Hamza', linkedinUrl: URL });
    expect(r.confidence).toBe(0.15);
    expect(modelsUsed()).toEqual(['haiku']);
  });

  it('a confident cheap pass never escalates', async () => {
    mockCreate.mockResolvedValueOnce(answer(person({ confidence: 0.92 })));
    const r = await enrichProfile({ fullName: 'Ali Hamza', linkedinUrl: URL });
    expect(r.confidence).toBe(0.92);
    expect(modelsUsed()).toEqual(['haiku']);
  });

  it('escalate:false (the ScrapingDog gap fill) never spends the stronger model, even for a weak hit', async () => {
    mockCreate.mockResolvedValueOnce(answer(person({ confidence: 0.4 })));
    const r = await enrichProfile({ fullName: 'Ali Hamza', linkedinUrl: URL }, { escalate: false });
    expect(r.confidence).toBe(0.4);
    expect(modelsUsed()).toEqual(['haiku']);
  });

  it('a failed escalation keeps the cheap result', async () => {
    mockCreate.mockResolvedValueOnce(answer(person({ confidence: 0.4 })));
    mockCreate.mockRejectedValueOnce(new Error('overloaded'));
    const r = await enrichProfile({ fullName: 'Ali Hamza', linkedinUrl: URL });
    expect(modelsUsed()).toEqual(['haiku', 'sonnet']);
    expect(r.confidence).toBe(0.4);
  });
});

describe('shouldEscalate', () => {
  const base: EnrichResult = { profile: null, confidence: 0, sources: [], foundLinkedinUrl: null, requestedLinkedinUrl: URL, enrichedAt: null };
  const prof = { fullName: 'A', headline: null, currentRole: null, currentCompany: null, industry: null, location: null, summary: null, pastRoles: [], education: [], skills: [], likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [], questionsToVerify: [], linkedinUrl: URL, photoUrl: null };
  it('no profile, an empty profile, or confidence 0 → no', () => {
    expect(shouldEscalate(base)).toBe(false);
    expect(shouldEscalate({ ...base, profile: prof, confidence: 0 })).toBe(false);
    // An all-null profile at 0.2 is "nobody, hedged", not a weak hit.
    expect(shouldEscalate({ ...base, profile: { ...prof, fullName: null }, confidence: 0.2 })).toBe(false);
  });
  it('a person at 0.01..0.59 with a matching or unknown URL → yes', () => {
    expect(shouldEscalate({ ...base, profile: prof, confidence: 0.3, foundLinkedinUrl: URL })).toBe(true);
    expect(shouldEscalate({ ...base, profile: prof, confidence: 0.3, foundLinkedinUrl: null })).toBe(true);
    expect(shouldEscalate({ ...base, profile: prof, confidence: 0.59, foundLinkedinUrl: URL })).toBe(true);
  });
  it('a different slug, or 0.6 and above → no', () => {
    expect(shouldEscalate({ ...base, profile: prof, confidence: 0.15, foundLinkedinUrl: 'https://www.linkedin.com/in/other' })).toBe(false);
    expect(shouldEscalate({ ...base, profile: prof, confidence: 0.6, foundLinkedinUrl: URL })).toBe(false);
  });
});
