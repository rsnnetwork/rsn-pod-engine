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
