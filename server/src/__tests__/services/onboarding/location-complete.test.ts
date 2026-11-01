// ─── "Where are you based?": a city and a country, or only a country (30 Oct review, 1.2) ───────────
//
// Stefan: "Some profiles show 'No location', others show only 'USA'." A location that is exactly a country
// (a name or an alias, trimmed, in any case) is not where someone is based, so it counts as incomplete;
// anything more is a member's own words and counts as given. The client and the server judge it with this
// one helper from @rsn/shared, built from the matcher's own country table. The samples are production's
// real values (00-production-facts.md, 1 Nov 2026).

import { isCountryOnly, isLocationComplete, COUNTRY_ALIASES, COUNTRY_NAMES, ENDONYMS, fold } from '@rsn/shared';
import * as matcherConstraints from '../../../services/matching/want-constraints';
import * as matcherRegions from '../../../services/matching/want-regions';

describe('isCountryOnly', () => {
  it.each([
    'United Kingdom', 'USA', 'Nepal', 'usa', '  USA  ', 'U.S.A.', 'United States', 'the UK', 'The Netherlands',
    'Deutschland', 'Türkiye', 'Côte d’Ivoire', 'Bosnia & Herzegovina', 'Congo - Kinshasa', 'Czech Republic', 'germany.',
  ])('"%s" is only a country', (value) => {
    expect(isCountryOnly(value)).toBe(true);
    expect(isLocationComplete(value)).toBe(false);
  });

  it.each([
    'Manchester, UK', 'Malmö, Sweden (based on RocketReach data)', 'Spain/US', 'Omaha, NE ', 'Omaha, NE',
    'Greater Copenhagen Region', 'Copenhagen, Denmark', 'Copenhagen, Capital Region of Denmark, Denmark',
    'Kathmandu', 'Georgia',
    // A city that is its own country, or a city the alias table lists for its country, is where someone lives.
    'Singapore', 'Hong Kong', 'Dubai', 'Abu Dhabi', 'Monaco', 'Luxembourg', 'Kuwait', 'Panama',
  ])('"%s" says where they are based', (value) => {
    expect(isCountryOnly(value)).toBe(false);
    expect(isLocationComplete(value)).toBe(true);
  });

  it('nothing at all is not a country, and is not a location either', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(isCountryOnly(empty)).toBe(false);
      expect(isLocationComplete(empty)).toBe(false);
    }
  });

  it('every country name, alias and home name the matcher knows counts as only a country', () => {
    const CITIES = ['singapore', 'hong kong', 'dubai', 'abu dhabi', 'monaco', 'macao', 'macau', 'vatican city',
      'luxembourg', 'kuwait', 'san marino', 'djibouti', 'panama', 'andorra'];
    const names = [
      ...Object.entries(COUNTRY_ALIASES).flatMap(([canon, aliases]) => [canon, ...aliases]),
      ...Object.entries(COUNTRY_NAMES).flatMap(([canon, others]) => [canon, ...others]),
      ...Object.values(ENDONYMS).flat(),
    ].filter(n => !CITIES.includes(fold(n)));
    const missed = names.filter(n => !isCountryOnly(n) || !isCountryOnly(n.toUpperCase()));
    expect(missed).toEqual([]);
  });

  it('the matcher reads the same tables, moved to @rsn/shared, not a copy of them', () => {
    expect(matcherConstraints.COUNTRY_ALIASES).toBe(COUNTRY_ALIASES);
    expect(matcherConstraints.fold).toBe(fold);
    expect(matcherRegions.COUNTRY_NAMES).toBe(COUNTRY_NAMES);
    expect(matcherRegions.ENDONYMS).toBe(ENDONYMS);
  });
});
