// ─── 14 Sep 2026: the live page, and the whole page ──────────────────────────
// Shradha's slug: ScrapingDog's cached copy still said RSN while her page
// said Vokt. A linkId with its casing changed misses their cache (14 seconds,
// Vokt). And the page carries certifications, volunteering, publications,
// languages, followers: all mapped, and summarised into highlights.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { scrapingdogApiKey: 'test-key-do-not-leak', logLevel: 'silent', isDev: false, env: 'test' },
}));

import { freshSlug, mapProfile, mergeLiveWithCached, isThin, scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';

const mock = (status: number, body?: any) => ({ status, json: async () => body } as unknown as Response);

describe('freshSlug', () => {
  it('changes the casing so the slug is never the canonical lowercase form, and is reproducible per seed', () => {
    const a = freshSlug('shradhadhikari', 12345);
    expect(a.toLowerCase()).toBe('shradhadhikari');
    expect(a).not.toBe('shradhadhikari');
    expect(freshSlug('shradhadhikari', 12345)).toBe(a);
    expect(freshSlug('shradhadhikari', 67890)).not.toBe(a);
    expect(freshSlug('ali-hamza-b0650a281', 7).toLowerCase()).toBe('ali-hamza-b0650a281');
  });
  it('flips at least one letter even when the seed would flip none, and leaves a slug without letters alone', () => {
    expect(freshSlug('abc', 0)).not.toBe('abc');
    expect(freshSlug('123-456', 5)).toBe('123-456');
  });
});

const shradhaLive = {
  fullName: 'Shradha Adhikari', headline: '', location: '', about: 'Curious about data and business.', followers: '4K followers', connections: '500+ connections',
  experience: [
    { position: '', company_name: 'Vokt', starts_at: '', ends_at: '', duration: '' },
    { position: '', company_name: '*** ***** ********** * ***', starts_at: '', ends_at: '', duration: '' },
  ],
  education: [{ college_name: null, starts_at: '2025', ends_at: '2027' }],
  certification: [
    { certification: 'Python for Data Science, AI & Development', company_name: 'IBM', issue_date: 'Issued Jul 2025' },
    { certification: 'Business Development Foundations', company_name: 'LinkedIn', issue_date: 'Issued Mar 2025' },
  ],
  volunteering: [{ company_position: 'Researcher', company_name: 'Robin Hood Army' }],
  publications: [{ name: 'On Nepali fintech', sub_title: 'Blog', summary: '', date: '2025', link: '' }],
  languages: [{ name: 'English' }, { name: 'Nepali' }],
  projects: [], awards: [], courses: [], organizations: [],
  profile_photo: 'https://media.licdn.com/dms/image/shradha.jpg',
};
const shradhaCached = {
  fullName: 'Shradha Adhikari', headline: '', about: '',
  experience: [
    { position: '', company_name: 'Raw Speed Networking | RSN' },
    { position: '', company_name: 'misterraw' },
    { position: '', company_name: '******* *******' },
  ],
  certification: [{ certification: 'Sales: Practical Techniques', company_name: 'LinkedIn', issue_date: 'Issued Feb 2025' }],
};

describe('mapProfile: the whole page', () => {
  it('maps certifications, volunteering, publications, languages and followers, and builds highlights', () => {
    const m = mapProfile(shradhaLive, 'https://www.linkedin.com/in/shradhadhikari')!;
    expect(m.profile.currentCompany).toBe('Vokt');
    expect(m.profile.currentRole).toBeNull();
    expect(m.profile.summary).toBe('Curious about data and business.');
    expect(m.profile.pastRoles).toEqual([]);
    expect(m.profile.certifications).toEqual(['Python for Data Science, AI & Development (IBM, Jul 2025)', 'Business Development Foundations (LinkedIn, Mar 2025)']);
    expect(m.profile.volunteering).toEqual(['Researcher at Robin Hood Army']);
    expect(m.profile.publications).toEqual(['On Nepali fintech']);
    expect(m.profile.languages).toEqual(['English', 'Nepali']);
    // A masked college with only years is not an education line.
    expect(m.profile.educationText).toEqual([]);
    expect(m.profile.followers).toBe('4K followers');
    expect(m.profile.highlights).toEqual([
      'Certified: Python for Data Science, AI & Development (IBM, Jul 2025); Business Development Foundations (LinkedIn, Mar 2025)',
      'Volunteers as Researcher at Robin Hood Army',
      'Published: On Nepali fintech',
      'Speaks English, Nepali',
      '4K followers on LinkedIn',
    ]);
    expect(m.missing).toEqual(['headline', 'currentRole']);
    // One entry the guest view hid.
    expect(m.masked).toBe(1);
    expect(isThin(m.profile)).toBe(false);
  });

  it('a live page with masked entries but an About still reads the cached copy for the older positions', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mock(200, shradhaLive))
      .mockResolvedValueOnce(mock(200, shradhaCached));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (out.kind !== 'partial') throw new Error('expected partial');
    expect(out.result.profile?.currentCompany).toBe('Vokt');
    expect(out.result.profile?.summary).toBe('Curious about data and business.');
    expect(out.result.profile?.pastRoles).toEqual(['at Raw Speed Networking | RSN', 'at misterraw']);
    jest.restoreAllMocks();
  });

  // The live page (williamhgates, 14 Sep): "Co-chair\n        \n          Gates Foundation".
  it('the live page repeats the position inside the company with whitespace noise; the company is what is left', () => {
    const m = mapProfile({
      fullName: 'Bill Gates', headline: 'Chair, Gates Foundation and Founder, Breakthrough Energy',
      experience: [
        { position: 'Co-chair', company_name: 'Co-chair\n        \n      \n        \n          Gates Foundation', duration: '26 years' },
        { position: 'Founder', company_name: 'Founder\n          Breakthrough Energy', duration: '11 years' },
        { position: 'Co-founder', company_name: 'Microsoft', duration: '51 years' },
      ],
    }, 'u')!;
    expect(m.profile.currentRole).toBe('Co-chair');
    expect(m.profile.currentCompany).toBe('Gates Foundation');
    expect(m.profile.pastRoles).toEqual(['Founder at Breakthrough Energy (11 years)', 'Co-founder at Microsoft (51 years)']);
    expect(m.missing).toEqual([]);
  });

  it('an education entry with a school reads as a line', () => {
    const m = mapProfile({ fullName: 'X', education: [{ college_name: 'Copenhagen Business School', college_degree: 'BSc', college_degree_field: 'Economics', starts_at: '2020', ends_at: '2022' }] }, 'u')!;
    expect(m.profile.educationText).toEqual(['BSc in Economics, Copenhagen Business School (2020 to 2022)']);
    expect(m.profile.highlights).toEqual(['Education: BSc in Economics, Copenhagen Business School (2020 to 2022)']);
  });
});

