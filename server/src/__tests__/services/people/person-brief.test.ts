const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));

const mockBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({ areBlocked: (...a: unknown[]) => mockBlocked(...a), __esModule: true }));
const mockGetUser = jest.fn();
jest.mock('../../../services/identity/identity.service', () => ({ getUserById: (...a: unknown[]) => mockGetUser(...a), __esModule: true }));
const mockLoadProfile = jest.fn();
const mockScore = jest.fn();
jest.mock('../../../services/matching/platform-match.service', () => ({
  loadProfile: (...a: unknown[]) => mockLoadProfile(...a),
  scoreFit: (...a: unknown[]) => mockScore(...a),
  MATCH_THRESHOLD: 0.45,
  BROWSE_THRESHOLD: 0.12,
  __esModule: true,
}));
const mockPokeWith = jest.fn();
jest.mock('../../../services/poke/poke.service', () => ({ getPokeWith: (...a: unknown[]) => mockPokeWith(...a), __esModule: true }));
const mockGetResponse = jest.fn();
jest.mock('../../../services/people/person-response.service', () => ({ getResponse: (...a: unknown[]) => mockGetResponse(...a), __esModule: true }));

import { getPersonBrief, listRecentConnections } from '../../../services/people/person-brief.service';
import { PRIVATE_MEMBER_KEYS } from '../../../services/user/public-card';
import { NotFoundError } from '../../../middleware/errors';

const VIEWER = 'a0000000-0000-4000-8000-000000000001';
const TARGET = 'b0000000-0000-4000-8000-000000000002';
const target = {
  id: TARGET, displayName: 'Sarah Chen', firstName: 'Sarah', lastName: 'Chen', avatarUrl: null, bio: 'Building Harbor.',
  company: 'Harbor Collective', jobTitle: 'Founder', industry: 'Consumer', location: 'London', linkedinUrl: null,
  languages: [], professionalRole: ['Founder'], expertiseText: null, whatICanHelpWith: 'Introductions to European retailers',
  whoIWantToMeet: 'SECRET-WANT operators who scaled DTC', whyIWantToMeet: 'SECRET-WHY', myIntent: 'SECRET-INTENT',
  email: 'sarah@example.com', status: 'active',
};

function arm(o: {
  blocked?: boolean; poke?: unknown; response?: string | null;
  enc?: Record<string, unknown> | null; conv?: Record<string, unknown> | null; score?: number;
} = {}) {
  mockBlocked.mockResolvedValue(!!o.blocked);
  mockGetUser.mockResolvedValue(target);
  mockLoadProfile.mockImplementation((id: string) => Promise.resolve(
    id === VIEWER
      ? { id, whoIWantToMeet: 'founders in consumer', myIntent: null }
      : { id, whoIWantToMeet: target.whoIWantToMeet, whatICanHelpWith: target.whatICanHelpWith, expertiseText: null },
  ));
  mockScore.mockReturnValue({ score: o.score ?? 0.6, reason: "You're looking to meet founders — Sarah Chen is a Founder" });
  mockPokeWith.mockResolvedValue(o.poke ?? null);
  mockGetResponse.mockResolvedValue(o.response ?? null);
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM encounter_history WHERE/.test(sql)) return Promise.resolve({ rows: o.enc ? [o.enc] : [] });
    if (/FROM dm_conversations WHERE/.test(sql)) return Promise.resolve({ rows: o.conv ? [o.conv] : [] });
    return Promise.resolve({ rows: [] });
  });
}

