// ─── Cities, US states and Canadian provinces (8 Oct 2026) ────────────────────
//
// A place in a want is only a place when the matcher can tell it is one ("in Narnia" and "from
// Google" are capitalised words after a preposition too), and a person's location resolves to a
// country through a city it names ("Greater Düsseldorf Area", "Bangkok, TH", "Utrecht"). This table
// is both: every city, state and province here is a place a want can name (in the one or two words
// a want captures after a preposition), and says which country it is in. It is hand-kept data. A
// city that is not here is treated like any other unknown place: a want that names it filters
// nothing, and a location that names only it resolves to no country. Add one by adding it to its
// country below.
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
  /** A person's location can be this place, but a want never names it (see LOCATION_ONLY). */
  locationOnly: boolean;
}

// ── Places a person lives in and a want never names ────────────────────────────
//
// A place in a want is a hard filter, and a capitalised word after "in" or "from" is often not a
// place. The entries below are a place like any other in a person's location (they resolve, and
// they satisfy their country, their state and the Bay Area), but a want never reads them as one,
// so "bankers from Santander" or "engineers from Redmond" filter nothing instead of everyone
// outside that town. THE RULE: a name is listed when, after "in" or "from", it more often means
//   - a UNIVERSITY the town is known by ("from Princeton", "from Oxford", "from Berkeley"), or
//   - a COMPANY or a bank known by the town's name ("from Redmond", "from Cupertino", "from
//     Mountain View", "from Menlo Park", "from Palo Alto Networks", "from Santander"), or
//   - an INDUSTRY or an area with no borders that the name stands for ("from Silicon Valley").
// The launch audience's cities and the big cities of the world are not listed: "founders in Zurich"
// is a place, and listing a real place costs a want that no longer filters by it.
const LOCATION_ONLY: Readonly<Record<string, readonly string[]>> = {
  university: ['princeton', 'cambridge', 'oxford', 'new haven', 'ann arbor', 'chapel hill', 'berkeley', 'santa clara'],
  company: ['santander', 'redmond', 'cupertino', 'mountain view', 'menlo park', 'palo alto'],
  metonym: ['silicon valley'],
};
const LOCATION_ONLY_NAMES: ReadonlySet<string> = new Set(Object.values(LOCATION_ONLY).flat());

// The towns of Northern Ireland. A want "in Northern Ireland" is satisfied by a location that names
// the province or one of them (see SUBREGIONS); in a person's location they are the United Kingdom.
const NORTHERN_IRELAND_TOWNS: readonly string[] = [
  'belfast', 'derry|londonderry', 'lisburn', 'newry', 'armagh', 'omagh', 'enniskillen', 'coleraine', 'ballymena',
  'newtownabbey', 'craigavon', 'carrickfergus', 'portadown', 'larne', 'strabane',
];

