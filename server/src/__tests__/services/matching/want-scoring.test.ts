// ─── Matching breadth with strict constraints (Stefan, 9 Sep 2026) ──────────
//
// "Manufacturer in US with 20 years experience": the place and the years are
// strict; the category is matched by meaning (synonyms + related word forms).

jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import {
  scoreWants, scoreWantsForRecipient, MATCH_THRESHOLD, BROWSE_THRESHOLD,
} from '../../../services/matching/platform-match.service';

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

// 15 Sep 2026 (Raja's "a react developer who can build my product" agent):
// a sales consultant matched on "business development consultancy", a
// change coach on "leadership development", a marketer on "sales development"
// and on "react" inside "reactive tactics". A word inside another word is not
// the same word, and "business development" is sales, not software.
describe('developer means developer', () => {
  const WANT = ['a react developer who can build my product'];
  const nobody = { professionalRole: [] as string[], jobTitleSource: 'stated' };

  it('"business development consultancy" is not a developer', () => {
    const r = scoreWants(WANT, person({ ...nobody, jobTitle: 'sales consultant / sales strategist', whatICanHelpWith: 'practical sales consultancy, business development consultancy, frameworks' }));
    expect(r.score).toBe(0);
  });

  it('"leadership development" and "sales development" are not developers either', () => {
    expect(scoreWants(WANT, person({ ...nobody, jobTitle: 'Chief Adaptability Officer', expertiseText: 'agile coaching, scrum mastery, leadership development, enterprise transformation' })).score).toBe(0);
    expect(scoreWants(WANT, person({ ...nobody, jobTitle: 'Founder', bio: 'hands-on delivery, bringing deep expertise in sales development, digital marketing' })).score).toBe(0);
  });

  it('"reactive tactics" is not react', () => {
    expect(scoreWants(WANT, person({ ...nobody, jobTitle: 'Founder', bio: 'generalist hires instead of specialists, reactive tactics over repeatable systems' })).score).toBe(0);
  });

  it('a software development lead, a web developer and a reactjs engineer still are', () => {
    expect(scoreWants(WANT, person({ ...nobody, jobTitle: 'software development lead' })).score).toBeGreaterThan(0);
    expect(scoreWants(WANT, person({ ...nobody, jobTitle: 'web developer', expertiseText: 'product development' })).score).toBeGreaterThan(0);
    expect(scoreWants(WANT, person({ ...nobody, jobTitle: 'engineer', expertiseText: 'reactjs, typescript' })).score).toBeGreaterThan(0);
  });
});

