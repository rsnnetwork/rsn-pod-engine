// ─── Explicit want constraints (Stefan, 9 Sep 2026) ─────────────────────────
//
// "Manufacturer in US with 20 years experience." The LOCATION and the
// EXPERIENCE are explicit constraints — strict, never widened — while the
// CATEGORY ("manufacturer") is matched by meaning. No LLM: a curated country
// alias map plus a couple of regexes.
//
// Profiles have a free-text `location` but NO experience field, so years are
// parsed from bio/expertise text. A stated value below the bar excludes the
// person; an unstated one can't be verified, so the scorer keeps them but
// demotes them and says so in the reason (never a silent empty list).
//
// A place in a want is one of three things (7 Oct 2026): a COUNTRY (the alias
// table below, and the names in want-regions.ts), a REGION ("Europe", "DACH":
// satisfied by a country inside it, want-regions.ts), or a CITY, US state or
// Canadian province the matcher knows (want-cities.ts). Anything else after
// "in", "from"… ("Narnia", "SaaS", "Google") is not a place the code can
// resolve, and filters nothing: reading it as a location every candidate must
// match empties the list, which is what "in Europe" did.
//
// A person's location is read the other way (8 Oct 2026): it resolves to the
// countries it names, through a country name ("Deutschland", "Österreich") or,
// when it names none, through a state or province and then a city it knows
// ("Greater Düsseldorf Area"). A two-letter code ("NE", "TH") is never read: a
// city beside it says the country.

import {
  COUNTRY_NAMES, ENDONYMS, REGIONS, regionByKey, regionCovers,
} from './want-regions';
import {
  CODES_OF_COUNTRIES, KNOWN_PLACES, OWN_REGION_CODES, PLACES, PLACE_BY_NAME, REGION_CODES, SUBREGIONS,
} from './want-cities';
import type { RegionCode } from './want-cities';

export interface WantConstraints {
  /**
   * Canonical places the person must be in (any one satisfies): a country, a
   * region's key, or a known city. Never a place the code cannot resolve.
   */
  location: string[] | null;
  /** Minimum years of experience, when stated. */
  minYears: number | null;
}

export const COUNTRY_ALIASES: Record<string, string[]> = {
  'united states': ['usa', 'u.s.a.', 'u.s.', 'united states', 'united states of america', 'america', 'american'],
  'united kingdom': ['uk', 'u.k.', 'united kingdom', 'britain', 'great britain', 'england', 'british', 'scotland', 'wales'],
  'germany': ['germany', 'deutschland', 'german'],
  'india': ['india', 'indian'],
  'canada': ['canada', 'canadian'],
  'australia': ['australia', 'australian'],
  'france': ['france', 'french'],
  'netherlands': ['netherlands', 'holland', 'dutch'],
  'switzerland': ['switzerland', 'swiss'],
  'united arab emirates': ['uae', 'united arab emirates', 'dubai', 'abu dhabi', 'emirates'],
  'pakistan': ['pakistan', 'pakistani'],
  'singapore': ['singapore'],
  'spain': ['spain', 'spanish'],
  'italy': ['italy', 'italian'],
  'sweden': ['sweden', 'swedish'],
  'denmark': ['denmark', 'danish'],
  'norway': ['norway', 'norwegian'],
  'finland': ['finland', 'finnish'],
  'ireland': ['ireland', 'irish'],
  'israel': ['israel', 'israeli'],
  'brazil': ['brazil', 'brazilian'],
  'mexico': ['mexico', 'mexican'],
  'japan': ['japan', 'japanese'],
  'china': ['china', 'chinese'],
  'south africa': ['south africa', 'south african'],
  'nigeria': ['nigeria', 'nigerian'],
  'kenya': ['kenya', 'kenyan'],
  'poland': ['poland', 'polish'],
  'portugal': ['portugal', 'portuguese'],
  'austria': ['austria', 'austrian'],
  'belgium': ['belgium', 'belgian'],
  'turkey': ['turkey', 'türkiye', 'turkish'],
  'saudi arabia': ['saudi arabia', 'saudi', 'ksa'],
  'new zealand': ['new zealand'],
};

