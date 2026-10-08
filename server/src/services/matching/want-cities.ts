// ─── Cities, US states and Canadian provinces (8 Oct 2026) ────────────────────
//
// A place in a want is only a place when the matcher can tell it is one ("in Narnia" and "from
// Google" are capitalised words after a preposition too), and a person's location resolves to a
// country through a city it names ("Greater Düsseldorf Area", "Bangkok, TH", "Utrecht"). This table
// is both: every city, state and province here is a place a want can name, and says which country
// it is in. It is hand-kept data. A city that is not here is treated like any other unknown place:
// a want that names it filters nothing, and a location that names only it resolves to no country.
// Add one by adding it to its country below.
//
// WHERE THE LIST COMES FROM
//   The cities members name, plus the largest cities of each European country (the launch audience
//   is Düsseldorf and the DACH countries, so Germany, Austria and Switzerland are listed to the
//   towns a business would name), the cities of the other regions, and the capitals and business
//   centres of the countries members write from. It is not a gazetteer.
//
// HOW A NAME IS WRITTEN
//   Lowercase ASCII, the way a location is folded (accents and punctuation removed: "Zürich" and
//   "St. Gallen" are read as "zurich" and "st gallen"). An entry is "canonical|other spelling|...":
//   the first is what a want's place is called ("cologne"), the others are the same place written
//   another way ("koln", "koeln"), so a want in "Köln" and a profile in "Cologne" agree.
//
// A name that is several countries' ("Cambridge", "Georgia") is listed with no country: it is still
// a place a want can name, but it does not decide where a person is. A city that is several
// countries' but has one dominant meaning (Paris, London, Vienna, Dublin) is listed in that country,
// and a state, a province or a country written beside it wins ("Paris, Texas" is the US).

export type PlaceLevel = 'state' | 'city';

export interface Place {
  /** What a want calls it, and what the card prints after "in" (see placeLabel). Unique. */
  canon: string;
  /** Every spelling, canonical first: lowercase ASCII, as a folded location writes it. Each belongs to one place. */
  names: readonly string[];
  /** The country it is in, or null when the name does not say (it is also another country's). */
  country: string | null;
  /** A state or province names the country more firmly than a city does ("Paris, Texas"). */
  level: PlaceLevel;
}

// The towns of Northern Ireland. A want "in Northern Ireland" is satisfied by a location that names
// the province or one of them (see SUBREGIONS); in a person's location they are the United Kingdom.
const NORTHERN_IRELAND_TOWNS: readonly string[] = [
  'belfast', 'derry|londonderry', 'lisburn', 'newry', 'armagh', 'omagh', 'enniskillen', 'coleraine', 'ballymena',
  'newtownabbey', 'craigavon', 'carrickfergus', 'portadown', 'larne', 'strabane',
];

