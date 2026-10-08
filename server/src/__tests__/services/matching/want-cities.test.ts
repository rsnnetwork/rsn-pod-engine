// ─── The cities, states and provinces table (8 Oct 2026) ─────────────────────
//
// A person's location resolves to a country through a city it names, and a want's "in Köln" is a
// place when the matcher knows the city. The table is hand-kept data: a typo in it would put a
// person in the wrong country or take a place away from a want, so its shape is pinned here.

import {
  CODES_OF_COUNTRIES, KNOWN_PLACES, OWN_REGION_CODES, PLACES, PLACE_BY_NAME, REGION_CODES, SUBREGIONS,
} from '../../../services/matching/want-cities';
import {
  COUNTRY_ALIASES, LOOK_ALIKES, checkConstraints, extractConstraints, fold, locationCountries,
} from '../../../services/matching/want-constraints';
import { REGIONS, COUNTRY_NAMES, ENDONYMS } from '../../../services/matching/want-regions';

const knownCountries = new Set([...Object.keys(COUNTRY_ALIASES), ...Object.keys(COUNTRY_NAMES)]);
const countryOf = (name: string) => PLACE_BY_NAME.get(name)?.country;
/** Does a person at this location satisfy the place this want names? */
const satisfies = (want: string, location: string | null) =>
  checkConstraints(extractConstraints([want]), { location }).locationOk;

// Some entries are also a university, a company or a bank ("from Princeton", "from Redmond", "from
// Santander"), more often than the place a person lives. They still resolve a person's location, but a
// want never names them (a place in a want is a hard filter). The rule is in want-cities.ts; this pins
// the list, so adding to it is a decision someone makes on purpose.
describe('places that are also organisations (location only)', () => {
  // The counties and the Australian state that members write after a city are location only for another
  // reason (a want does not name a county), and are pinned apart below.
  const regionsAfterACity = [
    'east sussex', 'east yorkshire', 'greater manchester', 'merseyside', 'new south wales', 'north yorkshire',
    'south yorkshire', 'tyne and wear', 'west midlands', 'west sussex', 'west yorkshire', 'yorkshire',
  ];
  const onlyAll = PLACES.filter((p) => p.locationOnly).map((p) => p.canon).sort();
  const only = onlyAll.filter((name) => !name.endsWith('shire') && name !== 'cumbria' && !regionsAfterACity.includes(name));

  it('are the universities, companies and metonyms the rule names, and no more', () => {
    expect(only).toEqual([
      'ann arbor', 'berkeley', 'cambridge', 'chapel hill', 'cupertino', 'menlo park', 'mountain view', 'new haven',
      'oxford', 'palo alto', 'princeton', 'redmond', 'santa clara', 'santander', 'silicon valley',
    ]);
  });

  it('are, besides those, only the counties and the Australian state written after a city', () => {
    const rest = onlyAll.filter((name) => !only.includes(name));
    expect(rest.filter((name) => !regionsAfterACity.includes(name) && !name.endsWith('shire') && name !== 'cumbria')).toEqual([]);
    expect(rest).toEqual(expect.arrayContaining(['west yorkshire', 'new south wales', 'lancashire', 'oxfordshire', 'cumbria']));
    // none of them is a town or a county of the United States or Canada as well
    for (const name of ['kent', 'essex', 'norfolk', 'suffolk', 'durham', 'cheshire', 'devon', 'cornwall', 'surrey']) {
      expect([name, PLACES.some((p) => p.canon === name)]).toEqual([name, false]);
    }
  });

  it('are in the table, so a person there resolves, and out of what a want can name', () => {
    for (const name of only) {
      expect([name, KNOWN_PLACES.has(name), PLACE_BY_NAME.has(name)]).toEqual([name, false, false]);
    }
    expect(locationCountries('Palo Alto, CA')).toEqual(['united states']);
    expect(locationCountries('Redmond')).toEqual(['united states']);
    expect(locationCountries('Oxford')).toEqual(['united kingdom']);
    expect(locationCountries('Santander')).toEqual(['spain']);
    expect(locationCountries('Cambridge')).toEqual([]);
  });

  it('leave the launch audience\'s cities and the big cities nameable', () => {
    const missing = [
      'dusseldorf', 'cologne', 'munich', 'vienna', 'zurich', 'geneva', 'basel', 'bern', 'frankfurt', 'hamburg', 'berlin',
      'london', 'paris', 'new york', 'san francisco', 'boulder', 'sunnyvale', 'bellevue', 'barcelona', 'madrid',
      'amsterdam', 'toronto', 'bilbao', 'washington dc',
    ].filter((name) => !KNOWN_PLACES.has(name));
    expect(missing).toEqual([]);
  });
});

