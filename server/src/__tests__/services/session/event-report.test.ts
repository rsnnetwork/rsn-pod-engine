// ─── The organisers' event report (10 Nov 2026 spec, Part 3 Task 4; K4) ─────────────────────────────────────────
//
// getEventReport against a stand-in database: each of the six statements answers the rows Postgres would for the
// event being built, so what is tested here is who may read it, what each person may see and how the rows become the
// report (attendance from joined_at, a bye, a trio someone left, a breakout room, a "didn't work" rating kept out of
// the average, a pair who both said yes in two rounds counted once, a former member, a guest). The statements
// themselves ran for real on a scratch Postgres with the same events for the task report; here their shape is held:
// set-based on the event, meeting_records only for rooms that took place, no encounter_history, no feedback text.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockAccess = jest.fn();
const mockOrganisers = jest.fn();
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  getEventOrganiserAccess: (...a: unknown[]) => mockAccess(...a),
  resolveEventOrganiserIds: (...a: unknown[]) => mockOrganisers(...a),
  __esModule: true,
}));
const mockEmit = jest.fn().mockResolvedValue(undefined);
let mockIo: object | null = {};
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => mockIo,
  __esModule: true,
}));

import { UserRole } from '@rsn/shared';
import {
  EVENT_SQL, MEETINGS_SQL, PAIRS_SQL, PEOPLE_SQL, RATINGS_SQL,
  fanoutLateRating, fanoutSessionRatings, getEventReport,
} from '../../../services/session/event-report.service';

const SESSION = '5e550000-0000-4000-8000-000000000001';
const HOST = 'u-host';
const ACTOR = { userId: HOST, role: UserRole.MEMBER };
const ENDED = new Date('2026-11-10T20:00:00.000Z');
const at = (iso: string) => new Date(iso);

type Rows = Record<string, unknown>[];
interface World {
  event: Record<string, unknown> | null;
  people: Rows;
  matches: Rows;
  ratings: Rows;
  pairs: Rows;
}
let world: World;

function eventRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION, title: 'Founders evening', status: 'completed', timezone: 'Europe/Copenhagen',
    scheduled_at: at('2026-11-10T17:00:00.000Z'), started_at: at('2026-11-10T17:02:00.000Z'), ended_at: ENDED,
    updated_at: ENDED, number_of_rounds: '3', has_matches: true, people: 0, rounds: 0, feedback_count: 0,
    schedule_versions: 0, ...over,
  };
}

function person(userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: userId, status: 'left', joined_at: at('2026-11-10T17:01:00.000Z'), left_at: ENDED, is_no_show: false,
    rounds_completed: 2, registered_at: at('2026-11-01T09:00:00.000Z'), admitted_via: 'open',
    display_name: userId.toUpperCase(), email: `${userId}@example.com`, account_status: 'active', account_kind: 'member',
    is_host: false, is_cohost: false, groups: null, meetings: 0, people_met: 0, ratings_given: 0, ratings_expected: 0,
    mutual_matches: 0, ...over,
  };
}

function match(id: string, round: number, seats: (string | null)[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, round_number: round, participant_a_id: seats[0] ?? null, participant_b_id: seats[1] ?? null,
    participant_c_id: seats[2] ?? null, departed_user_ids: [], status: 'completed', is_manual: false, is_override: false,
    assignment_source: null, schedule_version: null, started_at: at('2026-11-10T17:10:00.000Z'),
    ended_at: at('2026-11-10T17:18:00.000Z'), ratings_expected: 0, ratings_submitted: 0, mutual_rows: 0, ...over,
  };
}

const ratingRound = (round: number, over: Record<string, unknown> = {}) => ({
  round_number: round, ratings: 0, q1: 0, q2: 0, q3: 0, q4: 0, q5: 0, didnt_work: 0, meet_again: 0, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIo = {};
  world = { event: eventRow(), people: [], matches: [], ratings: [], pairs: [] };
  mockAccess.mockResolvedValue({
    status: 'completed', isHost: true, isCohost: false, isPodOrganiser: false, isAdmin: false, isOrganiser: true, timeZone: null,
  });
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql === EVENT_SQL) {
      return { rows: world.event ? [{ ...world.event, people: world.people.length }] : [] };
    }
    if (sql === PEOPLE_SQL) return { rows: world.people };
    if (sql === MEETINGS_SQL) return { rows: world.matches };
    if (sql === RATINGS_SQL) return { rows: world.ratings };
    if (sql === PAIRS_SQL) return { rows: world.pairs };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });
});