const CITIES: Readonly<Record<string, readonly string[]>> = {
  // ── Germany, Austria, Switzerland ──────────────────────────────────────────
  germany: [
    'berlin', 'munich|munchen|muenchen', 'hamburg', 'frankfurt', 'cologne|koln|koeln', 'dusseldorf|duesseldorf',
    'stuttgart', 'leipzig', 'dresden', 'hannover', 'nuremberg|nurnberg|nuernberg', 'bonn', 'essen', 'dortmund',
    'bremen', 'duisburg', 'bochum', 'wuppertal', 'bielefeld', 'mannheim', 'karlsruhe', 'augsburg', 'wiesbaden',
    'aachen', 'munster|muenster', 'gelsenkirchen', 'monchengladbach|moenchengladbach', 'braunschweig', 'chemnitz',
    'kiel', 'magdeburg', 'freiburg', 'krefeld', 'lubeck|luebeck', 'mainz', 'erfurt', 'rostock', 'kassel', 'potsdam',
    'saarbrucken|saarbruecken', 'heidelberg', 'darmstadt', 'regensburg', 'ingolstadt', 'wurzburg|wuerzburg',
    'wolfsburg', 'ulm', 'heilbronn', 'pforzheim', 'offenbach', 'gottingen|goettingen', 'trier', 'jena', 'neuss',
    'leverkusen', 'siegen', 'oldenburg', 'osnabruck|osnabrueck', 'solingen', 'hildesheim', 'paderborn', 'koblenz',
    'bamberg', 'bayreuth', 'konstanz', 'tubingen|tuebingen', 'ludwigshafen', 'reutlingen', 'cottbus', 'flensburg',
    // Around Düsseldorf and along the Rhine and the Ruhr, where the launch audience lives and works
    'ratingen', 'meerbusch', 'hilden', 'langenfeld', 'mettmann', 'monheim', 'dormagen', 'grevenbroich', 'erkrath',
    'kaarst', 'willich', 'viersen', 'velbert', 'troisdorf', 'siegburg', 'bergisch gladbach', 'remscheid',
    'oberhausen', 'hagen', 'hamm', 'herne', 'bottrop', 'recklinghausen', 'moers', 'witten', 'mulheim|muelheim',
    'furth|fuerth', 'erlangen', 'bremerhaven', 'kaiserslautern', 'gutersloh|guetersloh', 'schwerin', 'ludwigsburg',
    'esslingen', 'marburg', 'luneburg|lueneburg',
  ],
  austria: [
    'vienna|wien', 'graz', 'linz', 'salzburg', 'innsbruck', 'klagenfurt', 'villach', 'wels', 'st polten|sankt polten',
    'dornbirn', 'bregenz', 'steyr', 'wiener neustadt', 'feldkirch', 'leoben', 'krems',
  ],
  switzerland: [
    'zurich|zuerich', 'geneva|genf|geneve', 'basel', 'bern|berne', 'lausanne', 'lucerne|luzern', 'winterthur',
    'st gallen|sankt gallen', 'lugano', 'zug', 'neuchatel|neuenburg', 'fribourg', 'schaffhausen', 'chur', 'thun',
    'aarau', 'solothurn', 'sion', 'vevey', 'montreux', 'nyon', 'locarno', 'bellinzona', 'olten', 'davos',
  ],
  // ── The rest of Western and Northern Europe ────────────────────────────────
  'united kingdom': [
    'london', 'birmingham', 'manchester', 'glasgow', 'liverpool', 'bristol', 'sheffield', 'leeds', 'edinburgh',
    'leicester', 'cardiff', 'nottingham', 'newcastle', 'southampton', 'portsmouth', 'brighton',
    'aberdeen', 'dundee', 'swansea', 'york', 'exeter', 'norwich', 'coventry', 'plymouth', 'oxford', 'milton keynes',
    'northwich', 'inverness', 'wolverhampton', 'sunderland', 'salford', 'stockport', 'warrington', 'cheltenham',
    ...NORTHERN_IRELAND_TOWNS,
  ],
  ireland: ['dublin', 'cork', 'galway', 'limerick', 'waterford', 'kilkenny', 'drogheda', 'sligo'],
  france: [
    'paris', 'lyon', 'marseille', 'toulouse', 'nantes', 'strasbourg', 'montpellier', 'bordeaux', 'lille', 'rennes',
    'grenoble', 'dijon', 'toulon', 'reims', 'metz', 'annecy', 'sophia antipolis', 'saint etienne', 'le havre',
    'aix en provence', 'clermont ferrand',
  ],
  netherlands: [
    'amsterdam', 'rotterdam', 'the hague|den haag', 'utrecht', 'eindhoven', 'groningen', 'tilburg', 'almere',
    'breda', 'nijmegen', 'haarlem', 'delft', 'leiden', 'maastricht', 'arnhem', 'apeldoorn', 'enschede', 'zwolle',
    'amersfoort', 'leeuwarden',
  ],
  belgium: [
    'brussels|bruxelles|brussel', 'antwerp|antwerpen', 'ghent|gent', 'leuven|louvain', 'bruges|brugge', 'liege|luik',
    'charleroi', 'namur', 'mechelen', 'hasselt', 'kortrijk', 'ostend|oostende',
  ],
  denmark: ['copenhagen|kobenhavn', 'aarhus|arhus', 'odense', 'aalborg', 'esbjerg', 'roskilde', 'kolding'],
  sweden: [
    'stockholm', 'gothenburg|goteborg', 'malmo', 'uppsala', 'vasteras', 'orebro', 'linkoping', 'helsingborg', 'lund',
    'umea', 'norrkoping', 'jonkoping', 'gavle', 'sundsvall',
  ],
  norway: ['oslo', 'bergen', 'trondheim', 'stavanger', 'drammen', 'kristiansand', 'tromso', 'fredrikstad', 'bodo'],
  finland: ['helsinki|helsingfors', 'espoo', 'tampere', 'vantaa', 'oulu', 'turku', 'jyvaskyla', 'lahti', 'kuopio'],
  iceland: ['reykjavik', 'kopavogur', 'akureyri'],
  // ── Southern Europe ────────────────────────────────────────────────────────
  spain: [
    'madrid', 'barcelona', 'valencia', 'seville|sevilla', 'zaragoza', 'malaga', 'murcia', 'palma', 'bilbao',
    'alicante', 'valladolid', 'vigo', 'gijon', 'granada', 'san sebastian|donostia', 'santander', 'pamplona',
    'las palmas', 'marbella', 'girona', 'tarragona',
  ],
  portugal: [
    'lisbon|lisboa', 'porto|oporto', 'braga', 'coimbra', 'faro', 'funchal', 'aveiro', 'setubal', 'cascais', 'sintra',
    'guimaraes', 'leiria', 'evora', 'albufeira',
  ],
  italy: [
    'rome|roma', 'milan|milano', 'naples|napoli', 'turin|torino', 'palermo', 'genoa|genova', 'bologna',
    'florence|firenze', 'bari', 'catania', 'venice|venezia', 'verona', 'padua|padova', 'trieste', 'brescia', 'parma',
    'modena', 'reggio emilia', 'perugia', 'cagliari', 'trento', 'bergamo', 'pisa', 'lecce', 'salerno', 'ancona',
    'pescara', 'vicenza', 'treviso', 'bolzano|bozen', 'udine', 'siena', 'ravenna', 'rimini', 'livorno', 'taranto',
    'messina',
  ],
  greece: ['athens|athina', 'thessaloniki|salonica', 'patras', 'heraklion', 'larissa', 'volos', 'chania'],
  cyprus: ['nicosia|lefkosia', 'limassol', 'larnaca', 'paphos'],
  malta: ['valletta', 'sliema', 'st julians'],
  // ── Central and Eastern Europe, the Baltics, Turkey ────────────────────────
  poland: [
    'warsaw|warszawa', 'krakow|cracow', 'lodz', 'wroclaw', 'poznan', 'gdansk', 'szczecin', 'bydgoszcz', 'lublin',
    'katowice', 'bialystok', 'gdynia',
  ],
  czechia: ['prague|praha', 'brno', 'ostrava', 'plzen|pilsen', 'olomouc', 'liberec'],
  slovakia: ['bratislava', 'kosice'],
  hungary: ['budapest', 'debrecen', 'szeged', 'miskolc', 'pecs'],
  romania: [
    'bucharest|bucuresti', 'cluj napoca|cluj', 'timisoara', 'iasi', 'constanta', 'brasov', 'craiova', 'sibiu', 'oradea',
  ],
  bulgaria: ['sofia', 'plovdiv', 'varna', 'burgas'],
  serbia: ['belgrade|beograd', 'novi sad'],
  croatia: ['zagreb', 'rijeka', 'osijek', 'dubrovnik'],
  slovenia: ['ljubljana', 'maribor'],
  'bosnia and herzegovina': ['sarajevo', 'banja luka', 'mostar'],
  montenegro: ['podgorica'],
  'north macedonia': ['skopje'],
  albania: ['tirana'],
  kosovo: ['pristina|prishtina'],
  moldova: ['chisinau'],
  estonia: ['tallinn', 'tartu'],
  latvia: ['riga', 'daugavpils'],
  lithuania: ['vilnius', 'kaunas', 'klaipeda'],
  ukraine: ['kyiv|kiev', 'kharkiv|kharkov', 'odesa|odessa', 'dnipro', 'lviv|lvov', 'zaporizhzhia'],
  belarus: ['minsk'],
  russia: ['moscow|moskva', 'saint petersburg|st petersburg', 'novosibirsk', 'yekaterinburg', 'kazan'],
  turkey: ['istanbul', 'ankara', 'izmir', 'bursa', 'antalya'],
  // ── The Middle East and Africa ─────────────────────────────────────────────
  'saudi arabia': ['riyadh', 'jeddah|jidda', 'dammam', 'mecca', 'khobar'],
  'united arab emirates': ['sharjah', 'ajman', 'fujairah', 'ras al khaimah'],
  qatar: ['doha'],
  bahrain: ['manama'],
  oman: ['muscat'],
  kuwait: ['kuwait city'],
  egypt: ['cairo', 'alexandria', 'giza'],
  israel: ['tel aviv', 'jerusalem', 'haifa', 'beersheba'],
  jordan: ['amman'],
  lebanon: ['beirut'],
  iran: ['tehran', 'isfahan', 'shiraz'],
  iraq: ['baghdad', 'erbil', 'basra'],
  palestine: ['ramallah'],
  syria: ['damascus', 'aleppo'],
  morocco: ['casablanca', 'rabat', 'marrakech', 'tangier'],
  tunisia: ['tunis'],
  algeria: ['algiers'],
  nigeria: ['lagos', 'abuja', 'ibadan', 'kano', 'port harcourt'],
  ghana: ['accra', 'kumasi'],
  kenya: ['nairobi', 'mombasa', 'kisumu'],
  ethiopia: ['addis ababa'],
  rwanda: ['kigali'],
  uganda: ['kampala'],
  tanzania: ['dar es salaam', 'dodoma', 'zanzibar', 'arusha'],
  senegal: ['dakar'],
  "cote d'ivoire": ['abidjan'],
  'dr congo': ['kinshasa'],
  'south africa': ['johannesburg', 'cape town', 'durban', 'pretoria', 'stellenbosch', 'port elizabeth'],
  zambia: ['lusaka'],
  zimbabwe: ['harare'],
  mozambique: ['maputo'],
  angola: ['luanda'],
  namibia: ['windhoek'],
  botswana: ['gaborone'],
  cameroon: ['douala', 'yaounde'],
  sudan: ['khartoum'],
  somalia: ['mogadishu'],
  // ── Asia and Oceania ───────────────────────────────────────────────────────
  india: [
    'mumbai', 'delhi', 'new delhi', 'bangalore|bengaluru', 'hyderabad', 'chennai', 'pune', 'kolkata', 'ahmedabad',
    'jaipur', 'gurgaon|gurugram', 'noida', 'kochi', 'lucknow', 'chandigarh', 'indore', 'surat', 'nagpur', 'bhopal',
    'coimbatore', 'thiruvananthapuram',
  ],
  pakistan: [
    'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'peshawar', 'quetta', 'sialkot',
    'gujranwala', 'bahawalpur', 'sargodha', 'abbottabad', 'gujrat', 'sukkur', 'larkana',
  ],
  bangladesh: ['dhaka', 'chittagong'],
  'sri lanka': ['colombo', 'kandy'],
  nepal: ['kathmandu', 'pokhara'],
  china: [
    'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou', 'chengdu', 'nanjing', 'wuhan', 'tianjin', 'chongqing',
    'suzhou', 'xian', 'qingdao', 'xiamen',
  ],
  japan: ['tokyo', 'osaka', 'kyoto', 'yokohama', 'nagoya', 'sapporo', 'fukuoka', 'kobe'],
  'south korea': ['seoul', 'busan', 'incheon', 'daegu'],
  taiwan: ['taipei', 'kaohsiung', 'taichung'],
  thailand: ['bangkok', 'chiang mai', 'phuket', 'pattaya'],
  vietnam: ['hanoi', 'ho chi minh city|ho chi minh|saigon', 'da nang', 'haiphong'],
  cambodia: ['phnom penh', 'siem reap'],
  malaysia: ['kuala lumpur', 'penang', 'johor bahru'],
  indonesia: ['jakarta', 'bandung', 'surabaya', 'bali|denpasar', 'yogyakarta', 'medan'],
  philippines: ['manila', 'cebu', 'quezon city', 'makati', 'davao'],
  kazakhstan: ['almaty', 'astana|nur sultan'],
  uzbekistan: ['tashkent'],
  armenia: ['yerevan'],
  azerbaijan: ['baku'],
  mongolia: ['ulaanbaatar'],
  australia: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'gold coast', 'hobart', 'darwin'],
  'new zealand': ['auckland', 'wellington', 'christchurch'],
  // ── North America ──────────────────────────────────────────────────────────
  'united states': [
    'san francisco|bay area', 'los angeles', 'chicago', 'boston', 'seattle', 'austin', 'denver', 'atlanta', 'miami',
    'houston', 'dallas', 'san diego', 'san jose', 'portland', 'philadelphia', 'washington dc|washington d c|district of columbia',
    'detroit', 'omaha', 'jersey city', 'brooklyn', 'manhattan', 'las vegas', 'phoenix', 'san antonio', 'minneapolis',
    'st louis|saint louis', 'pittsburgh', 'cleveland', 'columbus', 'cincinnati', 'indianapolis', 'nashville',
    'charlotte', 'raleigh', 'orlando', 'tampa', 'salt lake city', 'kansas city', 'new orleans', 'baltimore',
    'boulder', 'palo alto', 'mountain view', 'menlo park', 'cupertino', 'sunnyvale', 'santa clara', 'oakland',
    'sacramento', 'honolulu', 'milwaukee', 'san mateo', 'redwood city', 'santa monica', 'irvine', 'providence',
    'hartford', 'albany', 'buffalo', 'louisville', 'memphis', 'oklahoma city', 'tulsa', 'albuquerque', 'tucson',
    'el paso', 'fort worth', 'jacksonville', 'des moines', 'boise', 'anchorage', 'ann arbor', 'chapel hill',
    'princeton', 'new haven', 'stamford', 'newark', 'scottsdale', 'plano', 'bellevue', 'redmond', 'silicon valley',
  ],
  canada: [
    'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton', 'winnipeg', 'halifax', 'kitchener',
    'mississauga', 'brampton', 'saskatoon', 'regina', 'markham',
  ],
  mexico: ['mexico city', 'guadalajara', 'monterrey', 'tijuana', 'puebla', 'queretaro', 'cancun'],
  // ── Latin America and the Caribbean ────────────────────────────────────────
  brazil: [
    'sao paulo', 'rio|rio de janeiro', 'brasilia', 'salvador', 'belo horizonte', 'curitiba', 'porto alegre', 'recife',
    'fortaleza', 'florianopolis', 'campinas',
  ],
  argentina: ['buenos aires', 'rosario', 'mendoza', 'la plata'],
  chile: ['santiago', 'valparaiso'],
  colombia: ['bogota', 'medellin', 'barranquilla', 'cartagena'],
  peru: ['lima', 'arequipa', 'cusco'],
  ecuador: ['quito', 'guayaquil'],
  venezuela: ['caracas', 'maracaibo'],
  uruguay: ['montevideo'],
  bolivia: ['la paz', 'cochabamba'],
  paraguay: ['asuncion'],
  panama: ['panama city'],
  'costa rica': ['heredia', 'alajuela'],
  guatemala: ['guatemala city'],
  'el salvador': ['san salvador'],
  honduras: ['tegucigalpa'],
  nicaragua: ['managua'],
  cuba: ['havana'],
  'dominican republic': ['santo domingo'],
  'trinidad and tobago': ['port of spain'],
  barbados: ['bridgetown'],
};