describe('getPersonBrief', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never carries the other member\'s private fields, and the opener never quotes them', async () => {
    arm();
    const brief = await getPersonBrief(VIEWER, TARGET);
    for (const k of PRIVATE_MEMBER_KEYS) expect(brief.person).not.toHaveProperty(k);
    expect(JSON.stringify(brief)).not.toMatch(/SECRET-/);
    expect(brief.theyCanBring).toBe('Introductions to European retailers');
    expect(brief.youAreLookingFor).toBe('founders in consumer');
  });

  it('builds "your path" only from relationships both people chose', async () => {
    arm();
    await getPersonBrief(VIEWER, TARGET);
    const sql = mockQuery.mock.calls.map(c => String(c[0])).find(s => /FROM encounter_history e1/.test(s))!;
    expect(sql).toMatch(/e1\.times_met > 0 OR e1\.last_session_id IS NOT NULL/);
    expect(sql).toMatch(/mutual_meet_again = true/);
    expect(sql).toMatch(/p\.status = 'accepted'/);
    expect(sql).toMatch(/user_blocks/);
  });

  it('hides blocked and closed people as not found, and refuses yourself', async () => {
    arm({ blocked: true });
    await expect(getPersonBrief(VIEWER, TARGET)).rejects.toMatchObject({ statusCode: 404 });
    arm();
    mockGetUser.mockResolvedValue({ ...target, status: 'deactivated' });
    await expect(getPersonBrief(VIEWER, TARGET)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPersonBrief(VIEWER, VIEWER)).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each([
    ['none', {}],
    ['requested', { poke: { id: 'p1', status: 'pending', sentByMe: true } }],
    ['incoming', { poke: { id: 'p2', status: 'pending', sentByMe: false } }],
    ['declined', { poke: { id: 'p3', status: 'declined', sentByMe: true } }],
    ['connected', { poke: { id: 'p4', status: 'accepted', sentByMe: true }, enc: { times_met: 0, last_met_at: new Date(), last_session_id: null } }],
    ['met', { enc: { times_met: 2, last_met_at: new Date('2026-09-01'), last_session_id: 's1' } }],
    ['met', { conv: { id: 'c1', joined_a: new Date(), joined_b: new Date() } }],
  ] as const)('relationship state %s', async (state, o) => {
    arm(o as never);
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.relationship.state).toBe(state);
  });

  it('counts meetings from events and from a held 1:1 meeting', async () => {
    arm({ enc: { times_met: 2, last_met_at: new Date('2026-09-01'), last_session_id: 's1' }, conv: { id: 'c1', joined_a: new Date(), joined_b: new Date() } });
    expect((await getPersonBrief(VIEWER, TARGET)).relationship.timesMet).toBe(3);
  });

  it('only calls it a match above the browse threshold', async () => {
    arm({ score: 0.6 });
    expect((await getPersonBrief(VIEWER, TARGET)).match?.strength).toBe('strong');
    arm({ score: 0.2 });
    expect((await getPersonBrief(VIEWER, TARGET)).match?.strength).toBe('close');
    arm({ score: 0.05 });
    expect((await getPersonBrief(VIEWER, TARGET)).match).toBeNull();
  });

  it('carries the member\'s own Save/Pass', async () => {
    arm({ response: 'passed' });
    const r = (await getPersonBrief(VIEWER, TARGET)).relationship;
    expect(r.passed).toBe(true);
    expect(r.saved).toBe(false);
  });
});

describe('listRecentConnections', () => {
  it('lists accepted requests either way, newest first, skipping blocked people', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ user_id: TARGET, display_name: 'Sarah Chen', avatar_url: null, connected_at: new Date('2026-09-20T10:00:00Z') }] });
    const out = await listRecentConnections(VIEWER);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/status = 'accepted'/);
    expect(sql).toMatch(/user_blocks/);
    expect(sql).toMatch(/ORDER BY connected_at DESC/);
    expect(out).toEqual([{ userId: TARGET, displayName: 'Sarah Chen', avatarUrl: null, connectedAt: '2026-09-20T10:00:00.000Z' }]);
  });
});

// ─── Beyond the brief: what the person page must never show, and which way each read points ───

describe('getPersonBrief: a person you cannot open', () => {
  beforeEach(() => jest.clearAllMocks());

  // A link to a blocked, closed or unknown member must show "not available" and
  // nothing about them, and must not reveal which of the three it is.
  const reads = () => [mockLoadProfile, mockQuery, mockPokeWith, mockGetResponse].every(m => m.mock.calls.length === 0);

  it.each([['blocked'], ['deactivated'], ['suspended'], ['banned']])('reads nothing else about someone who is %s', async (why) => {
    arm({ blocked: why === 'blocked' });
    if (why !== 'blocked') mockGetUser.mockResolvedValue({ ...target, status: why });
    await expect(getPersonBrief(VIEWER, TARGET)).rejects.toMatchObject({ statusCode: 404 });
    expect(reads()).toBe(true);
  });

  it('answers blocked, closed and unknown in exactly the same words', async () => {
    const caught = async () => getPersonBrief(VIEWER, TARGET).then(() => null, (e: Error & { statusCode: number; code: string }) => e);
    arm({ blocked: true });
    const blocked = await caught();
    arm();
    mockGetUser.mockResolvedValue({ ...target, status: 'deactivated' });
    const closed = await caught();
    mockGetUser.mockRejectedValue(new NotFoundError('User', TARGET));
    const unknown = await caught();
    expect(blocked).toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    expect({ status: closed?.statusCode, code: closed?.code, message: closed?.message })
      .toEqual({ status: blocked?.statusCode, code: blocked?.code, message: blocked?.message });
    expect({ status: unknown?.statusCode, code: unknown?.code, message: unknown?.message })
      .toEqual({ status: blocked?.statusCode, code: blocked?.code, message: blocked?.message });
  });

  it('refuses your own id before it reads anything', async () => {
    arm();
    await expect(getPersonBrief(VIEWER, VIEWER)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockBlocked).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(reads()).toBe(true);
  });
});