describe('the two-letter codes of US states and Canadian provinces', () => {
  const canons = new Set(PLACES.map((p) => p.canon));

  it('name a place the table has, in the right country', () => {
    expect(REGION_CODES.size).toBe(51 + 13); // 50 states and DC, 10 provinces and 3 territories
    for (const [code, region] of REGION_CODES) {
      expect([code, /^[a-z]{2}$/.test(code)]).toEqual([code, true]);
      expect([code, canons.has(region.place)]).toEqual([code, true]);
      const country = PLACES.find((p) => p.canon === region.place)?.country;
      // Georgia is the one place with no country of its own, and the state is meant by GA
      expect([code, country === null ? region.country : country]).toEqual([code, region.country]);
    }
    expect(REGION_CODES.get('va')).toEqual({ place: 'virginia', country: 'united states' });
    expect(REGION_CODES.get('on')).toEqual({ place: 'ontario', country: 'canada' });
    expect(REGION_CODES.get('dc')).toEqual({ place: 'washington dc', country: 'united states' });
  });

  it('keep, for each code that is also a country\'s, exactly the codes of the two kinds', () => {
    for (const [code, country] of CODES_OF_COUNTRIES) {
      expect([code, REGION_CODES.has(code)]).toEqual([code, true]);
      expect([code, knownCountries.has(country)]).toEqual([code, true]);
    }
    // no other region code is a country's ISO code in the tables (a check by the names Intl gives). ICU still
    // answers the retired code NH, the New Hebrides, with Vanuatu: that is not a country's code today.
    const retired = new Set(['nh']);
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    if (display.of('DE') === 'Germany') {
      const missed = [...REGION_CODES.keys()].filter((code) => {
        const name = display.of(code.toUpperCase());
        return !retired.has(code) && name !== undefined && name !== code.toUpperCase() && !CODES_OF_COUNTRIES.has(code)
          && locationCountries(name).length > 0;
      });
      expect(missed).toEqual([]);
    }
  });

  it('list a country\'s own region codes only for codes that collide, and for countries the table has', () => {
    for (const [country, codes] of Object.entries(OWN_REGION_CODES)) {
      expect([country, knownCountries.has(country)]).toEqual([country, true]);
      expect([country, codes.filter((code) => !REGION_CODES.has(code))]).toEqual([country, []]);
    }
  });
});

// A want names a place with one or two capitalised words after a preposition (a hyphenated name is one word), so
// a table entry can be named in a want only by a spelling of that shape. The others resolve a person's location
// and filter nothing when a want names them. This pins exactly which, so a change to the capture or to the table
// that makes one nameable (or another not) is seen.
describe('which places a want can name', () => {
  const written = (name: string) => name.split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
  const namesIt = (name: string, canon: string) => extractConstraints([`founders in ${written(name)}`]).location?.includes(canon) ?? false;
  const nameable = PLACES.filter((p) => !p.locationOnly);
  const cannot = nameable.filter((p) => !p.names.some((name) => namesIt(name, p.canon)));

  it('are all but the few whose every spelling is more than two capitalised words, or has a lowercase joiner, or is a country', () => {
    expect(cannot.map((p) => p.canon).sort()).toEqual([
      'aix en provence', 'dar es salaam', 'mexico city', 'port of spain', 'ras al khaimah', 'salt lake city',
    ]);
  });

  it('still resolve a person\'s location to their country', () => {
    for (const place of cannot) {
      for (const name of place.names) {
        expect([name, locationCountries(`Greater ${written(name)} Area`)]).toEqual([name, [place.country]]);
      }
    }
    expect(locationCountries('Aix-en-Provence')).toEqual(['france']);
    expect(locationCountries('Dar es Salaam')).toEqual(['tanzania']);
    expect(locationCountries('Port of Spain')).toEqual(['trinidad and tobago']);
    expect(locationCountries('Salt Lake City, UT')).toEqual(['united states']);
    expect(locationCountries('Ras Al Khaimah')).toEqual(['united arab emirates']);
  });

  it('are named by a shorter spelling where there is one (Ho Chi Minh City is Saigon in a want), and not otherwise', () => {
    expect(extractConstraints(['founders in Saigon']).location).toEqual(['ho chi minh city']);
    expect(extractConstraints(['founders in Ho Chi Minh City']).location).toBeNull();
    for (const want of ['founders in Aix-en-Provence', 'founders in Ras Al Khaimah', 'founders in Dar es Salaam',
      'founders in Salt Lake City', 'founders in Port of Spain']) {
      expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    }
  });

  it('and "Mexico City" in a want is the country Mexico, which takes a person anywhere in it', () => {
    expect(extractConstraints(['founders in Mexico City']).location).toEqual(['mexico']);
    expect(satisfies('founders in Mexico City', 'Guadalajara')).toBe(true);
  });
});

