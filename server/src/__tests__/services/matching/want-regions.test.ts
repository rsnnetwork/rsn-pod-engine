// ─── The region table (7 Oct 2026) ───────────────────────────────────────────
//
// A want that names a region ("in Europe", "in DACH") is satisfied by a person whose
// location names a country in it. This pins the table itself: it is data, and a typo
// in it would silently take people out of a region or put them in the wrong one.

import {
  REGIONS, COUNTRY_NAMES, COUNTRIES_IN_NO_REGION, ENDONYMS, regionByKey, regionLabel, placeLabel,
} from '../../../services/matching/want-regions';
import { COUNTRY_ALIASES, locationCountries } from '../../../services/matching/want-constraints';

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

  it('marks the region names that are also ordinary words, and only those, as read after a preposition only', () => {
    const marked = REGIONS.flatMap((r) => (r.afterPreposition ?? []).map((name) => ({ key: r.key, name })));
    expect(marked.map((m) => m.name).sort()).toEqual(['dach', 'eu', 'gcc', 'mena', 'nordic']);
    // Each is a name of its own region, so it is still read there, after a preposition.
    expect(marked.filter((m) => !regionByKey(m.key)!.names.includes(m.name))).toEqual([]);
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

  it('has no row of country names that no region uses, except the ones that say they are in no region', () => {
    const used = new Set(REGIONS.flatMap((r) => [...r.countries]));
    expect(Object.keys(COUNTRY_NAMES).filter((canon) => !used.has(canon) && !COUNTRIES_IN_NO_REGION.includes(canon))).toEqual([]);
    // ...and a country that says so is in no region (if a region takes it in, it moves to the regions' rows).
    expect(COUNTRIES_IN_NO_REGION.filter((canon) => used.has(canon))).toEqual([]);
    expect(COUNTRIES_IN_NO_REGION.length).toBeGreaterThan(0);
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
    expect(locationCountries('Albuquerque, New Mexico')).toEqual(['united states']); // a state: the US, not Mexico
    expect(locationCountries('Vancouver, British Columbia')).toEqual(['canada']); // not "British", so not the UK
    expect(locationCountries('Boston, New England')).toEqual(['united states']); // not England
    expect(locationCountries('Sydney, New South Wales')).toEqual(['australia']); // not Wales
    expect(locationCountries('Belfast, Northern Ireland')).toEqual(['united kingdom']); // not Ireland
    expect(locationCountries('Lagos, Nigeria')).toEqual(['nigeria']);
    expect(locationCountries('Santo Domingo, Dominican Republic')).toEqual(['dominican republic']);
    // Georgia is the state as often as the country, so it is no country on its own: Atlanta says the US.
    expect(locationCountries('Atlanta, Georgia')).toEqual(['united states']);
    expect(locationCountries('Georgia')).toEqual([]);
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

describe('the name a card prints after "in"', () => {
  it.each([
    ['bosnia and herzegovina', 'Bosnia and Herzegovina'], ['republic of the congo', 'Republic of the Congo'],
    ["cote d'ivoire", "Cote d'Ivoire"], ['dr congo', 'DR Congo'], ['sao tome and principe', 'Sao Tome and Principe'],
    ['united states', 'United States'], ['united kingdom', 'United Kingdom'], ['united arab emirates', 'United Arab Emirates'],
    ['guinea-bissau', 'Guinea-Bissau'], ['timor-leste', 'Timor-Leste'], ['north macedonia', 'North Macedonia'],
    ['new york', 'New York'], ['washington dc', 'Washington DC'], ['prince edward', 'Prince Edward Island'],
    ['st gallen', 'St Gallen'], ['germany', 'Germany'],
    // A region says what the member wrote.
    ['europe', 'Europe'], ['dach', 'DACH'], ['nordics', 'the Nordics'], ['eu', 'the EU'],
  ])('%s prints as %s', (key, shown) => {
    expect(placeLabel(key)).toBe(shown);
  });

  it('keeps "and", "of" and "the" lowercase inside every country name the tables know', () => {
    const names = new Set([...REGIONS.flatMap((r) => [...r.countries]), ...Object.keys(COUNTRY_NAMES)]);
    const wrong = [...names].map(placeLabel).filter((shown) => / (And|Of|The) /.test(shown) || !/^[A-Z]/.test(shown));
    expect(wrong).toEqual([]);
  });
});

describe('the names a country is written with at home', () => {
  it('belong to countries the tables know, and resolve back to them', () => {
    const known = new Set([...Object.keys(COUNTRY_ALIASES), ...Object.keys(COUNTRY_NAMES)]);
    expect(Object.keys(ENDONYMS).filter((canon) => !known.has(canon))).toEqual([]);
    const lost = Object.entries(ENDONYMS)
      .flatMap(([canon, names]) => names.filter((n) => !locationCountries(n).includes(canon)).map((n) => `${n} -> ${canon}`));
    expect(lost).toEqual([]);
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

// A person's location resolves to a country for every sovereign state, not only the ones a region lists:
// Jamaica, Armenia and the Bahamas are in no region, and are still where somebody lives.
describe('every sovereign state resolves from the name Intl gives it', () => {
  // The 193 UN member states, the Holy See and the three territories and states the tables also read.
  const CODES = (
    'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ ' +
    'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI ' +
    'NL NO NP NR NZ OM PA PE PG PH PK PL PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL ' +
    'TM TN TO TR TT TV TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW PS XK TW HK MO PR'
  ).split(' ');
  // Georgia is the US state as often as the country, so it is left out on purpose (see the header of want-regions.ts).
  const LEFT_OUT = new Set(['GE']);
  const display = new Intl.DisplayNames(['en'], { type: 'region' });
  const hasNames = display.of('DE') === 'Germany'; // a Node built without full ICU has no names to check

  (hasNames ? it : it.skip)('reaches all of them', () => {
    expect(CODES).toHaveLength(200);
    const unresolved = CODES.filter((code) => !LEFT_OUT.has(code) && locationCountries(display.of(code) ?? '').length === 0);
    expect(unresolved.map((code) => `${code} ${display.of(code)}`)).toEqual([]);
  });

  it('puts a person in Jamaica or Armenia in that country, and in no region', () => {
    expect(locationCountries('Kingston, Jamaica')).toEqual(['jamaica']);
    expect(locationCountries('Yerevan, Armenia')).toEqual(['armenia']);
    expect(locationCountries('Nassau, The Bahamas')).toEqual(['bahamas']);
    expect(locationCountries('Trinidad & Tobago')).toEqual(['trinidad and tobago']);
    expect(locationCountries('Basseterre, St. Kitts & Nevis')).toEqual(['saint kitts and nevis']);
    expect(locationCountries('Castries, St. Lucia')).toEqual(['saint lucia']);
    expect(locationCountries('Kingstown, St. Vincent & Grenadines')).toEqual(['saint vincent and the grenadines']);
    expect(locationCountries('Baku, Azerbaijan')).toEqual(['azerbaijan']);
    expect(REGIONS.filter((r) => ['jamaica', 'armenia', 'bahamas'].some((c) => r.countries.includes(c)))).toEqual([]);
  });

  it('does not take Dominica for the Dominican Republic or Grenada for a Spanish city', () => {
    expect(locationCountries('Roseau, Dominica')).toEqual(['dominica']);
    expect(locationCountries('Santo Domingo, Dominican Republic')).toEqual(['dominican republic']);
  });
});