describe('getPersonBrief: the fit is judged on the public card only', () => {
  beforeEach(() => jest.clearAllMocks());

  // The scorer counts a member's private interests as things they offer, and words its reason from
  // whatever matched. A want is matched on its synonyms too ("manufacturers" reaches "production" and
  // "industrial"), so a reason could spell a private interest back to the person looking (the
  // reviewer's case, 5 Oct 2026). The brief can be aimed at ANY member by id, so it scores their
  // public card only. These tests use the real scorer, not the stand-in above.
  const realScoreFit = () => jest.requireActual<typeof import('../../../services/matching/platform-match.service')>(
    '../../../services/matching/platform-match.service',
  ).scoreFit;

  const viewer = {
    id: VIEWER, displayName: 'Ali', whoIWantToMeet: 'manufacturers', myIntent: null,
    whyIWantToMeet: null, goals: null, professionalRole: null, jobTitle: null,
  };
  // Public card: a strategy consultant. Private: two interests that happen to be synonyms of the want.
  const consultant = {
    id: TARGET, displayName: 'Sarah Chen', professionalRole: ['Strategy consultant'], jobTitle: 'Strategy consultant',
    industry: 'Consulting', whatICanHelpWith: 'Go-to-market strategy', expertiseText: null,
    whatICareAbout: 'industrial design and production of short films',
    interests: ['industrial design', 'production of short films'],
    whoIWantToMeet: 'SECRETWANT investors', whyIWantToMeet: 'SECRETWHY', myIntent: 'SECRETINTENT', goals: ['SECRETGOAL'],
  };
  const armWith = (them: object) => {
    arm();
    mockScore.mockImplementation(realScoreFit());
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER ? viewer : them));
  };

  it('a fit that only the private interests make is no match at all, and none of their words reach the brief', async () => {
    armWith(consultant);
    // The row the user lookup returns carries the private interests too; the public card must drop them.
    mockGetUser.mockResolvedValue({ ...target, industry: 'Consulting', jobTitle: 'Strategy consultant', interests: consultant.interests });

    const brief = await getPersonBrief(VIEWER, TARGET);

    expect(brief.match).toBeNull();
    const everything = JSON.stringify(brief).toLowerCase();
    for (const word of ['production', 'industrial', 'short films', 'secretwant', 'secretwhy', 'secretintent', 'secretgoal', 'secret-', 'sarah@example.com']) {
      expect(everything).not.toContain(word);
    }
    // Control: scored on the whole profile the same pair DOES fit, strongly. So the interests are
    // exactly what the brief leaves out, and the checks above are not passing for want of a match.
    expect(realScoreFit()(viewer as never, consultant as never).score).toBeGreaterThanOrEqual(0.45);
  });

  it('a synonym that hits a public field still matches, and is named', async () => {
    armWith({ ...consultant, bio: 'We run an industrial fabrication shop with machining', interests: null, whatICareAbout: null });

    const brief = await getPersonBrief(VIEWER, TARGET);

    expect(brief.match?.strength).toBe('strong');
    expect(brief.match?.reason).toMatch(/industrial/);
    expect(brief.match?.reason).toMatch(/fabrication/);
  });

  it('with a public hit and a private one, only the public word is named', async () => {
    armWith({ ...consultant, bio: 'We run an industrial fabrication shop with machining' });

    const brief = await getPersonBrief(VIEWER, TARGET);

    expect(brief.match?.reason).toMatch(/industrial/);
    expect(brief.match?.reason).not.toMatch(/production/);
  });

  it('hands the scorer the viewer\'s own profile and, of the other member, only what is on the public card', async () => {
    arm();
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER ? viewer : consultant));

    await getPersonBrief(VIEWER, TARGET);

    const [me, them] = mockScore.mock.calls[0];
    expect(me).toBe(viewer); // the viewer's own want is what decides the fit
    expect(them).toMatchObject({
      id: TARGET, displayName: 'Sarah Chen', professionalRole: ['Strategy consultant'], jobTitle: 'Strategy consultant',
      industry: 'Consulting', whatICanHelpWith: 'Go-to-market strategy',
    });
    for (const k of PRIVATE_MEMBER_KEYS) if (k in them) expect(them[k]).toBeNull();
    expect(JSON.stringify(them)).not.toMatch(/SECRET|industrial design|short films/i);
  });
});

