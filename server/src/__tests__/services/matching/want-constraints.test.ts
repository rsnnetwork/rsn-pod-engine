// ─── Explicit want constraints (Stefan, 9 Sep 2026) ─────────────────────────
//
// "Manufacturer in US with 20 years experience": place + experience are strict.

import {
  locationTerms, parseYears, extractConstraints, checkConstraints, profileYears,
} from '../../../services/matching/want-constraints';

describe('locationTerms', () => {
  it('recognises country aliases as whole words, case-insensitively', () => {
    expect(locationTerms('manufacturer in US with 20 years experience')).toEqual(['united states']);
    expect(locationTerms('founders in the USA')).toEqual(['united states']);
    expect(locationTerms('based in the U.K.')).toEqual(['united kingdom']);
    expect(locationTerms('German engineers')).toEqual(['germany']);
  });
  it('does not treat the pronoun "us" as a country', () => {
    expect(locationTerms('people who can help us grow')).toEqual([]);
  });
  it('keeps a city after a location preposition', () => {
    expect(locationTerms('designers in London')).toEqual(['london']);
    expect(locationTerms('investors based in New York')).toEqual(['new york']);
    // 10 Sep 2026: how the extractor now phrases an inferred want tied to a place.
    expect(extractConstraints(['country manager in Nairobi', 'country manager']).location).toEqual(['nairobi']);
  });
  it('ignores non-places after "in"', () => {
    expect(locationTerms('experts in Manufacturing and Sales')).toEqual([]);
  });
});

describe('parseYears', () => {
  it('reads digits, plus signs and words', () => {
    expect(parseYears('20 years experience')).toBe(20);
    expect(parseYears('20+ yrs in manufacturing')).toBe(20);
    expect(parseYears('at least ten years')).toBe(10);
    expect(parseYears('two decades of leadership')).toBe(20);
    expect(parseYears('a decade in fintech')).toBe(10);
  });
  it('takes the largest figure and ignores nonsense', () => {
    expect(parseYears('5 years here, 12 years there')).toBe(12);
    expect(parseYears('founded in 2015')).toBeNull();
    expect(parseYears(null)).toBeNull();
  });
});

describe('extractConstraints + checkConstraints — Stefan\'s case', () => {
  const c = extractConstraints(['manufacturer in US with 20 years experience']);
  it('extracts the place and the minimum years', () => {
    expect(c).toEqual({ location: ['united states'], minYears: 20 });
  });
  it('a US manufacturer with 25 stated years satisfies both', () => {
    const r = checkConstraints(c, { location: 'Detroit, USA', bio: 'Industrial fabrication, 25 years in the trade' });
    expect(r).toEqual({ locationOk: true, yearsOk: true, yearsUnknown: false });
  });
  it('a German manufacturer is excluded on location, however experienced', () => {
    const r = checkConstraints(c, { location: 'Munich, Germany', bio: '30 years in manufacturing' });
    expect(r.locationOk).toBe(false);
  });
  it('a US manufacturer with 5 stated years is excluded on experience', () => {
    const r = checkConstraints(c, { location: 'Texas, United States', bio: '5 years running a factory' });
    expect(r).toMatchObject({ locationOk: true, yearsOk: false });
  });
  it('a US profile that states no years is unverifiable, not excluded (caller demotes + says so)', () => {
    const r = checkConstraints(c, { location: 'New York, US', bio: 'We run a production line for auto parts.' });
    expect(r).toEqual({ locationOk: true, yearsOk: null, yearsUnknown: true });
  });
  it('an unknown location does NOT satisfy a required place', () => {
    const r = checkConstraints(c, { location: null, bio: '25 years' });
    expect(r.locationOk).toBe(false);
  });
  it('a city requirement matches the profile location text', () => {
    const cc = extractConstraints(['designers in London']);
    expect(checkConstraints(cc, { location: 'London, UK' }).locationOk).toBe(true);
    expect(checkConstraints(cc, { location: 'Manchester, UK' }).locationOk).toBe(false);
  });
  it('no constraints → nothing to check', () => {
    const none = extractConstraints(['react developers to build my product']);
    expect(none).toEqual({ location: null, minYears: null });
    expect(checkConstraints(none, { location: null })).toEqual({ locationOk: null, yearsOk: null, yearsUnknown: false });
  });
});

