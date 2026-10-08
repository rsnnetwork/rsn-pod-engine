// ─── Where members say they are (8 Oct 2026) ─────────────────────────────────
//
// A place in a want is a hard filter, so the person's location has to be read as the member
// wrote it. The launch audience is Düsseldorf and the DACH countries; production holds 38
// locations in these shapes (counted read-only on 8 Oct): a country, a city and an ISO country
// code, a city and a US state code, a city alone, a LinkedIn "Greater Leeds Area", and free text.
// A location resolves to a country through a country name (including the German names
// Deutschland, Österreich, Schweiz) or through a city it names, whole word. A bare two-letter
// code is never a country: "Omaha, NE" is not Niger and "Detroit Metro, MI" is nothing foreign.

import {
  locationCountries, extractConstraints, checkConstraints,
} from '../../../services/matching/want-constraints';

const countriesOf = (location: string) => [...locationCountries(location)].sort();
/** Does a person at this location satisfy the place this want names? */
const satisfies = (want: string, location: string | null) =>
  checkConstraints(extractConstraints([want]), { location }).locationOk;

describe('the shapes production members write', () => {
  it.each([
    // a country only
    ['United Kingdom', ['united kingdom']], ['Pakistan', ['pakistan']], ['Austria', ['austria']],
    ['Cyprus', ['cyprus']], ['Israel', ['israel']], ['Nepal', ['nepal']], ['Portugal', ['portugal']],
    ['United States', ['united states']],
    // a city and an ISO country code: the code is not read, the city says the country
    ['Bangkok, TH', ['thailand']], ['Barcelona, ES', ['spain']], ['Copenhagen, DK', ['denmark']],
    ['Mexico City, MX', ['mexico']], ['New York, US', ['united states']],
    // a city and a US state code, or a state
    ['Detroit Metro, MI', ['united states']], ['Omaha, NE', ['united states']], ['New Jersey, USA', ['united states']],
    // a city alone, LinkedIn style
    ['Jersey City', ['united states']], ['Utrecht', ['netherlands']], ['Greater Leeds Area', ['united kingdom']],
    // free text
    ['Malmö, Sweden (based on RocketReach data)', ['sweden']], ['Spain/US', ['spain', 'united states']],
    ['London, England, United Kingdom', ['united kingdom']], ['Northwich, Cheshire, UK', ['united kingdom']],
    ['Islamabad, PAK', ['pakistan']],
    // the country the person is in now, not the city they came from
    ['Colombia (currently); originally Denver, Colorado', ['colombia']],
  ])('"%s" is in %j', (location, expected) => {
    expect(countriesOf(location)).toEqual(expected);
  });

  it('reads the launch audience: Düsseldorf and the DACH countries, in the words they write', () => {
    expect(countriesOf('Düsseldorf')).toEqual(['germany']);
    expect(countriesOf('Duesseldorf')).toEqual(['germany']);
    expect(countriesOf('Greater Düsseldorf Area')).toEqual(['germany']);
    expect(countriesOf('Köln, Deutschland')).toEqual(['germany']);
    expect(countriesOf('München')).toEqual(['germany']);
    expect(countriesOf('Wien, Österreich')).toEqual(['austria']);
    expect(countriesOf('Graz')).toEqual(['austria']);
    expect(countriesOf('Zürich, Schweiz')).toEqual(['switzerland']);
    expect(countriesOf('Genf')).toEqual(['switzerland']);
    expect(countriesOf('Basel')).toEqual(['switzerland']);
    expect(countriesOf('Bern')).toEqual(['switzerland']);
  });

  it('an empty location resolves to nothing', () => {
    expect(countriesOf('')).toEqual([]);
    expect(locationCountries(null)).toEqual([]);
    expect(locationCountries(undefined)).toEqual([]);
    expect(countriesOf('   ')).toEqual([]);
  });
});

