// ─── Platform Match (REASON v1 Phase 1, 17 Jul 2026) ─────────────────────────
//
// Stefan's rule, verbatim approved: "if what A wants matches what B is or
// offers, that is a match" — one-way fit SHOWS the suggestion; both must say
// yes before any introduction (the poke rails carry that part).

const mockQuery = jest.fn();
const mockSendPoke = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/poke/poke.service', () => ({
  sendPoke: (...args: unknown[]) => mockSendPoke(...args),
  __esModule: true,
}));
// The service's socket emit does `await import('../../index')` (the same
// lazy-io pattern poke uses). In prod that's the already-loaded server module;
// in Jest it would BOOT the server. Stub it.
jest.mock('../../../index', () => ({
  io: { to: () => ({ emit: () => {} }) },
  __esModule: true,
}));

import {
  scoreFit, wantedDesignations, getPlatformMatches, expressInterest,
  notifyMatchesOfNewUser, MATCH_THRESHOLD, BROWSE_THRESHOLD, IntentProfile,
} from '../../../services/matching/platform-match.service';

const profile = (over: Partial<IntentProfile>): IntentProfile => ({
  id: 'u-x', displayName: 'X', avatarUrl: null,
  professionalRole: null, jobTitle: null, company: null,
  expertiseText: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, myIntent: null,
  whoIWantToMeet: null, whyIWantToMeet: null,
  ...over,
});

// NB: professional_role is text[] in the real users table (as are goals and
// interests) — node-pg hands the service ARRAYS here, and treating them as
// strings crashed the endpoint on prod (caught by the 17 Jul E2E). These
// fixtures deliberately use the array shape to pin that.
const FOUNDER_SEEKING_INVESTORS = profile({
  id: 'u-founder', displayName: 'Fatima',
  professionalRole: ['Founder'], whoIWantToMeet: 'investors and angels for my seed round',
  myIntent: 'raise funding for my SaaS startup',
});
const INVESTOR = profile({
  id: 'u-investor', displayName: 'Iqbal',
  professionalRole: ['Angel Investor'], expertiseText: 'early stage SaaS investing',
});
const UNRELATED = profile({
  id: 'u-baker', displayName: 'Bilal',
  professionalRole: ['Pastry Chef'], expertiseText: 'sourdough croissants',
});

describe('scoreFit — Stefan\'s one-way rule', () => {
  it('A wants investors + B is an investor → match above threshold, with a readable reason', () => {
    const fit = scoreFit(FOUNDER_SEEKING_INVESTORS, INVESTOR);
    expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(fit.reason).toMatch(/investor/i);
    expect(fit.reason).toMatch(/Iqbal/);
  });

  it('no fit → below browse threshold and never invents a reason', () => {
    const fit = scoreFit(FOUNDER_SEEKING_INVESTORS, UNRELATED);
    expect(fit.score).toBeLessThan(BROWSE_THRESHOLD);
  });

  it('the rule is DIRECTIONAL: B fitting what A wants does not imply A fits what B wants', () => {
    // The investor never said what they want — so from the investor's side
    // there is no want-text and the founder cannot score a designation hit.
    const reverse = scoreFit(INVESTOR, FOUNDER_SEEKING_INVESTORS);
    const forward = scoreFit(FOUNDER_SEEKING_INVESTORS, INVESTOR);
    expect(forward.score).toBeGreaterThan(reverse.score);
  });

  it('keyword overlap alone (no designation) can qualify when the want-text matches offers', () => {
    const wantsAiHelp = profile({
      id: 'u-a', displayName: 'Aisha',
      whoIWantToMeet: 'someone who knows machine learning and computer vision deployment',
    });
    const mlEngineer = profile({
      id: 'u-b', displayName: 'Bashir',
      professionalRole: 'ML Engineer', // legacy string shape must ALSO work
      expertiseText: 'machine learning, computer vision, model deployment at scale',
    });
    const fit = scoreFit(wantsAiHelp, mlEngineer);
    expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(fit.reason.length).toBeGreaterThan(0);
  });

  it('a multi-role array renders as a readable role, never "[object" or a pg literal', () => {
    const wantsAdvisors = profile({
      id: 'u-w', displayName: 'Waqas', whoIWantToMeet: 'mentors and advisors',
    });
    const multi = profile({
      id: 'u-m', displayName: 'Mona',
      professionalRole: ['Advisor', 'Founder'], expertiseText: 'fundraising mentorship',
    });
    const fit = scoreFit(wantsAdvisors, multi);
    expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(fit.reason).not.toMatch(/\[object|\{/);
    expect(fit.reason).toMatch(/Advisor, Founder|Advisor/);
  });

  it('wantedDesignations scans ALL wanted buckets from free text, not just the first', () => {
    const keys = wantedDesignations(profile({
      id: 'u', whoIWantToMeet: 'founders and investors, ideally mentors too',
    })).map(w => w.key);
    expect(keys).toEqual(expect.arrayContaining(['founder', 'investor', 'advisor']));
  });
});

describe('getPlatformMatches', () => {
  beforeEach(() => mockQuery.mockReset());

  function armQueries(opts: { me?: any; candidates?: any[]; nextEvent?: any[] }) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM sessions/.test(sql)) return Promise.resolve({ rows: opts.nextEvent ?? [] });
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: opts.me ? [opts.me] : [] });
      return Promise.resolve({ rows: opts.candidates ?? [] });
    });
  }

  it('returns scored matches above the strict threshold, best first', async () => {
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [UNRELATED, INVESTOR],
    });
    const res = await getPlatformMatches('u-founder');
    expect(res.profileIncomplete).toBe(false);
    expect(res.matches.map(m => m.userId)).toEqual(['u-investor']);
    expect(res.matches[0].reason).toMatch(/investor/i);
  });

  it('no-match payload still carries the next upcoming event for the options screen', async () => {
    const when = new Date('2026-08-01T18:00:00Z');
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [UNRELATED],
      nextEvent: [{ id: 's1', title: 'RSN August', scheduledAt: when }],
    });
    const res = await getPlatformMatches('u-founder');
    expect(res.matches).toEqual([]);
    expect(res.nextEvent).toEqual({ id: 's1', title: 'RSN August', scheduledAt: when });
  });

  it('browse mode relaxes the threshold (find-other-people option)', async () => {
    const mild = profile({
      id: 'u-mild', displayName: 'Maryam',
      professionalRole: 'Marketing Consultant', expertiseText: 'growth and funding narratives',
    });
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [mild],
    });
    const strict = await getPlatformMatches('u-founder');
    const browse = await getPlatformMatches('u-founder', { browse: true });
    expect(strict.matches.length).toBe(0);
    expect(browse.matches.length).toBe(1);
  });

  it('a user who has not finished onboarding gets profileIncomplete, not matches', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: false } });
    const res = await getPlatformMatches('u-founder');
    expect(res.profileIncomplete).toBe(true);
    expect(res.matches).toEqual([]);
  });

  it('candidate SQL excludes prior encounters, pokes in either direction, and blocks', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [] });
    await getPlatformMatches('u-founder');
    const candidateSql = mockQuery.mock.calls.map(c => c[0] as string)
      .find(s => /u\.id <> \$1/.test(s))!;
    expect(candidateSql).toMatch(/encounter_history/);
    expect(candidateSql).toMatch(/user_pokes/);
    expect(candidateSql).toMatch(/user_blocks/);
    expect(candidateSql).toMatch(/onboarding_completed = true/);
  });
});