describe('places that contain others', () => {
  it('list only places the table has, under a place the table has', () => {
    const canons = new Set(PLACES.map((p) => p.canon));
    expect(SUBREGIONS.size).toBeGreaterThan(0);
    for (const [place, members] of SUBREGIONS) {
      expect([place, canons.has(place)]).toEqual([place, true]);
      expect([place, members.filter((m) => !canons.has(m))]).toEqual([place, []]);
    }
  });

  it('give the Bay Area the cities around San Francisco Bay', () => {
    const bay = SUBREGIONS.get('bay area') ?? [];
    for (const city of ['san francisco', 'oakland', 'san jose', 'palo alto', 'mountain view', 'menlo park', 'cupertino', 'sunnyvale', 'santa clara', 'redwood city', 'san mateo', 'berkeley', 'fremont', 'silicon valley']) {
      expect([city, bay.includes(city)]).toEqual([city, true]);
    }
    expect(bay).not.toContain('los angeles');
    expect(bay).not.toContain('sacramento');
  });
});

// A look-alike place ("New Mexico", "British Columbia", "Northern Ireland") is read in a want before the
// country whose name it contains. If it were missing from the table it would be read and then dropped
// as a place the code does not know, silently, so the want would filter nothing.
describe('the look-alike places', () => {
  const alike = LOOK_ALIKES.filter((n) => n.kind === 'place');

  it('are all places the table knows', () => {
    expect(alike.length).toBeGreaterThan(0);
    expect(alike.filter((n) => !KNOWN_PLACES.has(n.canon))).toEqual([]);
  });

  it('are each a place a want can name', () => {
    for (const n of alike) expect([n.name, extractConstraints([`founders in ${n.name}`]).location]).toEqual([n.name, [n.canon]]);
  });

  it('are set apart from the countries they contain, and the decoys are no place at all', () => {
    expect(extractConstraints(['founders in New England']).location).toBeNull();
    expect(extractConstraints(['founders in New South Wales']).location).toBeNull();
    expect(LOOK_ALIKES.filter((n) => n.kind === 'decoy').map((n) => n.name).sort())
      .toEqual(['new england', 'new south wales', 'port of spain']);
  });
});

describe('fold: a name as the matcher reads it', () => {
  it.each([
    ['Düsseldorf', 'dusseldorf'], ['Zürich', 'zurich'], ['Malmö', 'malmo'], ['København', 'kobenhavn'],
    ['Łódź', 'lodz'], ['Straße', 'strasse'], ['Ålesund', 'alesund'], ['İstanbul', 'istanbul'], ['São Paulo', 'sao paulo'],
    ['Côte d’Ivoire', "cote d'ivoire"], ['Bosnia & Herzegovina', 'bosnia and herzegovina'], ['St. Louis', 'st louis'],
    ['Washington, D.C.', 'washington d c'], ['  Greater   Leeds  Area ', 'greater leeds area'], ['Hong Kong SAR China', 'hong kong sar china'],
  ])('%s is read as %s', (written, folded) => {
    expect(fold(written)).toBe(folded);
  });
});