// The cities of the United States by the state they are in, and of Canada by province. This is the one
// place that says which city is where: it makes the cities (with their country), and it makes a state in
// a want take the people in its cities ("in Oklahoma" takes Oklahoma City and Tulsa, "in Indiana"
// Indianapolis). Kansas City is listed under Missouri, where the one of that name in the table is, so
// "in Kansas" does not take it. Washington DC is not in a state; "Washington" in a want is the state or DC.
const US_CITIES_BY_STATE: Readonly<Record<string, readonly string[]>> = {
  alaska: ['anchorage'],
  arizona: ['phoenix', 'tucson', 'scottsdale'],
  california: [
    'san francisco', 'los angeles', 'san diego', 'san jose', 'oakland', 'sacramento', 'palo alto', 'mountain view',
    'menlo park', 'cupertino', 'sunnyvale', 'santa clara', 'san mateo', 'redwood city', 'santa monica', 'irvine',
    'berkeley', 'fremont', 'silicon valley',
  ],
  colorado: ['denver', 'boulder'],
  connecticut: ['hartford', 'new haven', 'stamford'],
  florida: ['miami', 'orlando', 'tampa', 'jacksonville'],
  georgia: ['atlanta'],
  hawaii: ['honolulu'],
  idaho: ['boise'],
  illinois: ['chicago'],
  indiana: ['indianapolis'],
  iowa: ['des moines'],
  kentucky: ['louisville'],
  louisiana: ['new orleans'],
  maryland: ['baltimore'],
  massachusetts: ['boston'],
  michigan: ['detroit', 'ann arbor'],
  minnesota: ['minneapolis'],
  missouri: ['st louis|saint louis', 'kansas city'],
  nebraska: ['omaha'],
  nevada: ['las vegas'],
  'new jersey': ['jersey city', 'newark', 'princeton'],
  'new mexico': ['albuquerque'],
  'new york': ['brooklyn', 'manhattan', 'albany', 'buffalo'],
  'north carolina': ['charlotte', 'raleigh', 'chapel hill'],
  ohio: ['columbus', 'cleveland', 'cincinnati'],
  oklahoma: ['oklahoma city', 'tulsa'],
  oregon: ['portland'],
  pennsylvania: ['philadelphia', 'pittsburgh'],
  'rhode island': ['providence'],
  tennessee: ['nashville', 'memphis'],
  texas: ['austin', 'houston', 'dallas', 'san antonio', 'el paso', 'fort worth', 'plano'],
  utah: ['salt lake city'],
  washington: ['seattle', 'bellevue', 'redmond'],
  wisconsin: ['milwaukee'],
};

const CANADIAN_CITIES_BY_PROVINCE: Readonly<Record<string, readonly string[]>> = {
  alberta: ['calgary', 'edmonton'],
  'british columbia': ['vancouver'],
  manitoba: ['winnipeg'],
  'nova scotia': ['halifax'],
  ontario: ['toronto', 'ottawa', 'mississauga', 'brampton', 'kitchener', 'markham'],
  quebec: ['montreal'],
  saskatchewan: ['saskatoon', 'regina'],
};

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
  // The cities of the United States and Canada are listed under their state or province just below.
  'united states': [...Object.values(US_CITIES_BY_STATE).flat(), 'washington dc|washington d c|district of columbia'],
  canada: Object.values(CANADIAN_CITIES_BY_PROVINCE).flat(),
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

// ── Regions written after a city ───────────────────────────────────────────────
//
// A county or a state that members write after a city ("Halifax, West Yorkshire", "Newcastle, New
// South Wales"). Like a US state they decide the country over a city of the same name elsewhere
// (Halifax in Canada), but a want never names them: "founders in Kent" would take only the people
// who write Kent, not the ones in Canterbury. Only names that are no other country's town or county
// are listed (not Kent, Essex, Norfolk, Durham or Cheshire, which are towns in the United States too).
const REGIONS_AFTER_A_CITY: Readonly<Record<string, readonly string[]>> = {
  australia: ['new south wales|nsw'],
  'united kingdom': [
    'yorkshire', 'west yorkshire', 'south yorkshire', 'north yorkshire', 'east yorkshire', 'greater manchester',
    'merseyside', 'tyne and wear', 'west midlands', 'lancashire', 'derbyshire', 'nottinghamshire', 'leicestershire',
    'lincolnshire', 'cambridgeshire', 'oxfordshire', 'hertfordshire', 'buckinghamshire', 'bedfordshire',
    'northamptonshire', 'warwickshire', 'worcestershire', 'herefordshire', 'shropshire', 'staffordshire',
    'gloucestershire', 'wiltshire', 'cumbria', 'east sussex', 'west sussex',
  ],
};

// ── Two-letter codes ───────────────────────────────────────────────────────────
//
// A US state's or a Canadian province's code, last in a location after a comma, says that a city of
// another country named beside it is a namesake: "Vienna, VA" is Virginia, not Austria. It is read
// only then (a code with no city beside it says nothing, so "Omaha, NE" is never Niger), and not when
// the code is that country's own: "Berlin, DE" (Germany's ISO code, Delaware's code), "Toronto, CA".

