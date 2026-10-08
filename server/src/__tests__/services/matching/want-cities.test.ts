// ─── The cities, states and provinces table (8 Oct 2026) ─────────────────────
//
// A person's location resolves to a country through a city it names, and a want's "in Köln" is a
// place when the matcher knows the city. The table is hand-kept data: a typo in it would put a
// person in the wrong country or take a place away from a want, so its shape is pinned here.

import { PLACES, KNOWN_PLACES, PLACE_BY_NAME } from '../../../services/matching/want-cities';
import {
  COUNTRY_ALIASES, LOOK_ALIKES, extractConstraints, fold, locationCountries,
} from '../../../services/matching/want-constraints';
import { REGIONS, COUNTRY_NAMES, ENDONYMS } from '../../../services/matching/want-regions';

const knownCountries = new Set([...Object.keys(COUNTRY_ALIASES), ...Object.keys(COUNTRY_NAMES)]);
const countryOf = (name: string) => PLACE_BY_NAME.get(name)?.country;

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
    expect(LOOK_ALIKES.filter((n) => n.kind === 'decoy').map((n) => n.name).sort()).toEqual(['new england', 'new south wales']);
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
    expect(KNOWN_PLACES.size).toBe(PLACES.length);
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
    for (const ambiguous of ['cambridge', 'georgia']) {
      expect(PLACE_BY_NAME.has(ambiguous)).toBe(true);
      expect(countryOf(ambiguous)).toBeNull();
    }
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
