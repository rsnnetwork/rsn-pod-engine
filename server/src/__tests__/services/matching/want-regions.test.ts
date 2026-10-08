// ─── The region table (7 Oct 2026) ───────────────────────────────────────────
//
// A want that names a region ("in Europe", "in DACH") is satisfied by a person whose
// location names a country in it. This pins the table itself: it is data, and a typo
// in it would silently take people out of a region or put them in the wrong one.

import {
  REGIONS, COUNTRY_NAMES, KNOWN_PLACES, regionByKey, regionLabel,
} from '../../../services/matching/want-regions';
import { locationCountries } from '../../../services/matching/want-constraints';

const countriesOf = (key: string): string[] => [...regionByKey(key)!.countries];
const inside = (small: string, big: string) => countriesOf(small).every((c) => countriesOf(big).includes(c));

describe('the region table', () => {
  it('has the regions the product promises', () => {
    const keys = REGIONS.map((r) => r.key);
    for (const wanted of [
      'europe', 'eu', 'dach', 'benelux', 'nordics', 'scandinavia', 'uk and ireland',
      'middle east', 'mena', 'gcc', 'africa', 'asia', 'apac', 'latin america', 'north america',
    ]) expect(keys).toContain(wanted);
  });

  it('is well formed: lowercase keys, one label each, no name claimed by two regions, no country twice', () => {
    const problems: string[] = [];
    const seenKeys = new Set<string>();
    const nameOwner = new Map<string, string>();
    for (const r of REGIONS) {
      if (r.key !== r.key.toLowerCase()) problems.push(`${r.key}: key is not lowercase`);
      if (seenKeys.has(r.key)) problems.push(`${r.key}: key used twice`);
      seenKeys.add(r.key);
      if (!r.label.trim()) problems.push(`${r.key}: no label`);
      if (!r.names.includes(r.key)) problems.push(`${r.key}: is not called by its own key`);
      for (const n of r.names) {
        if (n !== n.toLowerCase()) problems.push(`${r.key}: name "${n}" is not lowercase`);
        const owner = nameOwner.get(n);
        if (owner) problems.push(`"${n}" belongs to both ${owner} and ${r.key}`);
        nameOwner.set(n, r.key);
      }
      if (r.countries.length < 2) problems.push(`${r.key}: fewer than two countries`);
      if (new Set(r.countries).size !== r.countries.length) problems.push(`${r.key}: lists a country twice`);
    }
    expect(problems).toEqual([]);
  });

  it('lists every country by a name that the matcher resolves back to that same country', () => {
    const lost: string[] = [];
    for (const r of REGIONS) {
      for (const c of r.countries) {
        if (!locationCountries(c).includes(c)) lost.push(`${c} (in ${r.key})`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('has no row of country names that no region uses', () => {
    const used = new Set(REGIONS.flatMap((r) => [...r.countries]));
    expect(Object.keys(COUNTRY_NAMES).filter((canon) => !used.has(canon))).toEqual([]);
  });

  it('reads the names a member writes: spellings, old names, the names the app itself writes', () => {
    const cases: Array<[string, string]> = [
      ['Czech Republic', 'czechia'], ['Czechia', 'czechia'], ['Holland', 'netherlands'], ['Deutschland', 'germany'],
      ['Türkiye', 'turkey'], ['Turkey', 'turkey'], ['Bosnia & Herzegovina', 'bosnia and herzegovina'],
      ['Congo - Kinshasa', 'dr congo'], ['Myanmar (Burma)', 'myanmar'], ['Macao SAR China', 'macao'],
      ['Côte d’Ivoire', "cote d'ivoire"], ['Ivory Coast', "cote d'ivoire"], ['São Tomé & Príncipe', 'sao tome and principe'],
      ['Eswatini', 'eswatini'], ['Swaziland', 'eswatini'], ['Timor-Leste', 'timor-leste'], ['East Timor', 'timor-leste'],
      ['North Macedonia', 'north macedonia'], ['Vatican City', 'vatican city'], ['Palestinian Territories', 'palestine'],
      ['Cabo Verde', 'cabo verde'], ['Cape Verde', 'cabo verde'], ['Korea', 'south korea'], ['Viet Nam', 'vietnam'],
    ];
    expect(cases.filter(([written, canon]) => !locationCountries(written).includes(canon))).toEqual([]);
  });

  it('does not find a country inside the name of another place', () => {
    expect(locationCountries('Port Moresby, Papua New Guinea')).toEqual(['papua new guinea']);
    expect(locationCountries('Malabo, Equatorial Guinea')).toEqual(['equatorial guinea']);
    expect(locationCountries('Bissau, Guinea-Bissau')).toEqual(['guinea-bissau']);
    expect(locationCountries('Juba, South Sudan')).toEqual(['south sudan']);
    expect(locationCountries('Albuquerque, New Mexico')).toEqual([]);
    expect(locationCountries('Vancouver, British Columbia')).toEqual([]); // not "British", so not the UK
    expect(locationCountries('Boston, New England')).toEqual([]); // not England
    expect(locationCountries('Sydney, New South Wales')).toEqual([]); // not Wales
    expect(locationCountries('Belfast, Northern Ireland')).toEqual(['united kingdom']); // not Ireland
    expect(locationCountries('Lagos, Nigeria')).toEqual(['nigeria']);
    expect(locationCountries('Santo Domingo, Dominican Republic')).toEqual(['dominican republic']);
    // Georgia is the state as often as the country, so it is left out rather than guessed.
    expect(locationCountries('Atlanta, Georgia')).toEqual([]);
  });

  it('reads "the EU" and "the European Union" as Europe: one region, the wider list', () => {
    // The 27 member states since 2020 are all in it, and so are the UK, Switzerland and Norway.
    const memberStates = [
      'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'denmark', 'estonia', 'finland',
      'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg',
      'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
    ];
    expect(memberStates).toHaveLength(27);
    expect(memberStates.filter((c) => !countriesOf('eu').includes(c))).toEqual([]);
    for (const outside of ['united kingdom', 'switzerland', 'norway']) expect(countriesOf('eu')).toContain(outside);
    expect([...countriesOf('eu')].sort()).toEqual([...countriesOf('europe')].sort());
    // Each keeps its own name and label, so the card says the one the member wrote.
    expect(regionByKey('eu')!.names).toEqual(expect.arrayContaining(['eu', 'european union']));
    expect(regionByKey('europe')!.names).not.toContain('eu');
  });

  it('puts the countries where the lists it was built from put them', () => {
    // Africa: the 54 states of the African Union / UN.
    expect(countriesOf('africa')).toHaveLength(54);
    expect(countriesOf('dach').sort()).toEqual(['austria', 'germany', 'switzerland']);
    expect(countriesOf('benelux').sort()).toEqual(['belgium', 'luxembourg', 'netherlands']);
    expect(countriesOf('scandinavia').sort()).toEqual(['denmark', 'norway', 'sweden']);
    expect(countriesOf('nordics').sort()).toEqual(['denmark', 'finland', 'iceland', 'norway', 'sweden']);
    expect(countriesOf('uk and ireland').sort()).toEqual(['ireland', 'united kingdom']);
    expect(countriesOf('gcc').sort()).toEqual(['bahrain', 'kuwait', 'oman', 'qatar', 'saudi arabia', 'united arab emirates']);
    expect(countriesOf('north america').sort()).toEqual(['canada', 'mexico', 'united states']);
  });

  it('keeps the regions consistent with one another', () => {
    const notInside = ([
      ['eu', 'europe'], ['nordics', 'europe'], ['scandinavia', 'nordics'], ['benelux', 'eu'], ['baltics', 'eu'],
      ['dach', 'europe'], ['uk and ireland', 'europe'], ['gcc', 'middle east'], ['asia', 'apac'],
      ['southeast asia', 'asia'], ['europe', 'emea'], ['middle east', 'emea'], ['africa', 'emea'],
      ['south america', 'latin america'], ['central america', 'latin america'],
    ] as Array<[string, string]>).filter(([small, big]) => !inside(small, big));
    expect(notInside).toEqual([]);
    const overlap = (a: string, b: string) => countriesOf(a).filter((c) => countriesOf(b).includes(c));
    expect(overlap('europe', 'africa')).toEqual([]);
    expect(overlap('europe', 'asia')).toEqual([]);
    expect(overlap('africa', 'asia')).toEqual([]);
    expect(overlap('latin america', 'north america')).toEqual(['mexico']);
  });

  it('gives each region the label the card prints after "in"', () => {
    expect(regionLabel('europe')).toBe('Europe');
    expect(regionLabel('dach')).toBe('DACH');
    expect(regionLabel('nordics')).toBe('the Nordics');
    expect(regionLabel('eu')).toBe('the EU');
    expect(regionLabel('middle east')).toBe('the Middle East');
    expect(regionLabel('uk and ireland')).toBe('the UK and Ireland');
    expect(regionLabel('latin america')).toBe('Latin America');
    expect(regionLabel('germany')).toBeNull();
    expect(regionLabel('narnia')).toBeNull();
  });
});

describe('the country names the app itself writes into a location', () => {
  // The onboarding card stored a member's country as Intl.DisplayNames wrote it, so those exact
  // spellings are what sits in real profiles ("Türkiye", "Czechia", "Bosnia & Herzegovina",
  // "Congo - Kinshasa"). Every country in a region must be reachable from one of them.
  const display = new Intl.DisplayNames(['en'], { type: 'region' });
  const hasNames = display.of('DE') === 'Germany'; // a Node built without full ICU has no names to check

  (hasNames ? it : it.skip)('reaches every listed country from the name Intl gives it', () => {
    const reached = new Set<string>();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of letters) {
      for (const b of letters) {
        const name = display.of(a + b);
        if (!name || name === a + b) continue;
        for (const c of locationCountries(name)) reached.add(c);
      }
    }
    const listed = [...new Set(REGIONS.flatMap((r) => [...r.countries]))];
    expect(listed.filter((c) => !reached.has(c))).toEqual([]);
  });
});

describe('the cities, states and provinces the matcher knows are places', () => {
  it('knows the ones members name, in the one or two words the extractor captures', () => {
    const missing = [
      'london', 'new york', 'berlin', 'nairobi', 'san francisco', 'tel aviv', 'cape town', 'mumbai',
      'texas', 'california', 'north carolina', 'ontario', 'british columbia', 'prince edward',
      'mannheim', 'karlsruhe', 'aarhus',
    ].filter((c) => !KNOWN_PLACES.has(c));
    expect(missing).toEqual([]);
  });

  it('is lowercase ASCII, at most two words, and never a name a country or region already has', () => {
    const problems: string[] = [];
    for (const c of KNOWN_PLACES) {
      if (!/^[a-z]+( [a-z]+)?$/.test(c)) problems.push(`${c}: not lowercase ASCII, one or two words`);
      if (locationCountries(c).length) problems.push(`${c}: is (or contains) a country`);
      if (REGIONS.some((r) => r.names.includes(c))) problems.push(`${c}: is a region`);
    }
    expect(problems).toEqual([]);
  });
});
