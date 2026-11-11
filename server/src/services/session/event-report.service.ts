// ─── The organisers' event report (10 Nov 2026 spec, Part 3 item 3; plan K4) ─────────────────────────────────────
//
// Who registered and who came, who met whom in each round, the ratings in aggregate and the pairs who both said
// they'd meet again, for the people running the event. A read: it writes nothing and tells no screen.
//
// Sources (audit-3 §1): session_participants (joined_at is the one true "came"; status is swept to 'left' at the end),
// matches (the rooms; a NULL second seat is a bye, departed_user_ids are people who were in the room and left),
// meeting_records (who met whom, one directed row per person, partner and round; is_mutual) and ratings (scores,
// "didn't work"). encounter_history is never read: it is cross-event and keyed by the last event a pair met at.
// Six set-based queries per report, every one on an indexed session_id: no per-person or per-room query.
//
// Privacy (K4): counts, averages and distributions only. No score a named person gave or received, no one-sided
// "meet again" (a rejection signal), no private note (ratings.feedback). The mutual pairs are named: both opted in.
// Emails go to the event's host, its co-hosts and admins only (the 9 Sep rule); a pod's director or host reads the
// report without them. A closed, suspended or banned account reads "Former member", with no email, and still counts.

import type {
  EventReport, EventReportMeeting, EventReportMutualMatch, EventReportOutcome, EventReportPerson, EventReportRound,
  EventReportSummary,
} from '@rsn/shared';
import { ErrorCodes, eventZone } from '@rsn/shared';
import logger from '../../config/logger';
import { query } from '../../db';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { classifyParticipant } from '../post-event-message/classify';
import { getEventOrganiserAccess, resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import type { Actor } from '../roles/actor';
import { FORMER_MEMBER_NAME } from '../users/active-member';

export const EVENT_REPORT_NOT_FOUND = 'This event could not be found.';
export const EVENT_REPORT_FORBIDDEN = 'Only the people running this event can see its report.';
export const EVENT_REPORT_TOO_LARGE = 'This event is too large to report on in one go.';
/** The most places and rounds one report covers (500 people and 12 rounds is a big event today). */
export const EVENT_REPORT_MAX_PEOPLE = 2000;
export const EVENT_REPORT_MAX_ROUNDS = 50;

/** The room statuses that mean the meeting took place: the ones meeting_records is written for. */
const HELD = new Set(['completed', 'reassigned']);
const OUTCOME_ORDER: Record<EventReportOutcome, number> = { stayed: 0, left_early: 1, could_not_join: 2, no_show: 3, removed: 4 };

// ─── Rows ────────────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  title: string;
  status: string;
  timezone: string | null;
  scheduled_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  updated_at: Date;
  number_of_rounds: string | null;
  has_matches: boolean;
  people: number;
  rounds: number;
  feedback_count: number;
  schedule_versions: number;
}

interface PersonRow {
  user_id: string;
  status: string;
  joined_at: Date | null;
  left_at: Date | null;
  is_no_show: boolean;
  rounds_completed: number;
  registered_at: Date;
  admitted_via: string | null;
  display_name: string | null;
  email: string | null;
  account_status: string;
  account_kind: string;
  is_host: boolean;
  is_cohost: boolean;
  groups: string[] | null;
  meetings: number;
  people_met: number;
  ratings_given: number;
  ratings_expected: number;
  mutual_matches: number;
}

interface MatchRow {
  id: string;
  round_number: number;
  participant_a_id: string | null;
  participant_b_id: string | null;
  participant_c_id: string | null;
  departed_user_ids: string[] | null;
  status: EventReportMeeting['status'];
  is_manual: boolean;
  is_override: boolean;
  assignment_source: string | null;
  schedule_version: number | null;
  started_at: Date | null;
  ended_at: Date | null;
  ratings_expected: number;
  ratings_submitted: number;
  mutual_rows: number;
}

