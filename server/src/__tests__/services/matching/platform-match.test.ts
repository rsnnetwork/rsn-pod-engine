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

import logger from '../../../config/logger';
import { canBring } from '@rsn/shared';
import { visibleEventSql } from '../../../services/session/session-access';
import { REQUEST_MESSAGE_MAX } from '../../../services/poke/request-message';
import {
  scoreFit, scoreWants, scoreWantsForRecipient, wantedDesignations, getPlatformMatches, expressInterest,
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

  // 9 Sep 2026 (Stefan): a narrow profile must never get an empty page. With
  // fewer than 3 strong matches the closest people are shown too, labelled —
  // so the strict list now carries the mild candidate as a "Close match", and
  // browse mode still shows them plainly.
  it('a narrow profile is never empty: fewer than 3 strong matches also shows the closest people, labelled', async () => {
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
    expect(strict.matches.length).toBe(1);
    expect(strict.matches[0].reason).toMatch(/^Close match — /);
    expect(browse.matches.length).toBe(1);
    expect(browse.matches[0].reason).not.toMatch(/^Close match/);
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

  // ── For You data (REASON milestone 1, Task A6) ─────────────────────────────

  it('For You cards carry saved, strength, industry and the public offer; the payload carries the viewer\'s own want', async () => {
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [{ ...INVESTOR, industry: 'Venture capital', whatICanHelpWith: 'Seed cheques and intros', saved: true }],
    });
    const res = await getPlatformMatches('u-founder');
    expect(res.youAreLookingFor).toBe('investors and angels for my seed round');
    expect(res.matches[0]).toMatchObject({
      industry: 'Venture capital', theyCanBring: 'Seed cheques and intros', saved: true, strength: 'strong',
    });
  });

  it('people the member passed on are excluded, and the Save state is read in the same query', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [] });
    await getPlatformMatches('u-founder');
    const candidateSql = mockQuery.mock.calls.map(c => c[0] as string).find(s => /u\.id <> \$1/.test(s))!;
    expect(candidateSql).toMatch(/LEFT JOIN person_responses pr/);
    expect(candidateSql).toMatch(/pr\.response IS NULL OR pr\.response <> 'passed'/);
  });

  it('the next event never reveals a private pod\'s event, nor an invite-only one the member cannot open (T2, D1)', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [] });
    await getPlatformMatches('u-founder');
    const call = mockQuery.mock.calls.find(c => /FROM sessions/.test(String(c[0])))!;
    // The events list's own rule (visibleEventSql): a public pod, the member's own pod, or an event they host,
    // co-host or hold a place in.
    expect(String(call[0])).toContain(visibleEventSql('s', '$1'));
    expect(String(call[0])).not.toMatch(/invite_only/);
    expect(call[1]).toEqual(['u-founder']);
  });

  it('the Save state is the member\'s OWN response to the person, never the person\'s response to the member', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [] });
    await getPlatformMatches('u-founder');
    const candidateSql = mockQuery.mock.calls.map(c => c[0] as string).find(s => /u\.id <> \$1/.test(s))!;
    expect(candidateSql).toMatch(/\(pr\.response = 'saved'\) AS "saved"/);
    // $1 is the member: pr.user_id = $1 means "the member's response about u". The mirror
    // image (pr.target_user_id = $1) would hide people who passed on the member.
    expect(candidateSql).toMatch(/LEFT JOIN person_responses pr ON pr\.user_id = \$1 AND pr\.target_user_id = u\.id/);
  });

  it('a strong match says strong and a Close match says close, in strict and browse mode alike', async () => {
    const mild = profile({
      id: 'u-mild', displayName: 'Maryam',
      professionalRole: 'Marketing Consultant', expertiseText: 'growth and funding narratives',
    });
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [mild, INVESTOR],
    });
    const strengths = (r: Awaited<ReturnType<typeof getPlatformMatches>>) => r.matches.map(m => [m.userId, m.strength]);
    const expected = [['u-investor', 'strong'], ['u-mild', 'close']];
    expect(strengths(await getPlatformMatches('u-founder'))).toEqual(expected);
    expect(strengths(await getPlatformMatches('u-founder', { browse: true }))).toEqual(expected);
  });

  it('saved is true only when the member saved the person: no response row reads as not saved', async () => {
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [
        { ...INVESTOR, id: 'u-saved', saved: true },
        { ...INVESTOR, id: 'u-no-row', saved: null }, // the LEFT JOIN found no response
      ],
    });
    const res = await getPlatformMatches('u-founder');
    expect(Object.fromEntries(res.matches.map(m => [m.userId, m.saved]))).toEqual({ 'u-saved': true, 'u-no-row': false });
  });

  it('the public offer is what they can help with, else their expertise, cut to a card; no offer is null', async () => {
    const longOffer = 'Introductions to seed funds across Europe and the Gulf. '.repeat(10);
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [
        { ...INVESTOR, id: 'u-help', whatICanHelpWith: 'Seed cheques and intros', expertiseText: 'early stage SaaS investing' },
        { ...INVESTOR, id: 'u-blank', whatICanHelpWith: '   ', expertiseText: 'early stage SaaS investing' },
        { ...INVESTOR, id: 'u-none', whatICanHelpWith: null, expertiseText: null },
        { ...INVESTOR, id: 'u-long', whatICanHelpWith: longOffer },
      ],
    });
    const res = await getPlatformMatches('u-founder');
    const offer = (id: string) => res.matches.find(m => m.userId === id)!.theyCanBring;
    expect(offer('u-help')).toBe('Seed cheques and intros');
    expect(offer('u-blank')).toBe('early stage SaaS investing'); // a blank answer falls through to expertise
    expect(offer('u-none')).toBeNull();
    expect(offer('u-long')).toHaveLength(160);
    expect(offer('u-long')!.endsWith('…')).toBe(true);
  });

  // 21 Oct 2026 (final review): "They can bring" reads the offer by the Human Profile's own rule (canBring,
  // in @rsn/shared), so a card and the profile it opens never show one offer two ways. An answer with no
  // letter or digit in it ('.', '…', '!!!') is no answer: the card goes on to their expertise, or shows none.
  it.each([
    ['an offer of only punctuation falls through to their expertise', { whatICanHelpWith: '...', expertiseText: 'early stage SaaS investing' }, 'early stage SaaS investing'],
    ['an offer of an ellipsis, with no expertise, is no offer', { whatICanHelpWith: '…', expertiseText: null }, null],
    ['an offer of exclamation marks and expertise of dashes is no offer', { whatICanHelpWith: '!!!', expertiseText: '- - -' }, null],
    ['an offer of an emoji alone is no offer', { whatICanHelpWith: '🙂', expertiseText: null }, null],
    ['a real offer is the offer', { whatICanHelpWith: 'Seed cheques and intros', expertiseText: 'early stage SaaS investing' }, 'Seed cheques and intros'],
  ])('%s, as the Human Profile shows it', async (_what, offer, expected) => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [{ ...INVESTOR, ...offer }] });
    const res = await getPlatformMatches('u-founder');
    expect(res.matches.map(m => m.userId)).toEqual(['u-investor']); // the premise: they are on the list
    expect(res.matches[0].theyCanBring).toBe(expected);
    expect(res.matches[0].theyCanBring).toBe(canBring({ ...INVESTOR, ...offer }));
  });

  it('no card carries another member\'s wants: only their public offer, role and industry', async () => {
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [{
        ...INVESTOR, industry: 'Venture capital', whatICanHelpWith: 'Seed cheques and intros',
        whoIWantToMeet: 'zzsecretwho', whyIWantToMeet: 'zzsecretwhy', myIntent: 'zzsecretintent',
        whatICareAbout: 'zzsecretcare', goals: ['zzsecretgoal'], interests: ['zzsecretinterest'],
      }],
    });
    const res = await getPlatformMatches('u-founder');
    expect(res.matches).toHaveLength(1); // the premise: the person IS shown, with their secrets on the row
    expect(JSON.stringify(res)).not.toMatch(/zzsecret/);
  });

  it('youAreLookingFor is the member\'s own want: what they want to meet, else their intent, else null', async () => {
    const lookingFor = async (over: Partial<IntentProfile>) => {
      armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, ...over, onboardingCompleted: true }, candidates: [] });
      return (await getPlatformMatches('u-founder')).youAreLookingFor;
    };
    expect(await lookingFor({})).toBe('investors and angels for my seed round');
    expect(await lookingFor({ whoIWantToMeet: '' })).toBe('raise funding for my SaaS startup'); // a blank answer falls through
    expect(await lookingFor({ whoIWantToMeet: '   ' })).toBe('raise funding for my SaaS startup');
    expect(await lookingFor({ whoIWantToMeet: null, myIntent: null })).toBeNull();
    expect(await lookingFor({ whoIWantToMeet: 'investors '.repeat(40) })).toHaveLength(160);
  });

  it('a member with no finished profile has no want to show back', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: false } });
    expect(await getPlatformMatches('u-founder')).toMatchObject({ profileIncomplete: true, matches: [], youAreLookingFor: null });
    armQueries({}); // no such member at all
    expect(await getPlatformMatches('u-ghost')).toMatchObject({ profileIncomplete: true, matches: [], youAreLookingFor: null });
  });
});