describe('a two-letter code is never a country', () => {
  it('"Omaha, NE" is not Niger, and "Detroit Metro, MI" is nothing foreign', () => {
    expect(countriesOf('Omaha, NE')).not.toContain('niger');
    expect(countriesOf('Detroit Metro, MI')).toEqual(['united states']);
    expect(satisfies('investors in Africa', 'Omaha, NE')).toBe(false);
    expect(satisfies('investors in North America', 'Omaha, NE')).toBe(true);
  });

  it('a code with no city beside it says nothing', () => {
    for (const code of ['NE', 'TH', 'ES', 'DK', 'MX', 'DE', 'IN', 'MI', 'CA', 'PA', 'ID', 'LA']) {
      expect([code, countriesOf(`Somewhere, ${code}`)]).toEqual([code, []]);
    }
  });

  it('a city beside a code is the city\'s country, whatever the code collides with', () => {
    expect(countriesOf('Barcelona, ES')).toEqual(['spain']);
    expect(countriesOf('Bangkok, TH')).toEqual(['thailand']);
    expect(countriesOf('Copenhagen, DK')).toEqual(['denmark']);
  });
});

// A US state or Canadian province code last in a location ("Vienna, VA") says that a city of another country
// named beside it is a namesake: Vienna, Virginia is not Austria. The code is read only then, and only
// when it is not that country's own ("Berlin, DE", "Toronto, CA", "Perth, WA" keep their city), and a code
// with no city beside it still says nothing.
describe('a US or Canadian town named after a foreign city', () => {
  it.each([
    ['Vienna, VA', 'united states'], ['Naples, FL', 'united states'], ['St. Petersburg, FL', 'united states'],
    ['Dublin, CA', 'united states'], ['Dublin, OH', 'united states'], ['Alexandria, VA', 'united states'],
    ['Athens, GA', 'united states'], ['Birmingham, AL', 'united states'], ['Manchester, NH', 'united states'],
    ['Oxford, MS', 'united states'], ['Paris, TX', 'united states'], ['Bergen County, NJ', 'united states'],
    ['Cairo, IL', 'united states'], ['Vancouver, WA', 'united states'], ['Berlin, NH', 'united states'],
    ['London, ON', 'canada'], ['Perth, ON', 'canada'], ['Manchester, NB', 'canada'], ['Dublin, ON', 'canada'],
    ['Cambridge, MA', 'united states'], ['Cambridge, ON', 'canada'], ['Dublin, Ohio', 'united states'],
  ])('%s is in %s', (location, country) => {
    expect(countriesOf(location)).toEqual([country]);
  });

  it('reads the code in any case, and with a full stop', () => {
    expect(countriesOf('dublin, ca')).toEqual(['united states']);
    expect(countriesOf('Vienna, Va.')).toEqual(['united states']);
    expect(countriesOf('Vienna ,VA')).toEqual(['united states']);
  });

  it('keeps the city when the code is that country\'s own, or the city is the code\'s', () => {
    for (const [location, country] of [
      ['Berlin, DE', 'germany'], ['Toronto, CA', 'canada'], ['Barcelona, ES', 'spain'], ['Bangkok, TH', 'thailand'],
      ['Mumbai, IN', 'india'], ['Tel Aviv, IL', 'israel'], ['Amsterdam, NL', 'netherlands'], ['Lima, PE', 'peru'],
      ['Casablanca, MA', 'morocco'], ['Valletta, MT', 'malta'], ['Tunis, TN', 'tunisia'], ['Medellin, CO', 'colombia'],
      ['Buenos Aires, AR', 'argentina'], ['Bandung, ID', 'indonesia'], ['Panama City, PA', 'panama'],
      ['Podgorica, ME', 'montenegro'], ['Chisinau, MD', 'moldova'], ['Khartoum, SD', 'sudan'], ['Bratislava, SK', 'slovakia'],
      ['Vancouver, BC', 'canada'], ['Portland, OR', 'united states'], ['Austin, TX', 'united states'],
      ['Atlanta, GA', 'united states'], ['San Jose, CA', 'united states'], ['Halifax, NS', 'canada'],
    ]) expect([location, countriesOf(location)]).toEqual([location, [country]]);
  });

  it('keeps the city when the code is one a country writes for its own regions', () => {
    for (const [location, country] of [
      ['Perth, WA', 'australia'], ['Darwin, NT', 'australia'], ['Chennai, TN', 'india'], ['Coimbatore, TN', 'india'],
      ['Monterrey, NL', 'mexico'], ['Tijuana, BC', 'mexico'], ['Recife, PE', 'brazil'], ['Florianopolis, SC', 'brazil'],
      ['Milano, MI', 'italy'], ['Catania, CT', 'italy'], ['Palermo, PA', 'italy'], ['Modena, MO', 'italy'],
      ['Trento, TN', 'italy'], ['Messina, ME', 'italy'], ['Cagliari, CA', 'italy'],
    ]) expect([location, countriesOf(location)]).toEqual([location, [country]]);
  });

  // S4-b fix round 1: the Swiss cantons, the Dutch and Spanish provinces and the Pakistani and Nigerian states
  // write their own codes after a city too, and eleven of them are also a US state's or a Canadian province's.
  it('keeps the city when the code is a Swiss canton\'s, a Dutch or Spanish province\'s, or another country\'s own', () => {
    for (const [location, country] of [
      ['Neuchâtel, NE', 'switzerland'], ['Amsterdam, NH', 'netherlands'], ['Utrecht, UT', 'netherlands'],
      ['Almere, FL', 'netherlands'], ['Eindhoven, NB', 'netherlands'], ['Malaga, MA', 'spain'], ['Málaga, MA', 'spain'],
      ['Valladolid, VA', 'spain'], ['Barcelona, CT', 'spain'], ['Madrid, MD', 'spain'], ['Karachi, SD', 'pakistan'],
      ['Lagos, LA', 'nigeria'],
    ]) expect([location, countriesOf(location)]).toEqual([location, [country]]);
  });

  it('puts those people in their own region, not in North America', () => {
    expect(satisfies('investors in DACH', 'Neuchâtel, NE')).toBe(true);
    expect(satisfies('investors in Europe', 'Neuchâtel, NE')).toBe(true);
    expect(satisfies('investors in the EU', 'Utrecht, UT')).toBe(true);
    expect(satisfies('investors in Europe', 'Amsterdam, NH')).toBe(true);
    expect(satisfies('investors in Europe', 'Barcelona, CT')).toBe(true);
    expect(satisfies('investors in Asia', 'Karachi, SD')).toBe(true);
    expect(satisfies('investors in Africa', 'Lagos, LA')).toBe(true);
    for (const location of ['Neuchâtel, NE', 'Utrecht, UT', 'Eindhoven, NB', 'Madrid, MD', 'Karachi, SD']) {
      expect([location, satisfies('investors in North America', location)]).toEqual([location, false]);
    }
  });

  it('still reads the code as the US state or Canadian province when the town really is one', () => {
    expect(countriesOf('Valencia, CA')).toEqual(['united states']); // California: Spain\'s codes do not include CA
    expect(countriesOf('Amsterdam, NY')).toEqual(['united states']);
    expect(countriesOf('Madrid, NM')).toEqual(['united states']);
    expect(countriesOf('Lagos, TX')).toEqual(['united states']);
  });

  it('reads a state or province spelled out, or a country written out, as before', () => {
    expect(countriesOf('Newcastle, New South Wales')).toEqual(['australia']);
    expect(countriesOf('Newcastle, NSW')).toEqual(['australia']);
    expect(countriesOf('Sydney, New South Wales')).toEqual(['australia']);
    expect(countriesOf('Vienna, Virginia')).toEqual(['united states']);
    expect(countriesOf('Vienna, VA, USA')).toEqual(['united states']);
    expect(countriesOf('Vienna, Austria')).toEqual(['austria']);
    expect(countriesOf('Cambridge, UK')).toEqual(['united kingdom']);
  });

  it('puts the person in the state the code names, so a want for the state takes them', () => {
    expect(satisfies('founders in Virginia', 'Vienna, VA')).toBe(true);
    expect(satisfies('founders in Georgia', 'Athens, GA')).toBe(true);
    expect(satisfies('founders in California', 'Dublin, CA')).toBe(true);
    expect(satisfies('founders in Ontario', 'London, ON')).toBe(true);
    expect(satisfies('founders in Massachusetts', 'Cambridge, MA')).toBe(true);
    expect(satisfies('founders in Austria', 'Vienna, VA')).toBe(false);
  });

  it('puts them in North America and not in the country they are named after', () => {
    expect(satisfies('investors in North America', 'Dublin, CA')).toBe(true);
    expect(satisfies('investors in Europe', 'Dublin, CA')).toBe(false);
    expect(satisfies('investors in Europe', 'Vienna, VA')).toBe(false);
    expect(satisfies('investors in the EU', 'Naples, FL')).toBe(false);
    expect(satisfies('investors in Europe', 'Athens, GA')).toBe(false);
    expect(satisfies('investors in the UK', 'Birmingham, AL')).toBe(false);
    expect(satisfies('investors in the UK', 'Manchester, NH')).toBe(false);
    expect(satisfies('investors in North America', 'London, ON')).toBe(true);
    expect(satisfies('investors in Europe', 'London, ON')).toBe(false);
    // and the foreign city keeps its own
    expect(satisfies('investors in Europe', 'Berlin, DE')).toBe(true);
    expect(satisfies('investors in Asia', 'Perth, WA')).toBe(false);
    expect(satisfies('investors in APAC', 'Perth, WA')).toBe(true);
  });

  it('is read only from the last part after a comma, and says nothing without a city', () => {
    expect(countriesOf('Vienna VA')).toEqual(['austria']); // no comma: not a trailing code
    expect(countriesOf('Vienna, VA, Remote')).toEqual(['austria']);
    for (const code of ['VA', 'FL', 'ON', 'MI', 'TX', 'NE', 'IN', 'CA', 'DE']) {
      expect([code, countriesOf(`Somewhere, ${code}`)]).toEqual([code, []]);
    }
  });
});