interface RatingRoundRow {
  round_number: number;
  ratings: number;
  q1: number; q2: number; q3: number; q4: number; q5: number;
  didnt_work: number;
  meet_again: number;
}

interface PairRow {
  a: string;
  b: string;
  mutual_rounds: number[] | null;
}

// ─── Queries (each set-based, $1 = the event) ───────────────────────────────

/** 1. The event, the facts the attendance classifier needs, the size guard and the two counts. */
export const EVENT_SQL = `
  SELECT s.id, s.title, s.status, s.timezone, s.scheduled_at, s.started_at, s.ended_at, s.updated_at,
         s.config->>'numberOfRounds' AS number_of_rounds,
         EXISTS (SELECT 1 FROM matches m WHERE m.session_id = s.id) AS has_matches,
         (SELECT COUNT(*)::int FROM session_participants sp WHERE sp.session_id = s.id) AS people,
         (SELECT COUNT(DISTINCT m.round_number)::int FROM matches m WHERE m.session_id = s.id) AS rounds,
         (SELECT COUNT(*)::int FROM event_feedback f WHERE f.session_id = s.id) AS feedback_count,
         (SELECT COUNT(*)::int FROM event_schedule_versions v WHERE v.session_id = s.id) AS schedule_versions
    FROM sessions s
   WHERE s.id = $1`;

/**
 * 2. Everyone with a place, their account, their organiser role, their groups and their own meeting counts. The
 * counts read meeting_records only for rooms that took place: a rating filed on a room nobody came to also writes a
 * row there, and that is not a meeting.
 */
export const PEOPLE_SQL = `
  WITH met AS (
    SELECT mr.user_id,
           COUNT(DISTINCT mr.round_number)::int AS meetings,
           COUNT(DISTINCT mr.partner_id)::int AS people_met,
           COUNT(*) FILTER (WHERE mr.meet_again_self IS NOT NULL)::int AS ratings_given,
           COUNT(*)::int AS ratings_expected,
           COUNT(DISTINCT mr.partner_id) FILTER (WHERE mr.is_mutual)::int AS mutual_matches
      FROM meeting_records mr
      JOIN matches m ON m.id = mr.match_id AND m.status IN ('completed', 'reassigned')
     WHERE mr.session_id = $1 AND mr.is_recap_eligible
     GROUP BY mr.user_id
  ), grp AS (
    SELECT epg.user_id, array_agg(g.label ORDER BY g.position, g.label) AS groups
      FROM event_participant_groups epg
      JOIN event_groups g ON g.id = epg.group_id
     WHERE epg.session_id = $1
     GROUP BY epg.user_id
  )
  SELECT sp.user_id, sp.status, sp.joined_at, sp.left_at, sp.is_no_show, sp.rounds_completed,
         sp.created_at AS registered_at, sp.admitted_via,
         u.display_name, u.email, u.status AS account_status, u.account_kind,
         (sp.user_id = s.host_user_id) AS is_host,
         (sc.user_id IS NOT NULL) AS is_cohost,
         grp.groups,
         COALESCE(met.meetings, 0) AS meetings,
         COALESCE(met.people_met, 0) AS people_met,
         COALESCE(met.ratings_given, 0) AS ratings_given,
         COALESCE(met.ratings_expected, 0) AS ratings_expected,
         COALESCE(met.mutual_matches, 0) AS mutual_matches
    FROM session_participants sp
    JOIN sessions s ON s.id = sp.session_id
    JOIN users u ON u.id = sp.user_id
    LEFT JOIN session_cohosts sc ON sc.session_id = sp.session_id AND sc.user_id = sp.user_id
    LEFT JOIN grp ON grp.user_id = sp.user_id
    LEFT JOIN met ON met.user_id = sp.user_id
   WHERE sp.session_id = $1`;

