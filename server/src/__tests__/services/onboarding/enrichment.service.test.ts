import {
  companyFromEmail,
  buildEnrichmentTarget,
  parseEnriched,
} from '../../../services/onboarding/enrichment.service';

describe('enrichment — companyFromEmail', () => {
  it('derives a company from a work-email domain', () => {
    expect(companyFromEmail('john@acme.com')).toBe('Acme');
    expect(companyFromEmail('x@bigco.io')).toBe('Bigco');
    expect(companyFromEmail('a@foo.co.uk')).toBe('Foo');
  });
  it('returns null for free/personal providers', () => {
    expect(companyFromEmail('jane@gmail.com')).toBeNull();
    expect(companyFromEmail('p@outlook.com')).toBeNull();
    expect(companyFromEmail('q@proton.me')).toBeNull();
  });
  it('returns null for missing/invalid emails', () => {
    expect(companyFromEmail(null)).toBeNull();
    expect(companyFromEmail('')).toBeNull();
    expect(companyFromEmail('notanemail')).toBeNull();
  });
});

describe('enrichment — buildEnrichmentTarget', () => {
  it('uses the LinkedIn URL when present (high-confidence path)', () => {
    const t = buildEnrichmentTarget({ fullName: 'John Smith', linkedinUrl: 'https://linkedin.com/in/js' });
    expect(t).toContain('John Smith');
    expect(t).toContain('LinkedIn: https://linkedin.com/in/js');
  });
  it('combines name + company-from-email + city/country (no-URL path)', () => {
    const t = buildEnrichmentTarget({ fullName: 'Jane Doe', email: 'jane@acme.com', city: 'London', country: 'UK' });
    expect(t).toContain('Jane Doe');
    expect(t).toContain('works at/with Acme');
    expect(t).toContain('located in London, UK');
  });
  it('falls back to name alone', () => {
    expect(buildEnrichmentTarget({ fullName: 'Bob' })).toBe('Bob');
  });
});

describe('enrichment — parseEnriched', () => {
  const good = JSON.stringify({
    fullName: 'Pat C', headline: 'CEO', currentRole: 'CEO', currentCompany: 'Stripe',
    industry: 'Fintech', location: 'SF', summary: 'builds payments',
    pastRoles: ['founder', 42], skills: ['payments'], likelyWantsToMeet: ['founders'],
    likelyOffers: ['advice'], education: [{ school: 'MIT' }], linkedinUrl: 'https://linkedin.com/in/pc',
    confidence: 0.9, sources: ['https://wikipedia.org', 7],
  });

  it('parses a clean JSON profile + clamps confidence', () => {
    const r = parseEnriched(good);
    expect(r.confidence).toBe(0.9);
    expect(r.profile?.currentCompany).toBe('Stripe');
    expect(r.profile?.pastRoles).toEqual(['founder']); // non-strings filtered
    expect(r.sources).toEqual(['https://wikipedia.org']); // non-strings filtered
    expect(r.foundLinkedinUrl).toBe('https://linkedin.com/in/pc');
  });
  it('extracts JSON even with surrounding prose', () => {
    const r = parseEnriched('Here is what I found:\n' + good + '\nHope that helps.');
    expect(r.profile?.fullName).toBe('Pat C');
  });
  it('clamps out-of-range confidence', () => {
    expect(parseEnriched(JSON.stringify({ confidence: 1.5 })).confidence).toBe(1);
    expect(parseEnriched(JSON.stringify({ confidence: -0.5 })).confidence).toBe(0);
  });
  it('returns confidence 0 + null profile when no JSON is present', () => {
    const r = parseEnriched('no json here, sorry');
    expect(r.confidence).toBe(0);
    expect(r.profile).toBeNull();
  });
});