// A location can name cities in two countries ("Berlin / San Francisco, CA"). The code last in it belongs to the
// city before it: it settles that city when it is a namesake ("Vienna, VA" is Virginia's), and says nothing when the
// city is already the code's country's. A city of another country named earlier keeps its own country.
describe('a location that names cities in two countries', () => {
  it.each([
    ['Berlin / San Francisco, CA', ['germany', 'united states']],
    ['Zurich & Palo Alto, CA', ['switzerland', 'united states']],
    ['Munich and Boston, MA', ['germany', 'united states']],
    ['Düsseldorf / Austin, TX', ['germany', 'united states']],
    ['London and Boston, MA', ['united kingdom', 'united states']],
    ['Toronto / Berlin', ['canada', 'germany']],
  ])('"%s" is in %j', (location, expected) => {
    expect(countriesOf(location)).toEqual(expected);
  });

  it('a namesake is still the US town when no city in the location is the code\'s country', () => {
    expect(countriesOf('Vienna, VA')).toEqual(['united states']);
    expect(countriesOf('Paris, TX')).toEqual(['united states']);
    expect(countriesOf('Dublin, CA')).toEqual(['united states']);
  });

  it('puts the person in the places of both countries, and in neither of the others', () => {
    expect(satisfies('investors in Europe', 'Berlin / San Francisco, CA')).toBe(true);
    expect(satisfies('investors in DACH', 'Zurich & Palo Alto, CA')).toBe(true);
    expect(satisfies('investors in the EU', 'Munich and Boston, MA')).toBe(true);
    expect(satisfies('investors in North America', 'Berlin / San Francisco, CA')).toBe(true);
    expect(satisfies('investors in the Bay Area', 'Berlin / San Francisco, CA')).toBe(true);
    expect(satisfies('investors in Germany', 'Berlin / San Francisco, CA')).toBe(true);
    expect(satisfies('investors in the US', 'Munich and Boston, MA')).toBe(true);
    expect(satisfies('investors in Asia', 'Berlin / San Francisco, CA')).toBe(false);
    expect(satisfies('investors in Austria', 'Munich and Boston, MA')).toBe(false);
  });
});