/** The letters Unicode does not take apart, and what they are read as ("Malmö" is "malmo", "Øre" is "ore"). */
const TRANSLITERATED: Readonly<Record<string, string>> = {
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h',
};

/**
 * A name or a person's location as the matcher reads it: lowercase, without accents, "&" as
 * "and", punctuation as spaces. "Côte d’Ivoire" and "Bosnia & Herzegovina", the way Intl writes
 * them into a profile, become "cote d'ivoire" and "bosnia and herzegovina"; "Düsseldorf" and
 * "Zürich" become "dusseldorf" and "zurich".
 */
export const fold = (s: string): string => s
  .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[ßæœøłđðþıħ]/g, (c) => TRANSLITERATED[c])
  .replace(/[’‘`´]/g, "'").replace(/&/g, ' and ').replace(/[^a-z0-9']+/g, ' ').trim();

// Dot-free lookup for phrases captured after a preposition ("U.K." → "uk", "Türkiye" → "turkiye").
const ALIAS_NODOT = new Map<string, string>();
for (const [canon, aliases] of Object.entries(COUNTRY_ALIASES)) {
  for (const alias of aliases) ALIAS_NODOT.set(fold(alias.replace(/\./g, '')), canon);
}

const ALIAS_COUNTRIES = new Set(Object.keys(COUNTRY_ALIASES));
/** The countries want-regions.ts adds to the alias table above (they are matched in a person's location). */
const EXTRA_COUNTRIES = new Set(Object.keys(COUNTRY_NAMES));

// ── Finding places in a text ──────────────────────────────────────────────────
//
// Country names, region names, the cities, states and provinces the matcher knows, and a few
// look-alikes are looked for together as whole words, LONGEST FIRST, and each one found is
// blanked out before the shorter ones are tried. That is what keeps "Latin America" from also
// being "America" (the United States), "South Africa" from also being Africa, "Papua New Guinea"
// from also being Guinea, "New Mexico" from being Mexico and "New York" from also being York.

// A state or a province names the country more firmly than a city does, and a country written out
// names it most firmly of all (see placesNamedIn).
export type NameKind = 'country' | 'region' | 'place' | 'decoy' | 'state' | 'city';
export interface PlaceName { name: string; kind: NameKind; canon: string; country?: string }
interface Scanner extends PlaceName { re: RegExp; length: number; first: string }

/**
 * Every name to look for, longest first, and for each first word the positions in that order of the
 * names that start with it. A text only contains a name if it contains the name's first word, so a
 * text is checked against the few names that start with one of its words, not against all of them.
 */
interface Scanners { all: Scanner[]; byFirstWord: Map<string, number[]> }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /[a-z0-9]+/g;

function compile(names: PlaceName[], normalise: (s: string) => string): Scanners {
  const all = names
    .map((n) => {
      const s = normalise(n.name);
      return { ...n, length: s.length, first: s.match(WORD)?.[0] ?? '', re: new RegExp(`(^|[^a-z0-9])${escapeRe(s)}(?=$|[^a-z0-9])`, 'gi') };
    })
    .sort((a, b) => b.length - a.length);
  const byFirstWord = new Map<string, number[]>();
  all.forEach(({ first }, at) => byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), at]));
  return { all, byFirstWord };
}

/**
 * Names read anywhere in a want, before the shorter names inside them. "New Mexico" is not Mexico,
 * "British Columbia" is not British and "Northern Ireland" is not Ireland: three places of their own.
 * "The Bay Area" however written ("San Francisco Bay Area", "SF Bay Area") is one region, not San
 * Francisco. Three more are only set aside, so that "New England" is not England, "New South Wales"
 * is not Wales and "Port of Spain" is not Spain. In a person's location the places are the entries
 * of want-cities.ts.
 */
export const LOOK_ALIKES: readonly PlaceName[] = [
  { name: 'new mexico', kind: 'place', canon: 'new mexico' },
  { name: 'british columbia', kind: 'place', canon: 'british columbia' },
  { name: 'northern ireland', kind: 'place', canon: 'northern ireland' },
  { name: 'san francisco bay area', kind: 'place', canon: 'bay area' },
  { name: 'sf bay area', kind: 'place', canon: 'bay area' },
  { name: 'bay area', kind: 'place', canon: 'bay area' },
  { name: 'new england', kind: 'decoy', canon: '' },
  { name: 'new south wales', kind: 'decoy', canon: '' },
  { name: 'port of spain', kind: 'decoy', canon: '' },
];
const countryNames: PlaceName[] = Object.entries(COUNTRY_ALIASES)
  .flatMap(([canon, aliases]) => aliases.map((name) => ({ name, kind: 'country' as const, canon })));
const extraCountryNames: PlaceName[] = [
  ...Object.entries(COUNTRY_NAMES)
    .flatMap(([canon, others]) => [canon, ...others].map((name) => ({ name, kind: 'country' as const, canon }))),
  ...Object.entries(ENDONYMS)
    .flatMap(([canon, others]) => others.map((name) => ({ name, kind: 'country' as const, canon }))),
];
const regionNames: PlaceName[] = REGIONS
  .flatMap((r) => r.names.map((name) => ({ name, kind: 'region' as const, canon: r.key })));

// In a want: the alias table and the regions, read as the member wrote them. A want's other
// countries are only places after "in", "from"… (see locationTerms), and so are the region names
// that are also ordinary words ("GCC", "Mena", "Nordic", "Dach": Region.afterPreposition).
const READ_ONLY_AFTER_A_PREPOSITION = new Set(REGIONS.flatMap((r) => r.afterPreposition ?? []));
const WANT_SCAN = compile(
  [...countryNames, ...regionNames.filter((n) => !READ_ONLY_AFTER_A_PREPOSITION.has(n.name)), ...LOOK_ALIKES],
  (s) => s.toLowerCase(),
);
// In a person's location: every country there is a name for, and every city, state and province
// the matcher knows, each with the country it is in (the two look-alike places are states here),
// accents and punctuation ignored.
const placeNames: PlaceName[] = PLACES.flatMap((p) => p.names.map((name) => ({
  name, kind: p.level, canon: p.canon, ...(p.country ? { country: p.country } : {}),
})));
// A decoy that is a place in a location is read as the place ("New South Wales" is an Australian state there).
const placeSpellings: ReadonlySet<string> = new Set(PLACES.flatMap((p) => p.names));
const PROFILE_SCAN = compile(
  [
    ...countryNames, ...extraCountryNames, ...regionNames,
    ...LOOK_ALIKES.filter((n) => n.kind === 'decoy' && !placeSpellings.has(n.name)), ...placeNames,
  ],
  fold,
);

interface Found {
  /** Countries a name says outright ("Germany", "Deutschland"). */
  countries: Set<string>;
  regions: Set<string>;
  /** Cities, states and provinces, by canonical name. */
  places: Set<string>;
  /** The countries the states and provinces found are in, and the cities: not names of countries. */
  stateCountries: Set<string>;
  cityCountries: Set<string>;
  /** True when a place was found that several countries have ("Cambridge"), so it names no country. */
  sharedName: boolean;
  /** The text with everything found blanked out. */
  rest: string;
}

function scan(text: string, scanners: Scanners): Found {
  const found: Found = {
    countries: new Set(), regions: new Set(), places: new Set(), stateCountries: new Set(), cityCountries: new Set(),
    sharedName: false, rest: text,
  };
  const candidates: number[] = [];
  for (const word of new Set(text.toLowerCase().match(WORD) ?? [])) candidates.push(...(scanners.byFirstWord.get(word) ?? []));
  for (const at of candidates.sort((a, b) => a - b)) {
    const s = scanners.all[at];
    found.rest = found.rest.replace(s.re, (hit: string, lead: string) => {
      if (s.kind === 'country') found.countries.add(s.canon);
      else if (s.kind === 'region') found.regions.add(s.canon);
      else if (s.kind === 'place') found.places.add(s.canon);
      else if (s.kind === 'state' || s.kind === 'city') {
        found.places.add(s.canon);
        if (s.country) (s.kind === 'state' ? found.stateCountries : found.cityCountries).add(s.country);
        else found.sharedName = true;
      }
      return lead + ' '.repeat(hit.length - lead.length);
    });
  }
  return found;
}

/** "US" is a country only in capitals or after a preposition: lowercase "us" is a pronoun ("help us"). */
const mentionsUS = (text: string) =>
  /\bU\.?S\.?\b/.test(text) || /\b(?:in|from|within|near|based in|located in)\s+(?:the\s+)?us\b/i.test(text);

/** Words that follow a location preposition but are not places. */
const NOT_PLACES = new Set(['the', 'a', 'an', 'my', 'our', 'their', 'this', 'that', 'need', 'order', 'general', 'particular', 'tech', 'software', 'business', 'sales', 'marketing', 'finance', 'healthcare', 'manufacturing', 'ai']);

/** The extra countries by the name they are written with, for a phrase captured after a preposition ("Czech Republic" → "czechia"). */
const EXTRA_BY_NAME = new Map<string, string>(
  extraCountryNames.map((n) => [fold(n.name), n.canon] as [string, string]),
);

/** The regions by the name they are written with, for a phrase captured after a preposition ("GCC" → "gcc"). */
const REGION_BY_NAME = new Map<string, string>(
  regionNames.map((n) => [fold(n.name.replace(/\./g, '')), n.canon] as [string, string]),
);

/** The country, region or city a phrase captured after a preposition is the name of (by any spelling), or undefined. */
const nameOf = (key: string): string | undefined =>
  ALIAS_NODOT.get(key) ?? EXTRA_BY_NAME.get(key) ?? REGION_BY_NAME.get(key) ?? PLACE_BY_NAME.get(key)?.canon;

/** The country or city a single word is the name of, or undefined. Never a region. */
const placeNamed = (word: string): string | undefined =>
  ALIAS_NODOT.get(word) ?? EXTRA_BY_NAME.get(word) ?? PLACE_BY_NAME.get(word)?.canon;

// One or two capitalised words after a location preposition. Letters, not only A-Z: "in Düsseldorf",
// "in Zürich" and "in Österreich" are the launch audience's wants. A hyphen followed by a capital letter
// goes on with the name ("Guinea-Bissau", "Clermont-Ferrand"); "-based" and the like do not.
//
// A name never runs across the end of a sentence or of a line. The matcher joins the want fields with ". "
// (extractConstraints), so a place that ends one field is followed by a full stop and the next field's first
// word, capitalised: "Founders in the EU. Raise a seed round" must not be read as the name "EU Raise". So a full
// stop followed by white space ends the name, whatever the length of the word before it ("EU.", "DC.", "Rio.").
// The exception is the abbreviation a name can start with, which is written with a full stop and goes on:
// "St. Louis", "Ste. Genevieve", "Mt. Pleasant", "Ft. Lauderdale", "Pt. Pleasant". A word with full stops inside
// ("U.K.", "D.C.") is one word and ends the name like any other. The second word follows after spaces or tabs
// only, never a line break.
const NAME_WORD = String.raw`\p{Lu}[\p{L}.]+(?:-\p{Lu}[\p{L}.]+)*`;
const NAME_GOES_ON = String.raw`(?:(?<!\.)|(?<=\b(?:St|Ste|Mt|Ft|Pt)\.))[ \t]+`;
const PLACE_AFTER_A_PREPOSITION = new RegExp(
  String.raw`\b(in|based in|located in|from|within|near)\s+(?:the\s+)?(${NAME_WORD}(?:${NAME_GOES_ON}${NAME_WORD})?)`, 'gu',
);

/** The words that only finish the name of a place: "New York City", "Prince Edward Island", "Kansas State". */
const PLACE_TYPE_WORDS: ReadonlySet<string> = new Set(['City', 'County', 'State', 'Province', 'Region', 'Territory', 'Island', 'Islands', 'Area']);

/** Is the capitalised word at the start of `after` one that finishes a place's name: a type of place, or a state's or province's code ("Los Angeles CA")? */
function finishesAPlace(after: string): boolean {
  const next = /^[ \t]+(\p{Lu}\p{L}*)/u.exec(after)?.[1];
  return !!next && (PLACE_TYPE_WORDS.has(next) || (next.length === 2 && REGION_CODES.has(next.toLowerCase())));
}

/**
 * Canonical place terms mentioned in free text: country aliases and region
 * names (whole-word), plus capitalised words after "in / based in / located
 * in / from / within / near" so cities work ("in London" → "london"). "US" is
 * only a country when written in capitals or after a location preposition —
 * lowercase "us" is a pronoun ("help us").
 *
 * Not everything after a preposition is a place ("in SaaS", "from Google"), so
 * this returns the candidates; extractConstraints keeps only those the code
 * can resolve.
 */
export function locationTerms(written: string | null | undefined): string[] {
  if (!written) return [];
  // "ü" typed as "u" plus a combining diaeresis (a want pasted from a Mac or a PDF) is the same letter.
  const text = written.normalize('NFC');
  const { countries, regions, places, rest } = scan(text, WANT_SCAN);
  const out = new Set<string>(countries);
  if (mentionsUS(text)) out.add('united states');
  const prepRe = PLACE_AFTER_A_PREPOSITION;
  prepRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = prepRe.exec(rest)) !== null) {
    const after = rest.slice(prepRe.lastIndex);
    // "Jordan Smith's network", "Austin Russell's": a possessive is a person or an organisation, not a place.
    if (/^['’]s\b/.test(after)) continue;
    // Compare without dots so "U.K." and "U.S." resolve to their country, not
    // to a phantom city called "u.k". Folded, so "Köln" is the "koln" the table knows.
    const key = fold(m[2].replace(/\./g, ''));
    const words = key.split(' ');
    // After "from", a capital letter that goes on is the rest of a name: "Palo Alto Networks", "Zurich Insurance"
    // (unless the capture ended the sentence: "from Berlin. Investors welcome", "from the EU. Raise a seed round",
    // or it is a place the code knows and the word only finishes it: "from New York City", "from Los Angeles CA").
    if (m[1] === 'from' && !m[2].endsWith('.') && /^[ \t]+\p{Lu}/u.test(after) && !(nameOf(key) && finishesAPlace(after))) continue;
    // "The Bahamas" starts with a word that is no place, and is one.
    if (!key || (NOT_PLACES.has(words[0]) && !nameOf(key))) continue;
    if (key === 'us' || key === 'usa') { out.add('united states'); continue; }
    let canon = nameOf(key);
    // A short capitalised word is rarely a place ("in IT", "from AI"), unless it is a name the code knows ("in the EU").
    if (key.length < 3 && !canon) continue;
    // "in Berlin Mitte", "in Austin Texas": two capitalised words that are not a place together but
    // start with one. After "from" the pair is as often a company or a school ("from Boston Consulting
    // Group"), so there only a place that stands alone counts, or one name joined by a hyphen ("from Berlin-Mitte").
    if (!canon && words.length > 1 && (m[1] !== 'from' || !/[ \t]/.test(m[2]))) canon = placeNamed(words[0]);
    out.add(canon ?? key); // known country or region; anything else is a city or an unknown place
  }
  for (const p of places) out.add(p);
  for (const r of regions) out.add(r);
  return [...out];
}

/** A place the code can resolve to something: a country, a region, or a city it knows. */
const isResolvablePlace = (term: string) =>
  !!regionByKey(term) || ALIAS_COUNTRIES.has(term) || EXTRA_COUNTRIES.has(term) || KNOWN_PLACES.has(term);

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/** The largest "N years" / "N+ yrs" / "two decades" figure in a text, or null. */
export function parseYears(text: string | null | undefined): number | null {
  if (!text) return null;
  let max: number | null = null;
  const consider = (n: number) => { if (Number.isFinite(n) && n > 0 && n <= 60) max = max === null ? n : Math.max(max, n); };
  const re = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) consider(Number(m[1]));
  const wordRe = /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty)\s+(?:years?|yrs?)\b/gi;
  while ((m = wordRe.exec(text)) !== null) consider(WORD_NUMBERS[m[1].toLowerCase()]);
  const decRe = /\b(a|one|two|three|four|five|\d)\s+decades?\b/gi;
  while ((m = decRe.exec(text)) !== null) {
    const w = m[1].toLowerCase();
    consider((w === 'a' ? 1 : (WORD_NUMBERS[w] ?? Number(w))) * 10);
  }
  return max;
}

/** What the want text explicitly requires: a place and/or a minimum experience. */
export function extractConstraints(wants: Array<string | null | undefined>): WantConstraints {
  const text = wants.filter(Boolean).join('. ');
  const location = locationTerms(text).filter(isResolvablePlace);
  return {
    location: location.length ? location : null,
    minYears: parseYears(text),
  };
}

export interface ProfileLike {
  location?: string | null;
  bio?: string | null;
  expertiseText?: string | null;
  whatICanHelpWith?: string | null;
  whatICareAbout?: string | null;
  jobTitle?: string | null;
  company?: string | null;
}

/** Years of experience a profile states anywhere in its text, or null. */
export function profileYears(p: ProfileLike): number | null {
  return parseYears([p.bio, p.expertiseText, p.whatICanHelpWith, p.whatICareAbout, p.jobTitle].filter(Boolean).join('. '));
}

export interface ConstraintCheck {
  /** null = no location required; false = required and NOT satisfied (unknown location counts as not). */
  locationOk: boolean | null;
  /** null = no minimum required OR the profile doesn't state years (unverifiable); false = stated and below. */
  yearsOk: boolean | null;
  /** true when a minimum is required but the profile states no years. */
  yearsUnknown: boolean;
}

interface NamedPlaces { countries: Set<string>; regions: Set<string>; places: Set<string> }
const NAMED_PLACES = new Map<string, NamedPlaces>();

/**
 * The US state or Canadian province whose two-letter code is the last part of a location after a
 * comma ("Vienna, VA"), when it settles a namesake: a city or a state of another country, or a name
 * several countries have ("Cambridge, MA"), is beside it. Not when the code is that country's own:
 * "Berlin, DE" (Germany's code), "Toronto, CA", "Perth, WA" (Western Australia) keep their city.
 */
function regionCodeThatSettles(location: string, found: Found): RegionCode | null {
  const parts = location.split(',');
  if (parts.length < 2) return null;
  const code = /^([A-Za-z]{2})\.?$/.exec(parts[parts.length - 1].trim())?.[1].toLowerCase();
  const region = code ? REGION_CODES.get(code) : undefined;
  if (!code || !region) return null;
  const beside = [...found.cityCountries, ...found.stateCountries];
  if (beside.some((k) => CODES_OF_COUNTRIES.get(code) === k || OWN_REGION_CODES[k]?.includes(code))) return null;
  return found.sharedName || beside.some((k) => k !== region.country) ? region : null;
}

/** The countries, regions and cities, states and provinces a person's location names, accents and punctuation ignored. */
function placesNamedIn(location: string): NamedPlaces {
  const known = NAMED_PLACES.get(location);
  if (known) return known;
  const found = scan(fold(location), PROFILE_SCAN);
  if (mentionsUS(location)) found.countries.add('united states');
  // A country written out says where the person is. Without one a state or province does ("Paris,
  // Texas" is the US), and without that a city ("Greater Düsseldorf Area" is Germany). A US state's or
  // Canadian province's code last in the location does what its name would, but only when it settles
  // a namesake ("Vienna, VA"); a code on its own is none of these ("Omaha, NE" is not Niger).
  let countries: Set<string>;
  if (found.countries.size) {
    countries = found.countries;
  } else {
    const coded = regionCodeThatSettles(location, found);
    if (coded) found.places.add(coded.place);
    countries = coded ? new Set([coded.country])
      : found.stateCountries.size ? found.stateCountries : found.cityCountries;
  }
  // Locations repeat across the people a want is scored against; the cache is bounded.
  if (NAMED_PLACES.size >= 5000) NAMED_PLACES.clear();
  const named = { countries, regions: found.regions, places: found.places };
  NAMED_PLACES.set(location, named);
  return named;
}

/**
 * The countries (by canonical name) that a location names: "Prague, Czech Republic" →
 * czechia, "Istanbul, Türkiye" → turkey, "Port Moresby, Papua New Guinea" → papua new
 * guinea and not Guinea. A region is satisfied by one of these.
 */
export function locationCountries(location: string | null | undefined): string[] {
  return location ? [...placesNamedIn(location).countries] : [];
}

/** Does a person named in `named` sit inside the region `key`? A person who says "the Nordics" is in Europe. */
function inRegion(key: string, named: NamedPlaces): boolean {
  const region = regionByKey(key);
  if (!region) return false;
  if (region.countries.some((c) => named.countries.has(c))) return true;
  for (const k of named.regions) if (k === key || regionCovers(key, k)) return true;
  return false;
}

/**
 * Does a location, as placesNamedIn reads it, satisfy one place the want names? A region is a
 * country inside it, a country is a country the location names (so "Czech Republic" is czechia),
 * and a city, state or province is that name as a whole word or words, or a town inside it
 * ("in Northern Ireland" takes Belfast). Never letters inside another name: "Oman" is not in
 * "Romania", "Mali" is not in "Malibu", "Rio" is not in "Ontario" and "eu" is not in "Eugene".
 */
function placeSatisfied(req: string, named: NamedPlaces): boolean {
  if (regionByKey(req)) return inRegion(req, named);
  if (ALIAS_COUNTRIES.has(req) || EXTRA_COUNTRIES.has(req)) return named.countries.has(req);
  return named.places.has(req) || !!SUBREGIONS.get(req)?.some((town) => named.places.has(town));
}

/** The first place the want requires that this person satisfies, or null. */
function satisfiedPlace(c: WantConstraints, p: ProfileLike): string | null {
  if (!c.location) return null;
  const named = placesNamedIn(p.location || '');
  return c.location.find((req) => placeSatisfied(req, named)) ?? null;
}

/**
 * Which of the places the want names this person is in: the one the card says ("in the Nordics",
 * "in Germany"), not merely the first one the want mentions.
 */
export function matchedPlace(c: WantConstraints, p: ProfileLike): string | null {
  return satisfiedPlace(c, p);
}

export function checkConstraints(c: WantConstraints, p: ProfileLike): ConstraintCheck {
  let locationOk: boolean | null = null;
  if (c.location) locationOk = satisfiedPlace(c, p) !== null;
  let yearsOk: boolean | null = null;
  let yearsUnknown = false;
  if (c.minYears !== null) {
    const y = profileYears(p);
    if (y === null) yearsUnknown = true;
    else yearsOk = y >= c.minYears;
  }
  return { locationOk, yearsOk, yearsUnknown };
}