describe('profileYears', () => {
  it('reads years from any profile text field', () => {
    expect(profileYears({ jobTitle: 'CTO', expertiseText: 'Over 15 years building hardware' })).toBe(15);
    expect(profileYears({ bio: 'Founder' })).toBeNull();
  });
});

// ─── A region in a want (7 Oct 2026) ─────────────────────────────────────────
//
// A member whose want said "fintech founders, seed investors and payments partners in
// Europe" got no suggestions at all, although every candidate lived in a European city
// ("Berlin, Germany", "Amsterdam, Netherlands", "Milan, Italy"): "Europe" was matched as
// a word against the candidate's location, and nothing knew that Germany is in Europe.
// The same want without "in Europe" gave six strong matches.

const DEMO_WANT = 'fintech founders, seed investors and payments partners in Europe';
const placesIn = (text: string) => locationTerms(text).sort();
/** Does a person at this location satisfy the place this want names? */
const satisfies = (want: string, location: string | null) =>
  checkConstraints(extractConstraints([want]), { location }).locationOk;

describe('a region in a want', () => {
  it('is read as one place, named as the region', () => {
    expect(placesIn(DEMO_WANT)).toEqual(['europe']);
    expect(placesIn('European fintech founders')).toEqual(['europe']);
    expect(placesIn('founders in the EU')).toEqual(['eu']);
    expect(placesIn('founders in the European Union')).toEqual(['eu']);
    expect(placesIn('founders in the DACH region')).toEqual(['dach']);
    expect(placesIn('investors in Benelux')).toEqual(['benelux']);
    expect(placesIn('investors in the Nordics')).toEqual(['nordics']);
    expect(placesIn('investors in Scandinavia')).toEqual(['scandinavia']);
    expect(placesIn('buyers in the Middle East')).toEqual(['middle east']);
    expect(placesIn('buyers in MENA')).toEqual(['mena']);
    expect(placesIn('buyers in the GCC')).toEqual(['gcc']);
    expect(placesIn('founders in Africa')).toEqual(['africa']);
    expect(placesIn('founders in Asia')).toEqual(['asia']);
    expect(placesIn('founders in APAC')).toEqual(['apac']);
    expect(placesIn('founders in Asia-Pacific')).toEqual(['apac']);
    expect(placesIn('founders in Latin America')).toEqual(['latin america']);
    expect(placesIn('founders in LatAm')).toEqual(['latin america']);
    expect(placesIn('founders in North America')).toEqual(['north america']);
    expect(placesIn('founders in EMEA')).toEqual(['emea']);
    // "UK & Ireland" is one region, not the two countries it is made of.
    expect(placesIn('investors in UK & Ireland')).toEqual(['uk and ireland']);
    expect(placesIn('investors in the British Isles')).toEqual(['uk and ireland']);
  });

  it('is not also read as the country whose name it contains', () => {
    // "America" in "Latin America" is not the United States, and "Africa" in "South Africa" is not Africa.
    expect(placesIn('founders in Latin America')).not.toContain('united states');
    expect(placesIn('founders in North America')).not.toContain('united states');
    expect(placesIn('founders in South Africa')).toEqual(['south africa']);
    expect(placesIn('founders in the United Arab Emirates')).toEqual(['united arab emirates']);
  });

  it('can sit beside a country or another region in the same want', () => {
    expect(placesIn('investors in Germany or the Nordics')).toEqual(['germany', 'nordics']);
    expect(placesIn('investors in the Nordics and Benelux')).toEqual(['benelux', 'nordics']);
  });

  it('is extracted as the place the want requires', () => {
    expect(extractConstraints([DEMO_WANT])).toEqual({ location: ['europe'], minYears: null });
  });
});