const US_STATES: readonly string[] = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york|nyc', 'north carolina', 'north dakota', 'ohio', 'oklahoma',
  'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
];

// "Prince Edward Island" is captured as its first two words, so that is what a want calls it.
const CANADIAN_PROVINCES: readonly string[] = [
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick',
  'newfoundland|newfoundland and labrador', 'prince edward|prince edward island', 'yukon', 'nunavut',
  'northwest territories',
];

/** Places a want can name that do not say where a person is: another country has the name too. */
const SHARED_NAMES: readonly Place[] = [
  { canon: 'cambridge', names: ['cambridge'], country: null, level: 'city' },
  // The US state, and the country: "Atlanta, Georgia" is the US because of Atlanta, "Tbilisi, Georgia" is not.
  { canon: 'georgia', names: ['georgia'], country: null, level: 'state' },
  // The capital of Puerto Rico, and a province of Argentina.
  { canon: 'san juan', names: ['san juan'], country: null, level: 'city' },
];

const place = (entry: string, country: string, level: PlaceLevel): Place => {
  const names = entry.split('|');
  return { canon: names[0], names, country, level };
};

export const PLACES: readonly Place[] = [
  ...Object.entries(CITIES).flatMap(([country, entries]) => entries.map((entry) => place(entry, country, 'city'))),
  ...US_STATES.map((entry) => place(entry, 'united states', 'state')),
  ...CANADIAN_PROVINCES.map((entry) => place(entry, 'canada', 'state')),
  // Its own place in a want, the United Kingdom in a location (and never Ireland).
  place('northern ireland', 'united kingdom', 'state'),
  ...SHARED_NAMES,
];

/**
 * Places that contain others a person may name instead: a want "in Northern Ireland" is satisfied
 * by a location that names the province or any town in it, by the town's canonical name.
 */
export const SUBREGIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['northern ireland', NORTHERN_IRELAND_TOWNS.map((entry) => entry.split('|')[0])],
]);

/** The canonical names of every place above: what a want's place is, once it is read. */
export const KNOWN_PLACES: ReadonlySet<string> = new Set(PLACES.map((p) => p.canon));

/** Every spelling of every place, to the place. */
export const PLACE_BY_NAME: ReadonlyMap<string, Place> = new Map(
  PLACES.flatMap((p) => p.names.map((name) => [name, p] as const)),
);