describe('a county or an Australian state written after a city', () => {
  it('decides the country over a city of the same name elsewhere', () => {
    expect(countriesOf('Halifax, West Yorkshire')).toEqual(['united kingdom']);
    expect(countriesOf('Leeds, Yorkshire')).toEqual(['united kingdom']);
    expect(countriesOf('Manchester, Greater Manchester')).toEqual(['united kingdom']);
    expect(countriesOf('Oxford, Oxfordshire')).toEqual(['united kingdom']);
    expect(countriesOf('Newcastle, Tyne and Wear')).toEqual(['united kingdom']);
    expect(countriesOf('Birmingham, West Midlands')).toEqual(['united kingdom']);
    expect(countriesOf('Perth, Western Australia')).toEqual(['australia']);
    expect(countriesOf('Halifax')).toEqual(['canada']);
    expect(countriesOf('Halifax, Nova Scotia')).toEqual(['canada']);
  });

  it('is not a place a want can name', () => {
    for (const want of ['founders in West Yorkshire', 'founders in Oxfordshire', 'founders in New South Wales', 'founders in Greater Manchester']) {
      expect([want, extractConstraints([want]).location]).toEqual([want, null]);
    }
  });
});

describe('Jersey City and New Jersey are the United States, never the island', () => {
  it('resolves them to the US and nothing else', () => {
    expect(countriesOf('Jersey City')).toEqual(['united states']);
    expect(countriesOf('Jersey City, NJ')).toEqual(['united states']);
    expect(countriesOf('New Jersey')).toEqual(['united states']);
    expect(countriesOf('New Jersey, USA')).toEqual(['united states']);
    expect(satisfies('investors in Europe', 'Jersey City')).toBe(false);
    expect(satisfies('investors in North America', 'Jersey City')).toBe(true);
  });

  it('does not read the island as a country: it is no place a want can name', () => {
    expect(countriesOf('Jersey')).toEqual([]);
    expect(extractConstraints(['founders in Jersey']).location).toBeNull();
  });
});