// "gcc", "mena", the singular "nordic" and "dach" are also a compiler, a first name, a semiconductor
// company and the German word for roof. Each match is a hard place filter (everyone outside the region
// scores 0, and the never-empty fallback never widens place), so they are read as a place only after a
// location preposition, the rule the module already uses for Jordan and Chad. The names nothing else
// is called (Europe, Latin America, ...) are still read anywhere.
describe('a region name that is also an ordinary word', () => {
  it('is not a place when the want merely contains it', () => {
    // locationTerms lists candidates ("from Acme" is one); extractConstraints keeps the ones that are places.
    expect(placesIn('compiler engineers who know GCC and LLVM')).toEqual([]);
    expect(placesIn('Entwickler, die unter einem Dach arbeiten')).toEqual([]);
    expect(placesIn('GCC and MENA are on my mind')).toEqual([]);
    expect(placesIn('Nordic design studios')).toEqual([]);
    for (const want of [
      'compiler engineers who know GCC and LLVM', 'engineers from Nordic Semiconductor',
      'meet Mena from Acme', 'Entwickler, die unter einem Dach arbeiten',
      'GCC and MENA are on my mind', 'Nordic design studios',
    ]) expect(extractConstraints([want]).location).toBeNull();
  });

  it('is still a place after a location preposition', () => {
    expect(placesIn('founders in the GCC')).toEqual(['gcc']);
    expect(placesIn('investors in MENA')).toEqual(['mena']);
    expect(placesIn('people in DACH')).toEqual(['dach']);
    expect(placesIn('partners in the Nordics')).toEqual(['nordics']);
    expect(placesIn('founders in the DACH region')).toEqual(['dach']);
    expect(placesIn('investors from DACH')).toEqual(['dach']);
    expect(placesIn('founders based in the GCC')).toEqual(['gcc']);
    expect(placesIn('buyers located in MENA')).toEqual(['mena']);
    expect(placesIn('founders in Nordic countries')).toEqual(['nordics']);
    expect(placesIn('founders within the Nordic region')).toEqual(['nordics']);
    expect(placesIn('suppliers near DACH')).toEqual(['dach']);
    expect(extractConstraints(['people in DACH']).location).toEqual(['dach']);
  });

  it('keeps working as a place once read: the people there are found, the others are not', () => {
    expect(satisfies('people in DACH', 'Vienna, Austria')).toBe(true);
    expect(satisfies('people in DACH', 'Paris, France')).toBe(false);
    expect(satisfies('founders in the GCC', 'Doha, Qatar')).toBe(true);
    expect(satisfies('founders in the GCC', 'Cairo, Egypt')).toBe(false);
    expect(satisfies('investors in MENA', 'Cairo, Egypt')).toBe(true);
    expect(satisfies('partners in the Nordics', 'Helsinki, Finland')).toBe(true);
  });

  it('leaves the names nothing else is called readable anywhere in the want', () => {
    expect(placesIn('Latin America fintech founders')).toEqual(['latin america']);
    expect(placesIn('European fintech founders')).toEqual(['europe']);
    expect(placesIn('Benelux founders')).toEqual(['benelux']);
    expect(placesIn('APAC founders')).toEqual(['apac']);
    expect(placesIn('Scandinavia-based founders')).toEqual(['scandinavia']);
    expect(placesIn('the Nordics are my market')).toEqual(['nordics']);
  });
});

