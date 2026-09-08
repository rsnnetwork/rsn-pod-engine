// ─── Matching breadth with strict constraints (Stefan, 9 Sep 2026) ──────────
//
// "Manufacturer in US with 20 years experience": the place and the years are
// strict; the category is matched by meaning (synonyms + related word forms).

jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { scoreWants, MATCH_THRESHOLD, BROWSE_THRESHOLD } from '../../../services/matching/platform-match.service';

const person = (over: Record<string, unknown> = {}) => ({
  id: 'u', displayName: 'Pat', avatarUrl: null,
  professionalRole: ['Founder'], jobTitle: 'Owner', jobTitleSource: 'stated', company: 'Acme',
  expertiseText: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, myIntent: null, whoIWantToMeet: null, whyIWantToMeet: null,
  industry: null, bio: null, location: null,
  ...over,
}) as any;

const WANT = ['manufacturer in US with 20 years experience'];

describe('Stefan\'s case: strict place + years, smart category', () => {
  it('a US industrial-fabrication company with 25 stated years is a match, even though it never says "manufacturer"', () => {
    const r = scoreWants(WANT, person({ company: 'Ridge Fabrication', industry: 'Industrial fabrication', location: 'Cleveland, USA', bio: '25 years of precision machining and assembly.' }));
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(r.reason).toBeTruthy();
  });
  it('a German manufacturer is excluded on location, however good the category fit', () => {
    const r = scoreWants(WANT, person({ industry: 'Manufacturing', location: 'Munich, Germany', bio: '30 years in manufacturing' }));
    expect(r.score).toBe(0);
  });
  it('a US manufacturer with 5 stated years is excluded on experience', () => {
    const r = scoreWants(WANT, person({ industry: 'Manufacturing', location: 'Austin, United States', bio: '5 years running our factory' }));
    expect(r.score).toBe(0);
  });
  it('a US manufacturer that never states years is kept but ranked below one that does, and the reason says so', () => {
    const stated = scoreWants(WANT, person({ industry: 'Manufacturing', location: 'Detroit, US', bio: '22 years in production' }));
    const unknown = scoreWants(WANT, person({ industry: 'Manufacturing', location: 'Detroit, US', bio: 'We run a production line for auto parts.' }));
    expect(unknown.score).toBeGreaterThan(0);
    expect(unknown.score).toBeLessThan(stated.score);
    expect(unknown.reason).toMatch(/years of experience/i);
  });
  it('someone with no location at all does not satisfy an explicit place', () => {
    const r = scoreWants(WANT, person({ industry: 'Manufacturing', location: null, bio: '25 years' }));
    expect(r.score).toBe(0);
  });
});

describe('related meaning at score time', () => {
  it('"react developers" finds a "software development lead" (related word form)', () => {
    const r = scoreWants(['react developers to build my product'], person({ professionalRole: ['Lead'], jobTitle: 'Software development lead', expertiseText: 'react typescript' }));
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
  it('synonyms apply when scoring a plain want (not only when an agent is created)', () => {
    const r = scoreWants(['people in AI'], person({ professionalRole: ['Engineer'], jobTitle: 'Machine learning engineer', expertiseText: 'deep learning models' }));
    expect(r.score).toBeGreaterThan(BROWSE_THRESHOLD);
  });
  it('a want with no explicit place or years still scores as before', () => {
    const r = scoreWants(['founders'], person({ professionalRole: ['Founder'], jobTitle: 'Founder & CEO', location: 'Berlin, Germany' }));
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});
