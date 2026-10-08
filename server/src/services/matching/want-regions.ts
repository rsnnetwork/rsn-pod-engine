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
// want-constraints.ts (the older alias table) or in COUNTRY_NAMES below. Armenia, Azerbaijan and
// Georgia are in no region: which of Europe or the Middle East claims them depends on who is
// asked, and Georgia is also a US state.
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
// The Middle East and North Africa as the World Bank draws it: Turkey is not in it.
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
  { key: 'dach', label: 'DACH', names: ['dach'], countries: DACH },
  { key: 'benelux', label: 'Benelux', names: ['benelux'], countries: BENELUX },
  { key: 'nordics', label: 'the Nordics', names: ['nordics', 'nordic', 'nordic countries'], countries: NORDICS },
  { key: 'scandinavia', label: 'Scandinavia', names: ['scandinavia', 'scandinavian'], countries: SCANDINAVIA },
  { key: 'baltics', label: 'the Baltics', names: ['baltics', 'baltic states', 'baltic countries'], countries: BALTICS },
  {
    key: 'uk and ireland', label: 'the UK and Ireland', countries: UK_AND_IRELAND,
    names: ['uk and ireland', 'uk & ireland', 'uk/ireland', 'british isles', 'britain and ireland', 'britain & ireland'],
  },
  { key: 'middle east', label: 'the Middle East', names: ['middle east', 'middle-east'], countries: MIDDLE_EAST },
  {
    key: 'mena', label: 'MENA', countries: MENA,
    names: ['mena', 'middle east and north africa', 'middle east & north africa'],
  },
  {
    key: 'gcc', label: 'the GCC', countries: GCC,
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
export const COUNTRY_NAMES: Readonly<Record<string, readonly string[]>> = {
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

// ── Cities, states and provinces the matcher knows are places ──────────────────
//
// A want's "in X" is only a place when we can tell X is one: "in Narnia", "from Google" and
// "in SaaS" are capitalised words after a preposition too, and reading each as a location every
// candidate must match would empty the list. Countries and regions are known from the tables
// above; these are the cities, US states and Canadian provinces, in the one or two words the
// extractor captures after a preposition, that members commonly name. One that is not here is
// treated like any other unknown place: it filters nothing. Add one by adding it here.
export const KNOWN_PLACES: ReadonlySet<string> = new Set(
  [
    // Britain and Ireland
    'london', 'manchester', 'birmingham', 'edinburgh', 'glasgow', 'bristol', 'leeds', 'liverpool',
    'cambridge', 'oxford', 'belfast', 'cardiff', 'dublin', 'cork',
    // Germany, Austria, Switzerland
    'berlin', 'munich', 'munchen', 'hamburg', 'frankfurt', 'cologne', 'koln', 'dusseldorf', 'duesseldorf',
    'stuttgart', 'leipzig', 'dresden', 'hannover', 'nuremberg', 'bonn', 'essen', 'dortmund', 'bremen',
    'vienna', 'salzburg', 'graz', 'zurich', 'geneva', 'basel', 'bern', 'lausanne',
    // The rest of Europe
    'paris', 'lyon', 'marseille', 'toulouse', 'amsterdam', 'rotterdam', 'utrecht', 'eindhoven',
    'brussels', 'antwerp', 'madrid', 'barcelona', 'valencia', 'seville', 'lisbon', 'porto', 'rome',
    'milan', 'turin', 'naples', 'florence', 'bologna', 'athens', 'copenhagen', 'stockholm', 'gothenburg',
    'malmo', 'oslo', 'bergen', 'helsinki', 'reykjavik', 'warsaw', 'krakow', 'prague', 'budapest',
    'bucharest', 'sofia', 'belgrade', 'zagreb', 'ljubljana', 'bratislava', 'vilnius', 'riga', 'tallinn',
    'kyiv', 'kiev', 'istanbul', 'ankara', 'moscow',
    // More of the launch markets: Germany, Austria, Switzerland, the Benelux, the UK, the Nordics,
    // southern Europe (a name with an umlaut cannot be captured after a preposition, so those are absent)
    'aachen', 'augsburg', 'bielefeld', 'bochum', 'braunschweig', 'chemnitz', 'darmstadt', 'duisburg',
    'erfurt', 'freiburg', 'heidelberg', 'karlsruhe', 'kassel', 'kiel', 'krefeld', 'leverkusen',
    'magdeburg', 'mainz', 'mannheim', 'neuss', 'potsdam', 'regensburg', 'rostock', 'ulm', 'wiesbaden',
    'wuppertal', 'linz', 'innsbruck', 'klagenfurt', 'lucerne', 'winterthur', 'lugano', 'zug', 'st gallen',
    'groningen', 'tilburg', 'breda', 'nijmegen', 'haarlem', 'delft', 'leiden', 'maastricht', 'almere',
    'ghent', 'leuven', 'sheffield', 'nottingham', 'newcastle', 'leicester', 'southampton', 'brighton',
    'aberdeen', 'dundee', 'swansea', 'york', 'exeter', 'norwich', 'coventry', 'plymouth', 'aarhus',
    'odense', 'aalborg', 'uppsala', 'trondheim', 'stavanger', 'tampere', 'turku', 'genoa', 'venice',
    'verona', 'padua', 'palermo', 'bari', 'malaga', 'bilbao', 'zaragoza', 'granada', 'coimbra',
    'thessaloniki',
    // The Middle East and Africa
    'riyadh', 'jeddah', 'doha', 'manama', 'muscat', 'cairo', 'tel aviv', 'jerusalem', 'amman', 'beirut',
    'tehran', 'baghdad', 'nairobi', 'lagos', 'abuja', 'accra', 'johannesburg', 'cape town', 'durban',
    'casablanca', 'tunis', 'algiers', 'addis ababa', 'kigali', 'kampala', 'dakar', 'abidjan', 'kinshasa',
    // Asia and Oceania
    'tokyo', 'osaka', 'seoul', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'taipei', 'bangkok',
    'jakarta', 'manila', 'kuala lumpur', 'hanoi', 'mumbai', 'delhi', 'new delhi', 'bangalore', 'bengaluru',
    'hyderabad', 'chennai', 'pune', 'kolkata', 'karachi', 'lahore', 'islamabad', 'rawalpindi', 'dhaka',
    'colombo', 'kathmandu', 'sydney', 'melbourne', 'brisbane', 'perth', 'auckland', 'wellington',
    // The Americas
    'new york', 'san francisco', 'los angeles', 'chicago', 'boston', 'seattle', 'austin', 'denver',
    'atlanta', 'miami', 'houston', 'dallas', 'washington', 'washington dc', 'san diego', 'san jose',
    'portland', 'philadelphia', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'guadalajara',
    'bogota', 'medellin', 'lima', 'santiago', 'buenos aires', 'sao paulo', 'rio', 'brasilia', 'quito',
    'caracas', 'montevideo', 'havana', 'san juan',
    // US states
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
    'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
    'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
    'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
    'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
    'west virginia', 'wisconsin', 'wyoming',
    // Canadian provinces ("Prince Edward Island" is captured as its first two words)
    'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia',
    'new brunswick', 'newfoundland', 'prince edward',
  ],
);