describe('the launch audience satisfies the regions it is in', () => {
  it.each(['Düsseldorf', 'Greater Düsseldorf Area', 'Wien, Österreich', 'Zürich, Schweiz'])(
    '%s is in Europe, the EU and DACH', (location) => {
      expect(satisfies('investors in Europe', location)).toBe(true);
      expect(satisfies('investors in the EU', location)).toBe(true);
      expect(satisfies('investors in DACH', location)).toBe(true);
      expect(satisfies('investors in the Nordics', location)).toBe(false);
      expect(satisfies('investors in North America', location)).toBe(false);
    },
  );

  it('Barcelona, ES is in Europe and the EU, not DACH', () => {
    expect(satisfies('investors in Europe', 'Barcelona, ES')).toBe(true);
    expect(satisfies('investors in the EU', 'Barcelona, ES')).toBe(true);
    expect(satisfies('investors in DACH', 'Barcelona, ES')).toBe(false);
  });

  it('places outside Europe stay outside', () => {
    expect(satisfies('investors in Europe', 'Bangkok, TH')).toBe(false);
    expect(satisfies('investors in Asia', 'Bangkok, TH')).toBe(true);
    expect(satisfies('investors in Southeast Asia', 'Bangkok, TH')).toBe(true);
    expect(satisfies('investors in Europe', 'Islamabad, PAK')).toBe(false);
    expect(satisfies('investors in Asia', 'Islamabad, PAK')).toBe(true);
    expect(satisfies('investors in Latin America', 'Mexico City, MX')).toBe(true);
    expect(satisfies('investors in North America', 'Detroit Metro, MI')).toBe(true);
    expect(satisfies('investors in Europe', 'Detroit Metro, MI')).toBe(false);
  });

  it('an empty location keeps failing a place want (unchanged: no place is no match)', () => {
    expect(satisfies('investors in Europe', '')).toBe(false);
    expect(satisfies('investors in Germany', null)).toBe(false);
    expect(satisfies('investors in Berlin', '')).toBe(false);
  });
});