describe('getPersonBrief: whose answers, and which way each read points', () => {
  beforeEach(() => jest.clearAllMocks());

  const callWith = (re: RegExp) => mockQuery.mock.calls.find(c => re.test(String(c[0])))!;

  it('reads the viewer\'s own Save/Pass, request and recorded answers about the person, never the reverse', async () => {
    arm();
    await getPersonBrief(VIEWER, TARGET);
    expect(mockGetResponse).toHaveBeenCalledWith(VIEWER, TARGET);
    expect(mockPokeWith).toHaveBeenCalledWith(VIEWER, TARGET);
    const outcomes = callWith(/FROM meeting_outcomes/);
    expect(String(outcomes[0]).replace(/\s+/g, ' ')).toMatch(/WHERE user_id = \$1 AND target_user_id = \$2/);
    expect(outcomes[1]).toEqual([VIEWER, TARGET]);
  });

  it('looks the pair up in stored order (lower id first) whichever of the two is looking', async () => {
    arm();
    await getPersonBrief(VIEWER, TARGET);
    expect(callWith(/FROM encounter_history WHERE/)[1]).toEqual([VIEWER, TARGET]);
    expect(callWith(/FROM dm_conversations WHERE/)[1]).toEqual([VIEWER, TARGET]);

    jest.clearAllMocks();
    arm();
    mockGetUser.mockResolvedValue({ ...target, id: VIEWER, status: 'active' });
    await getPersonBrief(TARGET, VIEWER);
    expect(callWith(/FROM encounter_history WHERE/)[1]).toEqual([VIEWER, TARGET]);
    expect(callWith(/FROM dm_conversations WHERE/)[1]).toEqual([VIEWER, TARGET]);
  });

  it('asks every shared list and the path about this viewer and this person', async () => {
    arm();
    await getPersonBrief(VIEWER, TARGET);
    for (const re of [/FROM circle_members x/, /FROM pod_members x/, /FROM session_participants x/, /FROM encounter_history e1/]) {
      expect(callWith(re)[1]).toEqual([VIEWER, TARGET]);
    }
  });
});

