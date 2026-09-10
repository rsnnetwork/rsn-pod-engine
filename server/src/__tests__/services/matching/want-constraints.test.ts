// ─── Explicit want constraints (Stefan, 9 Sep 2026) ─────────────────────────
//
// "Manufacturer in US with 20 years experience": place + experience are strict.

import {
  locationTerms, parseYears, extractConstraints, checkConstraints, profileYears,
} from '../../../services/matching/want-constraints';

describe('locationTerms', () => {
  it('recognises country aliases as whole words, case-insensitively', () => {
    expect(locationTerms('manufacturer in US with 20 years experience')).toEqual(['united states']);
    expect(locationTerms('founders in the USA')).toEqual(['united states']);
    expect(locationTerms('based in the U.K.')).toEqual(['united kingdom']);
    expect(locationTerms('German engineers')).toEqual(['germany']);
  });
  it('does not treat the pronoun "us" as a country', () => {
    expect(locationTerms('people who can help us grow')).toEqual([]);
  });
  it('keeps a city after a location preposition', () => {
    expect(locationTerms('designers in London')).toEqual(['london']);
    expect(locationTerms('investors based in New York')).toEqual(['new york']);
    // 10 Sep 2026: how the extractor now phrases an inferred want tied to a place.
    expect(extractConstraints(['country manager in Nairobi', 'country manager']).location).toEqual(['nairobi']);
  });
  it('ignores non-places after "in"', () => {
    expect(locationTerms('experts in Manufacturing and Sales')).toEqual([]);
  });
});

describe('parseYears', () => {
  it('reads digits, plus signs and words', () => {
    expect(parseYears('20 years experience')).toBe(20);
    expect(parseYears('20+ yrs in manufacturing')).toBe(20);
    expect(parseYears('at least ten years')).toBe(10);
    expect(parseYears('two decades of leadership')).toBe(20);
    expect(parseYears('a decade in fintech')).toBe(10);
  });
  it('takes the largest figure and ignores nonsense', () => {
    expect(parseYears('5 years here, 12 years there')).toBe(12);
    expect(parseYears('founded in 2015')).toBeNull();
    expect(parseYears(null)).toBeNull();
  });
});

describe('extractConstraints + checkConstraints — Stefan\'s case', () => {
  const c = extractConstraints(['manufacturer in US with 20 years experience']);
  it('extracts the place and the minimum years', () => {
    expect(c).toEqual({ location: ['united states'], minYears: 20 });
  });
  it('a US manufacturer with 25 stated years satisfies both', () => {
    const r = checkConstraints(c, { location: 'Detroit, USA', bio: 'Industrial fabrication, 25 years in the trade' });
    expect(r).toEqual({ locationOk: true, yearsOk: true, yearsUnknown: false });
  });
  it('a German manufacturer is excluded on location, however experienced', () => {
    const r = checkConstraints(c, { location: 'Munich, Germany', bio: '30 years in manufacturing' });
    expect(r.locationOk).toBe(false);
  });
  it('a US manufacturer with 5 stated years is excluded on experience', () => {
    const r = checkConstraints(c, { location: 'Texas, United States', bio: '5 years running a factory' });
    expect(r).toMatchObject({ locationOk: true, yearsOk: false });
  });
  it('a US profile that states no years is unverifiable, not excluded (caller demotes + says so)', () => {
    const r = checkConstraints(c, { location: 'New York, US', bio: 'We run a production line for auto parts.' });
    expect(r).toEqual({ locationOk: true, yearsOk: null, yearsUnknown: true });
  });
  it('an unknown location does NOT satisfy a required place', () => {
    const r = checkConstraints(c, { location: null, bio: '25 years' });
    expect(r.locationOk).toBe(false);
  });
  it('a city requirement matches the profile location text', () => {
    const cc = extractConstraints(['designers in London']);
    expect(checkConstraints(cc, { location: 'London, UK' }).locationOk).toBe(true);
    expect(checkConstraints(cc, { location: 'Manchester, UK' }).locationOk).toBe(false);
  });
  it('no constraints → nothing to check', () => {
    const none = extractConstraints(['react developers to build my product']);
    expect(none).toEqual({ location: null, minYears: null });
    expect(checkConstraints(none, { location: null })).toEqual({ locationOk: null, yearsOk: null, yearsUnknown: false });
  });
});

describe('profileYears', () => {
  it('reads years from any profile text field', () => {
    expect(profileYears({ jobTitle: 'CTO', expertiseText: 'Over 15 years building hardware' })).toBe(15);
    expect(profileYears({ bio: 'Founder' })).toBeNull();
  });
});