describe('a city or state decides the country only when nothing says it outright', () => {
  it('an explicit country wins over a city of the same name elsewhere', () => {
    expect(countriesOf('Paris, France')).toEqual(['france']);
    expect(countriesOf('Dublin, Ohio, USA')).toEqual(['united states']);
    expect(countriesOf('Rome, US')).toEqual(['united states']);
    expect(countriesOf('Valencia, Venezuela')).toEqual(['venezuela']);
  });

  it('a state or province wins over a city of the same name elsewhere', () => {
    expect(countriesOf('Paris, Texas')).toEqual(['united states']);
    expect(countriesOf('London, Ontario')).toEqual(['canada']);
    expect(countriesOf('Birmingham, Alabama')).toEqual(['united states']);
    expect(satisfies('investors in Europe', 'Paris, Texas')).toBe(false);
    expect(satisfies('investors in Europe', 'London, Ontario')).toBe(false);
  });

  it('a name that is several countries\' is no country on its own', () => {
    expect(countriesOf('Cambridge')).toEqual([]);
    expect(countriesOf('Cambridge, UK')).toEqual(['united kingdom']);
    expect(countriesOf('Cambridge, Massachusetts')).toEqual(['united states']);
    expect(countriesOf('Tbilisi, Georgia')).toEqual([]);
    expect(countriesOf('Georgia')).toEqual([]);
    expect(countriesOf('Atlanta, Georgia')).toEqual(['united states']);
  });

  it('a city that contains a country\'s name is its own place', () => {
    expect(countriesOf('Port of Spain, Trinidad & Tobago')).toEqual(['trinidad and tobago']);
    expect(countriesOf('Kuwait City')).toEqual(['kuwait']);
    expect(countriesOf('Guatemala City')).toEqual(['guatemala']);
    expect(countriesOf('Panama City, Florida')).toEqual(['united states']);
    expect(countriesOf('Panama City')).toEqual(['panama']);
    expect(countriesOf('San Salvador')).toEqual(['el salvador']);
    expect(countriesOf('Salvador, Bahia')).toEqual(['brazil']);
  });
});

describe('the names a country is written with at home', () => {
  it.each([
    ['Deutschland', 'germany'], ['Österreich', 'austria'], ['Schweiz', 'switzerland'], ['Suisse', 'switzerland'],
    ['Svizzera', 'switzerland'], ['España', 'spain'], ['Italia', 'italy'], ['Nederland', 'netherlands'],
    ['België', 'belgium'], ['Belgique', 'belgium'], ['Polska', 'poland'], ['Sverige', 'sweden'], ['Norge', 'norway'],
    ['Danmark', 'denmark'], ['Suomi', 'finland'], ['Brasil', 'brazil'], ['Éire', 'ireland'], ['Luxemburg', 'luxembourg'],
    // the way a German speaker writes the neighbours
    ['Spanien', 'spain'], ['Italien', 'italy'], ['Frankreich', 'france'], ['Niederlande', 'netherlands'],
    ['Polen', 'poland'], ['Tschechien', 'czechia'], ['Schweden', 'sweden'], ['Norwegen', 'norway'],
    ['Dänemark', 'denmark'], ['Finnland', 'finland'], ['Griechenland', 'greece'], ['Ungarn', 'hungary'],
    ['Türkei', 'turkey'], ['Vereinigtes Königreich', 'united kingdom'], ['Großbritannien', 'united kingdom'],
  ])('%s is %s', (written, country) => {
    expect(countriesOf(`Somewhere, ${written}`)).toEqual([country]);
    expect(countriesOf(written)).toEqual([country]);
  });
});

describe('a city is the same city however it is written', () => {
  it.each([
    ['investors in Cologne', 'Köln, Deutschland'], ['investors in Köln', 'Cologne'], ['investors in Koeln', 'Köln'],
    ['investors in Munich', 'München'], ['investors in München', 'Munich, Germany'], ['investors in Muenchen', 'Munich'],
    ['investors in Vienna', 'Wien, Österreich'], ['investors in Wien', 'Vienna, Austria'],
    ['investors in Zurich', 'Zürich, Schweiz'], ['investors in Zürich', 'Zurich'],
    ['investors in Geneva', 'Genf'], ['investors in Düsseldorf', 'Greater Düsseldorf Area'],
    ['investors in Dusseldorf', 'Düsseldorf'], ['investors in Nuremberg', 'Nürnberg'],
    ['investors in Düsseldorf', 'Duesseldorf, Germany'], ['investors in Malmö', 'Malmo, Sweden'],
  ])('"%s" takes %s', (want, location) => {
    expect(satisfies(want, location)).toBe(true);
  });

  it('and not another city of the same country', () => {
    expect(satisfies('investors in Düsseldorf', 'Köln, Deutschland')).toBe(false);
    expect(satisfies('investors in Cologne', 'Berlin, Germany')).toBe(false);
    expect(satisfies('investors in Vienna', 'Graz, Austria')).toBe(false);
    expect(satisfies('investors in Zürich', 'Basel, Schweiz')).toBe(false);
  });

  it('a want in the words of the launch audience is a place, not a missing one', () => {
    expect(extractConstraints(['investors in Düsseldorf']).location).toEqual(['dusseldorf']);
    expect(extractConstraints(['founders in Zürich']).location).toEqual(['zurich']);
    expect(extractConstraints(['founders in München']).location).toEqual(['munich']);
    expect(extractConstraints(['founders in Köln']).location).toEqual(['cologne']);
    expect(extractConstraints(['Gründer in Österreich']).location).toEqual(['austria']);
    expect(extractConstraints(['partners in The Hague']).location).toEqual(['the hague']);
    expect(extractConstraints(['partners in Den Haag']).location).toEqual(['the hague']);
  });
});