describe('expressInterest — the introduction rides the poke rails', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); });

  it('sends the introduction as the poke message: no want stated by the sender, so the neutral sentence', async () => {
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

    // The INVESTOR expresses interest in the FOUNDER. This test used to expect
    // "why the investor fits what the FOUNDER wanted", which is the recipient's
    // own want, and the sender reads the message back (5 Oct 2026). The investor
    // stated no want. 30 Oct 2026: with no reason REASON says nothing at all, rather than a
    // sentence that only looks like a reason, and there is no note, so the request carries neither.
    await expressInterest('u-investor', 'u-founder');
    expect(mockSendPoke).toHaveBeenCalledTimes(1);
    expect(mockSendPoke.mock.calls[0]).toEqual(['u-investor', 'u-founder', undefined, undefined, undefined, undefined]);
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

describe('expressInterest with a personal note and format (milestone 1)', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); mockSendPoke.mockResolvedValue({ id: 'p1' }); });

  function armProfiles() {
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [(params as string[])[0] === 'u-founder' ? FOUNDER_SEEKING_INVESTORS : INVESTOR] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('leads with the member\'s own note and attaches REASON\'s reason, with the format', async () => {
    armProfiles();
    await expressInterest('u-founder', 'u-investor', undefined, { note: '  I would love your view on our seed round.  ', format: 'coffee' });
    const [sender, recipient, message, agentId, format, reasonLine] = mockSendPoke.mock.calls[0];
    expect([sender, recipient, agentId, format]).toEqual(['u-founder', 'u-investor', undefined, 'coffee']);
    // 30 Oct 2026: the note and REASON's line travel apart, the line in the third person.
    expect(message).toBe('I would love your view on our seed round.');
    expect(reasonLine).toMatch(/^Fatima is looking to meet .+, and Iqbal is an Angel Investor\.$/);
    expect(String(reasonLine).length).toBeLessThanOrEqual(REQUEST_MESSAGE_MAX);
  });

  it('a note is still sent as written when the profiles cannot be loaded', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expressInterest('u-founder', 'u-investor', undefined, { note: 'Hello there' });
    expect(mockSendPoke.mock.calls[0][2]).toBe('Hello there');
  });

  it('profiles that give no reason to attach: the note is sent exactly as written', async () => {
    // Both members load, but neither has said what they want, so there is nothing to attach.
    mockQuery.mockImplementation((sql: string, params: unknown[]) => (
      /WHERE u\.id = \$1/.test(sql)
        ? Promise.resolve({ rows: [profile({ id: (params as string[])[0], displayName: 'Quinn' })] })
        : Promise.resolve({ rows: [] })
    ));
    await expressInterest('u-a', 'u-b', undefined, { note: '  Hello there  ', format: 'video_20' });
    const [, , message, , format, reasonLine] = mockSendPoke.mock.calls[0];
    expect(message).toBe('Hello there');
    expect(format).toBe('video_20');
    expect(reasonLine).toBeUndefined();

    // The premise: without a note this same pair sends nothing at all, so there really was no reason.
    mockSendPoke.mockClear();
    await expressInterest('u-a', 'u-b');
    expect(mockSendPoke.mock.calls[0].slice(2)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('without a note it still writes the introduction itself, and passes no format', async () => {
    armProfiles();
    await expressInterest('u-founder', 'u-investor');
    const [, , message, agentId, format, reasonLine] = mockSendPoke.mock.calls[0];
    expect(message).toBeUndefined();
    // REASON's own line, with no em dash and none of the old "We think you two should meet.".
    expect(reasonLine).toBe('Fatima is looking to meet investors, and Iqbal is an Angel Investor.');
    expect(reasonLine).not.toMatch(/—|We think you two should meet/);
    expect(agentId).toBeUndefined();
    expect(format).toBeUndefined();
  });
});

// ─── A meeting request never quotes the recipient's own want (5 Oct 2026) ────
//
// When the sender had no stated want that fitted the recipient, the request
// fell back to text written from the RECIPIENT's own want ("You're looking to
// meet investors — Iqbal is an Angel Investor"). The sender reads the stored
// message twice: in the 201 response of the interest call and, once the
// recipient accepts, as the first message of their conversation. So pressing
// "I want to meet" told a member what another member privately wants to meet.
// Stefan's approved point 1: another member's wants stay private. The message
// may now carry only what the SENDER chose to share.
describe('expressInterest never quotes the recipient\'s own want', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); mockSendPoke.mockResolvedValue({ id: 'p1' }); });

  // Serves the given profiles by id, and an agent's want text when it is asked for.
  function armPair(profiles: IntentProfile[], agents: Record<string, string> = {}) {
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      const id = (params as string[])[0];
      if (/WHERE u\.id = \$1/.test(sql)) {
        const found = profiles.find((p) => p.id === id);
        return Promise.resolve({ rows: found ? [{ ...found, onboardingCompleted: true }] : [] });
      }
      if (/FROM matching_agents/.test(sql)) {
        return Promise.resolve({ rows: id in agents ? [{ want_text: agents[id] }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  // The founder's own words ('investors and angels for my seed round'), and the
  // three openings the old fallback wrote its sentence with.
  const THE_RECIPIENTS_WANT = [
    'investors', 'angels', 'seed round',
    "You're looking to meet", "What you're looking for", 'Their profile matches',
  ];
  // Compares against an empty list, so a failure prints the message and the phrases found.
  function expectNoneOf(text: string, phrases: string[]) {
    const found = phrases.filter((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));
    expect({ message: text, found }).toEqual({ message: text, found: [] });
  }

  // The premise of every test below: the founder's own want DOES fit the
  // investor, so the old fallback had a sentence to write and would have used it.
  it('premise: the recipient\'s own want fits the sender, and that fit is worded with the founder\'s want', () => {
    const fallback = scoreFit(FOUNDER_SEEKING_INVESTORS, INVESTOR);
    expect(fallback.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(fallback.reason).toMatch(/^You're looking to meet investors/);
  });

  it('a sender who stated no want: the message is the neutral sentence, with nothing from the recipient\'s want', async () => {
    armPair([FOUNDER_SEEKING_INVESTORS, INVESTOR]);

    await expressInterest('u-investor', 'u-founder');

    const [, , message, , , reasonLine] = mockSendPoke.mock.calls[0];
    expect([message, reasonLine]).toEqual([undefined, undefined]);
    expectNoneOf(JSON.stringify(mockSendPoke.mock.calls[0]), THE_RECIPIENTS_WANT);
  });

  it('a sender whose own want does not fit the recipient: nothing either', async () => {
    // Most senders HAVE a want; it just is not this person. That must not open
    // the door to the recipient's want either.
    const investorWantingChefs = { ...INVESTOR, whoIWantToMeet: 'pastry chefs and bakers' };
    armPair([FOUNDER_SEEKING_INVESTORS, investorWantingChefs]);

    await expressInterest('u-investor', 'u-founder');

    const [, , message, , , reasonLine] = mockSendPoke.mock.calls[0];
    expect([message, reasonLine]).toEqual([undefined, undefined]);
    expectNoneOf(JSON.stringify(mockSendPoke.mock.calls[0]), THE_RECIPIENTS_WANT);
  });

  it('the same pair with a note: the message is exactly the trimmed note', async () => {
    armPair([FOUNDER_SEEKING_INVESTORS, INVESTOR]);

    await expressInterest('u-investor', 'u-founder', undefined, { note: '  I would value a short chat.  ' });

    const [, , message, , , reasonLine] = mockSendPoke.mock.calls[0];
    expect(message).toBe('I would value a short chat.');
    expect(reasonLine).toBeUndefined();
    expectNoneOf(JSON.stringify(mockSendPoke.mock.calls[0]), [...THE_RECIPIENTS_WANT, 'Why REASON suggested this']);
  });

  it('the sender\'s own want that fits the recipient is still the reason, now its own line in the third person', async () => {
    armPair([FOUNDER_SEEKING_INVESTORS, INVESTOR]);
    const LINE = 'Fatima is looking to meet investors, and Iqbal is an Angel Investor.';

    await expressInterest('u-founder', 'u-investor');
    expect(mockSendPoke.mock.calls[0].slice(2)).toEqual([undefined, undefined, undefined, LINE]);

    mockSendPoke.mockClear();
    await expressInterest('u-founder', 'u-investor', undefined, { note: 'Hello there' });
    expect(mockSendPoke.mock.calls[0].slice(2)).toEqual(['Hello there', undefined, undefined, LINE]);
  });

  it('an agent introduction says what the agent was looking for, never the recipient\'s own want', async () => {
    armPair([FOUNDER_SEEKING_INVESTORS, INVESTOR], { 'agent-founders': 'founders' });

    await expressInterest('u-investor', 'u-founder', 'agent-founders');

    const [, , message, agentId, , reasonLine] = mockSendPoke.mock.calls[0];
    expect(message).toBeUndefined();
    expect(reasonLine).toBe('Iqbal is looking to meet founders, and Fatima is a Founder.');
    expect(agentId).toBe('agent-founders');
    expectNoneOf(reasonLine, THE_RECIPIENTS_WANT);
  });

  it('an agent whose want does not fit the recipient: the neutral sentence, not the recipient\'s want', async () => {
    armPair([FOUNDER_SEEKING_INVESTORS, INVESTOR], { 'agent-chefs': 'pastry chefs' });

    await expressInterest('u-investor', 'u-founder', 'agent-chefs');

    const [, , message, agentId, , reasonLine] = mockSendPoke.mock.calls[0];
    expect([message, reasonLine]).toEqual([undefined, undefined]);
    expect(agentId).toBe('agent-chefs');
  });
});

// ─── A long note and a long reason are each kept whole (5 Oct 2026, 30 Oct 2026) ─────────────────
//
// A request held REQUEST_MESSAGE_MAX characters (500): the member's note, a blank line and
// "Why REASON suggested this: <reason>.", so a long note cut REASON's reason short. Since 30 Oct
// the two are stored apart (migration 120): the note is the request's message and the reason is
// its own line, each whole. Only the one text older clients read still runs them together within
// the cap, and request-text.test.ts pins how the line gives way there.
describe('expressInterest: a long note and a long reason are each kept whole', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); mockSendPoke.mockResolvedValue({ id: 'p1' }); });

  // A 100-character name (the longest the database holds) and a long title make a long reason.
  const LONG_NAME = 'Fatima Zahra Al-Hassan Rodriguez de la Vega Montgomery Featherstonehaugh the Third of Westminster Abbey';
  const LONG_TITLE = 'Managing Partner of a Seed Stage Venture Capital Fund';

  function arm(senderName = LONG_NAME) {
    const sender = { ...FOUNDER_SEEKING_INVESTORS, displayName: senderName };
    const recipient = { ...INVESTOR, professionalRole: [LONG_TITLE] };
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        const found = (params as string[])[0] === 'u-founder' ? sender : recipient;
        return Promise.resolve({ rows: [{ ...found, onboardingCompleted: true }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('a 300-character note goes whole as the message, and the whole reason as its own line', async () => {
    arm();
    const note = 'x'.repeat(300);
    await expressInterest('u-founder', 'u-investor', undefined, { note });
    const [, , message, , , reasonLine] = mockSendPoke.mock.calls[0];
    expect(message).toBe(note);
    expect(reasonLine).toBe(`${LONG_NAME} is looking to meet investors, and Iqbal is a ${LONG_TITLE}.`);
    expect(String(reasonLine).length).toBeLessThanOrEqual(REQUEST_MESSAGE_MAX);
  });

  it('a line longer than the cap is cut between words, and an emoji is never cut in half', async () => {
    arm('🌸'.repeat(300));
    await expressInterest('u-founder', 'u-investor');
    const line = String(mockSendPoke.mock.calls[0][5]);
    expect(line.length).toBeLessThanOrEqual(REQUEST_MESSAGE_MAX);
    expect(line.endsWith('…')).toBe(true);
    expect(new TextDecoder().decode(new TextEncoder().encode(line))).toBe(line); // no half emoji
  });
});


// ─── An agent's private want is read only for its owner (5 Oct 2026) ─────────
//
// An agent's want text is the owner's private search. expressInterest reads it to word
// the introduction that agent produced. routes/agents.ts checks the agent is the
// caller's before calling, so today only an owner arrives here, but the read itself
// must not hand the text to anyone else, and a failing read must not be silent.
describe('expressInterest reads an agent\'s want only for its owner', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); mockSendPoke.mockResolvedValue({ id: 'p1' }); });

  const AGENT = 'agent-founders';
  const WORDED_BY_THE_AGENT = 'Iqbal is looking to meet founders, and Fatima is a Founder.';
  /** REASON's line on the one request sent, the sixth thing sendPoke is given. */
  const lineSent = () => mockSendPoke.mock.calls[0][5];

  /**
   * The two members, and one agent that belongs to `owner`. The agent row is returned the way
   * Postgres would: for the owner named in the query, or, when the query names no owner, for
   * anyone who knows the id.
   */
  function armAgent(owner: string) {
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      const [first, second] = params as string[];
      if (/WHERE u\.id = \$1/.test(sql)) {
        const found = first === 'u-founder' ? FOUNDER_SEEKING_INVESTORS : INVESTOR;
        return Promise.resolve({ rows: [{ ...found, onboardingCompleted: true }] });
      }
      if (/FROM matching_agents/.test(sql)) {
        const asksForTheOwner = /user_id = \$2/.test(sql);
        const visible = first === AGENT && (!asksForTheOwner || second === owner);
        return Promise.resolve({ rows: visible ? [{ want_text: 'founders' }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('the owner\'s own agent still words the introduction', async () => {
    armAgent('u-investor');
    await expressInterest('u-investor', 'u-founder', AGENT);
    expect(lineSent()).toBe(WORDED_BY_THE_AGENT);
  });

  it('another member\'s agent id gives no want: the request is worded without it', async () => {
    armAgent('u-someone-else');
    await expressInterest('u-investor', 'u-founder', AGENT);
    expect(lineSent()).toBeUndefined();
    expect(mockSendPoke.mock.calls[0][2]).toBeUndefined(); // and no note stands in for it
  });

  it('asks the database for the agent AND its owner, who is the sender', async () => {
    armAgent('u-investor');
    await expressInterest('u-investor', 'u-founder', AGENT);
    const read = mockQuery.mock.calls.find((c) => /FROM matching_agents/.test(String(c[0])))!;
    expect(String(read[0])).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(read[1]).toEqual([AGENT, 'u-investor']);
  });

  it('a failing read is logged, not hidden, and the request is still sent', async () => {
    const failure = new Error('connection reset');
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        const found = (params as string[])[0] === 'u-founder' ? FOUNDER_SEEKING_INVESTORS : INVESTOR;
        return Promise.resolve({ rows: [{ ...found, onboardingCompleted: true }] });
      }
      if (/FROM matching_agents/.test(sql)) return Promise.reject(failure);
      return Promise.resolve({ rows: [] });
    });

    await expressInterest('u-investor', 'u-founder', AGENT);

    expect(mockSendPoke).toHaveBeenCalledTimes(1);
    expect(lineSent()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: failure, agentId: AGENT }), expect.any(String));
  });
});

// ─── What a reason prints comes from the public card (5 Oct 2026) ────────────────────────────────
// A want is matched on its synonyms too: "manufacturers" reaches "production" and "industrial",
// words the member never typed. The scorer counts a member's private interests as things they
// offer, so a synonym that only an interest contained was printed in the reason, which spelled
// the interest out to the member reading it (the reviewer's case). The words printed now come
// from the public card only. The interests still count towards the score, so nobody loses a match.
describe('a reason names only words from the other member\'s public card', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); mockSendPoke.mockResolvedValue({ id: 'p1' }); });

  const GENERIC = "Their profile matches what you're looking for";
  const viewer = profile({ id: 'u-viewer', displayName: 'Ali', whoIWantToMeet: 'manufacturers' });
  // Public card: a strategy consultant. Private: two interests that are synonyms of the want.
  const consultant = profile({
    id: 'u-consultant', displayName: 'Sarah Chen', firstName: 'Sarah', professionalRole: ['Strategy consultant'], jobTitle: 'Strategy consultant',
    industry: 'Consulting', whatICanHelpWith: 'Go-to-market strategy',
    interests: ['industrial design', 'production of short films'],
  });
  // The same kind of words, but on the public card.
  const fabricator = { ...consultant, bio: 'We run an industrial fabrication shop with machining', interests: null };
  const privateWords = /production|industrial|short films/i;

  describe('scoreFit', () => {
    it('a fit that only the private interests make keeps its score and prints none of their words', () => {
      const fit = scoreFit(viewer, consultant);
      expect(fit.score).toBeCloseTo(0.4667, 3); // unchanged: the interests still decide who is suggested
      expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(fit.reason).toBe(GENERIC);
      // Control: without the interests there is no fit at all, so they are what made it.
      expect(scoreFit(viewer, { ...consultant, interests: null }).score).toBe(0);
    });

    it('what they say they care about is held to the same rule', () => {
      const fit = scoreFit(viewer, { ...consultant, interests: null, whatICareAbout: 'industrial design and the production of short films' });
      expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(fit.reason).toBe(GENERIC);
    });

    it('a synonym that hits a public field still prints', () => {
      const fit = scoreFit(viewer, fabricator);
      expect(fit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
      expect(fit.reason).toMatch(/^What you're looking for matches their profile: /);
      for (const word of ['industrial', 'fabrication', 'machining']) expect(fit.reason).toContain(word);
    });

    it('with a public hit and a private one, only the public words print, and the private one still raises the score', () => {
      const both = scoreFit(viewer, { ...fabricator, interests: ['production of short films'] });
      const publicOnly = scoreFit(viewer, fabricator);
      expect(both.reason).toContain('industrial');
      expect(both.reason).not.toMatch(/production/i);
      expect(both.score).toBeGreaterThan(publicOnly.score);
    });

    it('a role or title match is named as before: those are public', () => {
      const fit = scoreFit(profile({ id: 'u-w', whoIWantToMeet: 'strategy consultants' }), { ...consultant, interests: ['sailing'] });
      expect(fit.reason).toMatch(/Strategy consultant/i);
    });
  });

  describe('the other ways the same analysis is worded', () => {
    it('scoreWants (an agent\'s want) prints none of the private words and keeps the score', () => {
      const fit = scoreWants(['manufacturers'], consultant, undefined, ['manufacturers']);
      expect(fit.score).toBeCloseTo(0.4667, 3);
      expect(fit.reason).toBe(GENERIC);
      expect(scoreWants(['manufacturers'], fabricator, undefined, ['manufacturers']).reason).toContain('fabrication');
    });

    it('scoreWantsForRecipient (the introduction) prints none of the private words and keeps the score', () => {
      const fit = scoreWantsForRecipient(['manufacturers'], consultant, 'Ali');
      expect(fit.score).toBeCloseTo(0.4667, 3);
      expect(fit.reason).toBe("Sarah's profile matches what Ali is looking for");
      expect(scoreWantsForRecipient(['manufacturers'], fabricator, 'Ali').reason)
        .toMatch(/^What Ali is looking for matches Sarah's profile: .*fabrication/);
    });
  });

  describe('every screen that shows a reason', () => {
    it('For You: the card keeps its place and its strength, and its reason names no private word', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (/FROM sessions/.test(sql)) return Promise.resolve({ rows: [] });
        if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{ ...viewer, onboardingCompleted: true }] });
        return Promise.resolve({ rows: [consultant] }); // the candidates
      });
      const { matches } = await getPlatformMatches('u-viewer');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ userId: 'u-consultant', strength: 'strong', reason: GENERIC });
      // The fit is about 0.467; a card carries only its band (21 Oct 2026, see platform-match-mutual.test.ts).
      expect(matches[0].score).toBe(1);
    });

    it('the "someone new matches" bell: the member is still told, and the body names no private word', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{ ...consultant, onboardingCompleted: true }] }); // the newcomer
        if (/u\.id <> \$1 AND u\.status = 'active'/.test(sql)) return Promise.resolve({ rows: [viewer] }); // existing members
        if (/SELECT id FROM notifications/.test(sql)) return Promise.resolve({ rows: [] });
        if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
        return Promise.resolve({ rows: [] });
      });
      expect(await notifyMatchesOfNewUser('u-consultant')).toBe(1);
      const insert = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
      expect((insert[1] as unknown[])[0]).toBe('u-viewer');
      expect((insert[1] as unknown[])[2]).toBe(GENERIC);
    });

    it('the introduction text: the sender\'s own want is still attached, and nothing of the recipient\'s private interests', async () => {
      mockQuery.mockImplementation((sql: string, params: unknown[]) => {
        if (/WHERE u\.id = \$1/.test(sql)) {
          const found = [viewer, consultant].find((p) => p.id === (params as string[])[0]);
          return Promise.resolve({ rows: found ? [{ ...found, onboardingCompleted: true }] : [] });
        }
        return Promise.resolve({ rows: [] });
      });
      await expressInterest('u-viewer', 'u-consultant');
      const line = mockSendPoke.mock.calls[0][5] as string;
      expect(line).toBe("Sarah's profile matches what Ali is looking for.");
      expect(JSON.stringify(mockSendPoke.mock.calls[0])).not.toMatch(privateWords);
    });
  });
});

