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
// Canadian province the matcher knows. Anything else after "in", "from"…
// ("Narnia", "SaaS", "Google") is not a place the code can resolve, and filters
// nothing: reading it as a location every candidate must match empties the
// list, which is what "in Europe" did.

import {
  COUNTRY_NAMES, KNOWN_PLACES, REGIONS, regionByKey, regionCovers,
} from './want-regions';

export interface WantConstraints {
  /**
   * Canonical places the person must be in (any one satisfies): a country, a
   * region's key, or a known city. Never a place the code cannot resolve.
   */
  location: string[] | null;
  /** Minimum years of experience, when stated. */
  minYears: number | null;
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  'united states': ['usa', 'u.s.a.', 'u.s.', 'united states', 'united states of america', 'america', 'american'],
  'united kingdom': ['uk', 'u.k.', 'united kingdom', 'britain', 'great britain', 'england', 'british', 'scotland', 'wales', 'northern ireland'],
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

// Dot-free lookup for phrases captured after a preposition ("U.K." → "uk").
const ALIAS_NODOT = new Map<string, string>();
for (const [canon, aliases] of Object.entries(COUNTRY_ALIASES)) {
  for (const alias of aliases) ALIAS_NODOT.set(alias.replace(/\./g, ''), canon);
}

const ALIAS_COUNTRIES = new Set(Object.keys(COUNTRY_ALIASES));
/** The countries want-regions.ts adds to the alias table above (they are matched in a person's location). */
const EXTRA_COUNTRIES = new Set(Object.keys(COUNTRY_NAMES));

// ── Finding places in a text ──────────────────────────────────────────────────
//
// Country names, region names and a few look-alikes are looked for together, LONGEST FIRST,
// and each one found is blanked out before the shorter ones are tried. That is what keeps
// "Latin America" from also being "America" (the United States), "South Africa" from also
// being Africa, "Papua New Guinea" from also being Guinea, and "New Mexico" from being Mexico.

type NameKind = 'country' | 'region' | 'place' | 'decoy';
interface PlaceName { name: string; kind: NameKind; canon: string }
interface Scanner { re: RegExp; kind: NameKind; canon: string; length: number }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A person's location as the matcher reads it: lowercase, without accents, "&" as "and",
 * punctuation as spaces. "Côte d’Ivoire" and "Bosnia & Herzegovina", the way Intl writes them
 * into a profile, become "cote d'ivoire" and "bosnia and herzegovina".
 */
const fold = (s: string) => s
  .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[’‘`´]/g, "'").replace(/&/g, ' and ').replace(/[^a-z0-9']+/g, ' ').trim();

const compile = (names: PlaceName[], normalise: (s: string) => string): Scanner[] => names
  .map((n) => {
    const s = normalise(n.name);
    return { kind: n.kind, canon: n.canon, length: s.length, re: new RegExp(`(^|[^a-z0-9])${escapeRe(s)}(?=$|[^a-z0-9])`, 'gi') };
  })
  .sort((a, b) => b.length - a.length);

/**
 * Places whose name contains a country's name (or adjective) and which are not that country:
 * "New Mexico" is not Mexico and "British Columbia" is not British. The first two are places of
 * their own; the last two are only set aside, so that "New England" is not England and "New
 * South Wales" is not Wales.
 */
const LOOK_ALIKES: PlaceName[] = [
  { name: 'new mexico', kind: 'place', canon: 'new mexico' },
  { name: 'british columbia', kind: 'place', canon: 'british columbia' },
  { name: 'new england', kind: 'decoy', canon: '' },
  { name: 'new south wales', kind: 'decoy', canon: '' },
];
const countryNames: PlaceName[] = Object.entries(COUNTRY_ALIASES)
  .flatMap(([canon, aliases]) => aliases.map((name) => ({ name, kind: 'country' as const, canon })));
const extraCountryNames: PlaceName[] = Object.entries(COUNTRY_NAMES)
  .flatMap(([canon, others]) => [canon, ...others].map((name) => ({ name, kind: 'country' as const, canon })));
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
// In a person's location: every country there is a name for, accents and punctuation ignored.
const PROFILE_SCAN = compile([...countryNames, ...extraCountryNames, ...regionNames, ...LOOK_ALIKES], fold);

function scan(
  text: string, scanners: Scanner[],
): { countries: Set<string>; regions: Set<string>; places: Set<string>; rest: string } {
  const countries = new Set<string>();
  const regions = new Set<string>();
  const places = new Set<string>();
  let rest = text;
  for (const s of scanners) {
    rest = rest.replace(s.re, (found: string, lead: string) => {
      if (s.kind === 'country') countries.add(s.canon);
      else if (s.kind === 'region') regions.add(s.canon);
      else if (s.kind === 'place') places.add(s.canon);
      return lead + ' '.repeat(found.length - lead.length);
    });
  }
  return { countries, regions, places, rest };
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
export function locationTerms(text: string | null | undefined): string[] {
  if (!text) return [];
  const { countries, regions, places, rest } = scan(text, WANT_SCAN);
  const out = new Set<string>(countries);
  if (mentionsUS(text)) out.add('united states');
  const prepRe = /\b(?:in|based in|located in|from|within|near)\s+(?:the\s+)?([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = prepRe.exec(rest)) !== null) {
    // Compare without dots so "U.K." and "U.S." resolve to their country, not
    // to a phantom city called "u.k".
    const key = m[1].toLowerCase().replace(/\./g, '').trim();
    const first = key.split(' ')[0];
    if (!key || NOT_PLACES.has(first)) continue;
    if (key === 'us' || key === 'usa') { out.add('united states'); continue; }
    if (key.length < 3) continue;
    const canon = ALIAS_NODOT.get(key) ?? EXTRA_BY_NAME.get(key) ?? REGION_BY_NAME.get(key);
    out.add(canon ?? key); // known alias → country or region; anything else is a city or an unknown place
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

/** Canonical place terms for a profile, from its location field (+ company text). */
export function profileLocationTerms(p: ProfileLike): string[] {
  const out = new Set<string>(locationTerms(p.location));
  // A location field like "Austin, TX" carries no alias; keep its own words too
  // so a want for "in Austin" still matches.
  for (const w of (p.location || '').toLowerCase().split(/[^a-z]+/)) {
    if (w.length >= 3) out.add(w);
  }
  return [...out];
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

interface NamedPlaces { countries: Set<string>; regions: Set<string> }
const NAMED_PLACES = new Map<string, NamedPlaces>();

/** The countries and regions a person's location names, accents and punctuation ignored. */
function placesNamedIn(location: string): NamedPlaces {
  const known = NAMED_PLACES.get(location);
  if (known) return known;
  const { countries, regions } = scan(fold(location), PROFILE_SCAN);
  if (mentionsUS(location)) countries.add('united states');
  // Locations repeat across the people a want is scored against; the cache is bounded.
  if (NAMED_PLACES.size >= 5000) NAMED_PLACES.clear();
  const named = { countries, regions };
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
 * The first place the want requires that this person satisfies, or null. A country or a city is
 * a word of their location, as before; a region is a country inside it (never a substring: "eu"
 * is not in "Eugene").
 */
function satisfiedPlace(c: WantConstraints, p: ProfileLike): string | null {
  if (!c.location) return null;
  const text = (p.location || '').toLowerCase();
  let have: Set<string> | null = null;
  let named: NamedPlaces | null = null;
  for (const req of c.location) {
    if (regionByKey(req)) {
      named ??= placesNamedIn(p.location || '');
      if (inRegion(req, named)) return req;
      continue;
    }
    have ??= new Set(profileLocationTerms(p));
    if (have.has(req) || text.includes(req)) return req;
    // A country the older alias table does not know, written another way ("Czech Republic" for czechia).
    if (EXTRA_COUNTRIES.has(req)) {
      named ??= placesNamedIn(p.location || '');
      if (named.countries.has(req)) return req;
    }
  }
  return null;
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