/** A US state's or a Canadian province's code, to the place it names. */
export interface RegionCode { place: string; country: 'united states' | 'canada' }

const US_STATE_CODES: ReadonlyArray<readonly [string, string]> = [
  ['al', 'alabama'], ['ak', 'alaska'], ['az', 'arizona'], ['ar', 'arkansas'], ['ca', 'california'], ['co', 'colorado'],
  ['ct', 'connecticut'], ['de', 'delaware'], ['fl', 'florida'], ['ga', 'georgia'], ['hi', 'hawaii'], ['id', 'idaho'],
  ['il', 'illinois'], ['in', 'indiana'], ['ia', 'iowa'], ['ks', 'kansas'], ['ky', 'kentucky'], ['la', 'louisiana'],
  ['me', 'maine'], ['md', 'maryland'], ['ma', 'massachusetts'], ['mi', 'michigan'], ['mn', 'minnesota'],
  ['ms', 'mississippi'], ['mo', 'missouri'], ['mt', 'montana'], ['ne', 'nebraska'], ['nv', 'nevada'],
  ['nh', 'new hampshire'], ['nj', 'new jersey'], ['nm', 'new mexico'], ['ny', 'new york'], ['nc', 'north carolina'],
  ['nd', 'north dakota'], ['oh', 'ohio'], ['ok', 'oklahoma'], ['or', 'oregon'], ['pa', 'pennsylvania'],
  ['ri', 'rhode island'], ['sc', 'south carolina'], ['sd', 'south dakota'], ['tn', 'tennessee'], ['tx', 'texas'],
  ['ut', 'utah'], ['vt', 'vermont'], ['va', 'virginia'], ['wa', 'washington'], ['wv', 'west virginia'],
  ['wi', 'wisconsin'], ['wy', 'wyoming'], ['dc', 'washington dc'],
];

const CANADIAN_PROVINCE_CODES: ReadonlyArray<readonly [string, string]> = [
  ['ab', 'alberta'], ['bc', 'british columbia'], ['mb', 'manitoba'], ['nb', 'new brunswick'], ['nl', 'newfoundland'],
  ['ns', 'nova scotia'], ['nt', 'northwest territories'], ['nu', 'nunavut'], ['on', 'ontario'], ['pe', 'prince edward'],
  ['qc', 'quebec'], ['sk', 'saskatchewan'], ['yt', 'yukon'],
];

export const REGION_CODES: ReadonlyMap<string, RegionCode> = new Map<string, RegionCode>([
  ...US_STATE_CODES.map(([code, place]): [string, RegionCode] => [code, { place, country: 'united states' }]),
  ...CANADIAN_PROVINCE_CODES.map(([code, place]): [string, RegionCode] => [code, { place, country: 'canada' }]),
]);

/**
 * The codes above that are also a country's ISO 3166 code ("DE" is Delaware and Germany, "NL" Newfoundland
 * and Labrador and the Netherlands). Beside a city of that country the code is the country's.
 */
export const CODES_OF_COUNTRIES: ReadonlyMap<string, string> = new Map([
  ['al', 'albania'], ['ar', 'argentina'], ['az', 'azerbaijan'], ['ca', 'canada'], ['co', 'colombia'], ['de', 'germany'],
  ['ga', 'gabon'], ['id', 'indonesia'], ['il', 'israel'], ['in', 'india'], ['la', 'laos'], ['ma', 'morocco'],
  ['md', 'moldova'], ['me', 'montenegro'], ['mn', 'mongolia'], ['mo', 'macao'], ['mt', 'malta'], ['ne', 'niger'],
  ['nl', 'netherlands'], ['pa', 'panama'], ['pe', 'peru'], ['sc', 'seychelles'], ['sd', 'sudan'], ['sk', 'slovakia'],
  ['tn', 'tunisia'], ['va', 'vatican city'],
]);

/**
 * Codes a country writes for its own regions after a city, that are also a US state's or a Canadian
 * province's: "Perth, WA" is Western Australia, "Monterrey, NL" is Nuevo Leon, "Milano, MI" is the
 * province of Milan. Listed for the countries whose cities the table has and that write their regions
 * this way (Australia, Brazil, India, Italy, Mexico), and only the codes that collide.
 */
