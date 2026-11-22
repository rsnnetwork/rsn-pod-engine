// ─── For You, sharper (22 Nov 2026) ──────────────────────────────────────────
//
// Stefan opened For You: "Why are these 5 people suggested to me? makes no sense". Every card read
// "You're looking to meet founders — X is a Founder", two of the five were people he had already
// asked, and the five were the same founders everyone saw. Read against his real data: he asks for
// 16 kinds of people, 26 of his 27 suggestions were a role match and nothing else, all 27 were
// people he had already asked, and equal fits were ordered by id. These pin the four fixes:
//   1. a designation alone is a close match on a profile-level fit (DESIGNATION_ALONE_SCORE);
//      strong needs a second signal on their card; a matching agent keeps the old rule;
//   2. the reason names that second signal, in the card's own words;
//   3. requests the member sent leave the suggestions for `waiting`;
//   4. equal fits are ordered by compareEqualFits, not by id; and a broad ask is flagged.

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/poke/poke.service', () => ({ sendPoke: jest.fn(), __esModule: true }));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));
// The newcomer bell runs the agents first; none here.
jest.mock('../../../services/matching/agent-matching.service', () => ({ scoreNewcomerAgainstAgents: jest.fn().mockResolvedValue([]), __esModule: true }));

import {
  scoreFit, scoreWants, getPlatformMatches, notifyMatchesOfNewUser, cardPhrases, compareEqualFits, dailyRotation, activityStep,
  cardCompleteness, wantedDesignations, MATCH_THRESHOLD, BROWSE_THRESHOLD, DESIGNATION_ALONE_SCORE, BROAD_WANTS, WAITING_LIMIT,
  type IntentProfile, type CandidateRow,
} from '../../../services/matching/platform-match.service';

const profile = (over: Partial<IntentProfile>): IntentProfile => ({
  id: 'u-x', displayName: 'X', avatarUrl: null,
  professionalRole: null, jobTitle: null, company: null,
  expertiseText: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, myIntent: null,
  whoIWantToMeet: null, whyIWantToMeet: null,
  ...over,
});
const row = (over: Partial<CandidateRow>): CandidateRow => ({
  ...profile({}), pokeStatus: null, pokeSentByOwner: null, saved: null, passedOnMember: null, ...over,
});

// Stefan's own answer, word for word (production, read only, 22 Nov 2026).
const STEFAN_WANTS = 'recruiters and hiring managers; managers, directors and executives; students, interns and recent graduates; '
  + 'freelancers and consultants; specialists: developers, engineers, designers and marketers; advisors and mentors with experience '
  + 'to share; investors, angel investors and venture capital firms; founders, co-founders and business owners';
const STEFAN = profile({ id: 'u-stefan', displayName: 'Stefan', professionalRole: ['Founder', 'Business owner', 'Advisor'], whoIWantToMeet: STEFAN_WANTS });

const WANTS_FINTECH_FOUNDERS = profile({ id: 'u-v', displayName: 'Vic', whoIWantToMeet: 'fintech founders' });
const PLAIN_FOUNDER = profile({ id: 'u-f', displayName: 'Gerald', professionalRole: ['Founder', 'Business owner'] });