describe('a region is satisfied by a country inside it', () => {
  it.each([
    ['Europe', 'Berlin, Germany'], ['Europe', 'Amsterdam, Netherlands'], ['Europe', 'Milan, Italy'],
    ['Europe', 'London, UK'], ['Europe', 'Dublin, Ireland'], ['Europe', 'Reykjavik, Iceland'],
    ['Europe', 'Prague, Czech Republic'], ['Europe', 'Prague, Czechia'], ['Europe', 'Athens, Greece'],
    ['Europe', 'Sarajevo, Bosnia & Herzegovina'], ['Europe', 'Istanbul, Türkiye'], ['Europe', 'Nicosia, Cyprus'],
    ['Europe', 'Germany'], ['Europe', 'Remote, Europe'], ['Europe', 'Brussels, Belgium'],
    ['DACH', 'Vienna, Austria'], ['DACH', 'Zurich, Switzerland'], ['DACH', 'Berlin, Germany'],
    ['the EU', 'Berlin, Germany'], ['the EU', 'Lisbon, Portugal'], ['the EU', 'Valletta, Malta'],
    // "the EU" and "Europe" are one region (the brief lists "Europe / EU / European Union" together,
    // and the old alias read eu as europe): the wider list, so the UK, Switzerland and Norway are in it.
    ['the EU', 'London, UK'], ['the EU', 'Zurich, Switzerland'], ['the EU', 'Oslo, Norway'],
    ['the EU', 'Remote, Europe'], ['the EU', 'Belfast, Northern Ireland'], ['Europe', 'Remote, EU'],
    ['Benelux', 'Luxembourg, Luxembourg'], ['Benelux', 'Rotterdam, Holland'], ['Benelux', 'Antwerp, Belgium'],
    ['the Nordics', 'Helsinki, Finland'], ['the Nordics', 'Oslo, Norway'], ['the Nordics', 'Stockholm, Sweden'],
    ['Scandinavia', 'Copenhagen, Denmark'], ['Scandinavia', 'Oslo, Norway'],
    ['UK & Ireland', 'Dublin, Ireland'], ['UK & Ireland', 'Edinburgh, Scotland'], ['UK & Ireland', 'London, UK'],
    ['the Baltics', 'Riga, Latvia'], ['the Baltics', 'Vilnius, Lithuania'],
    ['the Middle East', 'Dubai, United Arab Emirates'], ['the Middle East', 'Tel Aviv, Israel'],
    ['the Middle East', 'Riyadh, Saudi Arabia'], ['the Middle East', 'Cairo, Egypt'], ['the Middle East', 'Beirut, Lebanon'],
    ['MENA', 'Casablanca, Morocco'], ['MENA', 'Doha, Qatar'], ['MENA', 'Tunis, Tunisia'],
    ['the GCC', 'Kuwait City, Kuwait'], ['the GCC', 'Muscat, Oman'], ['the GCC', 'Abu Dhabi'],
    ['Africa', 'Lagos, Nigeria'], ['Africa', 'Nairobi, Kenya'], ['Africa', 'Cape Town, South Africa'],
    ['Africa', 'Accra, Ghana'], ['Africa', 'Cairo, Egypt'], ['Africa', 'Kinshasa, Democratic Republic of the Congo'],
    ['Africa', "Abidjan, Côte d’Ivoire"], ['Africa', 'Niamey, Niger'],
    ['Asia', 'Mumbai, India'], ['Asia', 'Tokyo, Japan'], ['Asia', 'Singapore'], ['Asia', 'Karachi, Pakistan'],
    ['Asia', 'Seoul, South Korea'], ['Asia', 'Hong Kong SAR China'], ['Asia', 'Almaty, Kazakhstan'], ['Asia', 'Hanoi, Vietnam'],
    ['APAC', 'Sydney, Australia'], ['APAC', 'Auckland, New Zealand'], ['APAC', 'Bangalore, India'],
    ['APAC', 'Port Moresby, Papua New Guinea'], ['APAC', 'Suva, Fiji'],
    ['Southeast Asia', 'Jakarta, Indonesia'], ['Southeast Asia', 'Bangkok, Thailand'], ['Southeast Asia', 'Singapore, Singapore'],
    ['Latin America', 'Sao Paulo, Brazil'], ['Latin America', 'Mexico City, Mexico'], ['Latin America', 'Bogotá, Colombia'],
    ['Latin America', 'Buenos Aires, Argentina'], ['Latin America', 'San José, Costa Rica'], ['Latin America', 'Havana, Cuba'],
    ['North America', 'Austin, United States'], ['North America', 'Toronto, Canada'], ['North America', 'Detroit, USA'],
    ['North America', 'Mexico City, Mexico'],
    ['South America', 'Lima, Peru'], ['South America', 'Santiago, Chile'],
    ['Central America', 'Panama City, Panama'], ['Central America', 'Guatemala City, Guatemala'],
    ['EMEA', 'Munich, Germany'], ['EMEA', 'Dubai, UAE'], ['EMEA', 'Johannesburg, South Africa'],
  ])('"%s" takes %s', (region, location) => {
    expect(satisfies(`investors in ${region}`, location)).toBe(true);
  });

  it.each([
    ['Europe', 'Austin, Texas'], ['Europe', 'Austin, United States'], ['Europe', 'Toronto, Canada'],
    ['Europe', 'Dubai, United Arab Emirates'], ['Europe', 'Nairobi, Kenya'], ['Europe', 'Singapore'],
    ['Europe', 'Sydney, Australia'], ['Europe', 'Atlanta, Georgia'], ['Europe', 'Paris, Texas'],
    ['DACH', 'Paris, France'], ['DACH', 'Amsterdam, Netherlands'], ['DACH', 'London, UK'], ['DACH', 'Austin, Texas'],
    ['the EU', 'Austin, Texas'], ['the EU', 'Dubai, United Arab Emirates'], ['the EU', 'Nairobi, Kenya'],
    ['Benelux', 'Paris, France'], ['Benelux', 'Berlin, Germany'],
    ['the Nordics', 'London, UK'], ['the Nordics', 'Tallinn, Estonia'],
    ['Scandinavia', 'Helsinki, Finland'], ['Scandinavia', 'Reykjavik, Iceland'],
    ['UK & Ireland', 'Paris, France'], ['UK & Ireland', 'Berlin, Germany'],
    ['the Baltics', 'Helsinki, Finland'],
    ['the Middle East', 'Mumbai, India'], ['the Middle East', 'Nairobi, Kenya'], ['the Middle East', 'Paris, France'],
    ['MENA', 'Lagos, Nigeria'], ['MENA', 'Ankara, Turkey'],
    ['the GCC', 'Cairo, Egypt'], ['the GCC', 'Amman, Jordan'],
    ['Africa', 'Lisbon, Portugal'], ['Africa', 'Mumbai, India'], ['Africa', 'Paris, France'],
    ['Asia', 'Dubai, UAE'], ['Asia', 'Sydney, Australia'], ['Asia', 'London, UK'],
    ['APAC', 'Dubai, UAE'], ['APAC', 'London, UK'],
    ['Southeast Asia', 'Mumbai, India'], ['Southeast Asia', 'Tokyo, Japan'],
    ['Latin America', 'Austin, United States'], ['Latin America', 'Toronto, Canada'], ['Latin America', 'Madrid, Spain'],
    ['Latin America', 'Albuquerque, New Mexico'], ['Latin America', 'Kingston, Jamaica'],
    ['North America', 'Sao Paulo, Brazil'], ['North America', 'London, UK'],
    ['South America', 'Mexico City, Mexico'], ['Central America', 'Lima, Peru'],
    ['EMEA', 'Austin, United States'], ['EMEA', 'Singapore'], ['EMEA', 'Sao Paulo, Brazil'],
  ])('"%s" does not take %s', (region, location) => {
    expect(satisfies(`investors in ${region}`, location)).toBe(false);
  });

  it('a person whose location is empty does not satisfy a region either', () => {
    expect(satisfies('investors in Europe', null)).toBe(false);
    expect(satisfies('investors in Europe', '')).toBe(false);
  });

  it('a region only matches whole words: no "eu" inside "Eugene" or "Neuchatel"', () => {
    expect(satisfies('investors in the EU', 'Eugene, Oregon')).toBe(false);
    expect(satisfies('investors in the EU', 'Neuchatel')).toBe(false);
    // And a country name inside a longer name is not that country: "Guinea" in "Papua New Guinea"
    // is not Africa, "New Mexico" is not Mexico.
    expect(satisfies('investors in Africa', 'Port Moresby, Papua New Guinea')).toBe(false);
    expect(satisfies('investors in Latin America', 'Albuquerque, New Mexico')).toBe(false);
  });

  it('a profile that names a region itself is read for the regions it sits inside', () => {
    expect(satisfies('investors in Europe', 'Remote, EU')).toBe(true);
    expect(satisfies('investors in Europe', 'Nordics')).toBe(true);
    expect(satisfies('investors in the EU', 'Remote, Europe')).toBe(true);
    expect(satisfies('investors in the EU', 'Remote, DACH')).toBe(true);
    expect(satisfies('investors in the DACH region', 'Remote, EU')).toBe(false);
    expect(satisfies('investors in Latin America', 'Remote, EU')).toBe(false);
  });

  it('Northern Ireland is the UK, not Ireland: in the UK and Ireland and in Europe, and so in the EU', () => {
    expect(satisfies('investors in the UK and Ireland', 'Belfast, Northern Ireland')).toBe(true);
    expect(satisfies('investors in Europe', 'Belfast, Northern Ireland')).toBe(true);
    expect(satisfies('investors in the EU', 'Belfast, Northern Ireland')).toBe(true);
    expect(satisfies('investors in the EU', 'Dublin, Ireland')).toBe(true);
  });

  it('"the EU", "the European Union" and "Europe" are one region, and the card says the one the member wrote', () => {
    expect(extractConstraints(['founders in the EU']).location).toEqual(['eu']);
    expect(extractConstraints(['founders in the European Union']).location).toEqual(['eu']);
    expect(extractConstraints(['European founders']).location).toEqual(['europe']);
    for (const location of ['Berlin, Germany', 'London, UK', 'Zurich, Switzerland', 'Oslo, Norway', 'Kyiv, Ukraine']) {
      expect(satisfies('founders in the EU', location)).toBe(satisfies('founders in Europe', location));
    }
  });

  it('a want that names two places is satisfied by either', () => {
    expect(satisfies('investors in Germany or the Nordics', 'Stockholm, Sweden')).toBe(true);
    expect(satisfies('investors in Germany or the Nordics', 'Berlin, Germany')).toBe(true);
    expect(satisfies('investors in Germany or the Nordics', 'Paris, France')).toBe(false);
  });

  it('a country, a city and the other year/place rules keep working beside regions', () => {
    const c = extractConstraints(['founders in Europe with 10 years experience']);
    expect(c).toEqual({ location: ['europe'], minYears: 10 });
    expect(checkConstraints(c, { location: 'Berlin, Germany', bio: '12 years in payments' }))
      .toEqual({ locationOk: true, yearsOk: true, yearsUnknown: false });
    expect(checkConstraints(c, { location: 'Berlin, Germany', bio: '3 years in payments' })).toMatchObject({ yearsOk: false });
    expect(checkConstraints(c, { location: 'Austin, Texas', bio: '12 years in payments' })).toMatchObject({ locationOk: false });
  });
});

