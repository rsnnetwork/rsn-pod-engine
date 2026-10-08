// ─── Regions, and the countries they are made of (7 Oct 2026) ────────────────
//
// "Fintech founders, seed investors and payments partners in Europe": the place a want
// names is often a REGION, and a person satisfies it when their location names a country
// inside it. Until now "Europe" was matched as a word against the candidate's location,
// so nobody in "Berlin, Germany" or "Milan, Italy" ever satisfied it and the member got
// no suggestions at all. This table is what says which countries are in which region.
//
// WHERE THE LISTS COME FROM
//   Europe, Africa, Asia, Latin America, Central and South America: the United Nations
//     geoscheme (M49, unstats.un.org/unsd/methodology/m49), adjusted where members use the
//     word differently, as noted on each list below.
//   EU: the 27 member states since the UK left in 2020 (european-union.europa.eu).
//   DACH, Benelux, Nordics, Scandinavia, Baltics, the UK and Ireland: the usual groupings.
//   GCC: the six members of the Gulf Cooperation Council.
//   Middle East, MENA, EMEA, APAC: conventions without one official list; the choices are
//     written next to each list.
// A country can be in several regions (Turkey is in Europe and the Middle East; Mexico is in
// North and Latin America), and a region lists the countries as they are named in
// want-constraints.ts (the older alias table) or in COUNTRY_NAMES below. Armenia and Azerbaijan
// (which of Europe or the Middle East claims them depends on who is asked) and the English-speaking
// Caribbean are in no region, but are still countries a person lives in and a want can name:
// they are the COUNTRIES_IN_NO_REGION rows. Georgia is left out altogether, because it is also
// a US state.
//
// Strictness is the rule for a place in a want (Stefan, 9 Sep 2026): a region is satisfied
// only by a country that is in it, and "Scandinavia" is not "the Nordics" (Finland and Iceland
// are Nordic, not Scandinavian). "The EU" and "the European Union" are the exception: the brief
// lists "Europe / EU / European Union" as one region, and a member who writes "the EU" means the
// European market (8 Oct 2026), so they are read as Europe, the wider list, and the card still
// says the one the member wrote.

export interface Region {
  /** What the region is called inside a constraint: lowercase, one per region. */
  key: string;
  /** How a card says it after "in": "in Europe", "in the Nordics". */
  label: string;
  /** Every way a want or a location writes it, lowercase. Includes the key. */
  names: readonly string[];
  /**
   * The names above that are also ordinary words ("GCC" is a compiler, "Mena" a first name, "Nordic"
   * a semiconductor company, "Dach" the German for roof). A want reads them as this region only after
   * a location preposition ("in the GCC"), like Jordan and Chad; a person's location always does.
   */
  afterPreposition?: readonly string[];
  /** The countries in it, by canonical name. */
  countries: readonly string[];
}

// ── The parts, written once so the bigger regions are built from them ──────────

const DACH = ['germany', 'austria', 'switzerland'];
const BENELUX = ['belgium', 'netherlands', 'luxembourg'];
const SCANDINAVIA = ['denmark', 'norway', 'sweden'];
const NORDICS = [...SCANDINAVIA, 'finland', 'iceland'];
const BALTICS = ['estonia', 'latvia', 'lithuania'];
const UK_AND_IRELAND = ['united kingdom', 'ireland'];

// The 27 member states. Europe below is built from them, and "the EU" is read as Europe.
const EU = [
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'denmark', 'estonia', 'finland',
  'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg',
  'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
];

// UN Europe (Eastern, Northern, Southern and Western Europe) plus the two transcontinental
// countries a European business would count: Cyprus (an EU member, which the UN files under
// Western Asia) and Turkey (which has the European side of Istanbul). The Caucasus states and
// Kazakhstan are left out. Both "Europe" and "the EU" are satisfied by any country in this list.
const EUROPE = [
  ...EU,
  'albania', 'andorra', 'belarus', 'bosnia and herzegovina', 'iceland', 'kosovo', 'liechtenstein',
  'moldova', 'monaco', 'montenegro', 'north macedonia', 'norway', 'russia', 'san marino', 'serbia',
  'switzerland', 'ukraine', 'united kingdom', 'vatican city', 'turkey',
];

