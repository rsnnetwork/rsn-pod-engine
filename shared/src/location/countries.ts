// ─── Countries, as REASON reads a place (moved here 1 Nov 2026) ─────────────
//
// The country names, aliases and home names the matcher reads a person's location with
// (services/matching/want-constraints.ts and want-regions.ts, which re-export them), kept here so
// the onboarding screens, the profile form and the server judge one question the same way: is a
// location only a country? (30 Oct review, 1.2: "others show only 'USA'".) The tables are as they
// were in the matcher; only where they live changed.

// ── The older alias table (it was want-constraints.ts's) ──────────────────────
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

// ── Countries the older alias table (want-constraints.ts) does not know ────────
//
// canonical name -> the other ways it is written. The canonical name itself is always
// understood. These are matched in a PERSON'S location only, never scanned for in a want's
// text: "Jordan", "Chad" and "Georgia" are first names as often as countries, and a want that
// says "meet Jordan" must not become a place. In a want a country is read after "in", "from",
// "based in"... as before.
//
// The spellings are the ones the app itself writes (the onboarding card stored a member's
// country as Intl.DisplayNames gives it: "Türkiye", "Czechia", "Bosnia & Herzegovina",
// "Congo - Kinshasa", "Hong Kong SAR China") plus the old and common names. Georgia is left
// out on purpose: it is the US state as often as the country.
const COUNTRY_NAMES_IN_REGIONS: Readonly<Record<string, readonly string[]>> = {
  // Europe
  luxembourg: [], greece: [], czechia: ['czech republic'], hungary: [], romania: [], bulgaria: [],
  croatia: [], slovenia: [], slovakia: ['slovak republic'], estonia: [], latvia: [], lithuania: [],
  cyprus: [], malta: [], iceland: [], albania: [], andorra: [], belarus: [],
  'bosnia and herzegovina': ['bosnia', 'bosnia herzegovina'], kosovo: [], liechtenstein: [],
  moldova: [], monaco: [], montenegro: [], 'north macedonia': ['macedonia'],
  russia: ['russian federation'], 'san marino': [], serbia: [], ukraine: [],
  'vatican city': ['holy see', 'vatican'],
  // The Middle East and North Africa
  bahrain: [], egypt: [], iran: [], iraq: [], jordan: [], kuwait: [], lebanon: [], oman: [],
  palestine: ['state of palestine', 'palestinian territories', 'west bank', 'gaza'],
  qatar: [], syria: [], yemen: [], algeria: [], libya: [], morocco: [], tunisia: [],
  // Africa
  angola: [], benin: [], botswana: [], 'burkina faso': [], burundi: [], 'cabo verde': ['cape verde'],
  cameroon: [], 'central african republic': [], chad: [], comoros: [],
  'dr congo': ['democratic republic of the congo', 'democratic republic of congo', 'congo kinshasa', 'drc'],
  'republic of the congo': ['congo brazzaville', 'congo'], "cote d'ivoire": ['ivory coast'],
  djibouti: [], 'equatorial guinea': [], eritrea: [], eswatini: ['swaziland'], ethiopia: [], gabon: [],
  gambia: ['the gambia'], ghana: [], guinea: [], 'guinea-bissau': [], lesotho: [], liberia: [],
  madagascar: [], malawi: [], mali: [], mauritania: [], mauritius: [], mozambique: [], namibia: [],
  niger: [], rwanda: [], 'sao tome and principe': ['sao tome'], senegal: [], seychelles: [],
  'sierra leone': [], somalia: [], 'south sudan': [], sudan: [], tanzania: [], togo: [], uganda: [],
  zambia: [], zimbabwe: [],
  // Asia and Oceania
  kazakhstan: [], kyrgyzstan: [], tajikistan: [], turkmenistan: [], uzbekistan: [], 'hong kong': [],
  macao: ['macau'], mongolia: [], 'north korea': [], 'south korea': ['korea', 'republic of korea'],
  taiwan: [], brunei: ['brunei darussalam'], cambodia: [], indonesia: [], laos: ['lao pdr'],
  malaysia: [], myanmar: ['burma'], philippines: [], thailand: [], 'timor-leste': ['east timor'],
  vietnam: ['viet nam'], afghanistan: [], bangladesh: [], bhutan: [], maldives: [], nepal: [],
  'sri lanka': [], fiji: [], kiribati: [], 'marshall islands': [], micronesia: ['federated states of micronesia'],
  nauru: [], palau: [], 'papua new guinea': [], samoa: [], 'solomon islands': [], tonga: [], tuvalu: [],
  vanuatu: [],
  // Latin America
  belize: [], 'costa rica': [], 'el salvador': [], guatemala: [], honduras: [], nicaragua: [], panama: [],
  argentina: [], bolivia: [], chile: [], colombia: [], ecuador: [], guyana: [], paraguay: [], peru: [],
  suriname: [], uruguay: [], venezuela: [], cuba: [], 'dominican republic': [], haiti: [], 'puerto rico': [],
};

