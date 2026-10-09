// ─── Explicit want constraints (Stefan, 9 Sep 2026) ─────────────────────────
//
// "Manufacturer in US with 20 years experience": place + experience are strict.

import {
  locationTerms, parseYears, extractConstraints, checkConstraints, profileYears, matchedPlace,
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
// location preposition, the rule the module already uses for Jordan and Chad. Every other region name
// needs the preposition too (see "a region name is a place only after a location preposition"); these
// five also need a capital letter, and no capitalised word after them ("in Nordic Semiconductor").
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

  it('needs a capital letter and no capitalised word after it, which the other region names do not', () => {
    for (const want of ['experts in gcc internals', 'people in dach', 'suppliers in GCC Steering', 'founders in mena']) {
      expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    }
    expect(placesIn('experts in GCC internals')).toEqual(['gcc']);
    // the others are read in lowercase, and before a capitalised word
    expect(placesIn('investors in europe')).toEqual(['europe']);
    expect(placesIn('investors in Europe Series A')).toEqual(['europe']);
  });
});

// A town that is also a university, a company or a bank ("from Princeton", "from Redmond", "from Santander") is
// more often that than the place a person lives, and a place in a want is a hard filter. Those entries still
// resolve a person's location, but a want never names them (want-cities.ts LOCATION_ONLY has the rule).
describe('a name that is an organisation more often than a place', () => {
  it('is not a place in a want', () => {
    for (const want of [
      'bankers from Santander', 'engineers from Palo Alto Networks', 'people from Silicon Valley Bank',
      'alumni from Santa Clara University', 'founders from Princeton', 'engineers from Redmond',
      'researchers in Oxford', 'coaches in Cambridge', 'founders in Palo Alto', 'investors in Silicon Valley',
      'designers from Cupertino', 'engineers from Mountain View', 'PMs from Menlo Park', 'scholars from New Haven',
      'founders in Ann Arbor', 'researchers in Chapel Hill', 'students from Berkeley',
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, null]);
  });

  it('but the big cities and the launch audience\'s cities are still places', () => {
    for (const [want, place] of [
      ['founders in Zurich', 'zurich'], ['investors in Düsseldorf', 'dusseldorf'], ['angels in Frankfurt', 'frankfurt'],
      ['founders in Berlin', 'berlin'], ['founders in London', 'london'], ['founders in Austin', 'austin'],
      ['founders in Boulder', 'boulder'], ['founders in Sunnyvale', 'sunnyvale'], ['founders in Bellevue', 'bellevue'],
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, [place]]);
  });

  it('after "from", a name that goes on with another capitalised word is not a place', () => {
    for (const want of [
      'engineers from Zurich Insurance', 'bankers from Barcelona Capital', 'alumni from Boston Consulting Group',
      'people from London Business School', 'staff from Berlin Brandenburg Airport', 'analysts from Frankfurt Trust',
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    // a capital letter that starts the next sentence, or follows a comma, does not continue the name
    expect(extractConstraints(['founders from Berlin. Investors welcome']).location).toEqual(['berlin']);
    expect(extractConstraints(['founders from Berlin, Germany']).location).toEqual(expect.arrayContaining(['berlin', 'germany']));
    expect(extractConstraints(['founders from Berlin']).location).toEqual(['berlin']);
  });

  it('a possessive is a person or an organisation, not a place', () => {
    for (const want of [
      "people in Jordan Smith's network", "people in Austin Russell's network", 'people in Chad Smith’s band',
      "founders in Paris Hilton's circle", "startups in Austin's scene",
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    // the same words without the possessive are the places
    expect(extractConstraints(['people in Jordan']).location).toEqual(['jordan']);
    expect(extractConstraints(['people in Austin']).location).toEqual(['austin']);
  });
});

// "The Bay Area" is a region of the cities around San Francisco Bay: a want that names it takes a person in
// any of them. It used to be another spelling of San Francisco, so Palo Alto, Oakland and San Jose failed it
// and the card said "(in San Francisco)".
describe('"the Bay Area"', () => {
  it('is one place however it is written', () => {
    for (const want of [
      'investors in the Bay Area', 'investors in the San Francisco Bay Area', 'investors in the SF Bay Area',
      'Bay Area founders', 'founders based in the Bay Area',
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, ['bay area']]);
  });

  it('takes a person in any of the cities around the Bay', () => {
    for (const location of [
      'San Francisco', 'Oakland, CA', 'San Jose, California', 'Palo Alto, CA', 'Mountain View', 'Menlo Park, CA', 'Cupertino',
      'Sunnyvale, California', 'Santa Clara', 'Redwood City', 'San Mateo', 'Berkeley', 'Fremont, California', 'Silicon Valley',
      'San Francisco Bay Area', 'Bay Area', 'Greater San Francisco Bay Area',
    ]) expect([location, satisfies('investors in the Bay Area', location)]).toEqual([location, true]);
  });

  it('does not take a person elsewhere', () => {
    for (const location of ['Los Angeles', 'Sacramento, CA', 'San Diego', 'Austin, Texas', 'New York', 'Seattle, WA', 'London, UK', '']) {
      expect([location, satisfies('investors in the Bay Area', location)]).toEqual([location, false]);
    }
  });

  it('keeps San Francisco itself a place: the Bay Area counts as San Francisco, as LinkedIn writes it, and not the other way', () => {
    expect(satisfies('founders in San Francisco', 'San Francisco Bay Area')).toBe(true);
    expect(satisfies('founders in San Francisco', 'San Francisco, CA')).toBe(true);
    expect(satisfies('founders in San Francisco', 'Oakland, CA')).toBe(false);
    expect(satisfies('founders in San Francisco', 'Palo Alto')).toBe(false);
  });

  it('resolves to the United States', () => {
    expect(extractConstraints(['founders in the US']).location).toEqual(['united states']);
    expect(satisfies('founders in the US', 'Bay Area')).toBe(true);
    expect(satisfies('founders in North America', 'Silicon Valley')).toBe(true);
  });

  // S4-b fix round 1: "Bay Area" was read anywhere in a want, so "Tampa Bay Area founders" became a strict San
  // Francisco filter. A bay is a place of its own (Tampa Bay, Monterey Bay, Cardiff Bay, Chesapeake Bay), and
  // the Bay Area alone is San Francisco's only where no other place word comes right before it.
  describe('"Bay Area" in a want', () => {
    const read = (...fields: string[]) => extractConstraints(fields).location;

    it('is the San Francisco Bay Area when nothing but a small word comes before it', () => {
      for (const want of [
        'the Bay Area investors', 'Bay Area founders', 'SF Bay Area founders', 'San Francisco Bay Area investors',
        'investors in the Bay Area', 'investors in Bay Area', 'founders from the Bay Area', 'founders near the Bay Area',
        'founders around the Bay Area', 'SF/Bay Area founders', 'San Francisco & Bay Area founders', 'Silicon Valley, Bay Area investors',
        'founders in the bay area', 'angels, the Bay Area', 'East Bay Area founders', 'South Bay Area startups',
      ]) {
        expect([want, read(want)]).toEqual([want, ['bay area']]);
        expect([want, read(want, NEXT_FIELD)]).toEqual([want, ['bay area']]);
        expect([want, read(NEXT_FIELD, want)]).toEqual([want, ['bay area']]);
      }
    });

    it('is not when another place word comes right before it: Tampa Bay, Monterey Bay, Cardiff Bay', () => {
      for (const want of [
        'Tampa Bay Area founders', 'Monterey Bay Area founders', 'Cardiff Bay area startups', 'Chesapeake Bay Area investors',
        'Botany Bay Area founders', 'Galway Bay Area startups',
      ]) {
        expect([want, read(want)]).toEqual([want, null]);
        expect([want, read(want, NEXT_FIELD)]).toEqual([want, null]);
        expect([want, read(NEXT_FIELD, want)]).toEqual([want, null]);
      }
      // after "in" the city before "Bay" is the place, as it always was
      expect(read('founders in the Tampa Bay Area')).toEqual(['tampa']);
      expect(read('startups in Cardiff Bay Area')).toEqual(['cardiff']);
    });

    it('is the Bay Area again after a full stop: the place word before it belongs to the last field', () => {
      expect(read('Founders in Tampa', 'Bay Area startups welcome')).toEqual(['tampa', 'bay area']);
      expect(read('Founders in Austin', 'Bay Area startups welcome')).toEqual(['austin', 'bay area']);
    });
  });

  // The Bay Area alone is how LinkedIn writes San Francisco ("San Francisco Bay Area"), and a person who writes
  // "Bay Area" or "SF Bay Area" without a city is in San Francisco for a want that names the city. A person who
  // names another city around the Bay is in that city, and not in San Francisco.
  describe('a person who writes the Bay Area alone', () => {
    it.each(['Bay Area', 'SF Bay Area', 'The Bay Area', 'San Francisco Bay Area', 'Greater San Francisco Bay Area', 'Bay Area, CA', 'Bay Area, United States'])(
      '"%s" satisfies "in San Francisco" and "in the Bay Area"', (location) => {
        expect([location, satisfies('founders in San Francisco', location)]).toEqual([location, true]);
        expect([location, satisfies('founders in the Bay Area', location)]).toEqual([location, true]);
        expect([location, satisfies('founders in California', location)]).toEqual([location, true]);
      },
    );

    it('says San Francisco on the card for a want that names the city', () => {
      expect(matchedPlace(extractConstraints(['founders in San Francisco']), { location: 'SF Bay Area' })).toBe('san francisco');
      expect(matchedPlace(extractConstraints(['founders in the Bay Area']), { location: 'SF Bay Area' })).toBe('bay area');
    });

    it('is not San Francisco when the person names another city around the Bay', () => {
      for (const location of ['Oakland, Bay Area', 'Palo Alto, Bay Area', 'San Jose, SF Bay Area', 'Berkeley, CA', 'Fremont, California']) {
        expect([location, satisfies('founders in San Francisco', location)]).toEqual([location, false]);
        expect([location, satisfies('founders in the Bay Area', location)]).toEqual([location, true]);
      }
    });

    it('is in the Bay Area when they write a direction before it, and not when they write another place', () => {
      expect(satisfies('founders in the Bay Area', 'East Bay Area, California')).toBe(true);
      expect(satisfies('founders in the Bay Area', 'South Bay Area')).toBe(true);
      expect(satisfies('founders in the Bay Area', 'Tampa Bay Area')).toBe(false);
      expect(satisfies('founders in the Bay Area', 'Monterey Bay Area, CA')).toBe(false);
      expect(satisfies('founders in Florida', 'Tampa Bay Area')).toBe(true);
    });

    it('is not San Francisco outside the Bay Area', () => {
      for (const location of ['Los Angeles', 'Austin, Texas', 'Tampa Bay Area', 'Monterey Bay Area']) {
        expect([location, satisfies('founders in San Francisco', location)]).toEqual([location, false]);
      }
    });
  });
});

// "eu" is the Portuguese for "I" and the first word of every "EU regulation experts" want, so like
// GCC and MENA it is a place only after a location preposition ("in the EU", "from the EU", "based in
// the EU"). "E.U." and "the European Union" are the same after one, and like every region name they
// are not a place anywhere else: "EU-based founders" has no place in it.
describe('"EU" in a want', () => {
  it('is not a place when the want merely contains it', () => {
    for (const want of [
      'EU regulation experts', 'Eu quero conhecer investidores', 'GDPR and EU grants specialists',
      'consultants for EU funding', 'EU data protection counsel',
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    expect(placesIn('EU regulation experts')).toEqual([]);
  });

  it('is a place after a location preposition', () => {
    for (const want of [
      'founders in the EU', 'investors from the EU', 'founders based in the EU', 'buyers located in the EU',
      'suppliers within the EU', 'partners near the EU', 'founders in EU', 'experts in EU markets',
    ]) expect([want, extractConstraints([want]).location]).toEqual([want, ['eu']]);
  });

  it('is read as "E.U." and "the European Union" after a preposition, and nowhere else', () => {
    expect(extractConstraints(['founders in the European Union']).location).toEqual(['eu']);
    expect(extractConstraints(['founders from the European Union']).location).toEqual(['eu']);
    expect(extractConstraints(['founders in the E.U.']).location).toEqual(['eu']);
    for (const want of ['EU-based founders', 'E.U. founders', 'European Union regulators', 'founders for the European Union']) {
      expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    }
  });

  it('still takes the people in Europe when it is a place', () => {
    expect(satisfies('founders based in the EU', 'Berlin, Germany')).toBe(true);
    expect(satisfies('founders based in the EU', 'Austin, Texas')).toBe(false);
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

  it('a region only matches whole words: no "eu" inside "Eugene", "Euclid" or "Eureka"', () => {
    expect(satisfies('investors in the EU', 'Eugene, Oregon')).toBe(false);
    expect(satisfies('investors in the EU', 'Euclid, Ohio')).toBe(false);
    expect(satisfies('investors in the EU', 'Eureka')).toBe(false);
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
    expect(extractConstraints(['founders in European cities']).location).toEqual(['europe']);
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

// A country want used to be satisfied by any location containing the letters of its name, and a city
// by any word of the location: "in Oman" took Bucharest, Romania, and the card said "(in Oman)".
// A country is now satisfied only by a country the location names (placesNamedIn), a city, state or
// province only by that name as a whole word or words.
describe('a place is matched as a whole place, never as letters inside another name', () => {
  it.each([
    ['Mexico', 'Albuquerque, New Mexico'], ['Ireland', 'Belfast, Northern Ireland'], ['Niger', 'Lagos, Nigeria'],
    ['Oman', 'Bucharest, Romania'], ['Mali', 'Malibu, California'], ['Iran', 'Tirana, Albania'],
    ['Sudan', 'Juba, South Sudan'], ['Guinea', 'Port Moresby, Papua New Guinea'], ['Kansas', 'Little Rock, Arkansas'],
    ['Rio', 'Toronto, Ontario'],
    // The same pattern elsewhere in the tables.
    ['Guinea', 'Malabo, Equatorial Guinea'], ['India', 'Indianapolis, Indiana'], ['Oman', 'Romania'],
  ])('"in %s" does not take %s', (place, location) => {
    expect(satisfies(`founders in ${place}`, location)).toBe(false);
  });

  it.each([
    ['Mexico', 'Mexico City, Mexico'], ['Mexico', 'Mexico'], ['Ireland', 'Dublin, Ireland'], ['Niger', 'Niamey, Niger'],
    ['Nigeria', 'Lagos, Nigeria'], ['Oman', 'Muscat, Oman'], ['Mali', 'Bamako, Mali'], ['Iran', 'Tehran, Iran'],
    ['Sudan', 'Khartoum, Sudan'], ['South Sudan', 'Juba, South Sudan'], ['Guinea', 'Conakry, Guinea'],
    ['Kansas', 'Wichita, Kansas'], ['Arkansas', 'Little Rock, Arkansas'], ['Rio', 'Rio, Brazil'],
    ['Ontario', 'Toronto, Ontario'], ['London', 'Greater London Area'], ['New York', 'New York, NY'],
    ['New Mexico', 'Santa Fe, New Mexico'], ['Texas', 'Austin, Texas'], ['York', 'York, England'],
  ])('"in %s" still takes %s', (place, location) => {
    expect(satisfies(`founders in ${place}`, location)).toBe(true);
  });

  it('a city is not found inside a longer place that contains its word', () => {
    expect(satisfies('founders in York', 'New York, NY')).toBe(false);
    expect(satisfies('founders in Washington DC', 'Seattle, Washington')).toBe(false);
    expect(satisfies('founders in Washington', 'Seattle, Washington')).toBe(true);
    expect(satisfies('founders in Washington DC', 'Washington, DC')).toBe(true);
  });

  it('a city written with accents or punctuation is still that city', () => {
    expect(satisfies('founders in Sao Paulo', 'São Paulo, Brazil')).toBe(true);
    expect(satisfies('founders in Bogota', 'Bogotá, Colombia')).toBe(true);
  });
});

// A state or a province in a want takes the people in its cities, as well as the people who write the state
// ("in Oklahoma" misses "Oklahoma City, OK", and "in Indiana" misses "Indianapolis", when only the word counts).
// Every city the table puts in a state is in it for this; the table is the one source of which city is where.
describe('a state or province in a want takes the cities in it', () => {
  it.each([
    ['Oklahoma', 'Oklahoma City, OK'], ['Oklahoma', 'Tulsa'], ['Indiana', 'Indianapolis'], ['Texas', 'Houston'],
    ['Texas', 'Austin'], ['Texas', 'Austin, TX'], ['California', 'Palo Alto'], ['California', 'Los Angeles, CA'],
    ['California', 'San Francisco Bay Area'], ['California', 'Silicon Valley'], ['California', 'Bay Area'],
    ['New York', 'Brooklyn'], ['New York', 'Buffalo, NY'], ['New York', 'Albany'], ['New York', 'NYC'],
    ['Georgia', 'Atlanta'], ['Illinois', 'Chicago'], ['Massachusetts', 'Boston'], ['Florida', 'Miami, FL'],
    ['New Jersey', 'Jersey City'], ['Colorado', 'Boulder'], ['Missouri', 'St. Louis'],
    ['Washington', 'Seattle'], ['Washington', 'Bellevue, WA'], ['Washington', 'Washington, DC'],
    ['Washington', 'Washington D.C.'], ['Washington', 'Washington DC'],
    ['Ontario', 'Toronto'], ['British Columbia', 'Vancouver'], ['Quebec', 'Montreal'], ['Alberta', 'Calgary'],
    ['Nova Scotia', 'Halifax'], ['Saskatchewan', 'Regina'],
  ])('"in %s" takes %s', (state, location) => {
    expect(satisfies(`founders in ${state}`, location)).toBe(true);
  });

  it.each([
    ['Texas', 'Oklahoma City'], ['Oklahoma', 'Austin, Texas'], ['Indiana', 'Chicago'], ['California', 'Las Vegas'],
    ['Nevada', 'San Francisco'], ['New York', 'Newark'],
    ['Washington', 'Portland, Oregon'], ['Ontario', 'Vancouver'], ['Quebec', 'Toronto'], ['Georgia', 'Miami'],
  ])('"in %s" does not take %s', (state, location) => {
    expect(satisfies(`founders in ${state}`, location)).toBe(false);
  });

  it('"Washington" in a want is the state or the capital, and "Washington DC" is only the capital', () => {
    expect(satisfies('founders in Washington', 'Seattle, Washington')).toBe(true);
    expect(satisfies('founders in Washington', 'Washington, DC')).toBe(true);
    expect(satisfies('founders in Washington DC', 'Washington, DC')).toBe(true);
    expect(satisfies('founders in Washington DC', 'Seattle, Washington')).toBe(false);
    expect(satisfies('founders in Washington DC', 'Seattle')).toBe(false);
  });

  it('puts Kansas City in Missouri, where the table has it, unless the person writes Kansas', () => {
    expect(satisfies('founders in Kansas', 'Kansas City, MO')).toBe(false);
    expect(satisfies('founders in Kansas', 'Kansas City')).toBe(false);
    expect(satisfies('founders in Kansas', 'Wichita, Kansas')).toBe(true);
    expect(satisfies('founders in Missouri', 'Kansas City, MO')).toBe(true);
    expect(satisfies('founders in Missouri', 'Kansas City')).toBe(true);
    // the code names the state the person is in, so the Kansas one is Kansas's and no longer Missouri's
    expect(satisfies('founders in Kansas', 'Kansas City, KS')).toBe(true);
    expect(satisfies('founders in Missouri', 'Kansas City, KS')).toBe(false);
  });

  it('names the state the member wrote on the card, not the city', () => {
    expect(matchedPlace(extractConstraints(['founders in Oklahoma']), { location: 'Oklahoma City, OK' })).toBe('oklahoma');
    expect(matchedPlace(extractConstraints(['founders in Washington']), { location: 'Washington, DC' })).toBe('washington');
  });
});

// The capture stopped at a hyphen, so "founders in Guinea-Bissau" was read as Guinea. A word that goes on
// after a hyphen with a capital letter is part of the name; "-based" and the like are not.
describe('a hyphenated name in a want', () => {
  it('stays whole', () => {
    expect(extractConstraints(['founders in Guinea-Bissau']).location).toEqual(['guinea-bissau']);
    expect(extractConstraints(['founders in Timor-Leste']).location).toEqual(['timor-leste']);
    expect(extractConstraints(['founders in Clermont-Ferrand']).location).toEqual(['clermont ferrand']);
    expect(satisfies('founders in Guinea-Bissau', 'Bissau, Guinea-Bissau')).toBe(true);
    expect(satisfies('founders in Guinea-Bissau', 'Conakry, Guinea')).toBe(false);
    expect(satisfies('founders in Guinea', 'Bissau, Guinea-Bissau')).toBe(false);
    expect(satisfies('founders in Guinea', 'Conakry, Guinea')).toBe(true);
  });

  it('does not take a lowercase suffix after the hyphen into the name', () => {
    expect(extractConstraints(['founders from Berlin-based startups']).location).toEqual(['berlin']);
    expect(extractConstraints(['founders in London-based firms']).location).toEqual(['london']);
    expect(extractConstraints(['founders in Austin-area startups']).location).toEqual(['austin']);
  });

  it('tries the first word of an unknown pair after "in", as for two words', () => {
    expect(extractConstraints(['founders in Berlin-Mitte']).location).toEqual(['berlin']);
    expect(extractConstraints(['founders from Coca-Cola']).location).toBeNull();
    expect(extractConstraints(['founders in Baden-Wurttemberg']).location).toBeNull();
  });
});

// In a want, Northern Ireland is its own place: "in Northern Ireland" is not Ireland and it is not the
// whole of the United Kingdom (London satisfied it, and the card said "(in United Kingdom)"). In a
// person's location it is still the United Kingdom, so a UK or Europe want takes Belfast.
describe('Northern Ireland', () => {
  it('is its own place in a want', () => {
    expect(extractConstraints(['founders in Northern Ireland']).location).toEqual(['northern ireland']);
    expect(extractConstraints(['Northern Ireland founders']).location).toEqual(['northern ireland']);
    expect(extractConstraints(['founders based in Northern Ireland or Scotland']).location)
      .toEqual(expect.arrayContaining(['northern ireland', 'united kingdom']));
  });

  it('is satisfied by a location that names Northern Ireland or a city there', () => {
    for (const location of ['Belfast', 'Belfast, Northern Ireland', 'Derry', 'Londonderry, UK', 'Lisburn, UK', 'Newry',
      'Northern Ireland', 'Armagh, Northern Ireland, United Kingdom']) {
      expect([location, satisfies('founders in Northern Ireland', location)]).toEqual([location, true]);
    }
  });

  it('is not satisfied by the rest of the United Kingdom, or by Ireland', () => {
    for (const location of ['London, UK', 'Edinburgh, Scotland', 'Cardiff, Wales', 'Dublin, Ireland', 'Cork', 'Manchester, England', 'United Kingdom', '']) {
      expect([location, satisfies('founders in Northern Ireland', location)]).toEqual([location, false]);
    }
  });

  it('is not Ireland: "in Ireland" does not take Belfast, and "in Northern Ireland" does not take Dublin', () => {
    expect(satisfies('founders in Ireland', 'Belfast, Northern Ireland')).toBe(false);
    expect(satisfies('founders in Ireland', 'Belfast')).toBe(false);
    expect(satisfies('founders in Ireland', 'Dublin, Ireland')).toBe(true);
  });

  it('is still the United Kingdom in a person\'s location', () => {
    for (const location of ['Belfast', 'Belfast, Northern Ireland', 'Northern Ireland', 'Derry']) {
      expect([location, satisfies('founders in the UK', location)]).toEqual([location, true]);
      expect([location, satisfies('founders in Europe', location)]).toEqual([location, true]);
      expect([location, satisfies('founders in the UK and Ireland', location)]).toEqual([location, true]);
      expect([location, satisfies('founders in Germany', location)]).toEqual([location, false]);
    }
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

  it('does not cut a two-word place the code knows down to its first word', () => {
    expect(extractConstraints(['founders in Washington DC']).location).toEqual(['washington dc']);
    expect(extractConstraints(['founders in New York']).location).toEqual(['new york']);
    expect(extractConstraints(['founders in Tel Aviv']).location).toEqual(['tel aviv']);
    expect(extractConstraints(['founders in North Carolina']).location).toEqual(['north carolina']);
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

// ─── The want fields are joined (8 Oct 2026, S4-b fix round 1) ────────────────
//
// The matcher reads the member's want as ONE text: the fields (who I want to meet, my intent, why, goals) are
// joined with ". " (platform-match.service.ts wantSources, want-constraints.ts extractConstraints). A place that
// ends one field is therefore followed by a full stop and the first word of the next field, capitalised, and a
// name captured after a preposition must stop at that full stop. Every test below hands the matcher two fields.
const NEXT_FIELD = 'Raise a seed round for my payments startup';
const endOfField = (field: string) => extractConstraints([field, NEXT_FIELD]).location;

describe('a place that ends a want field, with another field after it', () => {
  it.each([
    ['Fintech founders and seed investors in the EU', 'eu'],
    ['Founders from the EU', 'eu'],
    ['Founders based in the EU', 'eu'],
    ['Founders within the EU', 'eu'],
    ['Founders near the EU', 'eu'],
    ['Founders in EU', 'eu'],
    ['Founders in the E.U.', 'eu'],
    ['Founders in DACH', 'dach'],
    ['Buyers in MENA', 'mena'],
    ['Founders in the GCC', 'gcc'],
    ['Founders in the Nordics', 'nordics'],
    ['Founders in Europe', 'europe'],
    ['Founders from Washington DC', 'washington dc'],
    ['Founders from Washington D.C.', 'washington dc'],
    ['Founders from La Paz', 'la paz'],
    ['Founders from Novi Sad', 'novi sad'],
    ['Founders in Rio', 'rio'],
    ['Founders in NYC', 'new york'],
    ['Founders in Berlin', 'berlin'],
    ['Founders from Berlin', 'berlin'],
    ['Founders in the U.K.', 'united kingdom'],
    ['Founders from the US', 'united states'],
  ])('reads "%s" as %s', (field, place) => {
    expect([field, endOfField(field)]).toEqual([field, [place]]);
  });

  it('is not joined to the first word of the next field as one two-word name', () => {
    expect(locationTerms('Founders in the EU. Raise a seed round')).toEqual(['eu']);
    expect(locationTerms('Founders in the GCC. Raise a seed round')).toEqual(['gcc']);
    expect(locationTerms('Founders from Washington DC. Raise a seed round')).toEqual(['washington dc']);
    expect(locationTerms('Founders in Rio. Raise a seed round')).toEqual(['rio']);
  });

  it('keeps every place when several fields end with one: the first no longer swallows the second', () => {
    const both = extractConstraints(['Founders in the EU', 'Angels in Zurich']).location;
    expect(both).toHaveLength(2);
    expect(both).toEqual(expect.arrayContaining(['eu', 'zurich']));
    const three = extractConstraints(['Founders in the EU', 'Angels in Zurich', 'Bankers from La Paz', NEXT_FIELD]).location;
    expect(three).toHaveLength(3);
    expect(three).toEqual(expect.arrayContaining(['eu', 'zurich', 'la paz']));
  });

  it('still takes "St." as the start of a name, not the end of a sentence', () => {
    expect(endOfField('Partners in St. Lucia')).toEqual(['saint lucia']);
    expect(endOfField('Founders in St. Louis')).toEqual(['st louis']);
    expect(endOfField('Founders from St. Louis')).toEqual(['st louis']);
  });

  it('ends a name at the end of a line too: a place never runs onto the next line', () => {
    expect(extractConstraints(['Founders in the EU\nSeed investors']).location).toEqual(['eu']);
    expect(extractConstraints(['Founders from Berlin\nMunich investors']).location).toEqual(['berlin']);
    expect(extractConstraints(['Founders in Berlin\nSeed investors']).location).toEqual(['berlin']);
  });

  it('still needs the place to be a place: a name that is not one, at a field end, filters nothing', () => {
    expect(endOfField('Founders in Narnia')).toBeNull();
    expect(endOfField('Engineers from Google')).toBeNull();
    expect(endOfField('Founders in SaaS')).toBeNull();
  });
});

// After "from" a capitalised word that goes on is as often the rest of a company or a school as the rest of a
// place ("from Palo Alto Networks"), so the name was refused. But a place the code knows whole is a place, and
// the word after it may only finish it: "from New York City", "from Prince Edward Island", "from Los Angeles CA".
describe('after "from", a place the code knows is taken whole', () => {
  it.each([
    ['Founders from New York City', 'new york'],
    ['Founders from New York State', 'new york'],
    ['Founders from Prince Edward Island', 'prince edward'],
    ['Founders from Los Angeles CA', 'los angeles'],
    ['Founders from San Francisco CA', 'san francisco'],
    ['Founders from Berlin-Mitte', 'berlin'],
  ])('reads "%s" as %s, alone and with a field before or after it', (field, place) => {
    expect([field, extractConstraints([field]).location]).toEqual([field, [place]]);
    expect([field, endOfField(field)]).toEqual([field, [place]]);
    expect([field, extractConstraints([NEXT_FIELD, field]).location]).toEqual([field, [place]]);
  });

  it('does not turn a company or a school that starts with a place into that place', () => {
    for (const field of [
      'Engineers from Palo Alto Networks', 'People from Silicon Valley Bank', 'Journalists from New York Times',
      'Staff from Los Angeles Times', 'People from Hong Kong University', 'Alumni from New York University',
      'Analysts from Frankfurt Trust', 'Bankers from Zurich Insurance', 'Alumni from Boston Consulting Group',
    ]) expect([field, endOfField(field)]).toEqual([field, null]);
  });

  it('a hyphenated name after "from" falls back to its first word only when that is a place', () => {
    expect(extractConstraints(['Founders from Berlin-Mitte']).location).toEqual(['berlin']);
    expect(extractConstraints(['Founders from Coca-Cola']).location).toBeNull();
    expect(extractConstraints(['Founders from Rolls-Royce']).location).toBeNull();
  });

  it('keeps a place that a university or a company is named for out of a want, as before', () => {
    // Oxford and Palo Alto are people's locations but are never named in a want (want-cities.ts LOCATION_ONLY):
    // the place beside them still counts.
    expect(extractConstraints(['Founders in Oxford', 'Investors in London']).location).toEqual(['london']);
    expect(extractConstraints(['Investors in Palo Alto or in Austin']).location).toEqual(['austin']);
  });
});

// ─── A list of places after one preposition (8 Oct 2026, final review) ────────
//
// "Gründer in Köln oder Düsseldorf", "investors in Berlin, Munich and Hamburg": one preposition, several places.
// Only the first was read, so a member who named two cities was shown the people of the first one only, and the
// member whose second city was the one that matched saw an empty list. Places in a want are alternatives: a person
// in any of them satisfies it, so reading the whole list can only add people.
describe('a list of places after one preposition', () => {
  const placesIn_ = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();

  it.each([
    ['Gründer in Köln oder Düsseldorf', ['cologne', 'dusseldorf']],
    ['Investoren in Düsseldorf und Köln', ['cologne', 'dusseldorf']],
    ['Startups in Zürich oder Wien', ['vienna', 'zurich']],
    ['founders in Düsseldorf, Cologne or Essen', ['cologne', 'dusseldorf', 'essen']],
    ['investors in Berlin, Munich and Hamburg', ['berlin', 'hamburg', 'munich']],
    ['investors in Berlin, Munich, and Hamburg', ['berlin', 'hamburg', 'munich']],
    ['investors in Berlin / Munich / Hamburg', ['berlin', 'hamburg', 'munich']],
    ['investors in Berlin & Munich', ['berlin', 'munich']],
    ['investors from Berlin or Munich', ['berlin', 'munich']],
    ['investors based in Berlin and Munich', ['berlin', 'munich']],
    ['investors in Austin or Boston', ['austin', 'boston']],
    ['Investoren in Deutschland und Österreich', ['austria', 'germany']],
    ['Investoren in Deutschland, Österreich und der Schweiz', ['austria', 'germany', 'switzerland']],
    ['investors in Berlin and the Netherlands', ['berlin', 'netherlands']],
  ])('reads every place in "%s"', (want, expected) => {
    expect([want, placesIn_(want)]).toEqual([want, expected]);
    // the matcher joins the fields: the list is the same with another field after it and before it
    expect([want, placesIn_(want, NEXT_FIELD)]).toEqual([want, expected]);
    expect([want, placesIn_(NEXT_FIELD, want)]).toEqual([want, expected]);
  });

  // "Austin, Texas" is the way a city is written, not two places: the state after the city and a comma says which
  // city, and reading it as a second place would take everyone in Texas. (A city followed by a state it is NOT in,
  // "Paris, Texas", keeps the city and adds the state: see "a city qualified by a state or province it is not in".)
  it('does not take the state or country that follows a city and a comma for a second place', () => {
    for (const [want, place] of [
      ['founders in Austin, Texas', 'austin'], ['founders in San Francisco, California', 'san francisco'],
      ['founders in Toronto, Ontario', 'toronto'], ['founders in Albany, New York', 'albany'],
      ['founders in Seattle, Washington', 'seattle'], ['founders from Dallas, Texas', 'dallas'],
      ['founders in Zürich, Schweiz', 'zurich'],
      ['Gründer in Wien, Österreich', 'vienna'], ['founders based in Basel, Switzerland', 'basel'],
    ]) {
      expect([want, placesIn_(want)].flat()).toContain(place);
      // the person in the same state, in another city, is not asked for
      expect([want, placesIn_(want).filter((p) => p !== place && !['switzerland'].includes(p))]).toEqual([want, []]);
      expect([want, placesIn_(want, NEXT_FIELD).filter((p) => p !== place && !['switzerland'].includes(p))]).toEqual([want, []]);
      expect([want, placesIn_(NEXT_FIELD, want).filter((p) => p !== place && !['switzerland'].includes(p))]).toEqual([want, []]);
    }
    expect(satisfies('founders in Austin, Texas', 'Austin, TX')).toBe(true);
    expect(satisfies('founders in Austin, Texas', 'Houston, Texas')).toBe(false);
    expect(satisfies('founders in Toronto, Ontario', 'Ottawa, Ontario')).toBe(false);
    expect(satisfies('founders in Zürich, Schweiz', 'Basel, Schweiz')).toBe(false);
  });

  it('keeps a list of places a list, a state or a city that is not the first one\'s included', () => {
    expect(placesIn_('founders in Boston, New York and Chicago')).toEqual(['boston', 'chicago', 'new york']);
    expect(placesIn_('founders in San Francisco, New York and London')).toEqual(['london', 'new york', 'san francisco']);
    expect(placesIn_('investors in New York, Boston')).toEqual(['boston', 'new york']);
    expect(placesIn_('investors in Texas, Ohio and Oregon')).toEqual(['ohio', 'oregon', 'texas']);
    expect(placesIn_('investors in California, Texas')).toEqual(['california', 'texas']);
    expect(placesIn_('founders in Austin, Ohio')).toEqual(['austin', 'ohio']);
    expect(placesIn_('founders in Austin and Texas')).toEqual(['austin', 'texas']);
    expect(placesIn_('founders in Austin / Texas')).toEqual(['austin', 'texas']);
    // a qualified city is one item of a longer list
    expect(placesIn_('founders in Dallas, Texas and Houston')).toEqual(['dallas', 'houston']);
    expect(placesIn_('founders in Austin, Texas or Boston, Massachusetts')).toEqual(['austin', 'boston']);
    expect(placesIn_('founders in Austin, Texas, Dallas')).toEqual(['austin', 'dallas']);
  });

  it('is satisfied by a person in any of the places, and by nobody else', () => {
    const want = 'Gründer in Köln oder Düsseldorf';
    expect(satisfies(want, 'Düsseldorf, Germany')).toBe(true);
    expect(satisfies(want, 'Köln, Germany')).toBe(true);
    expect(satisfies(want, 'Cologne')).toBe(true);
    expect(satisfies(want, 'Essen, Germany')).toBe(false);
    expect(satisfies(want, 'Austin, Texas')).toBe(false);
    expect(satisfies('investors in Berlin, Munich and Hamburg', 'Hamburg, Germany')).toBe(true);
    expect(satisfies('investors in Berlin, Munich and Hamburg', 'Frankfurt, Germany')).toBe(false);
  });

  it('is read only when the first place is one the code knows', () => {
    expect(placesIn_('investors in Narnia and Berlin')).toEqual([]);
    expect(placesIn_('investors in Narnia, Berlin and Munich')).toEqual([]);
    expect(placesIn_('investors in Fintech and Berlin')).toEqual([]);
    // a name set apart from the countries inside it ("New England" is not England) is not a place either
    expect(placesIn_('investors in New England and Berlin')).toEqual([]);
    expect(placesIn_('investors in Nordic Semiconductor and Berlin')).toEqual([]);
  });

  it('drops an item the code does not know and goes on with the next', () => {
    expect(placesIn_('investors in Berlin and Google')).toEqual(['berlin']);
    expect(placesIn_('investors in Berlin, Google and Munich')).toEqual(['berlin', 'munich']);
    expect(placesIn_('investors in Berlin and Series A startups')).toEqual(['berlin']);
  });

  it('takes an item only as a whole name: the first word of a pair is not tried, as it is after the preposition', () => {
    expect(placesIn_('investors in Berlin and Jordan Smith')).toEqual(['berlin']);
    expect(placesIn_('investors in Berlin and Austin Russell')).toEqual(['berlin']);
    expect(placesIn_('investors in Berlin or Boston Consulting Group')).toEqual(['berlin']);
    // after the preposition itself the first word is still tried
    expect(placesIn_('investors in Austin Russell')).toEqual(['austin']);
    expect(placesIn_('investors in Berlin Mitte and Munich')).toEqual(['berlin', 'munich']);
  });

  it('does not run on past the places: a lowercase word ends the list, and so does a full stop', () => {
    expect(placesIn_('investors in Berlin and venture funds')).toEqual(['berlin']);
    expect(placesIn_('Founders in Berlin', 'Munich investors welcome')).toEqual(['berlin']);
    expect(placesIn_('Founders in Berlin.', 'Munich investors welcome')).toEqual(['berlin']);
    expect(placesIn_('Founders in Berlin,', 'Munich investors welcome')).toEqual(['berlin']);
    expect(placesIn_('Founders in Berlin and', 'Munich investors welcome')).toEqual(['berlin']);
  });

  it('keeps reading places after a second preposition: each list is its own', () => {
    expect(placesIn_('founders in Berlin and Munich and investors in Paris or Lyon')).toEqual(['berlin', 'lyon', 'munich', 'paris']);
    expect(placesIn_('founders from Berlin or Munich, investors in Paris')).toEqual(['berlin', 'munich', 'paris']);
  });

  it('reads a region in a list, and a possessive is still a person or an organisation', () => {
    expect(placesIn_('founders in Berlin and the Nordics')).toEqual(['berlin', 'nordics']);
    expect(placesIn_("founders in Berlin and Munich's best startups")).toEqual(['berlin']);
  });
});

// ─── A region name is a place only after a location preposition (8 Oct 2026, final review) ──
//
// "Founders building for Asia and Africa", "Middle East expansion partners" and "Scandinavian design founders" name
// a region in passing: it describes the work, not where the person must be, and none of them limited the list in
// production. Read anywhere, each limited it to the people located there. A region, written as a noun or as an
// adjective, is a place only after in, from, based in, located in, within, across, throughout or near.
describe('a region name is a place only after a location preposition', () => {
  const read = (want: string) => [...(extractConstraints([want]).location ?? [])].sort();

  it.each([
    ['investors in Europe', 'europe'],
    ['founders across the Nordics', 'nordics'],
    ['founders based in DACH', 'dach'],
    ['founders from Latin America', 'latin america'],
    ['partners located in the Middle East', 'middle east'],
    ['buyers within the GCC', 'gcc'],
    ['sellers throughout Africa', 'africa'],
    ['suppliers near the Baltics', 'baltics'],
    ['founders in Southeast Asia', 'southeast asia'],
    ['founders in Scandinavia', 'scandinavia'],
    ['founders in APAC', 'apac'],
    ['founders in EMEA', 'emea'],
    ['startups in North America', 'north america'],
    ['investors in the UK and Ireland', 'uk and ireland'],
    ['investors in the Middle East and North Africa', 'mena'],
    ['investors in European cities', 'europe'],
    ['founders in Latin American markets', 'latin america'],
    ['founders in Nordic countries', 'nordics'],
    ['experts in EU markets', 'eu'],
    ['investors in europe', 'europe'],
    ['founders in the nordics', 'nordics'],
    ['founders In Europe', 'europe'],
  ])('reads "%s" as %s, alone and beside another field', (want, region) => {
    expect([want, read(want)]).toEqual([want, [region]]);
    expect([want, [...(extractConstraints([want, NEXT_FIELD]).location ?? [])]]).toEqual([want, [region]]);
    expect([want, [...(extractConstraints([NEXT_FIELD, want]).location ?? [])]]).toEqual([want, [region]]);
  });

  it.each([
    'European founders', 'Middle East expansion partners', 'founders building for Asia and Africa', 'Scandinavian design founders',
    'EU-based founders', 'Latin American fintech founders', 'Latin America fintech founders', 'Nordic design studios',
    'APAC expansion experts', 'Benelux founders', 'Scandinavia-based founders', 'the Nordics are my market',
    'expanding into Europe', 'selling to MENA', 'a founder who sold to GCC governments', 'African diaspora founders in tech',
    'North American founders', 'DACH sales leaders', 'growth partners for EMEA', 'Baltic states startups',
    'European Union regulators', 'Gulf states procurement experts',
  ])('does not read a place in "%s", alone or beside another field', (want) => {
    expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    expect([want, extractConstraints([want, NEXT_FIELD]).location]).toEqual([want, null]);
    expect([want, extractConstraints([NEXT_FIELD, want]).location]).toEqual([want, null]);
  });

  it('does not let a preposition at the end of one field reach the region that starts the next', () => {
    expect(extractConstraints(['Founders based in', 'Europe is my target market']).location).toBeNull();
    expect(extractConstraints(['Founders in', 'Asia and Africa interest me']).location).toBeNull();
  });

  it('reads the regions of a list that follows the preposition, and only those', () => {
    expect(read('founders in Asia and Africa')).toEqual(['africa', 'asia']);
    expect(read('partners based in Europe, the Middle East and Africa')).toEqual(['africa', 'europe', 'middle east']);
    expect(read('investors in Germany or the Nordics')).toEqual(['germany', 'nordics']);
    expect(read('investors in the Nordics and Benelux')).toEqual(['benelux', 'nordics']);
    expect(read('founders in Europe building for Asia and Africa')).toEqual(['europe']);
  });

  it('"across" and "throughout" name a city or a state the way "in" does', () => {
    expect(read('founders across Texas')).toEqual(['texas']);
    expect(read('sellers throughout Berlin')).toEqual(['berlin']);
    expect(read('sellers throughout Berlin or Munich')).toEqual(['berlin', 'munich']);
    expect(read('founders across Narnia')).toEqual([]);
  });

  it('keeps a person in the region found, and a person outside it out', () => {
    expect(satisfies('founders building for Asia and Africa', 'Austin, Texas')).toBeNull();
    expect(satisfies('Middle East expansion partners', 'Austin, Texas')).toBeNull();
    expect(satisfies('Scandinavian design founders', 'Austin, Texas')).toBeNull();
    expect(satisfies('founders in Asia and Africa', 'Lagos, Nigeria')).toBe(true);
    expect(satisfies('founders in Asia and Africa', 'Austin, Texas')).toBe(false);
  });
});

// A rule that looks at the text before a name must look at a few words, not at everything before it: read with
// the whole text, a long want full of region names or "Bay Area" took seconds (S4-b fix round 1).
describe('a long text', () => {
  const took = (fn: () => void) => { const t0 = Date.now(); fn(); return Date.now() - t0; };

  it('is read in time proportional to its length', () => {
    for (const text of [
      'in the Nordics '.repeat(7000), 'Tampa Bay Area '.repeat(7000), 'founders in ' + 'Berlin, '.repeat(12000),
      'founders in ' + 'Berlin and '.repeat(9000), 'Bay Area '.repeat(11000),
    ]) expect(took(() => extractConstraints([text]))).toBeLessThan(1500);
  });

  it('is read in time proportional to its length when it is a person\'s location', () => {
    const wants = extractConstraints(['founders in Europe', 'founders in the Bay Area']);
    for (const location of ['Bay Area '.repeat(11000), 'San Francisco, '.repeat(7000) + 'CA', 'Tampa Bay Area, '.repeat(6000)]) {
      expect(took(() => checkConstraints(wants, { location }))).toBeLessThan(1500);
    }
  });
});

// ─── S4-b fix round 2 (9 Oct 2026) ────────────────────────────────────────────────────────────────────────────────
//
// I3 (the DACH launch): a German article after the first preposition ("in der Schweiz"), and a capital "In" or "From"
// at the start of a field, were not read, and beside a place that was read they narrowed the filter to it.
describe('a German article after the first preposition, and a capital preposition', () => {
  const read = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();

  it.each([
    ['Gründer in der Schweiz oder in Österreich', ['austria', 'switzerland']],
    ['Gründer in der Schweiz', ['switzerland']],
    ['Gründer in der Schweiz und in Deutschland', ['germany', 'switzerland']],
    ['Investoren in der DACH-Region', ['dach']],
    ['Investoren in der Schweiz, Österreich und Deutschland', ['austria', 'germany', 'switzerland']],
    ['Investoren in den USA', ['united states']],
    ['Gründer aus der Schweiz', ['switzerland']],
    ['Gründer aus Österreich', ['austria']],
    ['Gründer aus Düsseldorf oder aus Köln', ['cologne', 'dusseldorf']],
    ['Investoren bei München', ['munich']],
    ['In Düsseldorf and in the Nordics', ['dusseldorf', 'nordics']],
    ['In Düsseldorf', ['dusseldorf']],
    ['From Berlin', ['berlin']],
    ['From Berlin or from Munich', ['berlin', 'munich']],
    ['Based in Zürich', ['zurich']],
    ['Located In Munich', ['munich']],
    ['In the Nordics', ['nordics']],
    ['In der Schweiz oder in Österreich', ['austria', 'switzerland']],
    ['Founders In Europe', ['europe']],
    ['Aus Österreich', ['austria']],
  ])('reads every place in "%s"', (want, expected) => {
    expect([want, read(want)]).toEqual([want, expected]);
    expect([want, read(want, NEXT_FIELD)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want, 'Eine Runde aufsetzen')]).toEqual([want, expected]);
  });

  it('is satisfied by the people in any of the places', () => {
    const want = 'Gründer in der Schweiz oder in Österreich';
    expect(satisfies(want, 'Zürich, Schweiz')).toBe(true);
    expect(satisfies(want, 'Wien, Österreich')).toBe(true);
    expect(satisfies(want, 'Düsseldorf')).toBe(false);
    expect(satisfies('In Düsseldorf and in the Nordics', 'Düsseldorf')).toBe(true);
    expect(satisfies('In Düsseldorf and in the Nordics', 'Helsinki, Finland')).toBe(true);
    expect(satisfies('In Düsseldorf and in the Nordics', 'Austin, Texas')).toBe(false);
  });

  it('keeps what it did not read: an article before a word that is no place, and the prepositions as words', () => {
    expect(read('Gründer in der Welt')).toEqual([]);
    expect(read('Mitarbeiter bei Google')).toEqual([]);
    expect(read('Gründer aus Leidenschaft')).toEqual([]);
    expect(read('Inhaber, Haus und Hof, Ausbildung')).toEqual([]);
    expect(read('Investoren aus Zürich Versicherung')).toEqual([]);
    expect(read('Building tools In Fintech')).toEqual([]);
    expect(read('From Zero to One')).toEqual([]);
  });
});

// I2: a city qualified by a state or province it is not in ("Vienna, VA", "Dublin, OH", "Paris, Texas") names that
// state too. It was read as the foreign city alone, so the want named Dublin, Ireland and the person who wrote "Dublin,
// OH" (whose namesake the matcher had dropped) no longer matched the very place they wrote. (N1, fix round 3: the
// state is ADDED to the city, never put in its place: places are alternatives, so this can only widen.)
describe('a city qualified by a state or province it is not in', () => {
  const read = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();

  it.each([
    ['founders in Dublin, OH', ['dublin', 'ohio']], ['founders in Vienna, VA', ['vienna', 'virginia']],
    ['founders in Kansas City, KS', ['kansas', 'kansas city']], ['founders in Portland, ME', ['maine', 'portland']],
    ['founders in Paris, TX', ['paris', 'texas']], ['founders in Columbus, GA', ['columbus', 'georgia']],
    ['founders in Manhattan, KS', ['kansas', 'manhattan']], ['founders in London, ON', ['london', 'ontario']],
    ['founders in Dublin, CA', ['california', 'dublin']], ['founders in Vienna, Virginia', ['vienna', 'virginia']],
    ['founders in Birmingham, Alabama', ['alabama', 'birmingham']], ['founders in Paris, Texas', ['paris', 'texas']],
    ['founders in London, Ontario', ['london', 'ontario']], ['founders in Dublin, Ohio', ['dublin', 'ohio']],
    ['founders from Vienna, VA', ['vienna', 'virginia']], ['founders based in Paris, TX', ['paris', 'texas']],
  ])('reads "%s" as the city and the state or province it names', (want, expected) => {
    expect([want, read(want)]).toEqual([want, expected]);
    expect([want, read(want, NEXT_FIELD)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want, 'Eine Runde aufsetzen')]).toEqual([want, expected]);
  });

  it('finds the people who wrote the same place, and the town of the same name elsewhere too (wider, never narrower)', () => {
    for (const [want, same, elsewhere] of [
      ['founders in Dublin, OH', 'Dublin, OH', 'Dublin, Ireland'], ['founders in Vienna, VA', 'Vienna, VA', 'Vienna, Austria'],
      ['founders in Kansas City, KS', 'Kansas City, KS', 'Kansas City, MO'], ['founders in Portland, ME', 'Portland, ME', 'Portland, OR'],
      ['founders in Paris, TX', 'Paris, TX', 'Paris, France'], ['founders in Columbus, GA', 'Columbus, GA', 'Columbus, OH'],
      ['founders in Manhattan, KS', 'Manhattan, KS', 'Manhattan, NY'], ['founders in London, ON', 'London, ON', 'London, UK'],
      ['founders in Dublin, CA', 'Dublin, CA', 'Dublin, Ireland'], ['founders in Vienna, Virginia', 'Vienna, VA', 'Vienna, Austria'],
      ['founders in Birmingham, Alabama', 'Birmingham, AL', 'Birmingham, UK'], ['founders in Paris, Texas', 'Paris, Texas', 'Paris, France'],
    ]) {
      for (const field of [[want], [want, NEXT_FIELD], [NEXT_FIELD, want]]) {
        expect([want, same, checkConstraints(extractConstraints(field), { location: same }).locationOk]).toEqual([want, same, true]);
        expect([want, elsewhere, checkConstraints(extractConstraints(field), { location: elsewhere }).locationOk]).toEqual([want, elsewhere, true]);
        expect([want, 'Reykjavik, Iceland', checkConstraints(extractConstraints(field), { location: 'Reykjavik, Iceland' }).locationOk]).toEqual([want, 'Reykjavik, Iceland', false]);
      }
    }
  });

  it('says the state on the card', () => {
    expect(matchedPlace(extractConstraints(['founders in Dublin, OH']), { location: 'Dublin, OH' })).toBe('ohio');
    expect(matchedPlace(extractConstraints(['founders in Vienna, Virginia']), { location: 'Vienna, VA' })).toBe('virginia');
  });

  it('keeps the city when the qualifier is where it is, or is the country\'s own code', () => {
    for (const [want, place] of [
      ['founders in Austin, TX', 'austin'], ['founders in Toronto, ON', 'toronto'], ['founders in Portland, OR', 'portland'],
      ['founders in Kansas City, MO', 'kansas city'], ['founders in Berlin, DE', 'berlin'], ['founders in Toronto, CA', 'toronto'],
      ['founders in Perth, WA', 'perth'], ['founders in Neuchâtel, NE', 'neuchatel'], ['founders in Boston, MA', 'boston'],
      ['founders in Barcelona, CT', 'barcelona'], ['founders in Karachi, SD', 'karachi'], ['founders in Utrecht, UT', 'utrecht'],
    ]) {
      expect([want, read(want)]).toEqual([want, [place]]);
      expect([want, read(want, NEXT_FIELD)]).toEqual([want, [place]]);
    }
  });

  it('is one item of a longer list', () => {
    expect(read('founders in Dublin, OH or Boston')).toEqual(['boston', 'dublin', 'ohio']);
    expect(read('founders in Boston and Vienna, VA')).toEqual(['boston', 'vienna', 'virginia']);
    expect(read('founders in Dublin, OH, Dallas and Paris, Texas')).toEqual(['dallas', 'dublin', 'ohio', 'paris', 'texas']);
    expect(read('founders in Germany, Dublin, OH')).toEqual(['dublin', 'germany', 'ohio']);
  });

  it('leaves two cities and a state a list, and a lowercase code alone', () => {
    expect(read('founders in Boston, New York and Chicago')).toEqual(['boston', 'chicago', 'new york']);
    expect(read('founders in Austin, Ohio')).toEqual(['austin', 'ohio']);
    expect(read('founders in Dublin, oh')).toEqual(['dublin']);
  });

  it('takes both towns of one name for a want that names the town and no state', () => {
    expect(satisfies('founders in Kansas City', 'Kansas City, KS')).toBe(true);
    expect(satisfies('founders in Kansas City', 'Kansas City, MO')).toBe(true);
    expect(satisfies('founders in Kansas City', 'Kansas City')).toBe(true);
    expect(satisfies('founders in Portland', 'Portland, ME')).toBe(true);
    expect(satisfies('founders in Portland', 'Portland, OR')).toBe(true);
    // but not a town of another country: Vienna, Virginia is not Vienna, Austria
    expect(satisfies('founders in Vienna', 'Vienna, VA')).toBe(false);
    expect(satisfies('founders in Dublin', 'Dublin, OH')).toBe(false);
    expect(satisfies('founders in London', 'London, ON')).toBe(false);
    // and the state the table puts the town in does not take it when the person wrote another
    expect(satisfies('founders in Missouri', 'Kansas City, KS')).toBe(false);
    expect(satisfies('founders in Oregon', 'Portland, ME')).toBe(false);
    expect(satisfies('founders in New York', 'Manhattan, KS')).toBe(false);
  });
});

// N1 (S4-b fix round 3): the item after "City, " took the city's place whenever it named a state or province the city
// is not in, and it was compared with the last place kept, not with the item next to it. So an everyday abbreviation
// read as a state's code ("Investors in London, PE and VC" became Prince Edward Island), or a second city whose usual
// name is a state's ("Business Angels aus Düsseldorf, New York oder London" lost Düsseldorf), removed a city the member
// named, and every candidate there scored 0. A qualifier after a city never removes the city now: a state or province
// it is not in is ADDED beside it (places are alternatives, so this can only widen), and an item is compared only with
// the item directly before it. Every test hands the matcher the want alone, first, last and in the middle of three.
describe('a qualifier after a city never removes the city', () => {
  const read = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();
  const inEveryField = (want: string) => [[want], [want, NEXT_FIELD], [NEXT_FIELD, want], [NEXT_FIELD, want, 'Eine Runde aufsetzen']];

  it.each([
    // an everyday abbreviation that is also a state's or province's code: the state is added, and the city stays
    ['Investors in London, PE and VC', ['london', 'prince edward']],
    ['Gründer in Düsseldorf, AR und VR', ['arkansas', 'dusseldorf']],
    ['Senior bankers in London, MD or Director level', ['london', 'maryland']],
    ['Founders in Zurich, CO-founders welcome', ['colorado', 'zurich']],
    ['Accountants in Mumbai, CA qualified', ['california', 'mumbai']],
    ['Investors in London, OK with remote', ['london', 'oklahoma']],
    // a second city whose usual name or abbreviation is a state's: both are places
    ['Business Angels aus Düsseldorf, New York oder London', ['dusseldorf', 'london', 'new york']],
    ['Seed investors in Berlin, New York', ['berlin', 'new york']],
    ['Investoren in Berlin, New York und London', ['berlin', 'london', 'new york']],
    ['Investors in Berlin, LA, NYC', ['berlin', 'louisiana', 'new york']],
    ['Policy experts in Brussels, DC and London', ['brussels', 'london', 'washington dc']],
    // the item is compared with the one directly before it ("SF", no place), not with the last place kept: NYC is not
    // read beside Berlin, and Texas is a place of its own, not a word on where Dallas is
    ['VCs in Berlin, SF, NYC', ['berlin', 'new york']],
    ['VCs in Dallas, SF, Texas', ['dallas', 'texas']],
  ])('keeps the city in "%s"', (want, expected) => {
    for (const fields of inEveryField(want)) expect([fields, read(...fields)]).toEqual([fields, expected]);
  });

  it('finds the people in the city the member named, and in the other places', () => {
    for (const [want, location] of [
      ['Business Angels aus Düsseldorf, New York oder London', 'Düsseldorf, Germany'],
      ['Business Angels aus Düsseldorf, New York oder London', 'Greater Düsseldorf Area'],
      ['Business Angels aus Düsseldorf, New York oder London', 'New York, NY'],
      ['Business Angels aus Düsseldorf, New York oder London', 'London, UK'],
      ['Investors in London, PE and VC', 'London, United Kingdom'],
      ['Gründer in Düsseldorf, AR und VR', 'Düsseldorf'],
      ['Senior bankers in London, MD or Director level', 'London, UK'],
      ['Founders in Zurich, CO-founders welcome', 'Zürich, Schweiz'],
      ['Accountants in Mumbai, CA qualified', 'Mumbai, India'],
      ['Investors in London, OK with remote', 'London, UK'],
      ['Seed investors in Berlin, New York', 'Berlin, Germany'],
      ['Investoren in Berlin, New York und London', 'Berlin'],
      ['Investors in Berlin, LA, NYC', 'Berlin, Germany'],
      ['Policy experts in Brussels, DC and London', 'Brussels, Belgium'],
      ['VCs in Berlin, SF, NYC', 'Berlin, Germany'],
      ['VCs in Berlin, SF, NYC', 'New York, NY'],
    ]) {
      for (const fields of inEveryField(want)) {
        expect([fields, location, checkConstraints(extractConstraints(fields), { location }).locationOk]).toEqual([fields, location, true]);
      }
    }
    expect(matchedPlace(extractConstraints(['Business Angels aus Düsseldorf, New York oder London', NEXT_FIELD]), { location: 'Düsseldorf, Germany' })).toBe('dusseldorf');
  });

  it('still keeps out a person in none of the places', () => {
    for (const [want, location] of [
      ['Business Angels aus Düsseldorf, New York oder London', 'Essen, Germany'],
      ['Business Angels aus Düsseldorf, New York oder London', 'Paris, France'],
      ['Gründer in Düsseldorf, AR und VR', 'Köln, Germany'],
      ['VCs in Berlin, SF, NYC', 'Munich, Germany'],
      ['Policy experts in Brussels, DC and London', 'Paris, France'],
    ]) {
      for (const fields of inEveryField(want)) {
        expect([fields, location, checkConstraints(extractConstraints(fields), { location }).locationOk]).toEqual([fields, location, false]);
      }
    }
  });
});

// M1 (S4-b fix round 3): after "in", the German "die" and "das" say where to, not where. "Startups, die in die
// DACH-Region expandieren wollen" are startups that are not there yet, and reading DACH shut out exactly them. And a
// town's name after a German article is a word: "Workation in den Bergen" is the mountains, not Bergen in Norway, and
// "in dem Zug" a train, not Zug. After a preposition only der, dem and den (and "the") are articles now, and after a
// German article only a country or a region is read.
describe('a German article: "in die" says where to, and only a country or a region follows an article', () => {
  const read = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();
  const inEveryField = (want: string) => [[want], [want, NEXT_FIELD], [NEXT_FIELD, want], [NEXT_FIELD, want, 'Eine Runde aufsetzen']];

  it.each([
    'Startups, die in die DACH-Region expandieren wollen',
    'Startups, die in die Schweiz expandieren wollen',
    'Startups, die in die USA expandieren wollen',
    'Startups für die Expansion in die US',
    'Startups, die in das UK expandieren wollen',
    'Firmen, die in die EU expandieren',
    'Firmen, die in die Nordics expandieren',
    'Unternehmen, die in das Vereinigte Königreich gehen',
    'Workation in den Bergen',
    'Ideen austauschen in dem Zug nach München',
    'Gründer aus dem Zug',
  ])('reads no place in "%s"', (want) => {
    for (const fields of inEveryField(want)) expect([fields, extractConstraints(fields).location]).toEqual([fields, null]);
  });

  it.each([
    ['Investoren in den USA', ['united states']],
    ['Gründer in der Schweiz', ['switzerland']],
    ['Investoren in der DACH-Region', ['dach']],
    ['Investoren in der EU', ['eu']],
    ['Gründer in der Türkei', ['turkey']],
    ['Gründer aus der Schweiz', ['switzerland']],
    ['Gründer aus den USA', ['united states']],
    ['Gründer in der Schweiz oder in Österreich', ['austria', 'switzerland']],
    ['investors in the Netherlands', ['netherlands']],
    // the Bay Area is a region of towns, and German writes it with an article
    ['Startups in der Bay Area', ['bay area']],
  ])('still reads "%s"', (want, expected) => {
    for (const fields of inEveryField(want)) expect([fields, read(...fields)]).toEqual([fields, expected]);
  });

  it('reads no town after a German article in a list either, and still the countries', () => {
    for (const fields of inEveryField('Workation in Köln und den Bergen')) expect([fields, read(...fields)]).toEqual([fields, ['cologne']]);
    for (const fields of inEveryField('Startups in Berlin, die Zug fahren')) expect([fields, read(...fields)]).toEqual([fields, ['berlin']]);
    expect(read('Investoren in Deutschland, Österreich und der Schweiz')).toEqual(['austria', 'germany', 'switzerland']);
    expect(read('Investoren in Deutschland und die Schweiz')).toEqual(['germany', 'switzerland']);
  });

  it('still reads the places the same want names elsewhere', () => {
    expect(read('Startups in Berlin, die in die USA expandieren wollen')).toEqual(['berlin']);
    expect(read('Gründer in Köln, die in die DACH-Region expandieren', 'Investoren in der Schweiz')).toEqual(['cologne', 'switzerland']);
  });

  it('keeps nobody out for a direction or a word', () => {
    for (const want of ['Startups, die in die DACH-Region expandieren wollen', 'Workation in den Bergen', 'Startups, die in die USA expandieren wollen']) {
      for (const location of ['Paris, France', 'Austin, Texas', 'Bergen, Norway', 'Zug, Switzerland']) {
        expect([want, location, satisfies(want, location)]).toEqual([want, location, null]);
      }
    }
  });
});


// I1: "Fintech founders and seed investors in the UK or continental Europe" read the UK only. The region is the second
// place of a list, in lowercase or after a modifier, and was dropped; the other place alone became the strict filter
// (12 of 12 European candidates scored 0). A region that continues a list after a place already read is read, and a
// modifier ("continental", "Western", "the rest of") between the preposition or the joiner and the region is no
// obstacle. Every test hands the matcher the want among other fields.
describe('a region that continues a list, or follows a modifier', () => {
  const read = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();

  it.each([
    ['Fintech founders and seed investors in the UK or continental Europe', ['europe', 'united kingdom']],
    ['Seed investors in London or mainland Europe', ['europe', 'london']],
    ['seed investors in asia and europe', ['asia', 'europe']],
    ['Seed investors in latam and europe', ['europe', 'latin america']],
    ['Seed investors in the US and europe', ['europe', 'united states']],
    ['Seed investors in Germany and Western Europe', ['europe', 'germany']],
    ['Seed investors in DACH and wider Europe', ['dach', 'europe']],
    ['Fintech founders in Berlin or Western Europe', ['berlin', 'europe']],
    ['Fintech founders in Western Europe and the UK', ['europe', 'united kingdom']],
    ['founders in germany and the nordics', ['germany', 'nordics']],
    ['investors in europe or the middle east', ['europe', 'middle east']],
    // more of the same shapes
    ['investors in the Nordics, Benelux and eastern Europe', ['benelux', 'europe', 'nordics']],
    ['investors in Berlin, Munich and the rest of Europe', ['berlin', 'europe', 'munich']],
    ['founders in asia, europe and africa', ['africa', 'asia', 'europe']],
    ['founders in Germany or Austria or the rest of Europe', ['austria', 'europe', 'germany']],
    ['founders in London und mainland Europe', ['europe', 'london']],
    ['founders in Zürich or Wien or Europe', ['europe', 'vienna', 'zurich']],
    ['founders in the UK, Ireland and the Nordics', ['ireland', 'nordics', 'united kingdom']],
    ['seed investors in asia & europe', ['asia', 'europe']],
    ['seed investors in asia / europe', ['asia', 'europe']],
    ['seed investors based in europe and north america', ['europe', 'north america']],
    ['founders in Paris and sub-Saharan Africa', ['africa', 'paris']],
    ['founders in Asia and Central Asia', ['asia']],
  ])('reads every place in "%s"', (want, expected) => {
    expect([want, read(want)]).toEqual([want, expected]);
    // the matcher joins the fields: the same with another field after it, before it, and on both sides
    expect([want, read(want, NEXT_FIELD)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want, 'Eine Runde aufsetzen')]).toEqual([want, expected]);
  });

  it('reads a region after a modifier alone: "Western Europe" is Europe', () => {
    for (const [want, place] of [
      ['investors in Western Europe', 'europe'], ['investors in Eastern Europe', 'europe'], ['investors in continental Europe', 'europe'],
      ['investors in the rest of Europe', 'europe'], ['investors in southern Europe', 'europe'], ['investors in Central Asia', 'asia'],
      ['investors in sub-Saharan Africa', 'africa'], ['investors in other European countries', 'europe'],
      ['investors based in northern Europe', 'europe'], ['investors from wider Europe', 'europe'],
      ['investors across mainland Europe', 'europe'], ['investors in Greater Europe', 'europe'],
      ['investors within Western Europe', 'europe'], ['investors near the rest of Europe', 'europe'],
      ['investors in Sub Saharan Africa', 'africa'], ['investors in Southern Africa', 'africa'],
    ]) {
      expect([want, read(want)]).toEqual([want, [place]]);
      expect([want, read(want, NEXT_FIELD)]).toEqual([want, [place]]);
      expect([want, read(NEXT_FIELD, want)]).toEqual([want, [place]]);
    }
  });

  it('still needs a location preposition, or a place already read: a modifier does not make a mention a place', () => {
    for (const want of [
      'Western Europe expansion partners', 'continental European founders', 'founders building for Western Europe',
      'the rest of Europe is my market', 'investors who know mainland Europe', 'investors in fintech and europe',
      'investors in tech or western europe', 'founders in sales, wider Europe', 'Central Asia specialists',
      'selling to southern Europe',
    ]) {
      expect([want, extractConstraints([want]).location]).toEqual([want, null]);
      expect([want, extractConstraints([want, NEXT_FIELD]).location]).toEqual([want, null]);
      expect([want, extractConstraints([NEXT_FIELD, want]).location]).toEqual([want, null]);
    }
  });

  it('does not take a name that merely starts with a modifier for the region', () => {
    expect(read('investors in Central America')).toEqual(['central america']);
    expect(read('investors in Northern Ireland')).toEqual(['northern ireland']);
    expect(read('investors in South Africa')).toEqual(['south africa']);
    expect(read('investors in Greater Manchester')).toEqual([]);
    expect(read('investors in Middle East')).toEqual(['middle east']);
  });

  it('does not take an ordinary word for a region: only a capital letter and no capitalised word after it', () => {
    expect(read('investors in Germany and eu regulators')).toEqual(['germany']);
    expect(read('investors in Germany and dach roofers')).toEqual(['germany']);
    expect(read('investors in Germany and gcc compilers')).toEqual(['germany']);
    expect(read('investors in Germany and DACH')).toEqual(['dach', 'germany']);
  });

  it('is satisfied by the people in any of the places, and by nobody else', () => {
    const want = 'Fintech founders and seed investors in the UK or continental Europe';
    for (const location of ['London, UK', 'Berlin, Germany', 'Wien, Österreich', 'Reykjavik, Iceland']) {
      expect([location, satisfies(want, location)]).toEqual([location, true]);
    }
    for (const location of ['Austin, Texas', 'Lagos, Nigeria', 'Dubai, UAE']) {
      expect([location, satisfies(want, location)]).toEqual([location, false]);
    }
    expect(satisfies('seed investors in asia and europe', 'Berlin, Germany')).toBe(true);
    expect(satisfies('seed investors in asia and europe', 'Mumbai, India')).toBe(true);
    expect(satisfies('seed investors in asia and europe', 'Austin, Texas')).toBe(false);
  });
});

// I1, two more shapes found while testing: "and/or" joins a list too, and "the rest of the EU" has an article after the
// modifier ("the rest of Europe" was read, "the rest of the EU" was not).
describe('a list joined by "and/or", and "the rest of the" before a region', () => {
  const read = (...fields: string[]) => [...(extractConstraints(fields).location ?? [])].sort();

  it.each([
    ['investors in the UK and/or continental Europe', ['europe', 'united kingdom']],
    ['Gründer in Köln und/oder Düsseldorf', ['cologne', 'dusseldorf']],
    ['seed investors in asia and/or europe', ['asia', 'europe']],
    ['investors in London and/or Paris', ['london', 'paris']],
    ['investors in Germany and the rest of the EU', ['eu', 'germany']],
    ['investors in the rest of the Nordics', ['nordics']],
    ['investors in Berlin or the rest of the DACH region', ['berlin', 'dach']],
    ['investors in the UK, Ireland and the rest of the Nordics', ['ireland', 'nordics', 'united kingdom']],
    ['investors in the wider Nordics', ['nordics']],
    ['investors in the western EU', ['eu']],
  ])('reads every place in "%s"', (want, expected) => {
    expect([want, read(want)]).toEqual([want, expected]);
    expect([want, read(want, NEXT_FIELD)]).toEqual([want, expected]);
    expect([want, read(NEXT_FIELD, want, 'Eine Runde aufsetzen')]).toEqual([want, expected]);
  });

  it('still reads nothing without a preposition or a place before it', () => {
    for (const want of ['the rest of the EU is my market', 'selling to the rest of the Nordics', 'investors who know the western EU']) {
      expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    }
  });
});