// The Arab world and its neighbours as a business means "the Middle East": Egypt in, Cyprus out.
const MIDDLE_EAST = [
  'bahrain', 'egypt', 'iran', 'iraq', 'israel', 'jordan', 'kuwait', 'lebanon', 'oman', 'palestine',
  'qatar', 'saudi arabia', 'syria', 'turkey', 'united arab emirates', 'yemen',
];
const GCC = ['bahrain', 'kuwait', 'oman', 'qatar', 'saudi arabia', 'united arab emirates'];
// The Middle East and North Africa after the World Bank's grouping, without Turkey. The World Bank's
// own MENA also counts Djibouti and Malta; they are left out here (Djibouti is listed with Africa and
// Malta with Europe), so a person there is found by those regions and not by MENA.
const MENA = [
  'algeria', 'bahrain', 'egypt', 'iran', 'iraq', 'israel', 'jordan', 'kuwait', 'lebanon', 'libya',
  'morocco', 'oman', 'palestine', 'qatar', 'saudi arabia', 'syria', 'tunisia', 'united arab emirates',
  'yemen',
];

// The 54 African states (UN / African Union). Egypt is here and in the Middle East.
const AFRICA = [
  'algeria', 'angola', 'benin', 'botswana', 'burkina faso', 'burundi', 'cabo verde', 'cameroon',
  'central african republic', 'chad', 'comoros', 'dr congo', 'republic of the congo', "cote d'ivoire",
  'djibouti', 'egypt', 'equatorial guinea', 'eritrea', 'eswatini', 'ethiopia', 'gabon', 'gambia',
  'ghana', 'guinea', 'guinea-bissau', 'kenya', 'lesotho', 'liberia', 'libya', 'madagascar', 'malawi',
  'mali', 'mauritania', 'mauritius', 'morocco', 'mozambique', 'namibia', 'niger', 'nigeria', 'rwanda',
  'sao tome and principe', 'senegal', 'seychelles', 'sierra leone', 'somalia', 'south africa',
  'south sudan', 'sudan', 'tanzania', 'togo', 'tunisia', 'uganda', 'zambia', 'zimbabwe',
];

const SOUTHEAST_ASIA = [
  'brunei', 'cambodia', 'indonesia', 'laos', 'malaysia', 'myanmar', 'philippines', 'singapore',
  'thailand', 'timor-leste', 'vietnam',
];
// Asia as members use the word: Central, East, South-East and South Asia. The UN also files
// Western Asia (the Gulf, the Levant, Turkey, Iran, the Caucasus) under Asia; those are the
// Middle East's business, and "Asia" does not reach them.
const ASIA = [
  'kazakhstan', 'kyrgyzstan', 'tajikistan', 'turkmenistan', 'uzbekistan',
  'china', 'hong kong', 'japan', 'macao', 'mongolia', 'north korea', 'south korea', 'taiwan',
  ...SOUTHEAST_ASIA,
  'afghanistan', 'bangladesh', 'bhutan', 'india', 'maldives', 'nepal', 'pakistan', 'sri lanka',
];
const OCEANIA = [
  'australia', 'fiji', 'kiribati', 'marshall islands', 'micronesia', 'nauru', 'new zealand', 'palau',
  'papua new guinea', 'samoa', 'solomon islands', 'tonga', 'tuvalu', 'vanuatu',
];

const CENTRAL_AMERICA = ['belize', 'costa rica', 'el salvador', 'guatemala', 'honduras', 'nicaragua', 'panama'];
const SOUTH_AMERICA = [
  'argentina', 'bolivia', 'brazil', 'chile', 'colombia', 'ecuador', 'guyana', 'paraguay', 'peru',
  'suriname', 'uruguay', 'venezuela',
];
// Latin America: Mexico, Central and South America, and the Caribbean countries whose language
// is Spanish or French. The English-speaking Caribbean is not in it.
const LATIN_AMERICA = [
  'mexico', ...CENTRAL_AMERICA, ...SOUTH_AMERICA, 'cuba', 'dominican republic', 'haiti', 'puerto rico',
];
// North America as business uses it: the three USMCA countries. Central America and the
// Caribbean sit under Latin America.
const NORTH_AMERICA = ['united states', 'canada', 'mexico'];