describe('the cities, states and provinces the matcher knows', () => {
  it('knows the ones members name, in the one or two words the extractor captures', () => {
    const missing = [
      'london', 'new york', 'berlin', 'nairobi', 'san francisco', 'tel aviv', 'cape town', 'mumbai',
      'texas', 'california', 'north carolina', 'ontario', 'british columbia', 'prince edward',
      'mannheim', 'karlsruhe', 'aarhus', 'rio', 'washington dc', 'new delhi',
    ].filter((c) => !KNOWN_PLACES.has(c));
    expect(missing).toEqual([]);
  });

  it('knows the major cities of the DACH countries, the other big European cities and the production shapes', () => {
    const named = [
      // Germany, Austria, Switzerland: the launch audience
      'dusseldorf', 'cologne', 'bonn', 'essen', 'dortmund', 'duisburg', 'frankfurt', 'hamburg', 'munich', 'stuttgart',
      'berlin', 'leipzig', 'hannover', 'nuremberg', 'vienna', 'graz', 'linz', 'salzburg', 'zurich', 'geneva', 'basel',
      'bern', 'lausanne',
      // Europe
      'paris', 'amsterdam', 'brussels', 'madrid', 'barcelona', 'lisbon', 'rome', 'milan', 'athens', 'copenhagen',
      'stockholm', 'oslo', 'helsinki', 'warsaw', 'prague', 'budapest', 'bucharest', 'kyiv', 'dublin', 'utrecht',
      // the shapes production members write
      'bangkok', 'mexico city', 'detroit', 'omaha', 'jersey city', 'leeds', 'islamabad', 'denver', 'malmo',
    ].filter((c) => !KNOWN_PLACES.has(c));
    expect(named).toEqual([]);
  });

  it('is well formed: lowercase ASCII, every spelling folded, no spelling used by two places', () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const p of PLACES) {
      if (!/^[a-z]+( [a-z]+)*$/.test(p.canon)) problems.push(`${p.canon}: not lowercase ASCII words`);
      if (p.names[0] !== p.canon) problems.push(`${p.canon}: the first spelling is not the name itself`);
      for (const n of p.names) {
        if (fold(n) !== n) problems.push(`${p.canon}: spelling "${n}" is not in folded form (${fold(n)})`);
        const owner = seen.get(n);
        if (owner !== undefined) problems.push(`"${n}" belongs to both ${owner} and ${p.canon}`);
        seen.set(n, p.canon);
      }
      if (p.country !== null && !knownCountries.has(p.country)) problems.push(`${p.canon}: ${p.country} is not a country the tables know`);
    }
    expect(problems).toEqual([]);
    // Every place is known to a want, except the ones that are also organisations.
    expect(KNOWN_PLACES.size).toBe(PLACES.filter((p) => !p.locationOnly).length);
    expect(new Set(PLACES.map((p) => p.canon)).size).toBe(PLACES.length);
  });

  it('never uses a name a country or region already has', () => {
    const taken = new Set<string>([
      ...Object.values(COUNTRY_ALIASES).flat().map((a) => fold(a.replace(/\./g, ''))),
      ...Object.entries(COUNTRY_NAMES).flatMap(([canon, others]) => [canon, ...others].map(fold)),
      ...Object.values(ENDONYMS).flat().map(fold),
      ...REGIONS.flatMap((r) => r.names.map((n) => fold(n.replace(/\./g, '')))),
    ]);
    const clashes = PLACES.flatMap((p) => p.names.filter((n) => taken.has(n)).map((n) => `${p.canon}: "${n}"`));
    expect(clashes).toEqual([]);
  });

  it('puts the places in the country they are in', () => {
    const cases: Array<[string, string]> = [
      ['london', 'united kingdom'], ['dublin', 'ireland'], ['paris', 'france'], ['dusseldorf', 'germany'],
      ['duesseldorf', 'germany'], ['koln', 'germany'], ['wien', 'austria'], ['zuerich', 'switzerland'],
      ['genf', 'switzerland'], ['barcelona', 'spain'], ['utrecht', 'netherlands'], ['bangkok', 'thailand'],
      ['copenhagen', 'denmark'], ['kobenhavn', 'denmark'], ['mexico city', 'mexico'], ['detroit', 'united states'],
      ['omaha', 'united states'], ['jersey city', 'united states'], ['new jersey', 'united states'],
      ['texas', 'united states'], ['ontario', 'canada'], ['british columbia', 'canada'], ['islamabad', 'pakistan'],
      ['leeds', 'united kingdom'], ['malmo', 'sweden'], ['tel aviv', 'israel'], ['nairobi', 'kenya'],
      ['sao paulo', 'brazil'], ['sydney', 'australia'], ['port of spain', 'trinidad and tobago'],
    ];
    expect(cases.filter(([name, country]) => countryOf(name) !== country)).toEqual([]);
  });

  it('finds every spelling of every place in a location, and resolves it to its country', () => {
    const lost: string[] = [];
    for (const p of PLACES) {
      for (const name of p.names) {
        const countries = locationCountries(`Greater ${name} Area`);
        if (p.country === null ? countries.length > 0 : !countries.includes(p.country)) lost.push(`${name} -> ${countries.join('|') || 'nothing'}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('gives a name that is several countries\' no country of its own', () => {
    for (const ambiguous of ['cambridge', 'georgia', 'san juan']) {
      const place = PLACES.find((p) => p.canon === ambiguous);
      expect([ambiguous, place?.country]).toEqual([ambiguous, null]);
    }
    // Georgia and San Juan can be named in a want; Cambridge is also a university and cannot.
    expect(PLACE_BY_NAME.has('georgia')).toBe(true);
    expect(PLACE_BY_NAME.has('san juan')).toBe(true);
  });

  it('writes one canonical name for the spellings of a city, so a want and a profile agree', () => {
    for (const [spelling, canon] of [
      ['munchen', 'munich'], ['muenchen', 'munich'], ['koln', 'cologne'], ['koeln', 'cologne'], ['wien', 'vienna'],
      ['zuerich', 'zurich'], ['genf', 'geneva'], ['geneve', 'geneva'], ['nurnberg', 'nuremberg'], ['duesseldorf', 'dusseldorf'],
      ['den haag', 'the hague'], ['kobenhavn', 'copenhagen'], ['goteborg', 'gothenburg'], ['praha', 'prague'],
      ['lisboa', 'lisbon'], ['roma', 'rome'], ['bruxelles', 'brussels'], ['kiev', 'kyiv'], ['nyc', 'new york'],
    ]) expect([spelling, PLACE_BY_NAME.get(spelling)?.canon]).toEqual([spelling, canon]);
  });
});