describe('getPersonBrief: what the page is given', () => {
  beforeEach(() => jest.clearAllMocks());

  it('names the one person between you, and lists the shared circles, pods and next events', async () => {
    arm();
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM encounter_history e1/.test(sql)) return Promise.resolve({ rows: [{ id: 'm1', display_name: 'Mo Khan' }] });
      if (/FROM circle_members x/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1', name: 'Founders Circle' }] });
      if (/FROM pod_members x/.test(sql)) return Promise.resolve({ rows: [{ id: 'p1', name: 'Consumer Pod' }] });
      if (/FROM session_participants x/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 's9', title: 'Harbor Mixer', scheduled_at: new Date('2026-10-20T18:00:00Z') }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.path).toEqual({ id: 'm1', displayName: 'Mo Khan' });
    expect(brief.shared).toEqual({
      circles: [{ id: 'c1', name: 'Founders Circle' }],
      pods: [{ id: 'p1', name: 'Consumer Pod' }],
      upcomingEvents: [{ id: 's9', title: 'Harbor Mixer', scheduledAt: '2026-10-20T18:00:00.000Z' }],
    });
  });

  it('writes the first-20-minutes line from the two members\' own answers, in fixed words', async () => {
    arm();
    mockQuery.mockImplementation((sql: string) => Promise.resolve({
      rows: /FROM session_participants x/.test(sql)
        ? [{ id: 's9', title: 'Harbor Mixer', scheduled_at: new Date('2026-10-20T18:00:00Z') }] : [],
    }));
    expect((await getPersonBrief(VIEWER, TARGET)).opener).toBe(
      'Start with what Sarah can bring: Introductions to European retailers. Then say what you are looking for: founders in consumer. You will both be at Harbor Mixer.',
    );
  });

  it('falls back to the plain opener when neither member has said anything', async () => {
    arm();
    mockLoadProfile.mockResolvedValue({ id: 'x', whoIWantToMeet: null, myIntent: null, whatICanHelpWith: null, expertiseText: null });
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.theyCanBring).toBeNull();
    expect(brief.youAreLookingFor).toBeNull();
    expect(brief.opener).toBe('Start with why REASON put you two together.');
  });

  it('treats a blank offer as no offer, and reads the next field instead', async () => {
    arm();
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER
      ? { id, whoIWantToMeet: '', myIntent: 'meet founders who sell to retailers' }
      : { id, whatICanHelpWith: '', expertiseText: 'Retail partnerships.' }));
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.theyCanBring).toBe('Retail partnerships.');
    expect(brief.youAreLookingFor).toBe('meet founders who sell to retailers');
    expect(brief.opener).toBe('Start with what Sarah can bring: Retail partnerships. Then say what you are looking for: meet founders who sell to retailers.');
  });

  // `a || b` reads past '' but not past '   ': spaces are truthy, so the next field was never read.
  it('treats an answer that is only spaces as blank too, and reads the next field instead', async () => {
    arm();
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER
      ? { id, whoIWantToMeet: '   ', myIntent: 'meet founders who sell to retailers' }
      : { id, whatICanHelpWith: '  \n ', expertiseText: 'Retail partnerships.' }));
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.theyCanBring).toBe('Retail partnerships.');
    expect(brief.youAreLookingFor).toBe('meet founders who sell to retailers');
  });

  it('gives the request id only while a request is waiting on you, and the last-met date only for an event', async () => {
    const asked = (o: Parameters<typeof arm>[0]) => { arm(o); return getPersonBrief(VIEWER, TARGET).then(b => b.relationship); };
    expect((await asked({ poke: { id: 'p2', status: 'pending', sentByMe: false } })).pokeId).toBe('p2');
    expect((await asked({ poke: { id: 'p1', status: 'pending', sentByMe: true } })).pokeId).toBeNull();
    expect((await asked({ poke: { id: 'p4', status: 'accepted', sentByMe: false } })).pokeId).toBeNull();

    const atEvent = await asked({ enc: { times_met: 1, last_met_at: new Date('2026-09-01T09:00:00Z'), last_session_id: 's1' } });
    expect(atEvent.lastMetAt).toBe('2026-09-01T09:00:00.000Z');
    // A connection made by accepting a request writes an encounter row too; it is not a meeting.
    const acceptedOnly = await asked({
      poke: { id: 'p4', status: 'accepted', sentByMe: true },
      enc: { times_met: 0, last_met_at: new Date('2026-09-01T09:00:00Z'), last_session_id: null },
    });
    expect(acceptedOnly.lastMetAt).toBeNull();
    expect(acceptedOnly.timesMet).toBe(0);
    const oneToOneOnly = await asked({ conv: { id: 'c1', joined_a: new Date(), joined_b: new Date() } });
    expect(oneToOneOnly.timesMet).toBe(1);
    expect(oneToOneOnly.lastMetAt).toBeNull();
  });

  it('lists the viewer\'s recorded answers about the person, newest first as stored', async () => {
    arm();
    mockQuery.mockImplementation((sql: string) => Promise.resolve({
      rows: /FROM meeting_outcomes/.test(sql)
        ? [
          { worth_continuing: 'yes', outcome_keys: ['advice', 'follow_up'], created_at: new Date('2026-09-25T10:00:00Z') },
          { worth_continuing: 'maybe', outcome_keys: [], created_at: new Date('2026-09-10T10:00:00Z') },
        ] : [],
    }));
    expect((await getPersonBrief(VIEWER, TARGET)).relationship.outcomes).toEqual([
      { worthContinuing: 'yes', outcomes: ['advice', 'follow_up'], createdAt: '2026-09-25T10:00:00.000Z' },
      { worthContinuing: 'maybe', outcomes: [], createdAt: '2026-09-10T10:00:00.000Z' },
    ]);
  });
});

