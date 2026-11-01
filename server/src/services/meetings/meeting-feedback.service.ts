// ─── Feedback after a meeting (30 Oct 2026, item 5c) ─────────────────────────
//
// "After a meeting ends, show a short prompt asking how it went and if there were any problems. Save the answers
// in the admin panel." Each of a meeting's two people can answer once it has started: Worth continuing? and Any
// problems?. The answer is a meeting_outcomes row (migration 123) naming the meeting and, as target, the other
// person, so the person brief keeps reading one table. One row per person per meeting: a second press edits it.
// Only the person who answered (GET /meetings/:id, `myFeedback`) and the admins (GET /admin/feedback and its CSV)
// read it; the other person never does.

import {
  ErrorCodes, MEETING_PROBLEMS,
  type AdminFeedbackPage, type AdminFeedbackPerson, type AdminFeedbackRow, type MeetingFeedbackBody,
  type MeetingFeedbackSource, type MeetingKind, type MeetingProblem, type MyMeetingFeedback, type OutcomeKey,
  type SavedMeetingFeedback, type WorthContinuing,
} from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';

const MEETING_GONE = "We couldn't find that meeting.";

/** Each problem once, in the order the sheet lists them. */
function orderedProblems(problems: readonly MeetingProblem[] | undefined): MeetingProblem[] {
  const picked = new Set(problems ?? []);
  return MEETING_PROBLEMS.filter((p) => picked.has(p));
}

/** Blank text is no text. */
function cleanText(text: string | undefined | null): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed ? trimmed : null;
}

/**
 * Where an answer about this meeting comes from. Every meetings row is a scheduled 1:1 meeting until direct calls
 * are recorded as meetings too (meetings.source, migration 124): the release that adds that column maps its
 * 'instant' rows to 'instant' here, in this one place.
 */
function sourceOf(_meeting: { id: string }): MeetingFeedbackSource {
  return 'meeting';
}

interface FeedbackTarget {
  id: string;
  user_a_id: string;
  user_b_id: string;
  start_at: Date;
  status: string;
  /** The person answering, read fresh: the sign-in check keeps a status for up to a minute. */
  author_active: boolean;
  /** A block stands between the two, whichever of them made it. */
  blocked: boolean;
}

/**
 * Save, or change, the viewer's answer about a meeting. Refused unless the viewer is one of its two people (403,
 * a sentence), their account is open (403), no block stands between the two (404, as the meeting's own page reads
 * then), the meeting was not cancelled (409) and has started (409). A meeting from before migration 123 takes an
 * answer like any other. One statement, so two tabs pressing Send at once still leave one row.
 */
export async function submitMeetingFeedback(
  userId: string,
  meetingId: string,
  body: MeetingFeedbackBody,
  now = new Date(),
): Promise<SavedMeetingFeedback> {
  // activeMemberSql: `author.status = 'active'` is written inline here (switch to activeMemberSql after T2).
  const found = await query<FeedbackTarget>(
    `SELECT m.id, m.user_a_id, m.user_b_id, m.start_at, m.status,
            (author.status = 'active') AS author_active,
            EXISTS (
              SELECT 1 FROM user_blocks ub
               WHERE (ub.blocker_id = m.user_a_id AND ub.blocked_id = m.user_b_id)
                  OR (ub.blocker_id = m.user_b_id AND ub.blocked_id = m.user_a_id)) AS blocked
       FROM meetings m
       JOIN users author ON author.id = $2
      WHERE m.id = $1`,
    [meetingId, userId],
  );
  const meeting = found.rows[0];
  if (!meeting) throw new NotFoundError('Meeting', undefined, MEETING_GONE);
  if (meeting.user_a_id !== userId && meeting.user_b_id !== userId) {
    throw new ForbiddenError('Only the two people in this meeting can say how it went.');
  }
  if (!meeting.author_active) throw new ForbiddenError('Your account is closed, so you cannot leave feedback.');
  if (meeting.blocked) throw new NotFoundError('Meeting', undefined, MEETING_GONE);
  if (meeting.status === 'cancelled') {
    throw new ConflictError(ErrorCodes.MEETING_CANCELLED, 'This meeting was cancelled, so there is nothing to say about it yet.');
  }
  if (meeting.start_at.getTime() > now.getTime()) {
    throw new ConflictError(ErrorCodes.MEETING_NOT_STARTED, 'You can say how it went once the meeting has started.');
  }

  const partnerId = meeting.user_a_id === userId ? meeting.user_b_id : meeting.user_a_id;
  const problems = orderedProblems(body.problems);
  const problemText = cleanText(body.problemText);
  // The outcome chips stay on the profile's sheet: an edit keeps whatever outcome_keys the row has.
  const saved = await query<{
    id: string; worth_continuing: WorthContinuing; problems: MeetingProblem[]; problem_text: string | null; created_at: Date;
  }>(
    `INSERT INTO meeting_outcomes (user_id, target_user_id, worth_continuing, meeting_id, source, problems, problem_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, meeting_id) WHERE meeting_id IS NOT NULL DO UPDATE
        SET worth_continuing = EXCLUDED.worth_continuing,
            problems = EXCLUDED.problems,
            problem_text = EXCLUDED.problem_text
     RETURNING id, worth_continuing, problems, problem_text, created_at`,
    [userId, partnerId, body.worthContinuing, meetingId, sourceOf(meeting), problems, problemText],
  );
  const row = saved.rows[0];
  return {
    id: row.id,
    meetingId,
    worthContinuing: row.worth_continuing,
    problems: orderedProblems(row.problems),
    problemText: row.problem_text,
    createdAt: row.created_at.toISOString(),
  };
}

