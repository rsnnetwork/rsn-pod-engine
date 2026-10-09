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

  it('"in the EU" is Europe: the UK, Switzerland and Norway are found, and the card says the EU', () => {
    for (const c of [fintech('Liv', 'London, UK'), fintech('Zoe', 'Zurich, Switzerland'), fintech('Nils', 'Oslo, Norway')]) {
      const r = scoreWants([`${STACK} in the EU`], c);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(r.reason).toMatch(/\(in the EU\)$/);
    }
    expect(scoreWants([`${STACK} in the EU`], austin).score).toBe(0);
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

  it('"in the Bay Area" finds the people around the Bay and says so, not "San Francisco"', () => {
    for (const [name, location] of [['Pia', 'Palo Alto, CA'], ['Olga', 'Oakland, CA'], ['Sam', 'San Jose, California'], ['Fay', 'San Francisco']]) {
      const r = scoreWants([`${STACK} in the Bay Area`], fintech(name, location));
      expect([name, r.score >= MATCH_THRESHOLD]).toEqual([name, true]);
      expect(r.reason).toMatch(/\(in the Bay Area\)$/);
    }
    expect(scoreWants([`${STACK} in the Bay Area`], fintech('Alex', 'Austin, Texas')).score).toBe(0);
    // a bank or a university is not a place
    expect(scoreWants([`${STACK} from Santander`], fintech('Alex', 'Austin, Texas')).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(scoreWants([`${STACK} from Princeton`], fintech('Alex', 'Austin, Texas')).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('"in Northern Ireland" finds Belfast and says Northern Ireland, and does not find London', () => {
    const belfast = scoreWants([`${STACK} in Northern Ireland`], fintech('Niamh', 'Belfast, Northern Ireland'));
    expect(belfast.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(belfast.reason).toMatch(/\(in Northern Ireland\)$/);
    expect(scoreWants([`${STACK} in Northern Ireland`], fintech('Niamh', 'Derry')).reason).toMatch(/\(in Northern Ireland\)$/);
    expect(scoreWants([`${STACK} in Northern Ireland`], fintech('Liv', 'London, UK')).score).toBe(0);
    expect(scoreWants([`${STACK} in Northern Ireland`], fintech('Cian', 'Dublin, Ireland')).score).toBe(0);
    // and in the UK or Europe, Belfast counts as the UK
    expect(scoreWants([`${STACK} in the UK`], fintech('Niamh', 'Belfast')).reason).toMatch(/\(in United Kingdom\)$/);
    expect(scoreWants([`${STACK} in Europe`], fintech('Niamh', 'Belfast')).reason).toMatch(/\(in Europe\)$/);
  });

  it('never says a place the person is not in: "in Oman" does not find Bucharest and the card does not claim it', () => {
    for (const [place, location] of [
      ['Oman', 'Bucharest, Romania'], ['Mexico', 'Albuquerque, New Mexico'], ['Ireland', 'Belfast, Northern Ireland'],
      ['Niger', 'Lagos, Nigeria'], ['Kansas', 'Little Rock, Arkansas'], ['Sudan', 'Juba, South Sudan'],
    ]) {
      const r = scoreWants([`${STACK} in ${place}`], fintech('Radu', location));
      expect([place, r.score, r.reason]).toEqual([place, 0, '']);
    }
    expect(scoreWants([`${STACK} in Oman`], fintech('Salim', 'Muscat, Oman')).reason).toMatch(/\(in Oman\)$/);
  });

  // The words "and", "of" and "the" stay lowercase inside a name, and the few names title case gets
  // wrong print as people write them (the code writes plain ASCII in a reason, so no accents).
  describe('a place prints the way it is written', () => {
    const printed = (place: string, location: string) =>
      /\(in ([^)]+)\)$/.exec(scoreWants([`${STACK} in ${place}`], fintech('Pat', location)).reason)?.[1] ?? null;

    it.each([
      ['Bosnia', 'Sarajevo, Bosnia & Herzegovina', 'Bosnia and Herzegovina'],
      ['Congo', 'Brazzaville, Republic of the Congo', 'Republic of the Congo'],
      ['DR Congo', 'Kinshasa, Democratic Republic of the Congo', 'DR Congo'],
      ['Ivory Coast', 'Abidjan, Côte d’Ivoire', "Cote d'Ivoire"],
      ['Sao Tome', 'São Tomé & Príncipe', 'Sao Tome and Principe'],
      ['Prince Edward Island', 'Charlottetown, Prince Edward Island', 'Prince Edward Island'],
      ['United Arab Emirates', 'Dubai, UAE', 'United Arab Emirates'],
      ['New York', 'New York, NY', 'New York'],
    ])('"in %s" for a person in "%s" prints (in %s)', (place, location, shown) => {
      expect(printed(place, location)).toBe(shown);
    });
  });

  it('an agent\'s stored tags beside the member\'s own words do not change the place', () => {
    const own = [`${STACK} in Europe`];
    const withTags = [...own, 'fintech', 'payments', 'seed funding'];
    const r = scoreWants(withTags, berlin, undefined, own);
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(r.reason).toMatch(/\(in Europe\)$/);
    expect(scoreWants(withTags, austin, undefined, own).score).toBe(0);
  });

  it('a want that merely contains GCC, Nordic or Mena is not a place: the person in Texas is still found', () => {
    const compiler = (over: Record<string, unknown> = {}) => person({
      professionalRole: ['Engineer'], jobTitle: 'Compiler engineer', company: 'Acme',
      expertiseText: 'compilers, GCC and LLVM', location: 'Austin, Texas', ...over,
    });
    const gcc = scoreWants(['compiler engineers who know GCC and LLVM'], compiler());
    expect(gcc.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(gcc.reason).not.toMatch(/\(in /);
    const nordic = scoreWants(['engineers from Nordic Semiconductor'], compiler({ expertiseText: 'Nordic Semiconductor firmware' }));
    expect(nordic.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(nordic.reason).not.toMatch(/\(in /);
  });

  it('"EU regulation experts" is not a place: the person in Texas who knows EU regulation is still found', () => {
    const counsel = person({
      professionalRole: ['Counsel'], jobTitle: 'Regulatory counsel', expertiseText: 'EU regulation and compliance', location: 'Austin, Texas',
    });
    const r = scoreWants(['EU regulation compliance experts'], counsel);
    expect(r.score).toBeGreaterThan(0);
    expect(r.reason).not.toMatch(/\(in /);
    // and as a place it still filters: "in the EU" does not take Austin
    expect(scoreWants(['regulation compliance experts in the EU'], counsel).score).toBe(0);
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

  // The scorer is handed the want fields as an array and joins them with ". " (extractConstraints), so a
  // place that ends one field meets the first word of the next. S4-b fix round 1: "in the EU" at the end of
  // a field was read together with that word ("EU. Raise"), the place vanished, and everyone scored.
  describe('a place that ends one want field, with another field after it', () => {
    const FIELDS = ['Fintech founders and seed investors in the EU', 'Raise a seed round for my payments startup'];

    it('finds the people in the EU and says so on the card', () => {
      for (const c of [berlin, amsterdam, milan, vienna, paris]) {
        const r = scoreWants(FIELDS, c);
        expect([c.displayName, r.score >= MATCH_THRESHOLD]).toEqual([c.displayName, true]);
        expect(r.reason).toMatch(/\(in the EU\)$/);
      }
    });

    it('does not find the person in Austin: the place still filters', () => {
      expect(scoreWants(FIELDS, austin).score).toBe(0);
      expect(scoreWants(FIELDS, fintech('Alex', 'Austin, United States')).score).toBe(0);
    });

    it('is the same with the place in the middle field of three, and for the introduction the other member reads', () => {
      const three = ['Looking for fintech founders', 'Fintech founders and seed investors in the EU', 'Raise a seed round for my payments startup'];
      expect(scoreWants(three, berlin).reason).toMatch(/\(in the EU\)$/);
      expect(scoreWants(three, austin).score).toBe(0);
      expect(scoreWantsForRecipient(FIELDS, berlin, 'Ali').reason).toMatch(/\(in the EU\)$/);
      expect(scoreWantsForRecipient(FIELDS, austin, 'Ali').score).toBe(0);
    });

    it('keeps both places when two fields each end with one', () => {
      const fields = ['Fintech founders in the EU', 'Seed investors in Zurich', 'Raise a seed round'];
      expect(scoreWants(fields, berlin).reason).toMatch(/\(in the EU\)$/);
      expect(scoreWants(fields, zurich).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(scoreWants(fields, austin).score).toBe(0);
    });
  });

  // A region named in passing describes the work, not where the person must be (final review of release 6): in
  // production none of these limited the list, and read anywhere each limited it to the people located there.
  describe('a region mentioned in passing is not a place', () => {
    const lagos = fintech('Tunde', 'Lagos, Nigeria');

    it('leaves the person in Texas in the list, with no place on the card', () => {
      for (const wants of [
        [`${STACK} building for Asia and Africa`],
        [STACK, 'Founders building for Asia and Africa'],
        [`${STACK}, Middle East expansion partners`],
        [STACK, 'Scandinavian design founders welcome'],
        [`${STACK}, European fintech`],
        [STACK, 'EU-based teams preferred'],
      ]) {
        for (const c of [austin, berlin, lagos]) {
          const r = scoreWants(wants, c);
          expect([wants, c.displayName, r.score >= MATCH_THRESHOLD]).toEqual([wants, c.displayName, true]);
          expect(r.reason).not.toMatch(/\(in /);
        }
      }
    });

    it('does not hide the place the member did name: "in Europe" still filters, whatever else the fields say', () => {
      const wants = [`${STACK} in Europe`, 'Building for Asia and Africa'];
      expect(scoreWants(wants, berlin).reason).toMatch(/\(in Europe\)$/);
      expect(scoreWants(wants, austin).score).toBe(0);
      expect(scoreWants(wants, lagos).score).toBe(0);
    });

    it('is read after a preposition, in the fields as they are joined', () => {
      const wants = [`${STACK} across Africa`, 'Seed round'];
      expect(scoreWants(wants, lagos).reason).toMatch(/\(in Africa\)$/);
      expect(scoreWants(wants, berlin).score).toBe(0);
    });
  });

  // "Fintech-Gründer in Köln oder Düsseldorf": one preposition, two cities. Only the first was read, so the
  // founder in Düsseldorf was filtered out and the member's For You was empty (final review of release 6).
  describe('a list of places after one preposition', () => {
    const founderAt = (name: string, location: string) => fintech(name, location, { expertiseText: 'Fintech Gründer, Zahlungsverkehr' });
    const dieter = founderAt('Dieter', 'Düsseldorf, Germany');
    const kai = founderAt('Kai', 'Köln, Germany');
    const elke = founderAt('Elke', 'Essen, Germany');
    const FIELDS = ['Fintech-Gründer in Köln oder Düsseldorf', 'Raise a seed round for my payments startup'];

    it('control: without the place, the founders in Düsseldorf and Essen are both matches', () => {
      for (const c of [dieter, kai, elke]) {
        expect(scoreWants(['Fintech-Gründer', 'Raise a seed round for my payments startup'], c).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      }
    });

    it('takes the founder in Düsseldorf and the one in Köln, and not the one in Essen', () => {
      for (const wants of [['Fintech-Gründer in Köln oder Düsseldorf'], FIELDS, [FIELDS[1], FIELDS[0]]]) {
        expect(scoreWants(wants, dieter).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
        expect(scoreWants(wants, dieter).reason).toMatch(/\(in Dusseldorf\)$/);
        expect(scoreWants(wants, kai).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
        expect(scoreWants(wants, kai).reason).toMatch(/\(in Cologne\)$/);
        expect(scoreWants(wants, elke).score).toBe(0);
        expect(scoreWants(wants, austin).score).toBe(0);
      }
    });

    it('says the same to the member who is found', () => {
      expect(scoreWantsForRecipient(FIELDS, dieter, 'Ali').reason).toMatch(/\(in Dusseldorf\)$/);
      expect(scoreWantsForRecipient(FIELDS, elke, 'Ali').score).toBe(0);
    });

    // S4-b fix round 2 (I3, the DACH launch): "in der Schweiz oder in Österreich" read Austria only, and a field that
    // starts with "In Düsseldorf and in the Nordics" read the Nordics only.
    it('reads a German article after the first preposition, and a capital In at the start of a field', () => {
      const zuerich = founderAt('Zoe', 'Zürich, Schweiz');
      const wien = founderAt('Willi', 'Wien, Österreich');
      for (const wants of [
        ['Fintech-Gründer in der Schweiz oder in Österreich'],
        ['Fintech-Gründer in der Schweiz oder in Österreich', 'Raise a seed round for my payments startup'],
        ['Raise a seed round for my payments startup', 'Fintech-Gründer in der Schweiz oder in Österreich'],
      ]) {
        expect(scoreWants(wants, zuerich).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
        expect(scoreWants(wants, zuerich).reason).toMatch(/\(in Switzerland\)$/);
        expect(scoreWants(wants, wien).reason).toMatch(/\(in Austria\)$/);
        expect(scoreWants(wants, dieter).score).toBe(0);
        expect(scoreWants(wants, austin).score).toBe(0);
      }
      const fields = ['In Düsseldorf and in the Nordics', `${STACK}`];
      expect(scoreWants(fields, dieter).reason).toMatch(/\(in Dusseldorf\)$/);
      expect(scoreWants(fields, fintech('Sven', 'Stockholm, Sweden')).reason).toMatch(/\(in the Nordics\)$/);
      expect(scoreWants(fields, austin).score).toBe(0);
    });

    // I2: the person who wrote "Dublin, OH" was shut out by a want that named Dublin, OH. N1 (fix round 3): the state is
    // added to the city, never put in its place, so the town of the same name abroad is not shut out either.
    it('finds the person who wrote the same town and state, and keeps the town of the same name abroad', () => {
      const wants = [`${STACK} in Dublin, OH`, 'Raise a seed round'];
      const ohio = scoreWants(wants, fintech('Ola', 'Dublin, OH'));
      expect(ohio.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(ohio.reason).toMatch(/\(in Ohio\)$/);
      const ireland = scoreWants(wants, fintech('Cian', 'Dublin, Ireland'));
      expect(ireland.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(ireland.reason).toMatch(/\(in Dublin\)$/);
      expect(scoreWants(wants, berlin).score).toBe(0);
      const vienna_ = scoreWants([`${STACK} in Vienna, Virginia`, 'Raise a seed round'], fintech('Val', 'Vienna, VA'));
      expect(vienna_.reason).toMatch(/\(in Virginia\)$/);
      expect(scoreWants([`${STACK} in Vienna, Virginia`], vienna).reason).toMatch(/\(in Vienna\)$/);
      expect(scoreWants([`${STACK} in Vienna, Virginia`], berlin).score).toBe(0);
      const kc = [`${STACK} in Kansas City`, 'Raise a seed round'];
      expect(scoreWants(kc, fintech('Kay', 'Kansas City, KS')).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(scoreWants(kc, fintech('Moe', 'Kansas City, MO')).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    });

    // N1: "Business Angels aus Düsseldorf, New York oder London" read New York and London, and every angel in Düsseldorf
    // scored 0. A qualifier after a city never removes the city.
    it('keeps the city a hub list starts with: the angel in Düsseldorf is a match', () => {
      const angel = (name: string, location: string) => fintech(name, location, { professionalRole: ['Investor'], jobTitle: 'Business Angel' });
      const want = 'Business Angels aus Düsseldorf, New York oder London';
      for (const wants of [[want], [want, 'Raise a seed round for my payments startup'], ['Raise a seed round for my payments startup', want]]) {
        for (const [c, shown] of [
          [angel('Dieter', 'Düsseldorf, Germany'), 'Dusseldorf'], [angel('Nora', 'New York, NY'), 'New York'], [angel('Liv', 'London, UK'), 'London'],
        ] as const) {
          const r = scoreWants(wants, c);
          expect([wants, c.displayName, r.score >= MATCH_THRESHOLD]).toEqual([wants, c.displayName, true]);
          expect(r.reason).toMatch(new RegExp(`\\(in ${shown}\\)$`));
        }
        expect(scoreWants(wants, angel('Elke', 'Essen, Germany')).score).toBe(0);
      }
    });

    // M1 (fix round 3): after "in", "die" and "das" say where to. "Fintech-Gründer, die in die DACH-Region expandieren
    // wollen" read DACH and shut out exactly the founders the member wants, the ones not there yet; "in den Bergen" read
    // Bergen, Norway.
    it('reads no place in "in die DACH-Region", "in die USA" or "in den Bergen"', () => {
      const pia = founderAt('Pia', 'Paris, France');
      const alex = founderAt('Alex', 'Austin, Texas');
      for (const wants of [
        ['Fintech-Gründer, die in die DACH-Region expandieren wollen'],
        ['Fintech-Gründer, die in die DACH-Region expandieren wollen', 'Raise a seed round for my payments startup'],
        ['Raise a seed round for my payments startup', 'Fintech-Gründer, die in die USA expandieren wollen'],
        ['Fintech-Gründer für eine Workation in den Bergen', 'Raise a seed round for my payments startup'],
      ]) {
        for (const c of [pia, alex, dieter]) {
          const r = scoreWants(wants, c);
          expect([wants, c.displayName, r.score >= MATCH_THRESHOLD]).toEqual([wants, c.displayName, true]);
          expect(r.reason).not.toMatch(/\(in /);
        }
      }
    });

    // I1: the second place of a list, in lowercase or after a modifier, was dropped and the first alone became the
    // strict filter: "... in the UK or continental Europe" shut out every European candidate.
    it('keeps every place of "in the UK or continental Europe": the people in Europe are not shut out', () => {
      const wants = ['Fintech founders and seed investors in the UK or continental Europe', 'Raise a seed round for my payments startup'];
      for (const [c, shown] of [
        [fintech('Liv', 'London, UK'), 'United Kingdom'], [berlin, 'Europe'], [vienna, 'Europe'], [milan, 'Europe'],
        [fintech('Ina', 'Reykjavik, Iceland'), 'Europe'],
      ] as const) {
        const r = scoreWants(wants, c);
        expect([c.displayName, r.score >= MATCH_THRESHOLD]).toEqual([c.displayName, true]);
        expect(r.reason).toMatch(new RegExp(`\\(in ${shown}\\)$`));
      }
      expect(scoreWants(wants, austin).score).toBe(0);
      expect(scoreWants(wants, fintech('Tunde', 'Lagos, Nigeria')).score).toBe(0);
    });

    it('keeps both places of a lowercase list and of a list with a modifier', () => {
      for (const want of [
        `${STACK} in asia and europe`, `${STACK} in germany and western europe`, `${STACK} in London or mainland Europe`,
        `${STACK} in latam and europe`, `${STACK} in the US and europe`,
      ]) {
        expect([want, scoreWants([want, 'Raise a seed round'], berlin).score >= MATCH_THRESHOLD]).toEqual([want, true]);
      }
      expect(scoreWants([`${STACK} in asia and europe`, 'Raise a seed round'], fintech('Dev', 'Mumbai, India')).reason).toMatch(/\(in Asia\)$/);
      expect(scoreWants([`${STACK} in the US and europe`, 'Raise a seed round'], austin).reason).toMatch(/\(in United States\)$/);
      expect(scoreWants([`${STACK} in Western Europe and the UK`, 'Raise a seed round'], berlin).reason).toMatch(/\(in Europe\)$/);
    });

    it('"Austin, Texas" is Austin: the state after the city does not take the rest of Texas', () => {
      const wants = [`${STACK} in Austin, Texas`, 'Raise a seed round'];
      expect(scoreWants(wants, fintech('Alex', 'Austin, TX')).reason).toMatch(/\(in Austin\)$/);
      expect(scoreWants(wants, fintech('Hal', 'Houston, Texas')).score).toBe(0);
      expect(scoreWants(wants, fintech('Dee', 'Dallas')).score).toBe(0);
      // and a list of cities with a state in the middle is still a list
      const list = [`${STACK} in Austin, Texas and Boston`, 'Raise a seed round'];
      expect(scoreWants(list, fintech('Bo', 'Boston, MA')).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(scoreWants(list, fintech('Hal', 'Houston, Texas')).score).toBe(0);
    });

    it('works in English with three cities, and the last one is as good as the first', () => {
      const wants = [`${STACK} in Berlin, Munich and Hamburg`, 'Raise a seed round'];
      for (const [name, location, shown] of [['Anna', 'Berlin, Germany', 'Berlin'], ['Max', 'München, Germany', 'Munich'], ['Hanna', 'Hamburg', 'Hamburg']]) {
        const r = scoreWants(wants, fintech(name, location));
        expect([name, r.score >= MATCH_THRESHOLD]).toEqual([name, true]);
        expect(r.reason).toMatch(new RegExp(`\\(in ${shown}\\)$`));
      }
      expect(scoreWants(wants, fintech('Frieda', 'Frankfurt, Germany')).score).toBe(0);
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
