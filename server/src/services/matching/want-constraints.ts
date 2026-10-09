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
// match empties the list, which is what "in Europe" did. A region name is a
// place only after a location preposition ("investors in Europe"; "European
// founders" and "building for Asia and Africa" name none), a word that narrows
// it ("Western", "continental", "the rest of") does not change which, and one
// preposition may govern a list, whose items may be regions in any case
// ("Gründer in Köln oder Düsseldorf", "in the UK or continental Europe", "in asia
// and europe"). A state after a city never takes the city away: one the city is not
// in ("Paris, Texas", "Dublin, OH") is read beside it, so the want names both. "in der
// Schweiz" and a capital "In" are read like "in the" and "in", and after "im" only a
// region is read ("im DACH-Raum"; "Hi im Jordan" is "I'm Jordan"); "in die" and "in
// das" say where to and name no place, and after a German article only a country or
// a region is read ("in den Bergen" is the mountains).
//
// A person's location is read the other way (8 Oct 2026): it resolves to the
// countries it names, through a country name ("Deutschland", "Österreich") or,
// when it names none, through a state or province and then a city it knows
// ("Greater Düsseldorf Area"). A two-letter code ("NE", "TH") is never a
// country: a city beside it says the country. A US state's or Canadian
// province's code last after a comma ("Vienna, VA", "Portland, ME") is read
// beside a town the table knows, to say which state the person is in and to
// settle a namesake town.