// 7 Oct 2026: a want that names a region used to empty For You. The demo that showed it: a member
// who wanted "fintech founders, seed investors and payments partners in Europe" got no suggestions
// although every other member lived in a European city; the same want without "in Europe" gave
// six strong matches.
describe('For You with a place in the want', () => {
  beforeEach(() => mockQuery.mockReset());

  const STACK = 'fintech founders, seed investors and payments partners';
  const founder = (id: string, name: string, location: string | null) => profile({
    id, displayName: name, professionalRole: ['Founder'], jobTitle: 'Co-founder & CEO', company: `${name} Pay`,
    industry: 'Fintech', expertiseText: 'payments infrastructure and seed fundraising', location,
    // A private interest, to show the region never drags one into the reason.
    interests: ['sailing'],
  });
  const people = [
    founder('u-berlin', 'Anna', 'Berlin, Germany'),
    founder('u-amsterdam', 'Bram', 'Amsterdam, Netherlands'),
    founder('u-milan', 'Chiara', 'Milan, Italy'),
    founder('u-austin', 'Alex', 'Austin, Texas'),
  ];
  const viewer = (want: string) => ({
    ...profile({ id: 'u-viewer', displayName: 'Vic', whoIWantToMeet: want }), onboardingCompleted: true,
  });
  const forYou = async (want: string) => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM sessions/.test(sql)) return Promise.resolve({ rows: [] });
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [viewer(want)] });
      return Promise.resolve({ rows: people });
    });
    return (await getPlatformMatches('u-viewer')).matches;
  };

  it('control: without a place, all four are suggested', async () => {
    const matches = await forYou(STACK);
    expect(matches.map(m => m.userId).sort()).toEqual(['u-amsterdam', 'u-austin', 'u-berlin', 'u-milan']);
    expect(matches.every(m => m.strength === 'strong')).toBe(true);
  });

  it('"in Europe" suggests the three in Europe, strong, saying Europe, and not the one in Texas', async () => {
    const matches = await forYou(`${STACK} in Europe`);
    expect(matches.map(m => m.userId).sort()).toEqual(['u-amsterdam', 'u-berlin', 'u-milan']);
    for (const m of matches) {
      expect(m.strength).toBe('strong');
      expect(m.reason).toMatch(/\(in Europe\)$/);
      expect(m.reason).not.toMatch(/sailing|Berlin|Amsterdam|Milan|Germany|Netherlands|Italy/);
    }
  });

  it('"in DACH" suggests only the person in Germany', async () => {
    expect((await forYou(`${STACK} in DACH`)).map(m => m.userId)).toEqual(['u-berlin']);
  });

  it('an unknown place does not empty the list: "in Narnia" suggests all four, and says nothing about it', async () => {
    const matches = await forYou(`${STACK} in Narnia`);
    expect(matches.map(m => m.userId).sort()).toEqual(['u-amsterdam', 'u-austin', 'u-berlin', 'u-milan']);
    for (const m of matches) expect(m.reason).not.toMatch(/Narnia|\(in /);
  });

  it('a country the member names is still strict', async () => {
    const matches = await forYou(`${STACK} in the Netherlands`);
    expect(matches.map(m => m.userId)).toEqual(['u-amsterdam']);
    expect(matches[0].reason).toMatch(/\(in Netherlands\)$/);
  });
});