describe('a designation alone is a close match on For You, and still a strong one for a matching agent', () => {
  it('scoreFit: a founder with nothing else that fits scores DESIGNATION_ALONE_SCORE, a close match', () => {
    const fit = scoreFit(WANTS_FINTECH_FOUNDERS, PLAIN_FOUNDER);
    expect(fit.score).toBe(DESIGNATION_ALONE_SCORE);
    expect(fit.score).toBeGreaterThanOrEqual(BROWSE_THRESHOLD);
    expect(fit.score).toBeLessThan(MATCH_THRESHOLD);
    expect(fit.reason).toBe("You're looking to meet founders — Gerald is a Founder");
  });

  it('a matching agent asking for founders still finds the same founder strong (its want is one focused search)', () => {
    expect(scoreWants(['founders'], PLAIN_FOUNDER, undefined, ['founders']).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it.each([
    ['their industry', { industry: 'Fintech' }, 'fintech'],
    ['their company', { company: 'Fintech Labs' }, 'fintech'],
    ['their expertise', { expertiseText: 'fintech infrastructure' }, 'fintech'],
    ['what they can help with', { whatICanHelpWith: 'Intros across fintech' }, 'fintech'],
    ['their bio', { bio: 'Building a fintech for freelancers' }, 'fintech'],
  ])('a second signal in %s makes it strong, and the reason names it in the card\'s words', (_where, over, word) => {
    const fit = scoreFit(WANTS_FINTECH_FOUNDERS, { ...PLAIN_FOUNDER, ...over });
    expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(fit.reason).toBe(`You're looking to meet founders — Gerald is a Founder, and their profile mentions ${word}`);
  });

  it('the place the want names is a second signal too, and is said as before', () => {
    const want = profile({ id: 'u-v', whoIWantToMeet: 'founders in Germany' });
    const fit = scoreFit(want, { ...PLAIN_FOUNDER, location: 'Berlin, Germany' });
    expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(fit.reason).toBe("You're looking to meet founders — Gerald is a Founder (in Germany)");
  });

  it('a word that names a kind of person is never the second signal: "CEO" in a founder\'s bio, "advisor" in their expertise', () => {
    const want = profile({ id: 'u-v', whoIWantToMeet: 'founders, CEOs, advisors and business leaders' });
    for (const over of [{ bio: 'CEO of two companies' }, { expertiseText: 'advisor to startups' }, { bio: 'A leader in my field' }]) {
      expect({ over, score: scoreFit(want, { ...PLAIN_FOUNDER, ...over }).score }).toEqual({ over, score: DESIGNATION_ALONE_SCORE });
    }
  });

  it('the title the reason already names is not the second signal either', () => {
    const want = profile({ id: 'u-v', whoIWantToMeet: 'fintech founders' });
    const titled = { ...PLAIN_FOUNDER, professionalRole: ['Fintech Founder'] };
    expect(scoreFit(want, titled).score).toBe(DESIGNATION_ALONE_SCORE);
  });

  it('a private interest still counts for nothing it can be named by: it does not make a designation strong, and is not named', () => {
    const fit = scoreFit(WANTS_FINTECH_FOUNDERS, { ...PLAIN_FOUNDER, interests: ['fintech'], whatICareAbout: 'fintech regulation' });
    expect(fit.score).toBe(DESIGNATION_ALONE_SCORE);
    expect(fit.reason).not.toMatch(/fintech|regulation/);
  });

  it('only one word that a synonym brought in is not enough on its own; the member\'s own word is', () => {
    // "manufacturers" expands to production, industrial and the like (want-synonyms).
    const want = profile({ id: 'u-v', whoIWantToMeet: 'manufacturers' });
    const maker = profile({ id: 'u-m', displayName: 'Mo', professionalRole: ['Manufacturer'], bio: 'podcast production' });
    expect(scoreFit(want, maker).score).toBe(DESIGNATION_ALONE_SCORE);
  });
});

describe('cardPhrases: the matched words as the card has them', () => {
  it('keeps neighbours together and stops at punctuation', () => {
    const matched = new Set(['strategy', 'lead', 'generation', 'early', 'stage']);
    expect(cardPhrases(['Strategy, Lead Generation', 'Investing at the early-stage'], matched, 3)).toEqual(['strategy', 'lead generation', 'early stage']);
  });

  it('dedupes, keeps the card\'s order and stops at the limit', () => {
    expect(cardPhrases(['fintech; payments; fintech; saas'], new Set(['fintech', 'payments', 'saas']), 2)).toEqual(['fintech', 'payments']);
  });

  it('names nothing from a field it was not given', () => {
    expect(cardPhrases([null, undefined, ''], new Set(['fintech']), 3)).toEqual([]);
  });
});

describe('the order of equal fits', () => {
  const NOW = new Date('2026-11-22T10:00:00Z');
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it('what the two share comes first, then a complete card, then recent activity', () => {
    const shares = row({ id: 'u-a', sharedContext: 1 });
    const complete = row({ id: 'u-b', avatarUrl: 'https://x/y.png', whatICanHelpWith: 'Intros' });
    const active = row({ id: 'u-c', lastActiveAt: days(1) });
    const neither = row({ id: 'u-d', lastActiveAt: days(90) });
    const order = [neither, active, complete, shares].sort((a, b) => compareEqualFits('u-m', NOW, a, b)).map(r => r.id);
    expect(order).toEqual(['u-a', 'u-b', 'u-c', 'u-d']);
  });

  it('activity is read in coarse steps: this week, this month, before', () => {
    expect([activityStep(days(0), NOW), activityStep(days(7), NOW), activityStep(days(8), NOW), activityStep(days(30), NOW), activityStep(days(31), NOW), activityStep(null, NOW)])
      .toEqual([2, 2, 1, 1, 0, 0]);
  });

  it('a card is complete with a photo and something they can bring; a blank photo or offer is not one', () => {
    expect(cardCompleteness(profile({ avatarUrl: ' ', whatICanHelpWith: '...' }))).toBe(0);
    expect(cardCompleteness(profile({ avatarUrl: 'https://x/y.png', expertiseText: 'Seed rounds' }))).toBe(2);
  });

  it('the rotation is the same all UTC day for one member, and moves on the next', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `u-${i}`);
    const orderOn = (d: Date, member = 'u-m') => [...ids].sort((a, b) => dailyRotation(member, a, d) - dailyRotation(member, b, d));
    expect(orderOn(new Date('2026-11-22T00:01:00Z'))).toEqual(orderOn(new Date('2026-11-22T23:59:00Z')));
    expect(orderOn(new Date('2026-11-23T00:01:00Z'))).not.toEqual(orderOn(new Date('2026-11-22T00:01:00Z')));
    // ...and is not the same list for every member on the same day.
    expect(orderOn(NOW, 'u-other')).not.toEqual(orderOn(NOW));
  });
});

describe('getPlatformMatches: Stefan\'s page', () => {
  beforeEach(() => mockQuery.mockReset());

  function arm(me: IntentProfile, candidates: Partial<CandidateRow>[], waiting: unknown[] = []) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM sessions/.test(sql)) return Promise.resolve({ rows: [] });
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{ ...me, onboardingCompleted: true }] });
      if (/FROM user_pokes wp/.test(sql)) return Promise.resolve({ rows: waiting });
      return Promise.resolve({ rows: candidates });
    });
  }
  const sqlOf = (re: RegExp) => String(mockQuery.mock.calls.map(c => c[0]).find(s => re.test(String(s))));

  it('founders who are only founders are close matches; the one whose card also fits comes first, strong, saying why', async () => {
    const founders = ['u-f1', 'u-f2', 'u-f3', 'u-f4'].map((id, i) => ({ ...PLAIN_FOUNDER, id, displayName: `Founder ${i + 1}` }));
    const designer = { ...PLAIN_FOUNDER, id: 'u-d', displayName: 'Dana', expertiseText: 'Product design for marketplaces', professionalRole: ['Founder'] };
    const want = profile({ ...STEFAN, whoIWantToMeet: `${STEFAN_WANTS}; people building marketplaces` });
    arm(want, [...founders, designer]);
    const { matches } = await getPlatformMatches('u-stefan');
    expect(matches[0]).toMatchObject({ userId: 'u-d', strength: 'strong' });
    expect(matches[0].reason).toMatch(/, and their profile mentions marketplaces$/);
    expect(matches.slice(1).map(m => m.strength)).toEqual(['close', 'close', 'close', 'close']);
    for (const m of matches.slice(1)) expect(m.reason).toMatch(/^Close match — You're looking to meet founders/);
  });

  it('a member who asks for this many kinds of people is told the page is broad; one who asks for a few is not', async () => {
    expect(wantedDesignations(STEFAN).length).toBeGreaterThanOrEqual(BROAD_WANTS);
    arm(STEFAN, []);
    expect((await getPlatformMatches('u-stefan')).wantsBroad).toBe(true);
    arm(WANTS_FINTECH_FOUNDERS, []);
    expect((await getPlatformMatches('u-v')).wantsBroad).toBe(false);
  });

  it('someone the member asked is not a candidate any more; someone who asked the member still is', async () => {
    arm(STEFAN, []);
    await getPlatformMatches('u-stefan');
    const candidates = sqlOf(/u\.id <> \$1/);
    expect(candidates.replace(/\s+/g, ' ')).toContain(
      "AND NOT EXISTS ( SELECT 1 FROM user_pokes ws WHERE ws.status = 'pending' AND ws.sender_id = $1 AND ws.recipient_id = u.id)",
    );
    // Only the member's own request: nothing keyed on the other person sending one.
    expect(candidates).not.toMatch(/ws\.sender_id = u\.id/);
    // A request they received is still read onto the card, so it can offer Respond.
    expect(candidates).toMatch(/\(pk\.sender_id = \$1\) AS "pokeSentByOwner"/);
  });

  it('the member\'s waiting requests come back apart: newest first, public card only, with how many there are in all', async () => {
    const sentAt = new Date('2026-11-17T09:00:00Z');
    arm(STEFAN, [], [{
      userId: 'u-g', displayName: 'Gerald Ng', avatarUrl: 'https://x/g.png', professionalRoleRaw: ['Founder', 'Advisor'], jobTitle: 'CEO',
      company: 'Ng Ventures', profileBadge: 'premium', sentAt, total: 37,
    }]);
    const res = await getPlatformMatches('u-stefan');
    expect(res.waiting).toEqual([{
      userId: 'u-g', displayName: 'Gerald Ng', avatarUrl: 'https://x/g.png', professionalRole: 'Founder, Advisor', company: 'Ng Ventures',
      profileBadge: 'premium', sentAt,
    }]);
    expect(res.waitingCount).toBe(37);
    const call = mockQuery.mock.calls.find(c => /FROM user_pokes wp/.test(String(c[0])))!;
    const sql = String(call[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("WHERE wp.sender_id = $1 AND wp.status = 'pending'");
    expect(sql).toContain("wu.status = 'active'");
    expect(sql).toContain('FROM user_blocks wb');
    expect(sql).toContain('ORDER BY w."sentAt" DESC');
    expect(sql).toContain('COUNT(*) OVER ()');
    expect(call[1]).toEqual(['u-stefan', WAITING_LIMIT]);
  });

  it('no waiting requests: an empty list and a count of 0; and a member with no finished profile still sees theirs', async () => {
    arm(STEFAN, []);
    expect(await getPlatformMatches('u-stefan')).toMatchObject({ waiting: [], waitingCount: 0 });
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM user_pokes wp/.test(sql)) return Promise.resolve({ rows: [{ userId: 'u-g', displayName: 'G', avatarUrl: null, professionalRoleRaw: null, jobTitle: 'CEO', company: null, profileBadge: null, sentAt: new Date(), total: 1 }] });
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{ ...STEFAN, onboardingCompleted: false }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await getPlatformMatches('u-stefan');
    expect(res).toMatchObject({ profileIncomplete: true, matches: [], waitingCount: 1, wantsBroad: false });
    expect(res.waiting[0].professionalRole).toBe('CEO'); // no roles: their job title
  });

  it('equal fits are ordered by what the two share, not by id, and none of it reaches a card', async () => {
    const a = { ...PLAIN_FOUNDER, id: 'u-a', industry: 'Fintech' };
    const z = { ...PLAIN_FOUNDER, id: 'u-z', industry: 'Fintech', sharedContext: 2, lastActiveAt: new Date() };
    arm(WANTS_FINTECH_FOUNDERS, [a, z]);
    const { matches } = await getPlatformMatches('u-v');
    expect(matches.map(m => m.userId)).toEqual(['u-z', 'u-a']);
    expect(JSON.stringify(matches)).not.toMatch(/sharedContext|lastActiveAt/);
    expect(sqlOf(/u\.id <> \$1/)).toMatch(/AS "sharedContext"/);
  });

  it('a card carries the badge an admin gave them, or null', async () => {
    arm(WANTS_FINTECH_FOUNDERS, [{ ...PLAIN_FOUNDER, id: 'u-a', industry: 'Fintech', profileBadge: 'premium' }, { ...PLAIN_FOUNDER, id: 'u-b', industry: 'Fintech' }]);
    const { matches } = await getPlatformMatches('u-v');
    expect(Object.fromEntries(matches.map(m => [m.userId, m.profileBadge]))).toEqual({ 'u-a': 'premium', 'u-b': null });
    expect(sqlOf(/u\.id <> \$1/)).toContain('u.profile_badge AS "profileBadge"');
  });
});