import {
  COUNTRY_NAMES, ENDONYMS, REGIONS, regionByKey, regionCovers,
} from './want-regions';
import {
  CODES_OF_COUNTRIES, KNOWN_PLACES, OWN_REGION_CODES, PLACES, PLACE_BY_CANON, PLACE_BY_NAME, REGION_CODES, STATE_OF_CITY,
  SUBREGIONS, WRITTEN_FOR,
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
export interface PlaceName {
  name: string; kind: NameKind; canon: string; country?: string;
  /**
   * The name is read only where this says so, given the text just before it, the text just after it (a few words
   * of each, CHARS_AROUND_A_NAME characters at most) and the name as written.
   */
  where?: (before: string, after: string, written: string) => boolean;
}
interface Scanner extends PlaceName { re: RegExp; length: number; first: string }

/** How much of the text on each side of a name a `where` rule is shown: a text can be long, and a rule needs a few words. */
const CHARS_AROUND_A_NAME = 64;

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
 * The small words that can come before "Bay Area" and leave it the Bay Area: "the Bay Area", "in Bay Area", "SF Bay
 * Area", "East Bay Area". "Greater" is not among them: "Greater Bay Area" is the one in southern China as often.
 */
const WORDS_BEFORE_THE_BAY_AREA: ReadonlySet<string> = new Set([
  'the', 'in', 'from', 'within', 'across', 'throughout', 'near', 'around', 'at', 'of', 'and', 'or', 'to', 'for', 'with', 'by',
  'sf', 'east', 'west', 'north', 'south',
]);

/**
 * Does another word come right before the name, with only blanks between ("Tampa Bay Area", "Cardiff Bay
 * area")? A full stop, a comma or a slash before it ("SF/Bay Area", ". Bay Area") is no word, and the small
 * words above are not another place. Anything else could be a place whose bay it is: Tampa, Monterey, Cardiff.
 * A person's location also accepts "Greater" ("Greater Bay Area"): it is what they wrote, and a want is the
 * stricter reader, because a place in a want is a hard filter.
 */
function followsAPlaceWord(before: string, alsoSmall: readonly string[] = []): boolean {
  const found = /([\p{L}\p{N}]+)[ \t]+$/u.exec(before);
  if (!found) return false;
  // a word as long as all the text we were shown may be the tail of a longer one, and is not a small word
  if (found.index === 0 && before.length >= CHARS_AROUND_A_NAME) return true;
  const word = found[1].toLowerCase();
  return !WORDS_BEFORE_THE_BAY_AREA.has(word) && !alsoSmall.includes(word);
}

/**
 * Names read anywhere in a want, before the shorter names inside them. "New Mexico" is not Mexico,
 * "British Columbia" is not British and "Northern Ireland" is not Ireland: three places of their own.
 * "The Bay Area" however written ("San Francisco Bay Area", "SF Bay Area") is one region, not San
 * Francisco; "Bay Area" alone is, unless another place word comes right before it ("Tampa Bay Area" is
 * Tampa's). Three more are only set aside, so that "New England" is not England, "New South Wales"
 * is not Wales and "Port of Spain" is not Spain. In a person's location the places are the entries
 * of want-cities.ts.
 */
export const LOOK_ALIKES: readonly PlaceName[] = [
  { name: 'new mexico', kind: 'place', canon: 'new mexico' },
  { name: 'british columbia', kind: 'place', canon: 'british columbia' },
  { name: 'northern ireland', kind: 'place', canon: 'northern ireland' },
  { name: 'san francisco bay area', kind: 'place', canon: 'bay area' },
  { name: 'sf bay area', kind: 'place', canon: 'bay area' },
  { name: 'bay area', kind: 'place', canon: 'bay area', where: (before) => !followsAPlaceWord(before) },
  { name: 'new england', kind: 'decoy', canon: '' },
  { name: 'new south wales', kind: 'decoy', canon: '' },
  { name: 'port of spain', kind: 'decoy', canon: '' },
];
// "America" and "American" are the United States, but not the end of "Latin America", "North American" and the like:
// a want that says "Latin American fintech founders" has no place in it (and "in Berlin and north america" is Berlin
// and the region, which the list reader finds in the text because nothing set it aside).
const PART_OF_A_REGION_NAME = /\b(?:latin|north|south|central)[ \t]+$/i;
const countryNames: PlaceName[] = Object.entries(COUNTRY_ALIASES)
  .flatMap(([canon, aliases]) => aliases.map((name) => ({
    name, kind: 'country' as const, canon,
    ...(name === 'america' || name === 'american' ? { where: (before: string) => !PART_OF_A_REGION_NAME.test(before) } : {}),
  })));
const extraCountryNames: PlaceName[] = [
  ...Object.entries(COUNTRY_NAMES)
    .flatMap(([canon, others]) => [canon, ...others].map((name) => ({ name, kind: 'country' as const, canon }))),
  ...Object.entries(ENDONYMS)
    .flatMap(([canon, others]) => others.map((name) => ({ name, kind: 'country' as const, canon }))),
];
const regionNames: PlaceName[] = REGIONS
  .flatMap((r) => r.names.map((name) => ({ name, kind: 'region' as const, canon: r.key })));

// The words that make a name a place a person is in or comes from. "based in" and "located in" end in "in". The
// German "aus" and "bei" are the same words for the DACH members, and "im" is "in dem", after which only a region is
// read (see readName). An article may stand between the preposition and the name: "in the Nordics", "in der
// Schweiz", "aus den USA". Not "die" or "das": after "in" they say where to, not where ("Startups, die in die
// DACH-Region expandieren wollen" are not there yet), so nothing after them is a place.
const LOCATION_PREPOSITION_WORDS = ['based in', 'located in', 'in', 'im', 'from', 'within', 'across', 'throughout', 'near', 'aus', 'bei'];
const LOCATION_PREPOSITIONS = LOCATION_PREPOSITION_WORDS.join('|');
const ARTICLES_AFTER_A_PREPOSITION = 'the|der|dem|den';
const AFTER_A_LOCATION_PREPOSITION = new RegExp(
  String.raw`\b(?:${LOCATION_PREPOSITIONS})\s+(?:(?:${ARTICLES_AFTER_A_PREPOSITION})\s+)?$`, 'i',
);
// Nor a name of the alias table, which is read anywhere else in a want: "Startups, die in die USA expandieren wollen".
const INTO = /\bin\s+(?:die|das)\s+$/i;
// After a German article German writes a country ("in der Schweiz", "in den USA") or a region ("in der DACH-Region",
// "in der Bay Area"), never a town: "in den Bergen" is the mountains, not Bergen, and "in dem Zug" a train, not Zug.
const GERMAN_ARTICLES: ReadonlySet<string> = new Set(['der', 'die', 'das', 'dem', 'den']);

// A region name in a want is a place only after a location preposition ("investors in Europe", "founders across
// the Nordics"). Anywhere else it describes the work, not where the person must be: "founders building for Asia
// and Africa", "Middle East expansion partners", "Scandinavian design founders", "EU-based founders". The names
// that are also ordinary words ("GCC", "Mena", "Nordic", "Dach", "EU": Region.ordinaryWords) need a capital letter
// as well, and no capitalised word after them ("in Nordic Semiconductor" is a company, "in the GCC" a region).
const wantRegionNames: PlaceName[] = REGIONS.flatMap((r) => r.names.map((name) => {
  const ordinary = (r.ordinaryWords ?? []).includes(name);
  return {
    name, kind: 'region' as const, canon: r.key,
    where: (before: string, after: string, written: string) => AFTER_A_LOCATION_PREPOSITION.test(before)
      && (!ordinary || (/^\p{Lu}/u.test(written) && !/^[ \t]+\p{Lu}/u.test(after))),
  };
}));

// A word that narrows a region ("Western Europe", "continental Europe", "the rest of Europe", "sub-Saharan Africa")
// does not change where the person must be: it is Europe, or Africa. It is taken out of the text before the want is
// read, so that the region is read after a preposition, or as an item of a list, as if it stood alone. A modifier
// before anything that is not a region ("Greater Manchester", "Northern Ireland", "Central America") is left.
const REGION_MODIFIERS = [
  'western', 'eastern', 'northern', 'southern', 'central', 'continental', 'mainland', 'wider', 'greater', 'other',
  'rest of', 'all over', 'sub-saharan', 'sub saharan',
];
const REGION_NAME_ALTERNATION = [...new Set(REGIONS.flatMap((r) => r.names))].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const MODIFIER_ALTERNATION = REGION_MODIFIERS.map((word) => escapeRe(word).replace(/ /g, String.raw`[ \t]+`)).join('|');
// "the rest of the EU" goes with its article: both "the" before the modifier and the one after it are one "the".
const MODIFIED_REGION = new RegExp(
  String.raw`(?<![\p{L}\p{N}-])(?:the[ \t]+)?(?:${MODIFIER_ALTERNATION})[ \t]+(?=(?:the[ \t]+)?(?:${REGION_NAME_ALTERNATION})(?![\p{L}\p{N}]))`, 'giu',
);

// In a want: the alias table, the regions after a preposition, and the look-alikes, read as the member wrote
// them, and never right after "in die" or "in das". A want's other countries are only places after "in",
// "from"… (see locationTerms).
const notAfterInto = (n: PlaceName): PlaceName => (n.kind === 'decoy' ? n : {
  ...n, where: (before, after, written) => !INTO.test(before) && (!n.where || n.where(before, after, written)),
});
const WANT_SCAN = compile([...countryNames, ...wantRegionNames, ...LOOK_ALIKES].map(notAfterInto), (s) => s.toLowerCase());
// In a person's location: every country there is a name for, and every city, state and province
// the matcher knows, each with the country it is in (the two look-alike places are states here),
// accents and punctuation ignored.
const placeNames: PlaceName[] = PLACES.flatMap((p) => p.names.map((name) => ({
  name, kind: p.level, canon: p.canon, ...(p.country ? { country: p.country } : {}),
  // "Tampa Bay Area" is Tampa's, the same as in a want
  ...(p.canon === 'bay area' ? { where: (before: string) => !followsAPlaceWord(before, ['greater']) } : {}),
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
  /** The text with everything found replaced by READ characters. */
  rest: string;
}

/**
 * What scan() leaves in place of a name it has read, so that a name is read once ("Latin America" is not
 * also "America") and a place already read can still begin a list: "in Deutschland und Österreich". A decoy
 * is set aside with spaces instead: it is no place, so it begins no list.
 */
const READ = '\uE000';

function scan(text: string, scanners: Scanners): Found {
  const found: Found = {
    countries: new Set(), regions: new Set(), places: new Set(), stateCountries: new Set(), cityCountries: new Set(),
    sharedName: false, rest: text,
  };
  const candidates: number[] = [];
  for (const word of new Set(text.toLowerCase().match(WORD) ?? [])) candidates.push(...(scanners.byFirstWord.get(word) ?? []));
  for (const at of candidates.sort((a, b) => a - b)) {
    const s = scanners.all[at];
    found.rest = found.rest.replace(s.re, (hit: string, lead: string, offset: number, whole: string) => {
      const written = hit.slice(lead.length);
      const start = offset + lead.length;
      const end = offset + hit.length;
      const around = [whole.slice(Math.max(0, start - CHARS_AROUND_A_NAME), start), whole.slice(end, end + CHARS_AROUND_A_NAME)] as const;
      if (s.where && !s.where(around[0], around[1], written)) return hit;
      if (s.kind === 'decoy') return lead + ' '.repeat(written.length);
      if (s.kind === 'country') found.countries.add(s.canon);
      else if (s.kind === 'region') found.regions.add(s.canon);
      else if (s.kind === 'place') found.places.add(s.canon);
      else if (s.kind === 'state' || s.kind === 'city') {
        found.places.add(s.canon);
        if (s.country) (s.kind === 'state' ? found.stateCountries : found.cityCountries).add(s.country);
        else found.sharedName = true;
      }
      return lead + READ.repeat(hit.length - lead.length);
    });
  }
  return found;
}

/**
 * "US" is a country only in capitals or after a preposition: lowercase "us" is a pronoun ("help us"). Not right
 * after "in die" or "in das", which say where to (INTO): "Expansion in die US".
 */
const mentionsUS = (text: string) =>
  /(?<!\b[iI]n\s+(?:die|das)\s+)\bU\.?S\.?\b/.test(text) || /\b(?:in|from|within|near|based in|located in)\s+(?:the\s+)?us\b/i.test(text);

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
// A place the scan has already read counts as a name here: it can begin a list, and it needs nothing more.
const PLACE_ITEM = String.raw`(?:${READ}+|${NAME_WORD}(?:${NAME_GOES_ON}${NAME_WORD})?)`;
// A preposition is read with a capital letter too: a field that starts "In Düsseldorf" or "From Berlin" says the
// same as "in Düsseldorf" (so does "Based In" in a title). "in" becomes [iI]n, "based in" [bB]ased [iI]n.
const eitherCase = (phrase: string): string => phrase.replace(/\b([a-z])/g, (_, letter: string) => `[${letter}${letter.toUpperCase()}]`);
const LOCATION_PREPOSITIONS_EITHER_CASE = LOCATION_PREPOSITION_WORDS.map(eitherCase).join('|');
// The preposition, the article after it if there is one, and the name.
const PLACE_AFTER_A_PREPOSITION = new RegExp(
  String.raw`\b(${LOCATION_PREPOSITIONS_EITHER_CASE})\s+(?:(${ARTICLES_AFTER_A_PREPOSITION})\s+)?(${PLACE_ITEM})`, 'gu',
);
// A list goes on after a place: "Köln oder Düsseldorf", "Berlin, Munich and Hamburg", "Deutschland und der Schweiz".
// What joins the items is a comma, "&", "/" or "and", "or", "und", "oder" (after a comma too), and an article may
// come before an item ("und die Schweiz" too: the list already says where). The item is a place the scan has read or
// a capitalised name (LIST_PLACE), or, when it starts with a lowercase letter, the name of a region or of a country
// the alias table does not hold, in any case (LIST_NAMED: "asia and europe", "germany and the nordics"). Not the
// ordinary words (eu, dach, gcc ...), which a capital letter makes a region and nothing else does.
const LIST_JOINER = new RegExp(
  String.raw`(\s*[,&/]\s*(?:(?:and|or|und|oder)\s+)?|\s+(?:and/or|und/oder|and|or|und|oder)\s+)(?:(the|der|die|das|dem|den)\s+)?`, 'uy',
);
const LIST_PLACE = new RegExp(`(${PLACE_ITEM})`, 'uy');
const ORDINARY_REGION_WORDS: ReadonlySet<string> = new Set(REGIONS.flatMap((r) => r.ordinaryWords ?? []));
const LIST_NAMED = new RegExp(
  `(${[...new Set([...regionNames, ...extraCountryNames].map((n) => n.name).filter((name) => !ORDINARY_REGION_WORDS.has(name)))]
    .sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iuy',
);

/** The words that only finish the name of a place: "New York City", "Prince Edward Island", "Kansas State". */
const PLACE_TYPE_WORDS: ReadonlySet<string> = new Set(['City', 'County', 'State', 'Province', 'Region', 'Territory', 'Island', 'Islands', 'Area']);

/** Is the capitalised word at the start of `after` one that finishes a place's name: a type of place, or a state's or province's code ("Los Angeles CA")? */
function finishesAPlace(after: string): boolean {
  const next = /^[ \t]+(\p{Lu}\p{L}*)/u.exec(after)?.[1];
  return !!next && (PLACE_TYPE_WORDS.has(next) || (next.length === 2 && REGION_CODES.has(next.toLowerCase())));
}

/** "Jordan Smith's network", "Austin Russell's": a possessive is a person or an organisation, not a place. */
const isPossessive = (after: string): boolean => /^['’]s\b/.test(after);

/** "from" and the German "aus" and "bei" say where someone comes from or works: a name that goes on may be a company. */
const FROM_LIKE = /^(?:from|aus|bei)$/i;

/** A place German writes after an article: a country, a region, or the Bay Area (a region of towns). Not a town. */
const followsAnArticle = (canon: string): boolean =>
  !!regionByKey(canon) || ALIAS_COUNTRIES.has(canon) || EXTRA_COUNTRIES.has(canon) || canon === 'bay area';

/** Is the place after this article one German writes with an article (see GERMAN_ARTICLES)? "the" is not German. */
const fitsTheArticle = (article: string | undefined, canon: string): boolean =>
  !article || !GERMAN_ARTICLES.has(article) || followsAnArticle(canon);

/**
 * Read the name captured after a preposition (and the article between them, if any). Returns the place when the
 * name is one the code knows, so that a list ("Köln oder Düsseldorf") may go on after it and the caller can set it
 * down. A name the code does not know goes into `out` as a candidate that extractConstraints will throw away.
 */
function readName(preposition: string, article: string | undefined, name: string, after: string, out: Set<string>): string | undefined {
  if (isPossessive(after)) return undefined;
  // Compare without dots so "U.K." and "U.S." resolve to their country, not
  // to a phantom city called "u.k". Folded, so "Köln" is the "koln" the table knows.
  const key = fold(name.replace(/\./g, ''));
  const words = key.split(' ');
  const fromLike = FROM_LIKE.test(preposition);
  // After "from", a capital letter that goes on is the rest of a name: "Palo Alto Networks", "Zurich Insurance"
  // (unless the capture ended the sentence: "from Berlin. Investors welcome", "from the EU. Raise a seed round",
  // or it is a place the code knows and the word only finishes it: "from New York City", "from Los Angeles CA").
  if (fromLike && !name.endsWith('.') && /^[ \t]+\p{Lu}/u.test(after) && !(nameOf(key) && finishesAPlace(after))) return undefined;
  // "The Bahamas" starts with a word that is no place, and is one.
  if (!key || (NOT_PLACES.has(words[0]) && !nameOf(key))) return undefined;
  if (key === 'us' || key === 'usa') return 'united states';
  let canon = nameOf(key);
  // A short capitalised word is rarely a place ("in IT", "from AI"), unless it is a name the code knows ("in the EU").
  if (key.length < 3 && !canon) return undefined;
  // "in Berlin Mitte", "in Austin Texas": two capitalised words that are not a place together but
  // start with one. After "from" the pair is as often a company or a school ("from Boston Consulting
  // Group"), so there only a place that stands alone counts, or one name joined by a hyphen ("from Berlin-Mitte").
  if (!canon && words.length > 1 && (!fromLike || !/[ \t]/.test(name))) canon = placeNamed(words[0]);
  // "in den Bergen" is the mountains and "in dem Zug" a train: after a German article a town's name is a word. After
  // "im" ("in dem") only a region: "im DACH-Raum". Not a country: "Hi im Jordan" is "I'm Jordan" typed fast, and a
  // country read there would be a hard filter the member never meant ("im Iran" reads nothing, which only widens).
  if (canon && (/^im$/i.test(preposition) ? !regionByKey(canon) : !fitsTheArticle(article, canon))) return undefined;
  if (!canon) out.add(key); // a city or a place the code does not know
  return canon;
}

/**
 * The place the item after a city and a comma adds to the want, or undefined. It never takes the city away. It may
 * only say where the city is, and then it adds nothing: "Austin, Texas", "Albany, New York", "Zürich, Schweiz",
 * "Austin, TX" and "Berlin, DE" (Germany's own code). It may name a state or province the city is NOT in, and then it
 * adds that state and the city stays: "Dublin, OH" is Dublin and Ohio, "Paris, Texas" Paris and Texas. The member may
 * mean the town in that state, or be naming two places ("aus Düsseldorf, New York oder London"), or have written an
 * abbreviation that is also a code ("in London, PE and VC"); places are alternatives, so keeping both can only widen.
 * Or the item is a place of its own ("Boston, New York", "Berlin, Munich"), or nothing the code knows.
 */
function placeAfterACity(city: string, key: string, canon: string | undefined, written: string): string | undefined {
  const here = PLACE_BY_CANON.get(city);
  if (here?.level !== 'city') return canon;
  if (canon) {
    const there = PLACE_BY_CANON.get(canon);
    // a country or a region: the city's own country only says where it is ("Zürich, Schweiz"), any other is a place
    if (!there) return here.country === canon ? undefined : canon;
    return there.level === 'state' && SUBREGIONS.get(canon)?.includes(city) ? undefined : canon;
  }
  // a two-letter code in capitals: a state's or province's, unless it is the country's own or its regions' ("Berlin, DE")
  const code = key.length === 2 && written === written.toUpperCase() ? REGION_CODES.get(key) : undefined;
  if (!code) return undefined;
  if (CODES_OF_COUNTRIES.get(key) === here.country || (here.country && OWN_REGION_CODES[here.country]?.includes(key))) return undefined;
  return STATE_OF_CITY.get(city) === code.place ? undefined : code.place;
}

/**
 * Read the places a list goes on with after the first, from `start`, set them down in `places` (which holds the
 * first, when the code knows it) and return where the list ends. An item is taken as the whole name it is and
 * nothing else: not by its first word, as the first place after a preposition is ("in Berlin and Jordan Smith" is
 * not Jordan), and an item the code does not know is dropped, as is a town after a German article ("in Köln und
 * den Bergen" is Köln); a compound that starts with a region's name is the region ("in Berlin oder der
 * DACH-Region"). The item after a city and a comma is read beside that city (see placeAfterACity), and only
 * beside the item directly before it: in "Berlin, SF, NYC" the item before NYC is SF, no place, so NYC is a place of
 * its own and has nothing to do with Berlin.
 */
function readTheRestOfTheList(rest: string, start: number, places: string[]): number {
  let end = start;
  // what the item directly before names, when the code knows it
  let before: string | undefined = places[places.length - 1];
  for (;;) {
    LIST_JOINER.lastIndex = end;
    const joiner = LIST_JOINER.exec(rest);
    if (!joiner) return end;
    const at = LIST_JOINER.lastIndex;
    const sticky = /\p{Ll}/u.test(rest.charAt(at)) ? LIST_NAMED : LIST_PLACE;
    sticky.lastIndex = at;
    const next = sticky.exec(rest);
    if (!next) return end;
    end = sticky.lastIndex;
    const city = /^\s*,\s*$/.test(joiner[1]) ? before : undefined;
    before = undefined;
    if (next[1].startsWith(READ) || isPossessive(rest.slice(end))) continue;
    const written = next[1].replace(/\./g, '');
    const key = fold(written);
    let canon = key === 'us' || key === 'usa' ? 'united states' : nameOf(key);
    // A compound that starts with a region's name is that region ("oder der DACH-Region", "und dem DACH-Raum",
    // "EU-Raum"), as it is after a preposition, where the scan reads the region and leaves the rest of the word.
    if (!canon && written.includes('-')) canon = REGION_BY_NAME.get(fold(written.slice(0, written.indexOf('-'))));
    if (canon && !fitsTheArticle(joiner[2], canon)) canon = undefined;
    before = canon;
    const added = city === undefined ? canon : placeAfterACity(city, key, canon, written);
    if (added) places.push(added);
  }
}

/**
 * Canonical place terms mentioned in free text: country aliases and region
 * names (whole-word, the regions after a preposition), plus capitalised words
 * after "in / based in / located in / from / within / across / throughout /
 * near" (and the German "aus" and "bei") so cities work ("in London" →
 * "london"), and the places a list goes on with after the first ("in Köln oder
 * Düsseldorf"). "US" is only a country when written in capitals or after a
 * location preposition — lowercase "us" is a pronoun ("help us").
 *
 * Not everything after a preposition is a place ("in SaaS", "from Google"), so
 * this returns the candidates; extractConstraints keeps only those the code
 * can resolve.
 */
export function locationTerms(written: string | null | undefined): string[] {
  if (!written) return [];
  // "ü" typed as "u" plus a combining diaeresis (a want pasted from a Mac or a PDF) is the same letter. "Western
  // Europe" is read as Europe (see REGION_MODIFIERS).
  const text = written.normalize('NFC').replace(MODIFIED_REGION, '');
  const { countries, regions, places, rest } = scan(text, WANT_SCAN);
  const out = new Set<string>(countries);
  if (mentionsUS(text)) out.add('united states');
  const prepRe = PLACE_AFTER_A_PREPOSITION;
  prepRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = prepRe.exec(rest)) !== null) {
    const [, preposition, article, name] = m;
    const alreadyRead = name.startsWith(READ);
    const first = alreadyRead ? undefined : readName(preposition, article, name, rest.slice(prepRe.lastIndex), out);
    if (!alreadyRead && !first) continue;
    const listed = first ? [first] : [];
    prepRe.lastIndex = readTheRestOfTheList(rest, prepRe.lastIndex, listed);
    for (const place of listed) out.add(place);
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

/**
 * What a person's location names. `namesakes` are the towns in `places` that the table puts in another state than the
 * one the location's code gives: "Kansas City, KS" has the town Kansas City, which a want for Kansas City takes, but it
 * is not the one in Missouri, so "in Missouri" does not take it.
 */
interface NamedPlaces { countries: Set<string>; regions: Set<string>; places: Set<string>; namesakes: Set<string> }
const NAMED_PLACES = new Map<string, NamedPlaces>();

/** The US state or Canadian province a location's last part names by its code, and whether that decides the country. */
interface CodedRegion { region: RegionCode; settles: boolean }

/**
 * The US state or Canadian province whose two-letter code is the last part of a location after a comma
 * ("Vienna, VA", "Portland, ME"), when a place the table knows is beside it. Not when the code is that
 * country's own: "Berlin, DE" (Germany's code), "Toronto, CA", "Perth, WA" (Western Australia), "Neuchâtel,
 * NE" (a Swiss canton) keep their city, and a code with nothing beside it says nothing ("Omaha, NE" is not
 * Niger). It settles the country when the town beside it is a namesake: a city or a state of another country,
 * or a name several countries have ("Cambridge, MA"). When a city of the code's own country is named ("Berlin
 * / San Francisco, CA", "Portland, ME"), that city already says where the person is and the code settles
 * nothing, so Berlin keeps its country; the code still names the state the person is in.
 */
function codedRegionIn(location: string, found: Found): CodedRegion | null {
  const parts = location.split(',');
  if (parts.length < 2) return null;
  const code = /^([A-Za-z]{2})\.?$/.exec(parts[parts.length - 1].trim())?.[1].toLowerCase();
  const region = code ? REGION_CODES.get(code) : undefined;
  if (!code || !region) return null;
  const beside = [...found.cityCountries, ...found.stateCountries];
  if (beside.some((k) => CODES_OF_COUNTRIES.get(code) === k || OWN_REGION_CODES[k]?.includes(code))) return null;
  if (!found.sharedName && !beside.length) return null;
  return { region, settles: !beside.includes(region.country) };
}

/**
 * Sort out the towns a code shows to be namesakes of the town the person is in. A town the table puts in another
 * state of the same country is the same name in this state ("Portland, ME", "Kansas City, KS"): it stays a place the
 * person is in, for a want that names the town, and is set down as a namesake, so that it does not count for the state
 * the table gives it. A town of another country is not the person's ("Vienna, VA" is not Vienna, Austria; Vancouver,
 * Washington is not Vancouver, British Columbia): it goes.
 */
function settleNamesakes(places: Set<string>, namesakes: Set<string>, coded: CodedRegion): void {
  for (const town of places) {
    const state = STATE_OF_CITY.get(town);
    const country = PLACE_BY_CANON.get(town)?.country;
    if (state) {
      if (state === coded.region.place) continue;
      if (PLACE_BY_CANON.get(state)?.country === coded.region.country) namesakes.add(town);
      else places.delete(town);
    } else if (coded.settles && country && country !== coded.region.country) {
      places.delete(town);
    }
  }
}

/** The countries, regions and cities, states and provinces a person's location names, accents and punctuation ignored. */
function placesNamedIn(location: string): NamedPlaces {
  const known = NAMED_PLACES.get(location);
  if (known) return known;
  const found = scan(fold(location), PROFILE_SCAN);
  if (mentionsUS(location)) found.countries.add('united states');
  // A country written out says where the person is. Without one a state or province does ("Paris,
  // Texas" is the US), and without that a city ("Greater Düsseldorf Area" is Germany). A US state's or
  // Canadian province's code last in the location does what its name would, but only beside a town the
  // table knows ("Vienna, VA", "Portland, ME"); a code on its own is none of these ("Omaha, NE" is not Niger).
  let countries: Set<string>;
  const namesakes = new Set<string>();
  if (found.countries.size) {
    countries = found.countries;
  } else {
    const coded = codedRegionIn(location, found);
    if (coded) {
      found.places.add(coded.region.place);
      settleNamesakes(found.places, namesakes, coded);
    }
    countries = coded?.settles ? new Set([coded.region.country])
      : found.stateCountries.size ? found.stateCountries : found.cityCountries;
  }
  // Locations repeat across the people a want is scored against; the cache is bounded.
  if (NAMED_PLACES.size >= 5000) NAMED_PLACES.clear();
  const named = { countries, regions: found.regions, places: found.places, namesakes };
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
  if (named.places.has(req)) return true;
  // "Bay Area" or "SF Bay Area" with no town around the Bay named is how LinkedIn writes San Francisco.
  for (const [area, city] of WRITTEN_FOR) {
    if (req === city && named.places.has(area) && !SUBREGIONS.get(area)?.some((town) => named.places.has(town))) return true;
  }
  // A state, a province or the Bay Area takes the towns in it, but only the ones that are in the country the
  // person is in: "Halifax, West Yorkshire" is not in Nova Scotia, nor "San Jose, Costa Rica" in California. And
  // not the namesakes: "Portland, ME" is not in Oregon.
  return !!SUBREGIONS.get(req)?.some((town) => named.places.has(town) && !named.namesakes.has(town) && inACountryOfTheirs(town, named));
}

/** Is this town, as the table has it, in a country the person's location names? A town that several countries have is. */
function inACountryOfTheirs(town: string, named: NamedPlaces): boolean {
  const country = PLACE_BY_CANON.get(town)?.country;
  return !country || named.countries.has(country);
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