/** The viewer's own answer about a meeting, or null: never the other person's. */
export async function readMyFeedback(userId: string, meetingId: string): Promise<MyMeetingFeedback | null> {
  const found = await query<{ worth_continuing: WorthContinuing; problems: MeetingProblem[]; problem_text: string | null }>(
    `SELECT worth_continuing, problems, problem_text FROM meeting_outcomes WHERE user_id = $1 AND meeting_id = $2`,
    [userId, meetingId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return { worthContinuing: row.worth_continuing, problems: orderedProblems(row.problems), problemText: row.problem_text };
}

/**
 * After an answer is saved: the author's meeting page (its card goes) and person brief redraw, and every admin's
 * feedback list. Best-effort: the answer is already saved.
 */
export async function announceFeedback(userId: string, meetingId: string): Promise<void> {
  try {
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await emitEntities(io, [userId], [E.meeting(meetingId), E.user(userId)]);
  } catch (err) {
    logger.warn({ err, meetingId }, 'meeting feedback emit failed (non-fatal)');
  }
  await announceFeedbackToAdmins();
}

/** Every admin's feedback list redraws (the profile sheet's answers are listed there too). Best-effort, never throws. */
export async function announceFeedbackToAdmins(): Promise<void> {
  try {
    const { fanoutAdminEntities } = await import('../../realtime/fanout');
    // fanoutAdminEntities sends admin:<scope>, which is E.adminMeetingFeedback.
    await fanoutAdminEntities('meeting-feedback');
  } catch (err) {
    logger.warn({ err }, 'admin feedback list emit failed (non-fatal)');
  }
}

// ── The admin list ───────────────────────────────────────────────────────────

/** The most rows one page or one CSV holds. A CSV is read a page at a time up to this many. */
export const ADMIN_FEEDBACK_PAGE_MAX = 100;
export const ADMIN_FEEDBACK_CSV_MAX = 5000;

interface AdminFeedbackDbRow {
  id: string;
  created_at: Date;
  /** created_at to the microsecond, as the next page's edge: a millisecond edge would skip rows inside it. */
  edge_at: string;
  source: MeetingFeedbackSource | null;
  worth_continuing: WorthContinuing;
  problems: MeetingProblem[];
  problem_text: string | null;
  outcome_keys: OutcomeKey[];
  meeting_id: string | null;
  start_at: Date | null;
  duration_min: number | null;
  kind: MeetingKind | null;
  from_id: string;
  from_name: string | null;
  from_active: boolean;
  about_id: string;
  about_name: string | null;
  about_active: boolean;
  their_worth: WorthContinuing | null;
  their_problems: MeetingProblem[] | null;
  their_problem_text: string | null;
}

/** A page's edge: the answer time and id of its last row, "<ISO>~<uuid>". */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const isAdminFeedbackCursor = (s: string): boolean => CURSOR.test(s);
const cursorOf = (row: AdminFeedbackDbRow) => `${row.edge_at}~${row.id}`;

function person(id: string, name: string | null, active: boolean): AdminFeedbackPerson {
  return { userId: id, displayName: active ? name?.trim() || 'Member' : 'Former member', isFormerMember: !active };
}

function toAdminRow(r: AdminFeedbackDbRow): AdminFeedbackRow {
  return {
    id: r.id,
    answeredAt: r.created_at.toISOString(),
    source: r.source,
    meeting: r.meeting_id && r.start_at && r.kind
      ? { id: r.meeting_id, startAt: r.start_at.toISOString(), durationMin: r.duration_min ?? 0, kind: r.kind }
      : null,
    from: person(r.from_id, r.from_name, r.from_active),
    about: person(r.about_id, r.about_name, r.about_active),
    answer: {
      worthContinuing: r.worth_continuing,
      problems: orderedProblems(r.problems),
      problemText: r.problem_text,
      outcomes: r.outcome_keys ?? [],
    },
    theirAnswer: r.their_worth
      ? { worthContinuing: r.their_worth, problems: orderedProblems(r.their_problems ?? []), problemText: r.their_problem_text }
      : null,
  };
}

/**
 * One page of every answer, newest first: after-meeting answers and the profile sheet's alike, each with its
 * meeting (none for a profile answer), both people (a closed account reads "Former member") and the other person's
 * answer about the same meeting. "Only with problems" keeps the answers that picked a problem or wrote one.
 */
export async function listAdminFeedback(opts: {
  problemsOnly: boolean; limit: number; cursor?: string;
}): Promise<AdminFeedbackPage> {
  const params: unknown[] = [opts.problemsOnly];
  let after = '';
  const edge = opts.cursor ? CURSOR.exec(opts.cursor) : null;
  if (edge) {
    params.push(edge[1], edge[2]);
    after = `AND (o.created_at, o.id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(Math.min(opts.limit, ADMIN_FEEDBACK_PAGE_MAX) + 1);
  // activeMemberSql: `<alias>.status = 'active'` is written inline twice here (switch to activeMemberSql after T2).
  // A closed account is listed, as "Former member", never dropped: the answer it gave still counts.
  const found = await query<AdminFeedbackDbRow>(
    `SELECT o.id, o.created_at, to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS edge_at,
            o.source, o.worth_continuing, o.problems, o.problem_text, o.outcome_keys,
            o.meeting_id, m.start_at, m.duration_min, m.kind,
            fu.id AS from_id, fu.display_name AS from_name, (fu.status = 'active') AS from_active,
            au.id AS about_id, au.display_name AS about_name, (au.status = 'active') AS about_active,
            t.worth_continuing AS their_worth, t.problems AS their_problems, t.problem_text AS their_problem_text
       FROM meeting_outcomes o
       JOIN users fu ON fu.id = o.user_id
       JOIN users au ON au.id = o.target_user_id
       LEFT JOIN meetings m ON m.id = o.meeting_id
       LEFT JOIN meeting_outcomes t ON t.meeting_id = o.meeting_id AND t.user_id = o.target_user_id
      WHERE ($1::boolean IS FALSE OR cardinality(o.problems) > 0 OR o.problem_text IS NOT NULL)
        ${after}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const limit = Math.min(opts.limit, ADMIN_FEEDBACK_PAGE_MAX);
  const page = found.rows.slice(0, limit);
  return {
    items: page.map(toAdminRow),
    nextCursor: found.rows.length > limit ? cursorOf(page[page.length - 1]) : null,
  };
}

/** Every row the list would show with this filter, up to ADMIN_FEEDBACK_CSV_MAX, newest first. */
export async function allAdminFeedback(problemsOnly: boolean): Promise<AdminFeedbackRow[]> {
  const rows: AdminFeedbackRow[] = [];
  let cursor: string | undefined;
  while (rows.length < ADMIN_FEEDBACK_CSV_MAX) {
    const page = await listAdminFeedback({ problemsOnly, limit: ADMIN_FEEDBACK_PAGE_MAX, cursor });
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows.slice(0, ADMIN_FEEDBACK_CSV_MAX);
}

export const ADMIN_FEEDBACK_CSV_COLUMNS = [
  'answered_at', 'source', 'meeting_id', 'meeting_start_at', 'meeting_kind',
  'from_user_id', 'from_name', 'about_user_id', 'about_name',
  'worth_continuing', 'problems', 'problem_text', 'outcomes',
  'their_worth_continuing', 'their_problems', 'their_problem_text',
] as const;

/** "Profile" for a row the profile's outcome sheet wrote; the source itself otherwise. */
export const sourceLabel = (source: MeetingFeedbackSource | null): string => source ?? 'profile';

/**
 * One cell. Quoted when it holds a comma, a quote or a line break; and a cell a spreadsheet would read as a formula
 * (it starts with =, +, -, @, a tab or a carriage return: member-written text can) is written with a ' in front.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function adminFeedbackCsv(rows: AdminFeedbackRow[]): string {
  const lines = rows.map((r) => [
    r.answeredAt, sourceLabel(r.source), r.meeting?.id, r.meeting?.startAt, r.meeting?.kind,
    r.from.userId, r.from.displayName, r.about.userId, r.about.displayName,
    r.answer.worthContinuing, r.answer.problems.join(' '), r.answer.problemText, r.answer.outcomes.join(' '),
    r.theirAnswer?.worthContinuing, r.theirAnswer?.problems.join(' '), r.theirAnswer?.problemText,
  ].map(csvCell).join(','));
  return [ADMIN_FEEDBACK_CSV_COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}