/** 3. Every room that was set up and not left unstarted, with its meeting_records counts. */
export const MEETINGS_SQL = `
  WITH mr AS (
    SELECT match_id,
           COUNT(*)::int AS ratings_expected,
           COUNT(*) FILTER (WHERE meet_again_self IS NOT NULL)::int AS ratings_submitted,
           COUNT(*) FILTER (WHERE is_mutual)::int AS mutual_rows
      FROM meeting_records
     WHERE session_id = $1 AND is_recap_eligible
     GROUP BY match_id
  )
  SELECT m.id, m.round_number, m.participant_a_id, m.participant_b_id, m.participant_c_id, m.departed_user_ids,
         m.status, m.is_manual, m.is_override, m.assignment_source, m.schedule_version, m.started_at, m.ended_at,
         COALESCE(mr.ratings_expected, 0) AS ratings_expected,
         COALESCE(mr.ratings_submitted, 0) AS ratings_submitted,
         COALESCE(mr.mutual_rows, 0) AS mutual_rows
    FROM matches m
    LEFT JOIN mr ON mr.match_id = m.id
   WHERE m.session_id = $1 AND m.status <> 'scheduled'
   ORDER BY m.round_number, m.is_manual, m.created_at, m.id`;

/** 4. The ratings per round: how many, the 1-5 counts without "didn't work", "didn't work", "meet again". */
export const RATINGS_SQL = `
  SELECT m.round_number,
         COUNT(*)::int AS ratings,
         COUNT(*) FILTER (WHERE r.quality_score = 1 AND NOT r.excluded_from_quality_stats)::int AS q1,
         COUNT(*) FILTER (WHERE r.quality_score = 2 AND NOT r.excluded_from_quality_stats)::int AS q2,
         COUNT(*) FILTER (WHERE r.quality_score = 3 AND NOT r.excluded_from_quality_stats)::int AS q3,
         COUNT(*) FILTER (WHERE r.quality_score = 4 AND NOT r.excluded_from_quality_stats)::int AS q4,
         COUNT(*) FILTER (WHERE r.quality_score = 5 AND NOT r.excluded_from_quality_stats)::int AS q5,
         COUNT(*) FILTER (WHERE r.excluded_from_quality_stats)::int AS didnt_work,
         COUNT(*) FILTER (WHERE r.meet_again)::int AS meet_again
    FROM ratings r
    JOIN matches m ON m.id = r.match_id
   WHERE m.session_id = $1
   GROUP BY m.round_number
   ORDER BY m.round_number`;

/** 5. Every pair who met (in any order, once), and the rounds in which both said they'd meet again. */
export const PAIRS_SQL = `
  SELECT LEAST(mr.user_id, mr.partner_id) AS a, GREATEST(mr.user_id, mr.partner_id) AS b,
         array_agg(DISTINCT mr.round_number ORDER BY mr.round_number) FILTER (WHERE mr.is_mutual) AS mutual_rounds
    FROM meeting_records mr
    JOIN matches m ON m.id = mr.match_id AND m.status IN ('completed', 'reassigned')
   WHERE mr.session_id = $1 AND mr.is_recap_eligible
   GROUP BY 1, 2
   ORDER BY 1, 2`;

// ─── Shaping ─────────────────────────────────────────────────────────────────

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

function averageOf(dist: readonly number[]): number | null {
  let n = 0;
  let sum = 0;
  dist.forEach((count, i) => { n += count; sum += count * (i + 1); });
  return n > 0 ? Math.round((sum / n) * 100) / 100 : null;
}