export const REGIONS: readonly Region[] = [
  { key: 'europe', label: 'Europe', names: ['europe', 'european'], countries: EUROPE },
  { key: 'eu', label: 'the EU', names: ['eu', 'e.u.', 'european union'], countries: EUROPE },
  { key: 'emea', label: 'EMEA', names: ['emea'], countries: [...new Set([...EUROPE, ...MIDDLE_EAST, ...AFRICA])] },
  { key: 'dach', label: 'DACH', names: ['dach'], afterPreposition: ['dach'], countries: DACH },
  { key: 'benelux', label: 'Benelux', names: ['benelux'], countries: BENELUX },
  {
    key: 'nordics', label: 'the Nordics', names: ['nordics', 'nordic', 'nordic countries'],
    afterPreposition: ['nordic'], countries: NORDICS,
  },
  { key: 'scandinavia', label: 'Scandinavia', names: ['scandinavia', 'scandinavian'], countries: SCANDINAVIA },
  { key: 'baltics', label: 'the Baltics', names: ['baltics', 'baltic states', 'baltic countries'], countries: BALTICS },
  {
    key: 'uk and ireland', label: 'the UK and Ireland', countries: UK_AND_IRELAND,
    names: ['uk and ireland', 'uk & ireland', 'uk/ireland', 'british isles', 'britain and ireland', 'britain & ireland'],
  },
  { key: 'middle east', label: 'the Middle East', names: ['middle east', 'middle-east'], countries: MIDDLE_EAST },
  {
    key: 'mena', label: 'MENA', countries: MENA, afterPreposition: ['mena'],
    names: ['mena', 'middle east and north africa', 'middle east & north africa'],
  },
  {
    key: 'gcc', label: 'the GCC', countries: GCC, afterPreposition: ['gcc'],
    names: ['gcc', 'gulf states', 'gulf countries', 'gulf cooperation council'],
  },
  { key: 'africa', label: 'Africa', names: ['africa'], countries: AFRICA },
  { key: 'asia', label: 'Asia', names: ['asia'], countries: ASIA },
  {
    key: 'apac', label: 'APAC', countries: [...ASIA, ...OCEANIA],
    names: ['apac', 'asia pacific', 'asia-pacific', 'asia/pacific'],
  },
  {
    key: 'southeast asia', label: 'Southeast Asia', countries: SOUTHEAST_ASIA,
    names: ['southeast asia', 'south east asia', 'south-east asia', 'se asia'],
  },
  { key: 'latin america', label: 'Latin America', names: ['latin america', 'latin american', 'latam'], countries: LATIN_AMERICA },
  { key: 'north america', label: 'North America', names: ['north america', 'north american'], countries: NORTH_AMERICA },
  { key: 'south america', label: 'South America', names: ['south america', 'south american'], countries: SOUTH_AMERICA },
  { key: 'central america', label: 'Central America', names: ['central america', 'central american'], countries: CENTRAL_AMERICA },
];

const BY_KEY = new Map(REGIONS.map((r) => [r.key, r]));
const COUNTRY_SETS = new Map(REGIONS.map((r) => [r.key, new Set(r.countries)]));

export const regionByKey = (key: string): Region | undefined => BY_KEY.get(key);

/** The words a card prints after "in" for this region, or null when it is not a region. */
export const regionLabel = (key: string): string | null => BY_KEY.get(key)?.label ?? null;

// The few names that capitalising each word gets wrong. A reason is plain ASCII (the code prints no
// accents anywhere else), so Côte d'Ivoire is "Cote d'Ivoire", as it is keyed.
const PLACE_DISPLAY: ReadonlyMap<string, string> = new Map([
  ['dr congo', 'DR Congo'],
  ["cote d'ivoire", "Cote d'Ivoire"],
  ['washington dc', 'Washington DC'],
  ['prince edward', 'Prince Edward Island'], // the key is the two words a want captures
]);

const LOWERCASE_INSIDE_A_NAME = new Set(['and', 'of', 'the']);

/**
 * The words a card prints after "in" for a place key: a region as the member wrote it ("the
 * Nordics"), anything else with each word capitalised except "and", "of" and "the" inside the
 * name ("Bosnia and Herzegovina", "Republic of the Congo").
 */
export function placeLabel(key: string): string {
  return regionLabel(key) ?? PLACE_DISPLAY.get(key)
    ?? key.replace(/\b[a-z]+/g, (word, at: number) => (at > 0 && LOWERCASE_INSIDE_A_NAME.has(word) ? word : word[0].toUpperCase() + word.slice(1)));
}

/** True when every country of `inner` is also in `outer`: someone who says "the Nordics" is in Europe. */
export function regionCovers(outer: string, inner: string): boolean {
  const big = COUNTRY_SETS.get(outer);
  const small = BY_KEY.get(inner);
  return !!big && !!small && small.countries.every((c) => big.has(c));
}

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