describe('who may read the report', () => {
  it('an event that does not exist is a 404 in words', async () => {
    mockAccess.mockResolvedValue(null);
    await expect(getEventReport(SESSION, ACTOR)).rejects.toMatchObject({ statusCode: 404, message: 'This event could not be found.' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a participant and a stranger are refused (403, in words), before any report query runs', async () => {
    mockAccess.mockResolvedValue({
      status: 'completed', isHost: false, isCohost: false, isPodOrganiser: false, isAdmin: false, isOrganiser: false, timeZone: null,
    });
    await expect(getEventReport(SESSION, { userId: 'u-a', role: UserRole.MEMBER }))
      .rejects.toMatchObject({ statusCode: 403, message: 'Only the people running this event can see its report.' });
    await expect(getEventReport(SESSION, { userId: 'u-stranger', role: UserRole.MEMBER })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('asks the shared organiser rule with the actor\'s id and role', async () => {
    await getEventReport(SESSION, { userId: 'u-x', role: UserRole.ADMIN });
    expect(mockAccess).toHaveBeenCalledWith('u-x', UserRole.ADMIN, SESSION);
  });

  it('a pod director reads it without anyone\'s email; the host, a co-host and an admin see emails', async () => {
    world.people = [person('u-a')];
    mockAccess.mockResolvedValue({
      status: 'completed', isHost: false, isCohost: false, isPodOrganiser: true, isAdmin: false, isOrganiser: true, timeZone: null,
    });
    const director = await getEventReport(SESSION, { userId: 'u-dir', role: UserRole.MEMBER });
    expect(director.people[0].email).toBeNull();

    for (const who of [{ isHost: true }, { isCohost: true }, { isAdmin: true }]) {
      mockAccess.mockResolvedValue({
        status: 'completed', isHost: false, isCohost: false, isPodOrganiser: false, isAdmin: false, isOrganiser: true, timeZone: null, ...who,
      });
      const report = await getEventReport(SESSION, { userId: 'u-x', role: UserRole.MEMBER });
      expect(report.people[0].email).toBe('u-a@example.com');
    }
  });

  it('answers for an event in any state (a live one too)', async () => {
    world.event = eventRow({ status: 'round_active', ended_at: null });
    const report = await getEventReport(SESSION, ACTOR);
    expect(report.event.status).toBe('round_active');
    expect(report.event.endedAt).toBeNull();
  });

  it('refuses an event above 2,000 places or 50 rounds with a 413 in words, before reading people', async () => {
    world.people = Array.from({ length: 2001 }, (_, i) => person(`u-${i}`));
    await expect(getEventReport(SESSION, ACTOR))
      .rejects.toMatchObject({ statusCode: 413, code: 'REPORT_TOO_LARGE', message: 'This event is too large to report on in one go.' });
    world.people = [];
    world.event = eventRow({ rounds: 51 });
    await expect(getEventReport(SESSION, ACTOR)).rejects.toMatchObject({ statusCode: 413 });
    expect(mockQuery.mock.calls.some(([sql]) => sql === PEOPLE_SQL)).toBe(false);
  });
});

describe('attendance', () => {
  it('nobody came: every place is a no-show, nothing met, every rate that has no whole is null', async () => {
    world.event = eventRow({ has_matches: false });
    world.people = [
      person('u-a', { joined_at: null, left_at: null, rounds_completed: 0 }),
      person('u-b', { joined_at: null, left_at: null, rounds_completed: 0 }),
    ];
    const { summary, people } = await getEventReport(SESSION, ACTOR);
    expect(summary).toMatchObject({
      registered: 2, attended: 0, noShows: 2, removed: 0, stayed: 0, leftEarly: 0, couldNotJoin: 0, attendanceRate: 0,
      roundsRun: 0, meetings: 0, uniquePairsMet: 0, ratingsExpected: 0, ratingCompletion: null, avgQuality: null,
      meetAgainRate: null, mutualMatches: 0, qualityDistribution: [0, 0, 0, 0, 0],
    });
    expect(people.map((p) => p.outcome)).toEqual(['no_show', 'no_show']);
  });

  it('nobody registered: zero places and a null attendance rate', async () => {
    const { summary, people, meetings, rounds } = await getEventReport(SESSION, ACTOR);
    expect(summary.registered).toBe(0);
    expect(summary.attendanceRate).toBeNull();
    expect([people, meetings, rounds]).toEqual([[], [], []]);
  });

  it('came is joined_at, whatever the end-of-event sweep wrote to status: a late joiner attended, a never-joiner is a no-show', async () => {
    world.people = [
      // Joined in the closing lobby, after every round: swept to 'left' like everyone, but joined_at is set.
      person('u-late', { status: 'left', joined_at: at('2026-11-10T19:55:00.000Z'), rounds_completed: 0 }),
      // Never came: the sweep also wrote 'left'; joined_at is NULL.
      person('u-never', { status: 'left', joined_at: null, left_at: ENDED, rounds_completed: 0 }),
    ];
    const { summary, people } = await getEventReport(SESSION, ACTOR);
    expect(summary).toMatchObject({ registered: 2, attended: 1, noShows: 1, couldNotJoin: 1, attendanceRate: 0.5 });
    expect(Object.fromEntries(people.map((p) => [p.userId, p.outcome]))).toEqual({ 'u-late': 'could_not_join', 'u-never': 'no_show' });
  });

  it('removed is read first, then stayed / left early by the 2-minute rule; the host and co-hosts are listed but not counted', async () => {
    world.people = [
      person('u-removed', { status: 'removed', rounds_completed: 1 }),
      person('u-early', { left_at: at('2026-11-10T19:00:00.000Z') }),
      person('u-stayed', { left_at: at('2026-11-10T19:59:00.000Z') }),
      person(HOST, { is_host: true }),
      person('u-co', { is_cohost: true }),
    ];
    const { summary, people } = await getEventReport(SESSION, ACTOR);
    expect(summary).toMatchObject({ registered: 3, attended: 2, removed: 1, stayed: 1, leftEarly: 1, attendanceRate: 0.6667 });
    const byId = Object.fromEntries(people.map((p) => [p.userId, p]));
    expect(byId['u-removed'].outcome).toBe('removed');
    expect(byId[HOST].role).toBe('host');
    expect(byId['u-co'].role).toBe('co_host');
    expect(byId['u-early'].role).toBe('participant');
    // Ordered by outcome, then name.
    expect(people.map((p) => p.outcome)).toEqual(['stayed', 'stayed', 'stayed', 'left_early', 'removed']);
  });

  it('a video meeting (no matches) judges only whether the person came', async () => {
    world.event = eventRow({ has_matches: false });
    world.people = [person('u-a', { rounds_completed: 0 })];
    const { people } = await getEventReport(SESSION, ACTOR);
    expect(people[0].outcome).toBe('stayed');
  });

  it('a former member is named "Former member" with no email and still counts; a guest keeps the guest kind', async () => {
    world.people = [
      person('u-closed', { account_status: 'deactivated', display_name: 'Real Name', email: 'real@example.com' }),
      person('u-banned', { account_status: 'banned' }),
      person('u-guest', { account_kind: 'event_guest', display_name: 'Guest', email: 'guest@example.com' }),
    ];
    const { summary, people } = await getEventReport(SESSION, ACTOR);
    const byId = Object.fromEntries(people.map((p) => [p.userId, p]));
    expect(byId['u-closed']).toMatchObject({ displayName: 'Former member', email: null, formerMember: true, accountKind: 'member' });
    expect(byId['u-banned']).toMatchObject({ displayName: 'Former member', email: null, formerMember: true });
    expect(byId['u-guest']).toMatchObject({ displayName: 'Guest', email: 'guest@example.com', accountKind: 'event_guest', formerMember: false });
    expect(summary).toMatchObject({ registered: 3, guests: 1 });
  });

  it('carries each person\'s groups, how they were admitted, a missed meeting and their own counts (no score)', async () => {
    world.people = [person('u-a', {
      groups: ['Founders'], admitted_via: 'code', is_no_show: true, meetings: 2, people_met: 3, ratings_given: 2,
      ratings_expected: 3, mutual_matches: 1,
    })];
    const [p] = (await getEventReport(SESSION, ACTOR)).people;
    expect(p).toEqual({
      userId: 'u-a', displayName: 'U-A', email: 'u-a@example.com', accountKind: 'member', formerMember: false,
      role: 'participant', registeredAt: '2026-11-01T09:00:00.000Z', admittedVia: 'code', groups: ['Founders'],
      joinedAt: '2026-11-10T17:01:00.000Z', leftAt: '2026-11-10T20:00:00.000Z', outcome: 'stayed', missedAMeeting: true,
      roundsCompleted: 2, meetings: 2, peopleMet: 3, ratingsGiven: 2, ratingsExpected: 3, mutualMatches: 1,
    });
  });
});

describe('who met whom', () => {
  beforeEach(() => {
    world.people = ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'].map((id) => person(id));
  });

  it('a trio someone left: the leaver is in the room, the room counts once and its ratings are the meeting_records ones', async () => {
    world.matches = [match('m-trio', 1, ['u-a', 'u-b', null], {
      departed_user_ids: ['u-c'], ratings_expected: 6, ratings_submitted: 4, mutual_rows: 2,
    })];
    const { meetings, rounds, summary } = await getEventReport(SESSION, ACTOR);
    expect(meetings[0]).toMatchObject({ userIds: ['u-a', 'u-b'], departedUserIds: ['u-c'], ratingsExpected: 6, ratingsSubmitted: 4, mutualPairs: 1 });
    expect(rounds[0]).toMatchObject({ round: 1, rooms: 1, seated: 3, byes: 0, completed: 1 });
    expect(summary).toMatchObject({ meetings: 1, roundsRun: 1, ratingsExpected: 6, ratingsSubmitted: 4, ratingCompletion: 0.6667 });
  });

  it('a bye is a room with one seat: listed, counted as a bye, nothing to rate', async () => {
    world.matches = [
      match('m-1', 1, ['u-a', 'u-b'], { ratings_expected: 2 }),
      match('m-bye', 1, ['u-c', null]),
    ];
    const { meetings, rounds, summary } = await getEventReport(SESSION, ACTOR);
    expect(meetings.map((m) => [m.matchId, m.room, m.userIds])).toEqual([['m-1', 1, ['u-a', 'u-b']], ['m-bye', 2, ['u-c']]]);
    expect(rounds[0]).toMatchObject({ rooms: 2, seated: 3, byes: 1 });
    // A bye is a room, not a meeting: nobody to meet.
    expect(summary).toMatchObject({ meetings: 1, roundsRun: 1 });
  });

  it('a host breakout room comes after the matched rooms, says so, and does not make a round "run"', async () => {
    world.matches = [
      match('m-1', 1, ['u-a', 'u-b']),
      match('m-manual', 2, ['u-c', 'u-d'], { is_manual: true }),
    ];
    const { meetings, summary } = await getEventReport(SESSION, ACTOR);
    expect(meetings.find((m) => m.matchId === 'm-manual')).toMatchObject({ how: 'manual_room', room: 1, round: 2 });
    expect(summary).toMatchObject({ meetings: 2, manualRooms: 1, roundsRun: 1 });
  });

  it('says how each room was made, and the board version it came from', async () => {
    world.matches = [
      match('m-1', 1, ['u-a', 'u-b'], { is_override: true }),
      match('m-2', 1, ['u-c', 'u-d'], { assignment_source: 'manual', schedule_version: 2 }),
      match('m-3', 1, ['u-e', null], { assignment_source: 'repair', schedule_version: 3 }),
      match('m-4', 2, ['u-a', 'u-c'], { assignment_source: 'auto', schedule_version: 3 }),
    ];
    const { meetings } = await getEventReport(SESSION, ACTOR);
    expect(meetings.map((m) => [m.how, m.scheduleVersion])).toEqual([
      ['host_edited', null], ['board_manual', 2], ['board_repair', 3], ['matched', 3],
    ]);
  });

  it('a room nobody came to or that was cancelled is listed with its status but is not a meeting and has nothing to rate', async () => {
    world.matches = [
      match('m-ok', 1, ['u-a', 'u-b'], { ratings_expected: 2, ratings_submitted: 2 }),
      match('m-noshow', 1, ['u-c', 'u-d'], { status: 'no_show', ratings_expected: 2, ratings_submitted: 1 }),
      match('m-cancel', 1, ['u-e', 'u-a'], { status: 'cancelled', ratings_expected: 2 }),
    ];
    const { meetings, rounds, summary } = await getEventReport(SESSION, ACTOR);
    expect(meetings.map((m) => [m.status, m.ratingsExpected])).toEqual([['completed', 2], ['no_show', 0], ['cancelled', 0]]);
    expect(rounds[0]).toMatchObject({ rooms: 3, completed: 1, noShow: 1, cancelled: 1, seated: 4 });
    expect(summary).toMatchObject({ meetings: 1, ratingsExpected: 2, ratingsSubmitted: 2 });
  });

  it('a pair who both said yes in two rounds is one mutual match, in both rounds\' counts, named by id', async () => {
    world.matches = [match('m-1', 1, ['u-a', 'u-b']), match('m-2', 3, ['u-a', 'u-b'])];
    world.pairs = [
      { a: 'u-a', b: 'u-b', mutual_rounds: [1, 3] },
      { a: 'u-a', b: 'u-c', mutual_rounds: null },
    ];
    const { mutualMatches, summary, rounds } = await getEventReport(SESSION, ACTOR);
    expect(mutualMatches).toEqual([{ userIds: ['u-a', 'u-b'], rounds: [1, 3] }]);
    expect(summary).toMatchObject({ mutualMatches: 1, uniquePairsMet: 2 });
    expect(rounds.map((r) => [r.round, r.mutualPairs])).toEqual([[1, 1], [3, 1]]);
  });
});

describe('ratings, in aggregate only', () => {
  it('"didn\'t work" ratings are out of the average and the distribution, and counted on their own', async () => {
    world.ratings = [
      ratingRound(1, { ratings: 4, q4: 1, q5: 2, didnt_work: 1, meet_again: 2 }),
      ratingRound(2, { ratings: 2, q1: 1, q3: 1, meet_again: 1 }),
    ];
    world.matches = [match('m-1', 1, ['u-a', 'u-b']), match('m-2', 2, ['u-a', 'u-b'])];
    const { summary, rounds } = await getEventReport(SESSION, ACTOR);
    expect(summary.qualityDistribution).toEqual([1, 0, 1, 1, 2]);
    // (1 + 3 + 4 + 5 + 5) / 5, never the "didn't work" one's score.
    expect(summary.avgQuality).toBe(3.6);
    expect(summary.didntWork).toBe(1);
    expect(summary.meetAgainRate).toBe(0.5);
    expect(rounds.map((r) => [r.avgQuality, r.meetAgainRate])).toEqual([[4.67, 0.5], [2, 0.5]]);
  });

  it('nothing in the report names a score a person gave or received, a one-sided meet again or a note', async () => {
    world.people = [person('u-a'), person('u-b')];
    world.matches = [match('m-1', 1, ['u-a', 'u-b'], { ratings_expected: 2, ratings_submitted: 2 })];
    world.ratings = [ratingRound(1, { ratings: 2, q2: 1, q5: 1, meet_again: 1 })];
    const text = JSON.stringify(await getEventReport(SESSION, ACTOR));
    for (const key of ['quality_score', 'qualityScore', 'feedback"', 'meetAgain"', 'meet_again', 'ratingGiven', 'rating_given', 'theirMeetAgain']) {
      expect(text).not.toContain(key);
    }
  });

  it('carries the event\'s zone, the counts of feedback and published board versions, and the planned rounds', async () => {
    world.event = eventRow({ feedback_count: 4, schedule_versions: 2, number_of_rounds: '5', timezone: 'Mars/Base' });
    const report = await getEventReport(SESSION, ACTOR);
    expect(report.event.timezone).toBe('UTC');
    expect(report.summary).toMatchObject({ feedbackCount: 4, scheduleVersionsPublished: 2, roundsPlanned: 5 });
    world.event = eventRow({ number_of_rounds: null });
    expect((await getEventReport(SESSION, ACTOR)).summary.roundsPlanned).toBeNull();
  });
});

describe('the statements', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it('every one is on the event ($1) and none reads encounter_history or a rating\'s feedback text', async () => {
    await getEventReport(SESSION, ACTOR);
    const sqls = mockQuery.mock.calls.map(([sql, params]) => ({ sql: sql as string, params }));
    expect(sqls).toHaveLength(5);
    for (const { sql, params } of sqls) {
      expect(params).toEqual([SESSION]);
      expect(sql).not.toMatch(/encounter_history/);
      expect(sql).not.toMatch(/\.feedback\b/);
      expect(sql).toMatch(/= \$1/);
      expect(sql).not.toMatch(/LIMIT|OFFSET/);
    }
  });

  it('meeting counts read meeting_records only for rooms that took place; a "didn\'t work" rating never reaches a score count', () => {
    expect(flat(PEOPLE_SQL)).toContain("JOIN matches m ON m.id = mr.match_id AND m.status IN ('completed', 'reassigned')");
    expect(flat(PAIRS_SQL)).toContain("JOIN matches m ON m.id = mr.match_id AND m.status IN ('completed', 'reassigned')");
    for (const k of [1, 2, 3, 4, 5]) expect(flat(RATINGS_SQL)).toContain(`r.quality_score = ${k} AND NOT r.excluded_from_quality_stats`);
    expect(flat(MEETINGS_SQL)).toContain("m.status <> 'scheduled'");
    expect(flat(PAIRS_SQL)).toContain('LEAST(mr.user_id, mr.partner_id) AS a, GREATEST(mr.user_id, mr.partner_id) AS b');
    expect(flat(PEOPLE_SQL)).toContain('COUNT(DISTINCT mr.partner_id) FILTER (WHERE mr.is_mutual)');
  });
});

describe('telling the organisers', () => {
  it('fanoutSessionRatings sends session:<id>:ratings to the event\'s organisers', async () => {
    mockOrganisers.mockResolvedValue([HOST, 'u-co']);
    await fanoutSessionRatings(SESSION);
    expect(mockEmit).toHaveBeenCalledWith(mockIo, [HOST, 'u-co'], [`session:${SESSION}:ratings`]);
  });

  it('never throws, and sends nothing without a socket server', async () => {
    mockOrganisers.mockRejectedValue(new Error('db down'));
    await expect(fanoutSessionRatings(SESSION)).resolves.toBeUndefined();
    mockIo = null;
    mockOrganisers.mockResolvedValue([HOST]);
    await fanoutSessionRatings(SESSION);
    await fanoutLateRating('m-1');
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a rating tells them only while the event is closing or over', async () => {
    mockOrganisers.mockResolvedValue([HOST]);
    mockQuery.mockResolvedValueOnce({ rows: [{ session_id: SESSION }] });
    await fanoutLateRating('m-1');
    expect(flat(mockQuery.mock.calls[0][0])).toContain("s.status IN ('closing_lobby', 'completed')");
    expect(mockQuery.mock.calls[0][1]).toEqual(['m-1']);
    expect(mockEmit).toHaveBeenCalledWith(mockIo, [HOST], [`session:${SESSION}:ratings`]);

    mockEmit.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // a live round's rating
    await fanoutLateRating('m-2');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  function flat(s: string): string {
    return s.replace(/\s+/g, ' ');
  }
});