describe('expressInterest — the introduction rides the poke rails', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); });

  it('composes the introduction from the fit reason and sends it as the poke message', async () => {
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        const id = (params as string[])[0];
        const p = id === 'u-founder'
          ? { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }
          : { ...INVESTOR, onboardingCompleted: true };
        return Promise.resolve({ rows: [p] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockSendPoke.mockResolvedValue({ id: 'poke-1', status: 'pending' });

    // The INVESTOR expresses interest in the FOUNDER: the intro shown to the
    // founder explains why the investor fits what the FOUNDER wanted.
    await expressInterest('u-investor', 'u-founder');
    expect(mockSendPoke).toHaveBeenCalledTimes(1);
    const [senderId, recipientId, message] = mockSendPoke.mock.calls[0] as string[];
    expect(senderId).toBe('u-investor');
    expect(recipientId).toBe('u-founder');
    expect(message).toMatch(/investor/i);
    expect(message).toMatch(/should meet/i);
    expect(message.length).toBeLessThanOrEqual(500);
  });
});

describe('notifyMatchesOfNewUser — the "new batch" trigger', () => {
  beforeEach(() => mockQuery.mockReset());

  it('notifies existing members who fit the newcomer, once per 24h, capped', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [{ ...INVESTOR, onboardingCompleted: true }] });
      }
      if (/u\.id <> \$1 AND u\.status = 'active'/.test(sql)) {
        return Promise.resolve({ rows: [FOUNDER_SEEKING_INVESTORS, UNRELATED] });
      }
      if (/SELECT id FROM notifications/.test(sql)) return Promise.resolve({ rows: [] }); // no dedupe hit
      if (/INSERT INTO notifications/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const notified = await notifyMatchesOfNewUser('u-investor');
    // Only the founder (who wants investors) is notified; the baker is not.
    expect(notified).toBe(1);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect(insert[0]).toMatch(/'platform_match'/);
    expect((insert[1] as unknown[])[0]).toBe('u-founder');
  });

  it('respects the 24h dedupe — a member already notified today is skipped', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [{ ...INVESTOR, onboardingCompleted: true }] });
      }
      if (/u\.id <> \$1 AND u\.status = 'active'/.test(sql)) {
        return Promise.resolve({ rows: [FOUNDER_SEEKING_INVESTORS] });
      }
      if (/SELECT id FROM notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'already' }] });
      return Promise.resolve({ rows: [] });
    });
    const notified = await notifyMatchesOfNewUser('u-investor');
    expect(notified).toBe(0);
    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(false);
  });

  it('never throws — matching must not be able to break onboarding', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(notifyMatchesOfNewUser('u-x')).resolves.toBe(0);
  });
});