describe('a country that is in no region', () => {
  it('can be named in a want, and is satisfied by a person who lives there', () => {
    expect(extractConstraints(['founders in Jamaica or Canada']).location).toEqual(['canada', 'jamaica']);
    expect(satisfies('founders in Jamaica or Canada', 'Kingston, Jamaica')).toBe(true);
    expect(satisfies('founders in Jamaica or Canada', 'Toronto, Canada')).toBe(true);
    expect(satisfies('founders in Jamaica or Canada', 'London, UK')).toBe(false);
    expect(extractConstraints(['partners in Armenia']).location).toEqual(['armenia']);
    expect(extractConstraints(['partners in the Bahamas']).location).toEqual(['bahamas']);
    expect(extractConstraints(['partners in The Bahamas']).location).toEqual(['bahamas']);
    expect(extractConstraints(['partners in Trinidad and Tobago']).location).toEqual(['trinidad and tobago']);
    expect(extractConstraints(['partners in St. Lucia']).location).toEqual(['saint lucia']);
    expect(satisfies('partners in Trinidad and Tobago', 'Port of Spain, Trinidad & Tobago')).toBe(true);
  });

  it('is in no region, so a region want does not take it', () => {
    for (const region of ['Europe', 'Latin America', 'North America', 'Asia', 'Africa', 'the Middle East']) {
      expect(satisfies(`investors in ${region}`, 'Kingston, Jamaica')).toBe(false);
      expect(satisfies(`investors in ${region}`, 'Yerevan, Armenia')).toBe(false);
    }
  });
});