// 7 Oct 2026, found while seeding a local demo: a member whose "who I want to meet" was
// "fintech founders, seed investors and payments partners in Europe" got NO suggestions,
// although every candidate lived in a European city. The place was matched as a word in the
// candidate's location, and nothing knew that Germany is in Europe. The same want without
// "in Europe" gave six strong matches.
describe('a region in the want finds the people who are there', () => {
  const STACK = 'fintech founders, seed investors and payments partners';
  const fintech = (name: string, location: string | null, over: Record<string, unknown> = {}) => person({
    displayName: name, professionalRole: ['Founder'], jobTitle: 'Co-founder & CEO', jobTitleSource: 'stated',
    company: `${name} Pay`, industry: 'Fintech', expertiseText: 'payments infrastructure and seed fundraising',
    location, ...over,
  });
  const berlin = fintech('Anna', 'Berlin, Germany');
  const amsterdam = fintech('Bram', 'Amsterdam, Netherlands');
  const milan = fintech('Chiara', 'Milan, Italy');
  const vienna = fintech('Vera', 'Vienna, Austria');
  const zurich = fintech('Zoe', 'Zurich, Switzerland');
  const paris = fintech('Paul', 'Paris, France');
  const austin = fintech('Alex', 'Austin, Texas');

  it('control: without the place, all of them are strong matches (so the place is the only thing that changed)', () => {
    for (const c of [berlin, amsterdam, milan, vienna, zurich, paris, austin]) {
      expect(scoreWants([STACK], c).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    }
  });

  it('"in Europe" finds Berlin, Amsterdam and Milan, and the reason names Europe', () => {
    for (const c of [berlin, amsterdam, milan]) {
      const r = scoreWants([`${STACK} in Europe`], c);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(r.reason).toMatch(/\(in Europe\)$/);
    }
  });

  it('the place changes who is shown, never how strongly: the score is the same as without it', () => {
    for (const c of [berlin, amsterdam, milan]) {
      expect(scoreWants([`${STACK} in Europe`], c).score).toBeCloseTo(scoreWants([STACK], c).score, 5);
    }
  });

  it('"in Europe" does not find Austin, Texas', () => {
    expect(scoreWants([`${STACK} in Europe`], austin).score).toBe(0);
    expect(scoreWants([`${STACK} in Europe`], fintech('Alex', 'Austin, United States')).score).toBe(0);
  });

  it('"in DACH" finds Vienna and Zurich, not Paris', () => {
    for (const c of [vienna, zurich]) {
      const r = scoreWants([`${STACK} in DACH`], c);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(r.reason).toMatch(/\(in DACH\)$/);
    }
    expect(scoreWants([`${STACK} in DACH`], paris).score).toBe(0);
  });

  it('says the region the member wrote, in the words the card uses for it', () => {
    expect(scoreWants([`${STACK} in the Nordics`], fintech('Sven', 'Stockholm, Sweden')).reason).toMatch(/\(in the Nordics\)$/);
    expect(scoreWants([`${STACK} in the EU`], berlin).reason).toMatch(/\(in the EU\)$/);
    expect(scoreWants([`${STACK} in the Middle East`], fintech('Dana', 'Dubai, UAE')).reason).toMatch(/\(in the Middle East\)$/);
    expect(scoreWants([`${STACK} in LatAm`], fintech('Luz', 'Bogota, Colombia')).reason).toMatch(/\(in Latin America\)$/);
    expect(scoreWants([`${STACK} in UK and Ireland`], fintech('Ciara', 'Dublin, Ireland')).reason).toMatch(/\(in the UK and Ireland\)$/);
  });

  it('a want that names a country and a region says the one that fits this person', () => {
    const want = [`${STACK} in Germany or the Nordics`];
    expect(scoreWants(want, fintech('Sven', 'Stockholm, Sweden')).reason).toMatch(/\(in the Nordics\)$/);
    expect(scoreWants(want, berlin).reason).toMatch(/\(in Germany\)$/);
    expect(scoreWants(want, paris).score).toBe(0);
  });

  it('countries and cities print as they always did', () => {
    expect(scoreWants([`${STACK} in Germany`], berlin).reason).toMatch(/\(in Germany\)$/);
    expect(scoreWants([`${STACK} in the US`], fintech('Alex', 'Austin, United States')).reason).toMatch(/\(in United States\)$/);
    expect(scoreWants([`${STACK} in London`], fintech('Liv', 'London, UK')).reason).toMatch(/\(in London\)$/);
  });

  it('an agent\'s stored tags beside the member\'s own words do not change the place', () => {
    const own = [`${STACK} in Europe`];
    const withTags = [...own, 'fintech', 'payments', 'seed funding'];
    const r = scoreWants(withTags, berlin, undefined, own);
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(r.reason).toMatch(/\(in Europe\)$/);
    expect(scoreWants(withTags, austin, undefined, own).score).toBe(0);
  });

  describe('an unknown place filters nothing', () => {
    it('"in Narnia": everyone still scores as they do without it, and the reason does not print it', () => {
      for (const c of [berlin, amsterdam, milan, austin]) {
        const r = scoreWants([`${STACK} in Narnia`], c);
        expect(r.score).toBeCloseTo(scoreWants([STACK], c).score, 5);
        expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
        expect(r.reason).not.toMatch(/Narnia|\(in /);
      }
    });

    it('so do the capitalised words that are not places at all', () => {
      const tails = ['in Fintech', 'from Stripe', 'in SaaS', 'near Series A rounds'];
      const emptied = tails.filter((tail) => scoreWants([`${STACK} ${tail}`], austin).score < MATCH_THRESHOLD);
      expect(emptied).toEqual([]);
    });

    it('a place the code does know is still strict, even beside one it does not', () => {
      expect(scoreWants([`${STACK} in Narnia or Germany`], berlin).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(scoreWants([`${STACK} in Narnia or Germany`], paris).score).toBe(0);
    });
  });

  describe('what the reason may say', () => {
    // The place in the note is the member's OWN word, never the candidate's location; the
    // candidate's private fields never reach it, with a region as with anything else.
    const private_ = fintech('Greta', 'Berlin, Germany', {
      interests: ['sailing', 'private aviation'], whatICareAbout: 'collecting rare whisky',
    });

    it('names the region the member wrote, not where the person is, and none of their private interests', () => {
      for (const want of [`${STACK} in Europe`, `${STACK} in DACH`, `${STACK} in the EU`]) {
        const { reason } = scoreWants([want], private_);
        expect(reason).toMatch(/\(in (Europe|DACH|the EU)\)$/);
        expect(reason).not.toMatch(/sailing|aviation|whisky|Berlin|Germany|Greta Pay/i);
      }
    });

    it('is the same sentence for the introduction the other member reads, with the sender\'s own place', () => {
      const r = scoreWantsForRecipient([`${STACK} in Europe`], private_, 'Ali');
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(r.reason).toMatch(/\(in Europe\)$/);
      expect(r.reason).not.toMatch(/sailing|aviation|whisky/i);
    });

    it('an unknown place leaves nothing of it in the introduction either', () => {
      expect(scoreWantsForRecipient([`${STACK} in Narnia`], private_, 'Ali').reason).not.toMatch(/Narnia|\(in /);
    });
  });
});