// A want pasted from a Mac, a PDF or a word processor often carries "ü" as "u" plus a combining
// diaeresis (NFD). The letters are the same to a reader, so the place must be the same to the matcher.
describe('a want typed with combining accents (NFD) reads like one typed with whole letters', () => {
  it.each([
    ['investors in Zürich', ['zurich']], ['founders in München', ['munich']], ['Gründer in Österreich', ['austria']],
    ['investors in Düsseldorf', ['dusseldorf']], ['partners in Köln', ['cologne']], ['angels in Malmö', ['malmo']],
    ['founders in Türkiye', ['turkey']], ['founders based in Bogotá', ['bogota']], ['buyers from São Paulo', ['sao paulo']],
    ['Investoren in der Nähe von Wien', null],
  ])('%s', (want, expected) => {
    const decomposed = want.normalize('NFD');
    // The test is only meaningful if the string really is decomposed.
    if (/[^\u0000-\u007f]/.test(want)) expect(decomposed).not.toBe(want.normalize('NFC'));
    expect(extractConstraints([decomposed]).location).toEqual(extractConstraints([want.normalize('NFC')]).location);
    if (expected) expect(extractConstraints([decomposed]).location).toEqual(expected);
  });

  it('and a decomposed location was already read the same way', () => {
    expect(countriesOf('Zürich, Schweiz')).toEqual(['switzerland']);
    expect(countriesOf('Düsseldorf')).toEqual(['germany']);
    expect(satisfies('investors in Düsseldorf', 'Düsseldorf')).toBe(true);
  });
});

describe('cities the matcher did not know before', () => {
  it.each([
    ['Bangkok', 'thailand'], ['Utrecht', 'netherlands'], ['Leeds', 'united kingdom'], ['Islamabad', 'pakistan'],
    ['Detroit', 'united states'], ['Omaha', 'united states'], ['Denver', 'united states'], ['St. Louis', 'united states'],
    ['Silicon Valley', 'united states'], ['NYC', 'united states'],
    ['Bonn', 'germany'], ['Essen', 'germany'], ['Dortmund', 'germany'], ['Duisburg', 'germany'], ['Frankfurt', 'germany'],
    ['Hamburg', 'germany'], ['Stuttgart', 'germany'], ['Berlin', 'germany'], ['Leipzig', 'germany'], ['Hannover', 'germany'],
    ['Linz', 'austria'], ['Salzburg', 'austria'], ['Lausanne', 'switzerland'],
    ['Porto', 'portugal'], ['Kraków', 'poland'], ['København', 'denmark'], ['Göteborg', 'sweden'], ['Praha', 'czechia'],
    ['Lisboa', 'portugal'], ['Roma', 'italy'], ['Milano', 'italy'], ['Bucuresti', 'romania'], ['Kyiv', 'ukraine'],
    ['İstanbul', 'turkey'], ['São Paulo', 'brazil'], ['Bogotá', 'colombia'], ['Nairobi', 'kenya'], ['Lagos', 'nigeria'],
    ['Mumbai', 'india'], ['Karachi', 'pakistan'], ['Lahore', 'pakistan'], ['Dubai', 'united arab emirates'],
    ['Tel Aviv', 'israel'], ['Riyadh', 'saudi arabia'], ['Sydney', 'australia'], ['Toronto', 'canada'], ['Tokyo', 'japan'],
  ])('%s is in %s', (city, country) => {
    expect(countriesOf(city)).toEqual([country]);
  });
});