// "in Berlin Mitte" and "in Austin Texas" capture two capitalised words, and the pair is not a place the
// code knows; its first word is. After "in" (and "based in", "located in", "within", "near") the want is
// naming a place, so the first word is tried. After "from" it is as often a company or a school
// ("Boston Consulting Group", "Oxford University", "Georgia Tech"), which must not become a place.
describe('a two-word capture that is not a place', () => {
  it('falls back to its first word after "in"', () => {
    expect(extractConstraints(['investors in Berlin Mitte']).location).toEqual(['berlin']);
    expect(extractConstraints(['founders in Austin Texas']).location).toEqual(['austin']);
    expect(extractConstraints(['founders within Dallas Fort']).location).toEqual(['dallas']);
    // A country written beside the city is a place as well (any one satisfies), as it always was.
    expect(extractConstraints(['founders based in Zurich Switzerland']).location).toEqual(['switzerland', 'zurich']);
    expect(extractConstraints(['founders located in London England']).location).toEqual(['united kingdom', 'london']);
    expect(satisfies('investors in Berlin Mitte', 'Berlin, Germany')).toBe(true);
    expect(satisfies('investors in Berlin Mitte', 'Hamburg, Germany')).toBe(false);
  });

  it('does not after "from", where a company or a school is as likely as a place', () => {
    expect(extractConstraints(['alumni from Boston Consulting Group']).location).toBeNull();
    expect(extractConstraints(['people from Oxford University']).location).toBeNull();
    expect(extractConstraints(['engineers from Georgia Tech']).location).toBeNull();
  });

  it('never reads a region from the first word (a name that is also a company stays a company)', () => {
    expect(extractConstraints(['engineers in Nordic Semiconductor']).location).toBeNull();
    expect(extractConstraints(['engineers in Dach Holdings']).location).toBeNull();
    expect(extractConstraints(['compiler people in GCC Steering']).location).toBeNull();
  });

  it('stays unknown when the first word is no place either', () => {
    expect(extractConstraints(['founders in Narnia Springs']).location).toBeNull();
    expect(extractConstraints(['founders in Acme Corp']).location).toBeNull();
  });
});