function plannedRounds(raw: string | null): number | null {
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function howOf(m: MatchRow): EventReportMeeting['how'] {
  if (m.is_manual) return 'manual_room';
  if (m.is_override) return 'host_edited';
  if (m.assignment_source === 'manual') return 'board_manual';
  if (m.assignment_source === 'repair') return 'board_repair';
  return 'matched';
}

function toPerson(row: PersonRow, seesEmail: boolean, eventEndedAt: Date | null, eventHadMatches: boolean): EventReportPerson {
  const formerMember = row.account_status !== 'active';
  const accountKind = row.account_kind === 'event_guest' ? 'event_guest' : 'member';
  const ownName = (row.display_name ?? '').trim() || (accountKind === 'event_guest' ? 'Guest' : 'Member');
  const outcome: EventReportOutcome = row.status === 'removed'
    ? 'removed'
    : classifyParticipant({
      joinedAt: row.joined_at, leftAt: row.left_at, roundsCompleted: row.rounds_completed, eventHadMatches,
    }, eventEndedAt);
  return {
    userId: row.user_id,
    displayName: formerMember ? FORMER_MEMBER_NAME : ownName,
    email: seesEmail && !formerMember ? row.email : null,
    accountKind,
    formerMember,
    role: row.is_host ? 'host' : row.is_cohost ? 'co_host' : 'participant',
    registeredAt: iso(row.registered_at) ?? '',
    admittedVia: row.admitted_via,
    groups: row.groups ?? [],
    joinedAt: iso(row.joined_at),
    leftAt: iso(row.left_at),
    outcome,
    missedAMeeting: row.is_no_show,
    roundsCompleted: row.rounds_completed,
    meetings: row.meetings,
    peopleMet: row.people_met,
    ratingsGiven: row.ratings_given,
    ratingsExpected: row.ratings_expected,
    mutualMatches: row.mutual_matches,
  };
}

function byOutcomeThenName(a: EventReportPerson, b: EventReportPerson): number {
  return OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]
    || a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' })
    || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
}

function toMeetings(rows: MatchRow[]): EventReportMeeting[] {
  const roomsInRound = new Map<number, number>();
  return rows.map((m) => {
    const room = (roomsInRound.get(m.round_number) ?? 0) + 1;
    roomsInRound.set(m.round_number, room);
    const userIds = [m.participant_a_id, m.participant_b_id, m.participant_c_id].filter((id): id is string => !!id);
    const departedUserIds = [...new Set((m.departed_user_ids ?? []).filter((id) => !!id && !userIds.includes(id)))];
    const held = HELD.has(m.status);
    return {
      matchId: m.id,
      round: m.round_number,
      room,
      userIds,
      departedUserIds,
      status: m.status,
      how: howOf(m),
      scheduleVersion: m.schedule_version,
      startedAt: iso(m.started_at),
      endedAt: iso(m.ended_at),
      // A room that did not take place had no meeting, so nothing to rate, whatever a stray rating wrote.
      ratingsExpected: held ? m.ratings_expected : 0,
      ratingsSubmitted: held ? m.ratings_submitted : 0,
      // Each mutual pair is two directed rows, one per person.
      mutualPairs: held ? Math.floor(m.mutual_rows / 2) : 0,
    };
  });
}

function toRounds(meetings: EventReportMeeting[], ratings: RatingRoundRow[], mutual: EventReportMutualMatch[]): EventReportRound[] {
  const rounds = new Map<number, EventReportRound & { people: Set<string> }>();
  const roundOf = (n: number) => {
    let r = rounds.get(n);
    if (!r) {
      r = {
        round: n, rooms: 0, seated: 0, byes: 0, completed: 0, noShow: 0, cancelled: 0, reassigned: 0,
        ratingsExpected: 0, ratingsSubmitted: 0, avgQuality: null, meetAgainRate: null, mutualPairs: 0, people: new Set(),
      };
      rounds.set(n, r);
    }
    return r;
  };
  for (const m of meetings) {
    const r = roundOf(m.round);
    r.rooms++;
    if (m.status === 'completed') r.completed++;
    else if (m.status === 'no_show') r.noShow++;
    else if (m.status === 'cancelled') r.cancelled++;
    else if (m.status === 'reassigned') r.reassigned++;
    if (m.status !== 'cancelled') {
      const inRoom = [...m.userIds, ...m.departedUserIds];
      for (const id of inRoom) r.people.add(id);
      if (inRoom.length === 1) r.byes++;
    }
    r.ratingsExpected += m.ratingsExpected;
    r.ratingsSubmitted += m.ratingsSubmitted;
  }
  for (const row of ratings) {
    const r = roundOf(row.round_number);
    r.avgQuality = averageOf([row.q1, row.q2, row.q3, row.q4, row.q5]);
    r.meetAgainRate = rate(row.meet_again, row.ratings);
  }
  for (const pair of mutual) for (const n of pair.rounds) roundOf(n).mutualPairs++;
  return [...rounds.values()]
    .sort((a, b) => a.round - b.round)
    .map(({ people, ...r }) => ({ ...r, seated: people.size }));
}

