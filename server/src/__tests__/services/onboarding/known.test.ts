// Pure-function tests for the known/inferred profile helpers. db is mocked so
// importing the module has no side effects (the pure helpers don't query).
jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));

import { query } from '../../../db';
import { companyFromEmail, countryFromHeaders, nameFromEmail, inferKnownProfile } from '../../../services/onboarding/known';

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

// The bio-only incoherence fix: a member whose only saved data is `bio` (no
// company/job_title) must still see it on the confirm card's About field.
// GET /onboarding/known now surfaces it as `about`, straight from the saved
// column, so the client can prefill the draft before any candidate/enrichment
// data ever arrives.
describe('inferKnownProfile: about (from users.bio)', () => {
  // gmail.com is in the generic-domain skip list, so companyFromEmail never
  // guesses a company here — isolates the bio-only signal from the unrelated
  // email-domain company guess.
  const fakeReq = (userId = 'user-1') =>
    ({ headers: {}, user: { userId, email: 'member@gmail.com' } } as any);

  function mockUserRow(row: Partial<{
    email: string;
    display_name: string | null;
    first_name: string | null;
    company: string | null;
    location: string | null;
    job_title: string | null;
    linkedin_url: string | null;
    why_i_want_to_meet: string | null;
    bio: string | null;
    inviter_name: string | null;
    inviter_email: string | null;
  }>) {
    (query as jest.Mock)
      .mockResolvedValueOnce({
        rows: [{
          email: 'member@gmail.com',
          display_name: null,
          first_name: null,
          company: null,
          location: null,
          job_title: null,
          linkedin_url: null,
          why_i_want_to_meet: null,
          bio: null,
          inviter_name: null,
          inviter_email: null,
          ...row,
        }],
      })
      // The second query() call counts previous events; degrades to 0 either way.
      .mockResolvedValueOnce({ rows: [{ n: 0 }] });
  }

  afterEach(() => {
    (query as jest.Mock).mockReset();
  });

  it('surfaces the saved bio as `about`, even when company/job_title are both blank', async () => {
    mockUserRow({ bio: 'Building bridges between fintech and logistics.' });
    const result = await inferKnownProfile(fakeReq(), 'user-1');
    expect(result.about).toBe('Building bridges between fintech and logistics.');
    // The bio-only case: no other substantive field on file.
    expect(result.company).toBeNull();
    expect(result.role).toBeNull();
  });

  it('trims the saved bio', async () => {
    mockUserRow({ bio: '   Loves shipping things.   ' });
    const result = await inferKnownProfile(fakeReq(), 'user-1');
    expect(result.about).toBe('Loves shipping things.');
  });

  it('returns null for `about` when no bio is on file (never a guess)', async () => {
    mockUserRow({ bio: null });
    const result = await inferKnownProfile(fakeReq(), 'user-1');
    expect(result.about).toBeNull();
  });

  it('returns null for `about` when bio is an empty/whitespace string', async () => {
    mockUserRow({ bio: '   ' });
    const result = await inferKnownProfile(fakeReq(), 'user-1');
    expect(result.about).toBeNull();
  });
});
