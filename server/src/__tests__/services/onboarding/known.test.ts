// Pure-function tests for the known/inferred profile helpers. db is mocked so
// importing the module has no side effects (the pure helpers don't query).
jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));

import { companyFromEmail, countryFromHeaders, nameFromEmail } from '../../../services/onboarding/known';

describe('nameFromEmail', () => {
  it('derives a presentable name from the local part', () => {
    expect(nameFromEmail('stefan.avivson@gmail.com')).toBe('Stefan Avivson');
    expect(nameFromEmail('stefanavivson@gmail.com')).toBe('Stefanavivson');
    expect(nameFromEmail('waseemjaved069123@gmail.com')).toBe('Waseemjaved');
  });

  it('returns null for a malformed email', () => {
    expect(nameFromEmail('nope')).toBeNull();
    expect(nameFromEmail('@x.com')).toBeNull();
  });
});

describe('companyFromEmail', () => {
  it('infers a company from a non-generic domain', () => {
    expect(companyFromEmail('stefan@misterraw.com')).toBe('Misterraw');
    expect(companyFromEmail('a@acme.io')).toBe('Acme');
  });

  it('skips generic email providers', () => {
    for (const e of [
      'x@gmail.com', 'x@outlook.com', 'x@hotmail.com', 'x@yahoo.com',
      'x@icloud.com', 'x@proton.me', 'x@aol.com',
    ]) {
      expect(companyFromEmail(e)).toBeNull();
    }
  });

  it('returns null for a malformed email', () => {
    expect(companyFromEmail('nope')).toBeNull();
  });
});

describe('countryFromHeaders', () => {
  const req = (headers: Record<string, string>) => ({ headers } as any);

  it('resolves a country name from cf-ipcountry', () => {
    expect(countryFromHeaders(req({ 'cf-ipcountry': 'DK' }))).toBe('Denmark');
  });

  it('also reads x-vercel-ip-country (case/format tolerant)', () => {
    expect(countryFromHeaders(req({ 'x-vercel-ip-country': 'us' }))).toBe('United States');
  });

  it('returns null for missing / unknown / malformed codes', () => {
    expect(countryFromHeaders(req({}))).toBeNull();
    expect(countryFromHeaders(req({ 'cf-ipcountry': 'XX' }))).toBeNull();
    expect(countryFromHeaders(req({ 'cf-ipcountry': 'ZZZ' }))).toBeNull();
  });
});