export const OWN_REGION_CODES: Readonly<Record<string, readonly string[]>> = {
  australia: ['nt', 'wa'],
  brazil: ['pe', 'sc'],
  india: ['tn'],
  italy: ['ca', 'ct', 'me', 'mi', 'mo', 'pa', 'pe', 'tn'],
  mexico: ['bc', 'nl'],
};

/** Places a want can name that do not say where a person is: another country has the name too. */
const SHARED_NAMES: ReadonlyArray<readonly [string, PlaceLevel]> = [
  ['cambridge', 'city'], // England, Massachusetts and Ontario
  // The US state, and the country: "Atlanta, Georgia" is the US because of Atlanta, "Tbilisi, Georgia" is not.
  ['georgia', 'state'],
  ['san juan', 'city'], // The capital of Puerto Rico, and a province of Argentina.
];

const place = (entry: string, country: string | null, level: PlaceLevel): Place => {
  const names = entry.split('|');
  return { canon: names[0], names, country, level, locationOnly: LOCATION_ONLY_NAMES.has(names[0]) };
};

export const PLACES: readonly Place[] = [
  ...Object.entries(CITIES).flatMap(([country, entries]) => entries.map((entry) => place(entry, country, 'city'))),
  ...US_STATES.map((entry) => place(entry, 'united states', 'state')),
  ...CANADIAN_PROVINCES.map((entry) => place(entry, 'canada', 'state')),
  // Its own place in a want, the United Kingdom in a location (and never Ireland).
  place('northern ireland', 'united kingdom', 'state'),
  // The cities around San Francisco Bay: a place a want names, a region of the cities below (SUBREGIONS).
  place('bay area', 'united states', 'city'),
  ...Object.entries(REGIONS_AFTER_A_CITY)
    .flatMap(([country, entries]) => entries.map((entry) => ({ ...place(entry, country, 'state'), locationOnly: true }))),
  ...SHARED_NAMES.map(([name, level]) => place(name, null, level)),
];

const BAY_AREA_CITIES: readonly string[] = [
  'san francisco', 'oakland', 'san jose', 'palo alto', 'mountain view', 'menlo park', 'cupertino', 'sunnyvale',
  'santa clara', 'redwood city', 'san mateo', 'berkeley', 'fremont', 'silicon valley',
];

const canonicals = (entries: readonly string[]): string[] => entries.map((entry) => entry.split('|')[0]);

/** A place that holds more than the cities listed under it: California holds the Bay Area, "Washington" holds DC. */
const ALSO_HOLDS: Readonly<Record<string, readonly string[]>> = {
  california: ['bay area'],
  washington: ['washington dc'],
};

/**
 * Places that contain others a person may name instead: a want "in Northern Ireland" is satisfied
 * by a location that names the province or any town in it, by the town's canonical name. The same
 * for a state or a province and its cities: "in Oklahoma" takes Oklahoma City.
 */
export const SUBREGIONS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['northern ireland', canonicals(NORTHERN_IRELAND_TOWNS)],
  ['bay area', BAY_AREA_CITIES],
  ...Object.entries({ ...US_CITIES_BY_STATE, ...CANADIAN_CITIES_BY_PROVINCE })
    .map(([place, cities]): [string, readonly string[]] => [place, [...canonicals(cities), ...(ALSO_HOLDS[place] ?? [])]]),
]);

/** The places a want can name, by canonical name. A location-only place is not one of them. */
export const KNOWN_PLACES: ReadonlySet<string> = new Set(PLACES.filter((p) => !p.locationOnly).map((p) => p.canon));

/** Every spelling of every place a want can name, to the place. */
export const PLACE_BY_NAME: ReadonlyMap<string, Place> = new Map(
  PLACES.filter((p) => !p.locationOnly).flatMap((p) => p.names.map((name) => [name, p] as const)),
);