describe('getPersonBrief: the first-20-minutes line keeps the member\'s words as they wrote them', () => {
  beforeEach(() => jest.clearAllMocks());

  // `score` decides whether REASON has a reason for the pair (the brief's match), as elsewhere in this
  // file. `events` are the upcoming events the two share, soonest first. `user` is what the member
  // lookup returns about the other member.
  const briefFrom = async (
    offer: string | null, want: string | null,
    o: { score?: number; events?: string[]; user?: object } = {},
  ) => {
    arm({ score: o.score });
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER
      ? { id, whoIWantToMeet: want, myIntent: null }
      : { id, whatICanHelpWith: offer, expertiseText: null }));
    if (o.user) mockGetUser.mockResolvedValue({ ...target, ...o.user });
    const events = o.events;
    if (events) {
      mockQuery.mockImplementation((sql: string) => Promise.resolve({
        rows: /FROM session_participants x/.test(sql)
          ? events.map((title, i) => ({ id: `s${i}`, title, scheduled_at: new Date(Date.UTC(2026, 9, 20 + i, 18)) }))
          : [],
      }));
    }
    return getPersonBrief(VIEWER, TARGET);
  };
  const openerFrom = async (offer: string | null, want: string | null, o?: Parameters<typeof briefFrom>[2]) =>
    (await briefFrom(offer, want, o)).opener;

  // What a member types to get past a box. It has no letter or digit, and after a colon it reads as a mistake.
  const NO_ANSWER = ['.', '…', '!!!', '?!', '- - -', '🙂', '   ', ' \n '];

  // The words follow a colon, where their own first letter reads naturally, capital or not. Setting them
  // into a sentence lower-cased a proper noun ("google Ads") and read a first-person answer badly.
  it.each([
    'european market entry',
    'European market entry',
    'Google Ads and paid social',
    'Mentorship for first-time founders',
    'Building a marketplace for boat owners',
    'AWS cloud architecture',
    'UX research for consumer apps',
    'B2B sales',
    'LinkedIn growth',
    'SaaS pricing',
    '3 exits and a turnaround',
    "Women's health founders",
    'A technical co-founder',
  ])('keeps the offer "%s" as typed', async (offer) => {
    expect(await openerFrom(offer, null)).toBe(`Start with what Sarah can bring: ${offer}.`);
  });

  it('sets a first-person offer after the colon as it was written', async () => {
    expect(await openerFrom('I can help with pricing.', null)).toBe('Start with what Sarah can bring: I can help with pricing.');
    expect(await openerFrom("I'd help with hiring", null)).toBe("Start with what Sarah can bring: I'd help with hiring.");
  });

  it.each(['Founders in consumer goods', 'european retailers', 'AI founders in healthcare', 'I want to meet buyers'])(
    'keeps the viewer\'s own words "%s" as typed in what they are looking for, too',
    async (want) => {
      expect(await openerFrom(null, want)).toBe(
        `Start with why REASON put you two together. Then say what you are looking for: ${want}.`,
      );
    },
  );

  // A trailing run of . ! ? is replaced by one full stop, in whatever mix it was typed.
  it.each([
    'Fundraising', 'Fundraising.', 'Fundraising!', 'Fundraising?', 'Fundraising?!', 'Fundraising!!!', 'Fundraising...', 'Fundraising ?!',
  ])('ends the offer "%s" in exactly one full stop', async (offer) => {
    expect(await openerFrom(offer, null)).toBe('Start with what Sarah can bring: Fundraising.');
  });

  it.each(['meet founders', 'meet founders.', 'meet founders?!', 'meet founders...'])('ends the want "%s" in exactly one full stop', async (want) => {
    expect(await openerFrom('Fundraising', want)).toBe(
      'Start with what Sarah can bring: Fundraising. Then say what you are looking for: meet founders.',
    );
  });

  it('keeps an answer of several sentences whole, and closes only its end', async () => {
    expect(await openerFrom('Building Harbor. Mentorship for first-time founders!', null)).toBe(
      'Start with what Sarah can bring: Building Harbor. Mentorship for first-time founders.',
    );
  });

  // An answer that is only punctuation, symbols or spaces is no answer at all.
  it.each(NO_ANSWER)('an offer of %j is no offer: theyCanBring is null, and the line has no "can bring" clause', async (offer) => {
    const brief = await briefFrom(offer, null);
    expect(brief.theyCanBring).toBeNull();
    expect(brief.opener).toBe('Start with why REASON put you two together.');
    expect(brief.opener).not.toContain('can bring');
  });

  it.each(NO_ANSWER)('a want of %j is no want: youAreLookingFor is null, and the line has no "Then say" clause', async (want) => {
    const brief = await briefFrom('Fundraising', want);
    expect(brief.youAreLookingFor).toBeNull();
    expect(brief.opener).toBe('Start with what Sarah can bring: Fundraising.');
  });

  // A letter or digit in any script is an answer: members write in their own language.
  it.each(['市场营销', 'Ελληνικά', 'تسويق', 'Åäö', '2025'])('counts "%s" as an answer', async (offer) => {
    const brief = await briefFrom(offer, null);
    expect(brief.theyCanBring).toBe(offer);
    expect(brief.opener).toBe(`Start with what Sarah can bring: ${offer}.`);
  });

  // A blank answer already reads on to the next field; an answer with nothing in it to read does the same.
  it('reads past an answer that is only punctuation to the next field, as it does for a blank one', async () => {
    arm();
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER
      ? { id, whoIWantToMeet: '...', myIntent: 'meet founders who sell to retailers' }
      : { id, whatICanHelpWith: '!!!', expertiseText: 'Retail partnerships.' }));
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.theyCanBring).toBe('Retail partnerships.');
    expect(brief.youAreLookingFor).toBe('meet founders who sell to retailers');
  });

  // The line is judged on what the page would show, which is the answer after it is cut to length.
  it('counts an answer as empty when what is left after it is cut has no letter or digit', async () => {
    const brief = await briefFrom(`${'-'.repeat(200)}x`, null);
    expect(brief.theyCanBring).toBeNull();
    expect(brief.opener).toBe('Start with why REASON put you two together.');
  });

  describe('with no usable offer, the first line depends on whether REASON has a reason for the pair', () => {
    it.each([null, ...NO_ANSWER])('offer %j and a match: starts with why REASON put you two together', async (offer) => {
      const brief = await briefFrom(offer, null);
      expect(brief.match).not.toBeNull();
      expect(brief.opener).toBe('Start with why REASON put you two together.');
    });

    it.each([null, ...NO_ANSWER])('offer %j and no match: starts with what each of you is working on right now', async (offer) => {
      const brief = await briefFrom(offer, null, { score: 0.05 });
      expect(brief.match).toBeNull();
      expect(brief.opener).toBe('Start with what each of you is working on right now.');
    });

    it('is the same when a member has no profile to score at all', async () => {
      arm();
      mockLoadProfile.mockResolvedValue(null);
      const brief = await getPersonBrief(VIEWER, TARGET);
      expect(brief.match).toBeNull();
      expect(brief.opener).toBe('Start with what each of you is working on right now.');
    });
  });

  it('names the soonest shared event last, and only when the two share one', async () => {
    expect(await openerFrom('Fundraising', 'meet founders', { events: ['Harbor Mixer', 'Founders Dinner'] })).toBe(
      'Start with what Sarah can bring: Fundraising. Then say what you are looking for: meet founders. You will both be at Harbor Mixer.',
    );
    expect(await openerFrom('Fundraising', null, { events: [] })).toBe('Start with what Sarah can bring: Fundraising.');
    expect(await openerFrom(null, null, { events: ['Harbor Mixer'] })).toBe(
      'Start with why REASON put you two together. You will both be at Harbor Mixer.',
    );
    expect(await openerFrom(null, null, { score: 0.05, events: ['Harbor Mixer'] })).toBe(
      'Start with what each of you is working on right now. You will both be at Harbor Mixer.',
    );
  });

  it('uses the first word of the display name when there is no first name, and "they" when there is no name at all', async () => {
    expect(await openerFrom('Fundraising', null, { user: { firstName: '', displayName: 'Sarah Chen' } })).toBe(
      'Start with what Sarah can bring: Fundraising.',
    );
    expect(await openerFrom('Fundraising', null, { user: { firstName: '', displayName: '' } })).toBe(
      'Start with what they can bring: Fundraising.',
    );
  });

  // The line is made of fixed words and the members' own answers. With nothing usable offered, nothing
  // of the other member's private fields stands in for it, whichever fixed line is written.
  it.each([0.6, 0.05])('never fills a missing offer from the other member\'s own want or interests (score %p)', async (score) => {
    arm({ score });
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER
      ? { id, whoIWantToMeet: null, myIntent: null }
      : {
        id, whatICanHelpWith: '.', expertiseText: null, whoIWantToMeet: 'SECRET-WANT', myIntent: 'SECRET-INTENT',
        whyIWantToMeet: 'SECRET-WHY', interests: ['SECRET-INTEREST'], whatICareAbout: 'SECRET-CARES',
      }));
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.theyCanBring).toBeNull();
    expect(JSON.stringify(brief)).not.toMatch(/SECRET/);
  });

  // clip ends an answer it had to cut with "…". The line must not turn that into a finished
  // sentence: no full stop after a cut word, and the "…" must not be dropped.
  it('keeps the ellipsis of a long answer and puts no full stop after it', async () => {
    const long = 'Introductions to European retailers, fractional marketing leadership for consumer brands, and hands-on help '
      + 'with pricing, packaging and distribution deals across the UK, France and Germany for founders scaling past their first thousand customers';
    expect(Array.from(long).length).toBeGreaterThan(160);
    const cut = Array.from(long).slice(0, 159).join('');
    const opener = await openerFrom(long, 'founders in consumer');
    expect(opener).toBe(`Start with what Sarah can bring: ${cut}… Then say what you are looking for: founders in consumer.`);
    expect(opener).not.toContain('….');
  });

  it('keeps the ellipsis of a long answer in the last clause as well', async () => {
    const long = 'Founders who have scaled direct to consumer brands across several countries and now want to share what worked, '
      + 'what did not, and which hires made the difference, particularly in operations and finance';
    const cut = Array.from(long).slice(0, 159).join('');
    const opener = await openerFrom(null, long);
    expect(opener).toBe(`Start with why REASON put you two together. Then say what you are looking for: ${cut}…`);
  });

  it('puts no full stop after an offer the member ended with an ellipsis of their own', async () => {
    expect(await openerFrom('Introductions to European retailers…', null)).toBe(
      'Start with what Sarah can bring: Introductions to European retailers…',
    );
  });
});