// Countries no region lists, written the same way. Every sovereign state is one of the alias table,
// COUNTRY_NAMES_IN_REGIONS above or these, which the Intl test in want-regions.test.ts checks (Georgia
// aside). The short forms ("trinidad", "st kitts") are what a want captures before "and".
const COUNTRY_NAMES_IN_NO_REGION: Readonly<Record<string, readonly string[]>> = {
  armenia: [], azerbaijan: [],
  'antigua and barbuda': ['antigua'], bahamas: ['the bahamas'], barbados: [], dominica: [], grenada: [], jamaica: [],
  'saint kitts and nevis': ['st kitts and nevis', 'st kitts', 'saint kitts', 'st christopher and nevis'],
  'saint lucia': ['st lucia'],
  'saint vincent and the grenadines': [
    'st vincent and the grenadines', 'st vincent and grenadines', 'saint vincent and grenadines', 'st vincent', 'saint vincent',
  ],
  'trinidad and tobago': ['trinidad', 'tobago'],
};

export const COUNTRY_NAMES: Readonly<Record<string, readonly string[]>> = {
  ...COUNTRY_NAMES_IN_REGIONS, ...COUNTRY_NAMES_IN_NO_REGION,
};

/** The countries of COUNTRY_NAMES that no region lists. */
export const COUNTRIES_IN_NO_REGION: readonly string[] = Object.keys(COUNTRY_NAMES_IN_NO_REGION);

// ── Countries by the names they are written with at home ──────────────────────
//
// canonical name -> the names a person at home writes, and the names a German speaker writes the
// neighbours with. The launch audience is Düsseldorf and the DACH countries, so its locations say
// "Deutschland", "Österreich" and "Schweiz" ("Wien, Österreich", "Zürich, Schweiz"). Like the rows
// above, these are matched in a person's location, and in a want after a preposition ("Gründer in
// Österreich"), never scanned for anywhere in a want's text. Accents are folded when they are read.
export const ENDONYMS: Readonly<Record<string, readonly string[]>> = {
  austria: ['österreich'],
  switzerland: ['schweiz', 'suisse', 'svizzera', 'svizra'],
  france: ['frankreich'],
  italy: ['italia', 'italien'],
  spain: ['españa', 'spanien'],
  netherlands: ['nederland', 'niederlande'],
  belgium: ['belgië', 'belgique', 'belgien'],
  luxembourg: ['luxemburg', 'lëtzebuerg'],
  poland: ['polska', 'polen'],
  czechia: ['česko', 'tschechien'],
  slovakia: ['slovensko', 'slowakei'],
  hungary: ['magyarország', 'ungarn'],
  romania: ['românia', 'rumänien'],
  bulgaria: ['bulgarien'],
  croatia: ['hrvatska', 'kroatien'],
  slovenia: ['slovenija', 'slowenien'],
  serbia: ['srbija', 'serbien'],
  greece: ['hellas', 'griechenland'],
  cyprus: ['zypern'],
  turkey: ['türkei'],
  russia: ['russland'],
  sweden: ['sverige', 'schweden'],
  norway: ['norge', 'norwegen'],
  denmark: ['danmark', 'dänemark'],
  finland: ['suomi', 'finnland'],
  estonia: ['eesti', 'estland'],
  latvia: ['latvija', 'lettland'],
  lithuania: ['lietuva', 'litauen'],
  ireland: ['éire', 'irland'],
  'united kingdom': ['großbritannien', 'vereinigtes königreich'],
  'united states': ['vereinigte staaten'],
  brazil: ['brasil'],
  egypt: ['ägypten'],
};

// ── Only a country? (30 Oct review, 1.2) ──────────────────────────────────────
//
// A location that is exactly a country, by any name above (trimmed, in any case, with or without
// "the" and full stops: "USA", "U.S.A.", "the UK", "Deutschland"), does not say where someone is
// based. Anything more is the member's own words and counts as given: "Manchester, UK", "Omaha, NE",
// "Greater Copenhagen Region", "Spain/US". A city that is its own country ("Singapore", "Monaco") or
// a city the alias table files under its country ("Dubai") is where someone lives, so it is not "only
// a country". Stored values are never rewritten: location is a matcher input.

/** City states and cities the tables above list as a country's name: a place someone lives in. */
const CITIES_NAMED_AS_COUNTRIES = new Set(
  ['singapore', 'hong kong', 'macao', 'macau', 'monaco', 'vatican city', 'dubai', 'abu dhabi'],
);

/** A name as "only a country?" compares it: folded, without full stops, without a leading "the". */
const countryKey = (s: string): string => fold(s.replace(/\./g, '')).replace(/^the /, '');

const COUNTRY_ONLY = new Set(
  [
    ...Object.entries(COUNTRY_ALIASES).flatMap(([canon, aliases]) => [canon, ...aliases]),
    ...Object.entries(COUNTRY_NAMES).flatMap(([canon, others]) => [canon, ...others]),
    ...Object.values(ENDONYMS).flat(),
  ].map(countryKey).filter((key) => !CITIES_NAMED_AS_COUNTRIES.has(key)),
);

/** True when the location is exactly a country's name or alias; false for anything more, and for nothing at all. */
export function isCountryOnly(location: string | null | undefined): boolean {
  const key = countryKey(location ?? '');
  return key.length > 0 && COUNTRY_ONLY.has(key);
}

/** A location that says where someone is based: not empty, and not only a country. */
export function isLocationComplete(location: string | null | undefined): boolean {
  return (location ?? '').trim().length > 0 && !isCountryOnly(location);
}