function toSummary(
  people: EventReportPerson[], meetings: EventReportMeeting[], ratings: RatingRoundRow[], pairs: PairRow[],
  mutual: EventReportMutualMatch[], event: EventRow,
): EventReportSummary {
  const places = people.filter((p) => p.role === 'participant');
  const count = (o: EventReportOutcome) => places.filter((p) => p.outcome === o).length;
  const attended = places.filter((p) => p.outcome !== 'removed' && p.joinedAt !== null).length;
  const held = meetings.filter((m) => HELD.has(m.status));
  // A meeting is a room that took place with someone to meet: a bye (one seat, nobody left) is a room, not a meeting.
  const met = held.filter((m) => m.userIds.length + m.departedUserIds.length >= 2);
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let ratingsTotal = 0;
  let didntWork = 0;
  let meetAgain = 0;
  for (const r of ratings) {
    distribution[0] += r.q1; distribution[1] += r.q2; distribution[2] += r.q3; distribution[3] += r.q4; distribution[4] += r.q5;
    ratingsTotal += r.ratings;
    didntWork += r.didnt_work;
    meetAgain += r.meet_again;
  }
  const ratingsExpected = held.reduce((n, m) => n + m.ratingsExpected, 0);
  const ratingsSubmitted = held.reduce((n, m) => n + m.ratingsSubmitted, 0);
  return {
    registered: places.length,
    attended,
    noShows: count('no_show'),
    removed: count('removed'),
    stayed: count('stayed'),
    leftEarly: count('left_early'),
    couldNotJoin: count('could_not_join'),
    guests: places.filter((p) => p.accountKind === 'event_guest').length,
    attendanceRate: rate(attended, places.length),
    roundsPlanned: plannedRounds(event.number_of_rounds),
    roundsRun: new Set(met.filter((m) => m.how !== 'manual_room').map((m) => m.round)).size,
    meetings: met.length,
    manualRooms: met.filter((m) => m.how === 'manual_room').length,
    uniquePairsMet: pairs.length,
    ratingsExpected,
    ratingsSubmitted,
    ratingCompletion: rate(ratingsSubmitted, ratingsExpected),
    avgQuality: averageOf(distribution),
    qualityDistribution: distribution,
    didntWork,
    meetAgainRate: rate(meetAgain, ratingsTotal),
    mutualMatches: mutual.length,
    feedbackCount: event.feedback_count,
    scheduleVersionsPublished: event.schedule_versions,
  };
}

// ─── The report ──────────────────────────────────────────────────────────────

/**
 * The event's report for one of the people running it (getEventOrganiserAccess: the host, a co-host or moderator,
 * the pod's active director or host, an admin). 404 for no such event, 403 for anyone else, 413 above
 * EVENT_REPORT_MAX_PEOPLE places or EVENT_REPORT_MAX_ROUNDS rounds. Answers for an event in any state.
 */
