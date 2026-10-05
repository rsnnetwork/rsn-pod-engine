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
    expect(sql).toMatch(/ORDER BY p\.responded_at DESC/);
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

describe('getPersonBrief: the real scorer', () => {
  beforeEach(() => jest.clearAllMocks());

  // The scorer reads the OTHER member's whole profile, private fields included, to
  // decide the fit. What it hands back is the "why" line shown on the person page,
  // so it must carry only the viewer's own words and the other member's public
  // name and title. The scorer here is the real one, not the stand-in above.
  it('never puts the other member\'s private words in the brief, even when they are what matched', async () => {
    const { scoreFit } = jest.requireActual<typeof import('../../../services/matching/platform-match.service')>(
      '../../../services/matching/platform-match.service',
    );
    const privateWords = ['SECRETWANT', 'SECRETWHY', 'SECRETINTENT', 'SECRETGOAL', 'zebrafish', 'sarah@example.com'];
    const viewer = {
      id: VIEWER, displayName: 'Ali', whoIWantToMeet: 'sustainable packaging manufacturers', myIntent: null,
      whyIWantToMeet: null, goals: null, professionalRole: null, jobTitle: null,
    };
    const sarah = {
      id: TARGET, displayName: 'Sarah Chen', professionalRole: ['Founder'], jobTitle: 'Founder', company: 'Harbor Collective',
      whatICanHelpWith: 'Introductions to European retailers', expertiseText: null,
      // Private. Only her sustainable-packaging INTEREST can make her a fit for the want above.
      whatICareAbout: 'sustainable packaging zebrafish', interests: ['sustainable packaging', 'zebrafish'],
      whoIWantToMeet: 'SECRETWANT investors in biodegradable films', whyIWantToMeet: 'SECRETWHY',
      myIntent: 'SECRETINTENT', goals: ['SECRETGOAL'],
    };
    arm();
    mockScore.mockImplementation(scoreFit);
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER ? viewer : sarah));

    const brief = await getPersonBrief(VIEWER, TARGET);

    // The match is real, and it came through her private interest: without that interest there is none.
    // So the words below are absent because the scorer keeps them out, not because nothing matched.
    expect(brief.match).not.toBeNull();
    expect(brief.match?.reason).toMatch(/sustainable|packag/i);
    expect(scoreFit(viewer as never, { ...sarah, whatICareAbout: null, interests: [] } as never).score).toBe(0);
    const everything = JSON.stringify(brief);
    for (const word of privateWords) expect(everything).not.toContain(word);
    // The viewer's own words are theirs to see.
    expect(brief.youAreLookingFor).toBe('sustainable packaging manufacturers');
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
      'Ask Sarah about introductions to European retailers. Then say what you are looking for: founders in consumer. You will both be at Harbor Mixer.',
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
    expect(brief.opener).toBe('Ask Sarah about retail partnerships. Then say what you are looking for: meet founders who sell to retailers.');
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

describe('getPersonBrief: the first-20-minutes line sets the member\'s words into a sentence', () => {
  beforeEach(() => jest.clearAllMocks());

  const openerFrom = async (offer: string | null, want: string | null) => {
    arm();
    mockLoadProfile.mockImplementation((id: string) => Promise.resolve(id === VIEWER
      ? { id, whoIWantToMeet: want, myIntent: null }
      : { id, whatICanHelpWith: offer, expertiseText: null }));
    return (await getPersonBrief(VIEWER, TARGET)).opener;
  };

  // An answer that starts with an acronym, a brand or "I" must keep its capitals:
  // "aWS", "uX" and "i'd" look like typing mistakes on a page a member reads.
  it.each([
    ['AWS cloud architecture', 'Ask Sarah about AWS cloud architecture.'],
    ['UX research for consumer apps', 'Ask Sarah about UX research for consumer apps.'],
    ['B2B sales', 'Ask Sarah about B2B sales.'],
    ['LinkedIn growth', 'Ask Sarah about LinkedIn growth.'],
    ['SaaS pricing', 'Ask Sarah about SaaS pricing.'],
    ["I'd help with hiring", "Ask Sarah about I'd help with hiring."],
  ])('keeps "%s" as written', async (offer, expected) => {
    expect(await openerFrom(offer, null)).toBe(expected);
  });

  it.each([
    ['Introductions to European retailers', 'Ask Sarah about introductions to European retailers.'],
    ['Fundraising', 'Ask Sarah about fundraising.'],
    ['International expansion', 'Ask Sarah about international expansion.'],
    ["Women's health founders", "Ask Sarah about women's health founders."],
    ['A technical co-founder', 'Ask Sarah about a technical co-founder.'],
  ])('still lower-cases a plain first word: "%s"', async (offer, expected) => {
    expect(await openerFrom(offer, null)).toBe(expected);
  });

  it('keeps an acronym in what the viewer is looking for, too', async () => {
    expect(await openerFrom(null, 'AI founders in healthcare')).toBe(
      'Start with why REASON put you two together. Then say what you are looking for: AI founders in healthcare.',
    );
  });

  // clip ends an answer it had to cut with "…". The line must not turn that into a finished
  // sentence: no full stop after a cut word, and the "…" must not be dropped.
  it('keeps the ellipsis of a long answer and puts no full stop after it', async () => {
    const long = 'Introductions to European retailers, fractional marketing leadership for consumer brands, and hands-on help '
      + 'with pricing, packaging and distribution deals across the UK, France and Germany for founders scaling past their first thousand customers';
    expect(Array.from(long).length).toBeGreaterThan(160);
    const cut = Array.from(long).slice(0, 159).join('');
    const opener = await openerFrom(long, 'founders in consumer');
    expect(opener).toBe(`Ask Sarah about i${cut.slice(1)}… Then say what you are looking for: founders in consumer.`);
    expect(opener).not.toContain('….');
  });

  it('keeps the ellipsis of a long answer in the last clause as well', async () => {
    const long = 'Founders who have scaled direct to consumer brands across several countries and now want to share what worked, '
      + 'what did not, and which hires made the difference, particularly in operations and finance';
    const cut = Array.from(long).slice(0, 159).join('');
    const opener = await openerFrom(null, long);
    expect(opener).toBe(`Start with why REASON put you two together. Then say what you are looking for: f${cut.slice(1)}…`);
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
