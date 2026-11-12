// ─── 14 Sep 2026: the whole page ──────────────────────────────────────────────
// Shradha's page carries certifications, volunteering, publications, languages, followers: all mapped, and
// summarised into highlights. (The 14 Sep scrambled-casing "live" read was replaced on 12 Nov 2026 by one call for
// the plain slug, the id ScrapingDog serves its stored copy by: see scrapingdog.provider.ts.)

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { scrapingdogApiKey: 'test-key-do-not-leak', logLevel: 'silent', isDev: false, env: 'test' },
}));

import { mapProfile, scrapingdogProvider } from '../../../services/onboarding/providers/scrapingdog.provider';

const mock = (status: number, body?: any) => ({ status, json: async () => body } as unknown as Response);

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
describe('mapProfile: the whole page', () => {
  it('maps certifications, volunteering, publications, languages and followers, and builds highlights', () => {
    const m = mapProfile(shradhaLive, 'https://www.linkedin.com/in/shradhadhikari')!;
    expect(m.profile.currentCompany).toBe('Vokt');
    expect(m.profile.currentRole).toBeNull();
    expect(m.profile.summary).toBe('Curious about data and business.');
    expect(m.profile.pastRoles).toEqual([]);
    expect(m.profile.certifications).toEqual(['Python for Data Science, AI & Development (IBM, Jul 2025)', 'Business Development Foundations (LinkedIn, Mar 2025)']);
    expect(m.profile.volunteering).toEqual(['Researcher at Robin Hood Army']);
    expect(m.profile.publications).toEqual(['On Nepali fintech (Blog)']);
    expect(m.profile.languages).toEqual(['English', 'Nepali']);
    // A masked college with only years is not an education line.
    expect(m.profile.educationText).toEqual([]);
    expect(m.profile.followers).toBe('4K followers');
    expect(m.profile.highlights).toEqual([
      'Certified: Python for Data Science, AI & Development (IBM, Jul 2025); Business Development Foundations (LinkedIn, Mar 2025)',
      'Volunteers as Researcher at Robin Hood Army',
      'Published: On Nepali fintech (Blog)',
      'Speaks English, Nepali',
      '4K followers on LinkedIn',
    ]);
    expect(m.missing).toEqual(['headline', 'currentRole']);
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

  // Shradha's page (14 Sep): two recommendations with full text (the payload
  // carries the collapsed copy, "Show more", the full copy, "Show less"), a
  // publication with a summary, and the top card's company on a live scrape.
  it('recommendations keep their expanded text, publications keep their summary, posts are titles, and the top card names the company', () => {
    const m = mapProfile({
      fullName: 'Shradha Adhikari', experience: [], description: { description1: 'Vokt', description1_link: 'https://www.linkedin.com/company/vokt' },
      recommendations: [
        { name: 'Stefan Avivson', link: 'https://uk.linkedin.com/in/avivson', summary: '“People who dare win more. Shradha is one of them.”' },
        { name: 'Pravakar B.', link: 'https://np.linkedin.com/in/pravakarbogati', summary: '“I had the pleasure of working with Shradha where she headed… Show more “I had the pleasure of working with Shradha where she headed the National Office for Business Development at AIESEC Nepal.” Show less' },
      ],
      publications: [{ name: 'Business and Management in Asia', sub_title: 'Springer Nature', summary: 'Co-authored a book chapter on Invisible Enterprises.', date: '2026', link: '' }],
      activities: [{ title: 'Why founders should write', link: '', image: '', activity: 'Shared by Shradha' }],
      articles: [{ title: 'On Nepali fintech', link: '', author: 'Shradha', published_date: '2025' }],
    }, 'u')!;
    expect(m.profile.currentCompany).toBe('Vokt');
    expect(m.profile.recommendations).toEqual([
      'Stefan Avivson: “People who dare win more. Shradha is one of them.”',
      'Pravakar B.: “I had the pleasure of working with Shradha where she headed the National Office for Business Development at AIESEC Nepal.”',
    ]);
    expect(m.profile.publications).toEqual(['Business and Management in Asia (Springer Nature): Co-authored a book chapter on Invisible Enterprises.']);
    expect(m.profile.posts).toEqual(['Why founders should write', 'On Nepali fintech']);
    expect(m.profile.highlights).toEqual([
      'Published: Business and Management in Asia (Springer Nature): Co-authored a book chapter on Invisible Enterprises.',
      'Recent posts: Why founders should write; On Nepali fintech',
      'Recommended by Stefan Avivson: “People who dare win more. Shradha is one of them.”',
      'Recommended by Pravakar B.: “I had the pleasure of working with Shradha where she headed the National Office for Business Development at AIESEC Nepal.”',
    ]);
  });

  it('an education entry with a school reads as a line', () => {
    const m = mapProfile({ fullName: 'X', education: [{ college_name: 'Copenhagen Business School', college_degree: 'BSc', college_degree_field: 'Economics', starts_at: '2020', ends_at: '2022' }] }, 'u')!;
    expect(m.profile.educationText).toEqual(['BSc in Economics, Copenhagen Business School (2020 to 2022)']);
    expect(m.profile.highlights).toEqual(['Education: BSc in Economics, Copenhagen Business School (2020 to 2022)']);
  });
});

// 15 Sep 2026 (Ali's own page): the scrape carried LinkedIn's grey placeholder as the photo.
describe('a placeholder is no photo', () => {
  it('the placeholder maps to null', () => {
    const p = mapProfile({ ...shradhaLive, profile_photo: 'https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2' }, 'u')!.profile;
    expect(p.photoUrl).toBeNull();
  });
});

// 12 Nov 2026: one call per lookup, for the plain slug (the id ScrapingDog serves its stored copy by).
describe('enrich: one call, the plain slug', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('a full page: one call, the plain lower-case slug, one source', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mock(200, { fullName: 'Jane Doe', headline: 'CTO', about: 'Builds.', experience: [{ position: 'CTO', company_name: 'Acme' }] }));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/Jane-Doe' });
    expect(out.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('id')).toBe('jane-doe');
    if (out.kind === 'found') expect(out.result.sources).toEqual(['scrapingdog:jane-doe']);
  });

  it('a thin page with masked entries is returned as it is: still one call, no second read', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mock(200, { ...shradhaLive, about: '' }));
    const out = await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (out.kind !== 'partial') throw new Error('expected partial');
    expect(out.result.profile?.currentCompany).toBe('Vokt');
    expect(out.result.profile?.certifications).toHaveLength(2);
    expect(out.photoUrl).toBe('https://media.licdn.com/dms/image/shradha.jpg');
  });

  it.each([
    [500, { kind: 'provider_error', reason: 'scrapingdog 500' }],
    [404, { kind: 'not_found', reason: 'scrapingdog 404' }],
  ])('HTTP %i: its verdict, after one call', async (status, verdict) => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(mock(status));
    expect(await scrapingdogProvider.enrich({ linkedinUrl: 'https://www.linkedin.com/in/nobody-here' })).toEqual(verdict);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