export async function getEventReport(sessionId: string, actor: Actor): Promise<EventReport> {
  const access = await getEventOrganiserAccess(actor.userId, actor.role, sessionId);
  if (!access) throw new NotFoundError('Session', sessionId, EVENT_REPORT_NOT_FOUND);
  if (!access.isOrganiser) throw new ForbiddenError(EVENT_REPORT_FORBIDDEN);
  const seesEmail = access.isHost || access.isCohost || access.isAdmin;

  const eventResult = await query<EventRow>(EVENT_SQL, [sessionId]);
  const event = eventResult.rows[0];
  if (!event) throw new NotFoundError('Session', sessionId, EVENT_REPORT_NOT_FOUND);
  if (event.people > EVENT_REPORT_MAX_PEOPLE || event.rounds > EVENT_REPORT_MAX_ROUNDS) {
    throw new AppError(413, ErrorCodes.REPORT_TOO_LARGE, EVENT_REPORT_TOO_LARGE);
  }

  const [peopleResult, matchResult, ratingResult, pairResult] = await Promise.all([
    query<PersonRow>(PEOPLE_SQL, [sessionId]),
    query<MatchRow>(MEETINGS_SQL, [sessionId]),
    query<RatingRoundRow>(RATINGS_SQL, [sessionId]),
    query<PairRow>(PAIRS_SQL, [sessionId]),
  ]);

  // The same "ended" the "Message everyone who took part" buckets use (post-event-message.service loadSessionFacts).
  const eventEndedAt = event.ended_at ?? event.updated_at ?? null;
  const people = peopleResult.rows
    .map((row) => toPerson(row, seesEmail, eventEndedAt, event.has_matches))
    .sort(byOutcomeThenName);
  const meetings = toMeetings(matchResult.rows);
  const mutualMatches: EventReportMutualMatch[] = pairResult.rows
    .filter((p) => (p.mutual_rounds ?? []).length > 0)
    .map((p) => ({ userIds: [p.a, p.b], rounds: (p.mutual_rounds ?? []).map(Number) }));

  return {
    event: {
      id: event.id,
      title: event.title,
      status: event.status,
      timezone: eventZone(event.timezone),
      scheduledAt: iso(event.scheduled_at),
      startedAt: iso(event.started_at),
      endedAt: iso(event.ended_at),
    },
    generatedAt: new Date().toISOString(),
    summary: toSummary(people, meetings, ratingResult.rows, pairResult.rows, mutualMatches, event),
    people,
    rounds: toRounds(meetings, ratingResult.rows, mutualMatches),
    meetings,
    mutualMatches,
  };
}

// ─── Telling the report's readers ────────────────────────────────────────────

/**
 * The event's ratings or who-met-whom changed: tell the people running it, whose report counts them. Sent once per
 * round when its rating window closes (meeting_records was just written), and for a rating sent once the event is
 * closing or over. Best-effort: never throws, and a failure never undoes the rating.
 */
export async function fanoutSessionRatings(sessionId: string): Promise<void> {
  try {
    const io = getRealtimeIo();
    if (!io) return;
    const organisers = await resolveEventOrganiserIds(sessionId);
    await emitEntities(io, organisers, [E.sessionRatings(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutSessionRatings: failed to fan out');
  }
}

/**
 * A rating just landed on this room. While the event is live the round's own close tells the organisers once (a
 * live round's ratings would otherwise refetch their report hundreds of times); a rating sent from the recap, once
 * the event is closing or over, tells them now.
 */
export async function fanoutLateRating(matchId: string): Promise<void> {
  try {
    if (!getRealtimeIo()) return;
    const found = await query<{ session_id: string }>(
      `SELECT m.session_id FROM matches m JOIN sessions s ON s.id = m.session_id
        WHERE m.id = $1 AND s.status IN ('closing_lobby', 'completed')`,
      [matchId],
    );
    const sessionId = found.rows[0]?.session_id;
    if (sessionId) await fanoutSessionRatings(sessionId);
  } catch (err) {
    logger.warn({ err, matchId }, 'fanoutLateRating: failed to look up the event');
  }
}