describe('the "someone new matches" bell follows the same rule', () => {
  beforeEach(() => mockQuery.mockReset());

  function arm(newcomer: IntentProfile, members: IntentProfile[]) {
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{ ...newcomer, onboardingCompleted: true }] });
      if (/SELECT profile_visible, email/.test(sql)) return Promise.resolve({ rows: [{ profile_visible: true, email: 'newcomer@gmail.com' }] });
      if (/u\.id <> \$1 AND u\.status = 'active'/.test(sql)) return Promise.resolve({ rows: members });
      if (/SELECT id FROM notifications/.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('a newcomer who is only a founder does not ring a member who wants fintech founders', async () => {
    arm(PLAIN_FOUNDER, [WANTS_FINTECH_FOUNDERS]);
    expect(await notifyMatchesOfNewUser('u-f')).toBe(0);
  });

  it('a fintech founder does, and the bell says why', async () => {
    arm({ ...PLAIN_FOUNDER, industry: 'Fintech' }, [WANTS_FINTECH_FOUNDERS]);
    expect(await notifyMatchesOfNewUser('u-f')).toBe(1);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(String(c[0])))!;
    expect((insert[1] as unknown[])[2]).toBe("You're looking to meet founders — Gerald is a Founder, and their profile mentions fintech");
  });
});
