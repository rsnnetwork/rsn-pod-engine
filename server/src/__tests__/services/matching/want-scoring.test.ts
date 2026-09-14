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

// 15 Sep 2026 (Ali's first agent after re-onboarding, "Manufacturers and
// suppliers"): two of its three matches were a podcast strategist, on the
// word "production" in "podcast production", and a climate-tech investor, on
// the interest "industrial disruptors". Both words came from the synonym
// expansion of "manufacturing", not from Ali. One such word, alone, is not a
// match; the real manufacturer (industry "SaaS, Manufacturing") still is.
describe('one synonym word alone is not a match', () => {
  const WANT = ['manufacturers and suppliers, manufacturing'];
  const nobody = { professionalRole: [] as string[], jobTitle: null, jobTitleSource: null };

  it('"podcast production" does not make a strategist a manufacturer', () => {
    const r = scoreWants(WANT, person({ ...nobody, jobTitle: 'Lead Strategist', industry: 'Strategy',
      whatICanHelpWith: 'positioning and strategy expertise, Podcast production or guest appearances, brand development' }));
    expect(r.score).toBe(0);
    expect(r.reason).toBe('');
  });

  it('an interest in "industrial disruptors" does not make an investor a manufacturer', () => {
    const r = scoreWants(WANT, person({ ...nobody, jobTitle: 'Co-founder', industry: 'Climate Tech, Clean Tech and Renewables',
      interests: ['industrial disruptors', 'renewable energy'] }));
    expect(r.score).toBe(0);
  });

  it('the member\'s own word still matches on its own: industry "SaaS, Manufacturing"', () => {
    const r = scoreWants(WANT, person({ ...nobody, jobTitle: 'CTO and innovator', industry: 'SaaS, Manufacturing' }));
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(r.reason).toContain('manufactur');
  });

  it('two synonym words together still count: "industrial fabrication" and "machining"', () => {
    const r = scoreWants(WANT, person({ ...nobody, company: 'Ridge Fabrication', industry: 'Industrial fabrication', bio: 'precision machining and assembly' }));
    expect(r.score).toBeGreaterThanOrEqual(BROWSE_THRESHOLD);
    expect(r.score).toBeGreaterThan(0);
  });

  it('a designation hit does not need any words at all', () => {
    const r = scoreWants(['founders'], person({ professionalRole: ['Founder'], jobTitle: 'Founder', jobTitleSource: 'stated', bio: 'production of oat milk' }));
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

// 15 Sep 2026 (Raja's agent with the want text "manufacturing" found Ali
// Hamzaa, an AWS engineer who came to LEARN about manufacturing). The
// extractor had written his curiosity into interests and what_i_care_about,
// and the scorer read those as what he is. A word a member is looking for is
// not something they are; a real manufacturer with the industry on file still
// matches, whatever they are looking for.
describe('what a member wants is not what they are', () => {
  it('an AWS engineer curious about manufacturing is not found by a "manufacturing" agent', () => {
    const r = scoreWants(['manufacturing'], person({
      professionalRole: [], jobTitle: null, jobTitleSource: null, company: 'NorthBay Solutions', industry: null,
      expertiseText: 'AWS engagement security, prompt engineering', whatICanHelpWith: 'AWS security knowledge, AI and prompt engineering perspective',
      whatICareAbout: 'manufacturing business, learning from practitioners, growing knowledge in manufacturing',
      interests: ['manufacturing business', 'learning from practitioners', 'growing knowledge in manufacturing'],
      whoIWantToMeet: 'people working in manufacturing, manufacturing business professionals, manufacturer, operations manager, production lead',
      whyIWantToMeet: 'I want to meet people in the manufacturing business and learn from those already doing it.',
      myIntent: 'Gain knowledge about manufacturing and grow in the space.',
      goals: ['understanding the manufacturing business'],
    }));
    expect(r.score).toBe(0);
  });

  it('a manufacturer who also wants to meet manufacturers still matches, on the industry', () => {
    const r = scoreWants(['manufacturing'], person({
      professionalRole: ['Owner'], jobTitle: 'Owner', industry: 'Manufacturing',
      interests: ['manufacturing'], whatICareAbout: 'manufacturing',
      whoIWantToMeet: 'other manufacturers', whyIWantToMeet: 'to meet peers in manufacturing',
    }));
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('an interest that is not also a want still counts as who they are', () => {
    const r = scoreWants(['fintech'], person({
      professionalRole: [], jobTitle: 'Analyst', jobTitleSource: 'stated', industry: null,
      interests: ['fintech', 'payments'], whatICareAbout: 'fintech and payments',
      whoIWantToMeet: 'investors', whyIWantToMeet: 'raising a round',
    }));
    expect(r.score).toBeGreaterThan(0);
  });
});

// 15 Sep 2026: an agent stores its synonym expansion as tags at creation, and
// a rescore feeds those tags back in with the want text. Without saying which
// part is the member's own words, "production" and "industrial" counted as
// things Ali had asked for, and the two weak matches survived the new rule.
describe('an agent\'s stored tags are expansion, not the member\'s own words', () => {
  const wantText = 'manufacturers and suppliers, manufacturing';
  const storedTags = ['manufacturing', 'manufacturer', 'manufacturers', 'production', 'factory', 'industrial', 'fabrication', 'industrial fabrication', 'machining', 'assembly', 'manufacturers and suppliers'];
  const strategist = () => person({ professionalRole: [], jobTitle: 'Lead Strategist', jobTitleSource: 'stated', industry: 'Strategy',
    whatICanHelpWith: 'positioning and strategy expertise, Podcast production or guest appearances' });

  it('with the own text named, one stored-tag word alone is not a match', () => {
    expect(scoreWants([wantText, ...storedTags], strategist(), undefined, [wantText]).score).toBe(0);
  });

  it('without it (the old call shape) the tags read as own words: the case the agent path no longer takes', () => {
    expect(scoreWants([wantText, ...storedTags], strategist()).score).toBeGreaterThan(0);
  });

  it('a real manufacturer still matches through the own text', () => {
    const r = scoreWants([wantText, ...storedTags], person({ professionalRole: [], jobTitle: 'CTO', industry: 'SaaS, Manufacturing' }), undefined, [wantText]);
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});