describe('mergeLiveWithCached', () => {
  it('the live page wins on the current company and About; the cached copy fills gaps and its old company becomes a past role', () => {
    const live = mapProfile({ ...shradhaLive, about: '' }, 'u')!.profile;
    const cached = mapProfile({ ...shradhaCached, headline: 'Business developer', about: 'Old about.' }, 'u')!.profile;
    expect(isThin(live)).toBe(true);
    const m = mergeLiveWithCached(live, cached);
    expect(m.currentCompany).toBe('Vokt');
    expect(m.headline).toBe('Business developer');
    expect(m.summary).toBe('Old about.');
    expect(m.pastRoles).toEqual(['at Raw Speed Networking | RSN', 'at misterraw']);
    expect(m.certifications).toEqual([
      'Python for Data Science, AI & Development (IBM, Jul 2025)', 'Business Development Foundations (LinkedIn, Mar 2025)', 'Sales: Practical Techniques (LinkedIn, Feb 2025)',
    ]);
    expect(m.volunteering).toEqual(['Researcher at Robin Hood Army']);
    expect(m.photoUrl).toBe('https://media.licdn.com/dms/image/shradha.jpg');
  });
});

describe('enrich: live first, cached only to fill', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('a full live page is used alone: one call, a scrambled-case linkId, the live source', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mock(200, { fullName: 'Jane Doe', headline: 'CTO', about: 'Builds.', experience: [{ position: 'CTO', company_name: 'Acme' }] }));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/jane-doe' });
    expect(out.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.toLowerCase()).toContain('linkid=jane-doe');
    expect(url).not.toContain('linkId=jane-doe&');
    if (out.kind === 'found') expect(out.result.sources).toEqual(['scrapingdog:jane-doe:live']);
  });

  it('a thin live page is filled from the cached copy: two calls, the canonical linkId second, both sources', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mock(200, { ...shradhaLive, about: '' }))
      .mockResolvedValueOnce(mock(200, shradhaCached));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('linkId=shradhadhikari&');
    expect(out.kind).toBe('partial');
    if (out.kind !== 'partial') throw new Error('expected partial');
    expect(out.result.profile?.currentCompany).toBe('Vokt');
    expect(out.result.profile?.pastRoles).toEqual(['at Raw Speed Networking | RSN', 'at misterraw']);
    expect(out.result.profile?.certifications).toHaveLength(3);
    expect(out.result.sources).toEqual(['scrapingdog:shradhadhikari:live', 'scrapingdog:shradhadhikari']);
    expect(out.photoUrl).toBe('https://media.licdn.com/dms/image/shradha.jpg');
  });

  it('when the live scrape fails outright, the cached copy is the answer', async () => {
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mock(500))
      .mockResolvedValueOnce(mock(200, shradhaCached));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari' });
    expect(out.kind).toBe('partial');
    if (out.kind === 'partial') {
      expect(out.result.profile?.currentCompany).toBe('Raw Speed Networking | RSN');
      expect(out.result.sources).toEqual(['scrapingdog:shradhadhikari']);
    }
  });

  it('when both fail, the live verdict is reported', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mock(404)).mockResolvedValueOnce(mock(500));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/nobody-here' });
    expect(out.kind).toBe('not_found');
  });
});