describe('listRecentConnections: one row per person', () => {
  // Two members who each had a request accepted by the other (crossing requests) have two accepted
  // rows between them. The list must show the person once, at the time of the newest of them.
  it('groups the accepted requests by the other member, and keeps the newest time', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    await listRecentConnections(VIEWER);
    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/MAX\(p\.responded_at\) AS connected_at/);
    expect(sql).toMatch(/GROUP BY u\.id, u\.display_name, u\.avatar_url/);
    // Filters apply to each request before they are grouped; the limit applies to people.
    expect(sql.indexOf('WHERE')).toBeLessThan(sql.indexOf('GROUP BY'));
    expect(sql.indexOf('GROUP BY')).toBeLessThan(sql.indexOf('ORDER BY connected_at DESC'));
    expect(sql.indexOf('ORDER BY connected_at DESC')).toBeLessThan(sql.indexOf('LIMIT 5'));
  });

  it('passes the rows through one for one, newest first as the database sorted them', async () => {
    const OTHER = 'c0000000-0000-4000-8000-000000000003';
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [
      { user_id: TARGET, display_name: 'Sarah Chen', avatar_url: 'https://a/s.png', connected_at: new Date('2026-09-22T10:00:00Z') },
      { user_id: OTHER, display_name: 'Omar Haq', avatar_url: null, connected_at: new Date('2026-09-20T10:00:00Z') },
    ] });
    expect(await listRecentConnections(VIEWER)).toEqual([
      { userId: TARGET, displayName: 'Sarah Chen', avatarUrl: 'https://a/s.png', connectedAt: '2026-09-22T10:00:00.000Z' },
      { userId: OTHER, displayName: 'Omar Haq', avatarUrl: null, connectedAt: '2026-09-20T10:00:00.000Z' },
    ]);
  });
});

describe('listRecentConnections: whose connections', () => {
  it('asks only about the member who is looking, and gives an empty list when there are none', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(listRecentConnections(VIEWER)).resolves.toEqual([]);
    expect(mockQuery.mock.calls[0][1]).toEqual([VIEWER]);
  });
});