// "Narnia" is a place the code cannot resolve to anything. Reading it as a location every
// candidate must match would empty the list, exactly as "in Europe" did, so it is not a
// constraint at all. So with "in SaaS" or "from Google": capitalised words after a
// preposition that are not places.
describe('a place the code cannot resolve filters nothing', () => {
  it('is not extracted as a constraint', () => {
    expect(extractConstraints(['fintech founders in Narnia']).location).toBeNull();
    expect(extractConstraints(['engineers from Google']).location).toBeNull();
    expect(extractConstraints(['founders in SaaS']).location).toBeNull();
    expect(extractConstraints(['investors in Fintech and Payments']).location).toBeNull();
  });

  it('leaves everyone satisfying it', () => {
    for (const location of ['Berlin, Germany', 'Austin, Texas', 'Nairobi, Kenya', null]) {
      expect(satisfies('fintech founders in Narnia', location)).toBeNull();
    }
  });

  it('beside a place it does know, only the known one counts', () => {
    expect(extractConstraints(['founders in Narnia or Germany']).location).toEqual(['germany']);
    expect(satisfies('founders in Narnia or Germany', 'Munich, Germany')).toBe(true);
    expect(satisfies('founders in Narnia or Germany', 'Paris, France')).toBe(false);
  });

  it('a city or state the code knows is still a hard requirement, and so is any country, however the old table missed it', () => {
    expect(extractConstraints(['designers in London']).location).toEqual(['london']);
    expect(extractConstraints(['designers in Nairobi']).location).toEqual(['nairobi']);
    expect(extractConstraints(['investors based in New York']).location).toEqual(['new york']);
    expect(extractConstraints(['manufacturers in Texas']).location).toEqual(['texas']);
    expect(extractConstraints(['founders in British Columbia']).location).toEqual(['british columbia']);
    expect(satisfies('founders in British Columbia', 'Vancouver, British Columbia')).toBe(true);
    expect(satisfies('founders in British Columbia', 'London, UK')).toBe(false);
    // "New Mexico" is a state, not Mexico; "New England" and "New South Wales" are not England or Wales.
    expect(extractConstraints(['buyers in New Mexico']).location).toEqual(['new mexico']);
    expect(satisfies('buyers in New Mexico', 'Albuquerque, New Mexico')).toBe(true);
    expect(satisfies('buyers in New Mexico', 'Mexico City, Mexico')).toBe(false);
    expect(extractConstraints(['founders in New England']).location).toBeNull();
    expect(extractConstraints(['founders in New South Wales']).location).toBeNull();
    expect(satisfies('manufacturers in Texas', 'Austin, Texas')).toBe(true);
    expect(satisfies('manufacturers in Texas', 'Detroit, Michigan')).toBe(false);
    expect(extractConstraints(['founders in Kazakhstan']).location).toEqual(['kazakhstan']);
    expect(extractConstraints(['founders in Greece']).location).toEqual(['greece']);
    expect(satisfies('founders in Kazakhstan', 'Almaty, Kazakhstan')).toBe(true);
    expect(satisfies('founders in Kazakhstan', 'Berlin, Germany')).toBe(false);
  });
});
