// ─── An event's extra matching questions and each person's answers (10 Nov 2026 spec, Part 3 Task 5; K5) ─────
//
// The organiser asks up to five questions (shared/src/events/matching-questions.ts holds the rule and the affinity the
// engine scores with). This file stores them and each person's answers, gives the engine its signal, and holds the one
// registration rule: a required question is asked before a person's own first place, never before an approved
// request, an accepted invite, a returning place, an organiser's add or a promotion from the waiting list (they are let
// in and stay neutral until they answer).
//
//   "Matching questions are soft preferences. They only choose among the meetings the event already allows. A block, a
//   report, an inviter and the person they invited, and the event's group rules always win, and so does the no-repeat
//   rule. Questions never make a meeting that would otherwise be refused, never leave someone unmatched, and never cause
//   a repeat."
//
// An event with no event_matching_questions rows has no questions: every reader here makes one read and stops, and
// the engine is given nothing, so it matches exactly as before. Questions and answers lock once the event goes live
// (nothing is asked then, and a late arrival is neutral). Answers are visible only to the person and the event's
// organisers (canActAsHost): never to another participant, on a profile, on Everyone, on the call link's landing or in
// GET /schedule/mine.

import type { PoolClient, QueryResultRow } from 'pg';
import {
  ErrorCodes, cleanEventAnswers, missingRequiredQuestions, unansweredQuestions, validateEventQuestions,
  type EventAnswers, type EventInputIssue, type EventMatchingQuestion, type EventQuestionOption, type EventQuestionsView,
  type MatchingEventQuestions, type QuestionKind, type QuestionPrefer, type UserRole,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import type { Actor } from '../roles/actor';
import { canActAsHost } from '../roles/effective-role.service';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { isLiveStatus } from './main-room';
import { canSeeEvent, readEventAccessFacts } from './event-access';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';

/** A read in the caller's transaction when there is one, else on the pool. */
type Reader = <R extends QueryResultRow>(text: string, params: unknown[]) => Promise<{ rows: R[]; rowCount?: number | null }>;
const readerOf = (client?: PoolClient): Reader =>
  client ? (text, params) => client.query(text, params) : (text, params) => query(text, params);

const NOT_FOUND = "We couldn't find that event.";
const ORGANISERS_ONLY = 'Only the people running this event can change its matching questions.';
export const QUESTIONS_LIVE_SENTENCE = "Matching questions can't change while the event is live.";
const QUESTIONS_ENDED_SENTENCE = "This event has ended, so its matching questions can't change.";
const ANSWERS_LIVE_SENTENCE = "Your answers can't change once the event is live.";
const ANSWERS_ENDED_SENTENCE = "This event has ended, so your answers can't change.";
export const ANSWERS_REQUIRED_SENTENCE = "Answer this event's questions first.";
const REQUIRED_ANSWER_SENTENCE = 'This question needs an answer.';

/** The most answer rows the organisers' read returns (five questions for a thousand people). */
const ORGANISER_ANSWERS_MAX = 5000;

// ─── Reading ─────────────────────────────────────────────────────────────────

interface QuestionRow {
  id: string;
  key: string;
  prompt: string;
  kind: QuestionKind;
  prefer: QuestionPrefer;
  required: boolean;
  options: unknown;
}

interface StoredQuestion extends EventMatchingQuestion {
  id: string;
}

function optionsOf(raw: unknown): EventQuestionOption[] {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((o): o is { key: string; label: string } => !!o && typeof o.key === 'string' && typeof o.label === 'string')
    .map((o) => ({ key: o.key, label: o.label }));
}

async function readQuestions(sessionId: string, client?: PoolClient): Promise<StoredQuestion[]> {
  const r = await readerOf(client)<QuestionRow>(
    `SELECT id, key, prompt, kind, prefer, required, options FROM event_matching_questions WHERE session_id = $1 ORDER BY position, key`,
    [sessionId],
  );
  return r.rows.map((q) => ({
    id: q.id, key: q.key, prompt: q.prompt, kind: q.kind, prefer: q.prefer, required: q.required, options: optionsOf(q.options),
  }));
}

const publicShape = ({ id: _id, ...q }: StoredQuestion): EventMatchingQuestion => q;

/** The event's questions in their order, or none (the inert path: one read). With a client, in the caller's transaction. */
export async function getEventQuestions(sessionId: string, client?: PoolClient): Promise<EventMatchingQuestion[]> {
  return (await readQuestions(sessionId, client)).map(publicShape);
}

/** One person's answers in this event. */
async function answersOf(read: Reader, sessionId: string, userId: string): Promise<EventAnswers> {
  const r = await read<{ key: string; option_keys: string[] }>(
    `SELECT q.key, a.option_keys FROM event_question_answers a JOIN event_matching_questions q ON q.id = a.question_id
      WHERE a.session_id = $1 AND a.user_id = $2`,
    [sessionId, userId],
  );
  return Object.fromEntries(r.rows.map((row) => [row.key, row.option_keys]));
}

/** A person's answers (empty when they gave none, or the event has no questions). */
export async function getMyAnswers(sessionId: string, userId: string, client?: PoolClient): Promise<EventAnswers> {
  return answersOf(readerOf(client), sessionId, userId);
}

/**
 * The engine's signal for these people (Part 3 Task 5): the event's questions and each person's answers, or undefined
 * when the event has none (one read of event_matching_questions, nothing more: the engine then adds no term at all).
 * Best-effort, as the intent signals are: a soft preference must never stop a round, so a failed read is logged and
 * matching goes on without it.
 */
export async function loadQuestionSignals(sessionId: string, userIds: string[]): Promise<MatchingEventQuestions | undefined> {
  try {
    const questions = await readQuestions(sessionId);
    if (questions.length === 0) return undefined;
    const answersByUser: Record<string, EventAnswers> = {};
    if (userIds.length > 0) {
      const r = await query<{ user_id: string; key: string; option_keys: string[] }>(
        `SELECT a.user_id, q.key, a.option_keys
           FROM event_question_answers a JOIN event_matching_questions q ON q.id = a.question_id
          WHERE a.session_id = $1 AND a.user_id = ANY($2::uuid[])`,
        [sessionId, userIds],
      );
      for (const row of r.rows) (answersByUser[row.user_id] ??= {})[row.key] = row.option_keys;
    }
    return { questions: questions.map(publicShape), answersByUser };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Matching questions could not be read; the round is made without them (non-fatal)');
    return undefined;
  }
}

// ─── Telling people ──────────────────────────────────────────────────────────

/** The questions changed: the people running the event, everyone who holds a place, and everyone who has answered. */
export async function fanoutEventQuestions(sessionId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const [organisers, people] = await Promise.all([
      resolveEventOrganiserIds(sessionId),
      query<{ user_id: string }>(
        `SELECT user_id FROM session_participants WHERE session_id = $1 AND status <> 'removed'
         UNION
         SELECT user_id FROM event_question_answers WHERE session_id = $1`,
        [sessionId],
      ),
    ]);
    const everyone = [...new Set([...organisers, ...people.rows.map((r) => r.user_id)])];
    await emitEntities(io, everyone, [E.sessionQuestions(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutEventQuestions: failed to fan out');
  }
}

/** One person's answers changed: the people running the event (they see everyone's) and that person. */
export async function fanoutMyAnswers(sessionId: string, userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const organisers = await resolveEventOrganiserIds(sessionId);
    await emitEntities(io, [...new Set([...organisers, userId])], [E.sessionQuestions(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutMyAnswers: failed to fan out');
  }
}

// ─── Where the event stands ──────────────────────────────────────────────────

type AnswerWindow = 'open' | 'live' | 'ended';

function windowOf(status: string | null | undefined): AnswerWindow {
  if (status === 'completed' || status === 'cancelled') return 'ended';
  return isLiveStatus(status) ? 'live' : 'open';
}

async function statusOf(read: Reader, sessionId: string, lock = false): Promise<string> {
  const r = await read<{ status: string }>(
    `SELECT status FROM sessions WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [sessionId],
  );
  if (!r.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  return r.rows[0].status;
}

function refuseIssues(issues: EventInputIssue[]): void {
  if (issues.length === 0) return;
  const details: Record<string, string[]> = {};
  for (const issue of issues) (details[issue.field] ??= []).push(issue.message);
  throw new ValidationError(issues[0].message, details);
}

// ─── Writing answers ─────────────────────────────────────────────────────────

/**
 * Write a person's cleaned answers: each non-empty answer replaces theirs, an empty one removes it. Option keys hold no
 * comma (isQuestionKey), so each answer travels as one comma-joined text.
 */
async function writeAnswers(client: PoolClient, sessionId: string, userId: string, answers: EventAnswers): Promise<boolean> {
  const given = Object.entries(answers).filter(([, keys]) => keys.length > 0);
  const cleared = Object.entries(answers).filter(([, keys]) => keys.length === 0).map(([key]) => key);
  let changed = false;
  if (given.length > 0) {
    const r = await client.query(
      `INSERT INTO event_question_answers (session_id, question_id, user_id, option_keys)
       SELECT $1::uuid, q.id, $2::uuid, string_to_array(t.option_keys, ',')
         FROM unnest($3::text[], $4::text[]) AS t(key, option_keys)
         JOIN event_matching_questions q ON q.session_id = $1::uuid AND q.key = t.key
       ON CONFLICT (question_id, user_id) DO UPDATE
         SET option_keys = EXCLUDED.option_keys, updated_at = NOW()
         WHERE event_question_answers.option_keys IS DISTINCT FROM EXCLUDED.option_keys`,
      [sessionId, userId, given.map(([key]) => key), given.map(([, keys]) => keys.join(','))],
    );
    changed = (r.rowCount ?? 0) > 0;
  }
  if (cleared.length > 0) {
    const r = await client.query(
      `DELETE FROM event_question_answers a USING event_matching_questions q
        WHERE q.id = a.question_id AND a.session_id = $1 AND a.user_id = $2 AND q.key = ANY($3::text[])`,
      [sessionId, userId, cleared],
    );
    changed = changed || (r.rowCount ?? 0) > 0;
  }
  return changed;
}

export interface MyAnswersResult {
  mine: EventAnswers;
  missingRequired: string[];
  changed: boolean;
}

async function saveMyAnswersTx(
  client: PoolClient, sessionId: string, userId: string, raw: unknown, quietWhenLocked: boolean,
): Promise<MyAnswersResult> {
  const questions = await readQuestions(sessionId, client);
  if (questions.length === 0) return { mine: {}, missingRequired: [], changed: false };
  const window = windowOf(await statusOf(readerOf(client), sessionId));
  if (window !== 'open' && quietWhenLocked) {
    const mine = await answersOf(readerOf(client), sessionId, userId);
    return { mine, missingRequired: [], changed: false };
  }
  if (window === 'live') throw new ConflictError(ErrorCodes.SESSION_IN_PROGRESS, ANSWERS_LIVE_SENTENCE);
  if (window === 'ended') throw new ConflictError(ErrorCodes.EVENT_ENDED, ANSWERS_ENDED_SENTENCE);
  const { answers, issues } = cleanEventAnswers(questions, raw);
  const required = new Set(questions.filter((q) => q.required).map((q) => q.key));
  for (const [key, keys] of Object.entries(answers)) {
    if (keys.length === 0 && required.has(key)) issues.push({ field: `answers.${key}`, message: REQUIRED_ANSWER_SENTENCE });
  }
  refuseIssues(issues);
  const changed = await writeAnswers(client, sessionId, userId, answers);
  const mine = await answersOf(readerOf(client), sessionId, userId);
  return { mine, missingRequired: missingRequiredQuestions(questions, mine), changed };
}

/**
 * A person saves their own answers (only keys they send change; an empty list clears an optional answer), any time
 * before the event goes live. A required question cannot be cleared. With a client, part of the caller's transaction
 * (the call link's entry, which tells the screens itself); without, its own, and the screens are told here.
 * `quietWhenLocked` (the call link's entry): on a live or ended event the answers are left as they are, without a
 * refusal, since nothing is asked then.
 */
export async function saveMyAnswers(
  sessionId: string, userId: string, answers: unknown, client?: PoolClient, opts: { quietWhenLocked?: boolean } = {},
): Promise<MyAnswersResult> {
  const quiet = opts.quietWhenLocked === true;
  if (client) return saveMyAnswersTx(client, sessionId, userId, answers, quiet);
  const result = await transaction((tx) => saveMyAnswersTx(tx, sessionId, userId, answers, quiet));
  if (result.changed) void fanoutMyAnswers(sessionId, userId);
  return result;
}

/** PUT /sessions/:id/questions/mine: anyone who can see the event answers for themselves (an unseen event reads as unknown). */
export async function saveMyAnswersAs(sessionId: string, viewer: Actor, answers: unknown): Promise<MyAnswersResult> {
  const facts = await readEventAccessFacts(sessionId, viewer.userId);
  if (!facts || !canSeeEvent(facts, viewer.role)) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  return saveMyAnswers(sessionId, viewer.userId, answers);
}

/**
 * Registration's questions, inside registerParticipant's transaction (or the waiting list's), for an event that has
 * questions. Answers given are written (an unknown question or answer is dropped, a malformed one is a 400). Then only a
 * person's own first self-registration (`ownFirstPlace`) with a required question still unanswered is refused (409
 * EVENT_ANSWERS_REQUIRED), unless they run the event: an approved request, an accepted invite, a returning place,
 * anyone an organiser adds and a promotion from the waiting list are let in and stay neutral until they answer. Once the
 * event is live nothing is written or asked (the answers are locked; a late arrival is neutral). Returns whether any
 * answer was written, for the caller to tell the screens once its transaction has committed.
 */
export async function applyRegistrationAnswers(
  client: PoolClient, sessionId: string, userId: string, role: UserRole | undefined, answers: EventAnswers | undefined,
  ownFirstPlace: boolean,
): Promise<boolean> {
  const questions = await readQuestions(sessionId, client);
  if (questions.length === 0) return false;
  if (windowOf(await statusOf(readerOf(client), sessionId)) !== 'open') return false;
  let changed = false;
  if (answers && Object.keys(answers).length > 0) {
    const cleaned = cleanEventAnswers(questions, answers);
    refuseIssues(cleaned.issues);
    // Registration only adds answers: an empty list sent with it clears nothing.
    const given = Object.fromEntries(Object.entries(cleaned.answers).filter(([, keys]) => keys.length > 0));
    changed = await writeAnswers(client, sessionId, userId, given);
  }
  if (!ownFirstPlace || !questions.some((q) => q.required)) return changed;
  const mine = await answersOf(readerOf(client), sessionId, userId);
  if (missingRequiredQuestions(questions, mine).length === 0) return changed;
  const { allowed } = await canActAsHost(userId, role, sessionId);
  if (allowed) return changed;
  throw new ConflictError(ErrorCodes.EVENT_ANSWERS_REQUIRED, ANSWERS_REQUIRED_SENTENCE);
}

/**
 * The questions the call link's landing asks (Part 3 Task 5): signed out (`userId` null), all of them; signed in, those
 * the person has not answered; required ones first either way. Null when the event has none to ask, or no longer asks
 * (live or over). Never anyone's answers.
 */
export async function questionsToAsk(sessionId: string, userId: string | null, status: string): Promise<EventMatchingQuestion[] | null> {
  if (windowOf(status) !== 'open') return null;
  const questions = (await readQuestions(sessionId)).map(publicShape);
  if (questions.length === 0) return null;
  const mine = userId ? await answersOf(readerOf(), sessionId, userId) : {};
  const open = unansweredQuestions(questions, mine);
  return open.length > 0 ? open : null;
}

/** Whether a person still has a required question to answer, while the event still asks (not live, not over). */
export async function requiredQuestionsMissing(sessionId: string, userId: string, status: string): Promise<boolean> {
  if (windowOf(status) !== 'open') return false;
  const questions = await readQuestions(sessionId);
  if (!questions.some((q) => q.required)) return false;
  return missingRequiredQuestions(questions, await answersOf(readerOf(), sessionId, userId)).length > 0;
}

// ─── The organiser saves the questions ───────────────────────────────────────

async function requireOrganiser(sessionId: string, actor: Actor): Promise<void> {
  const { allowed } = await canActAsHost(actor.userId, actor.role, sessionId);
  if (allowed) return;
  // An event this person cannot see answers exactly as an id that does not exist, never "only organisers".
  const facts = await readEventAccessFacts(sessionId, actor.userId);
  if (!facts || !canSeeEvent(facts, actor.role)) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  throw new ForbiddenError(ORGANISERS_ONLY);
}

/** Prompts and labels trimmed; everything else as sent (validateEventQuestions refuses what is wrong). */
function normalised(questions: EventMatchingQuestion[]): EventMatchingQuestion[] {
  return questions.map((q) => ({
    key: q.key,
    prompt: typeof q.prompt === 'string' ? q.prompt.trim() : q.prompt,
    kind: q.kind,
    prefer: q.prefer,
    required: q.required === true,
    options: (q.options ?? []).map((o) => ({ key: o.key, label: typeof o.label === 'string' ? o.label.trim() : o.label })),
  }));
}

/**
 * The questions the save left, and the answers they no longer hold: a removed question's answers go with it (ON DELETE
 * CASCADE); an answer left with no option the question still offers is removed, then the offered ones are kept in the
 * order given; a one-answer question keeps no answer of several. Returns the people whose answers changed.
 */
async function writeQuestions(client: PoolClient, sessionId: string, actorId: string, questions: EventMatchingQuestion[]): Promise<string[]> {
  const keys = questions.map((q) => q.key);
  const dropped = await client.query<{ user_id: string }>(
    `DELETE FROM event_question_answers a USING event_matching_questions q
      WHERE q.id = a.question_id AND q.session_id = $1 AND NOT (q.key = ANY($2::text[]))
      RETURNING a.user_id`,
    [sessionId, keys],
  );
  await client.query(`DELETE FROM event_matching_questions WHERE session_id = $1 AND NOT (key = ANY($2::text[]))`, [sessionId, keys]);
  if (questions.length > 0) {
    await client.query(
      `INSERT INTO event_matching_questions (session_id, key, prompt, kind, prefer, required, options, position, updated_by, updated_at)
       SELECT $1::uuid, t.key, t.prompt, t.kind, t.prefer, t.required, t.options::jsonb, t.position, $9::uuid, NOW()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[], $8::int[])
              AS t(key, prompt, kind, prefer, required, options, position)
       ON CONFLICT (session_id, key) DO UPDATE
         SET prompt = EXCLUDED.prompt, kind = EXCLUDED.kind, prefer = EXCLUDED.prefer, required = EXCLUDED.required,
             options = EXCLUDED.options, position = EXCLUDED.position, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [
        sessionId, keys, questions.map((q) => q.prompt), questions.map((q) => q.kind), questions.map((q) => q.prefer),
        questions.map((q) => q.required), questions.map((q) => JSON.stringify(q.options)), keys.map((_, i) => i), actorId,
      ],
    );
  }
  const emptied = await client.query<{ user_id: string }>(
    `DELETE FROM event_question_answers a USING event_matching_questions q
      WHERE q.id = a.question_id AND a.session_id = $1
        AND (NOT EXISTS (SELECT 1 FROM unnest(a.option_keys) AS k(key)
                          WHERE k.key IN (SELECT o->>'key' FROM jsonb_array_elements(q.options) AS o))
             OR (q.kind = 'single' AND cardinality(a.option_keys) > 1))
      RETURNING a.user_id`,
    [sessionId],
  );
  const stripped = await client.query<{ user_id: string }>(
    `UPDATE event_question_answers a
        SET option_keys = ARRAY(SELECT k.key FROM unnest(a.option_keys) WITH ORDINALITY AS k(key, n)
                                 WHERE k.key IN (SELECT o->>'key' FROM jsonb_array_elements(q.options) AS o)
                                 ORDER BY k.n),
            updated_at = NOW()
       FROM event_matching_questions q
      WHERE q.id = a.question_id AND a.session_id = $1
        AND EXISTS (SELECT 1 FROM unnest(a.option_keys) AS k(key)
                     WHERE k.key NOT IN (SELECT o->>'key' FROM jsonb_array_elements(q.options) AS o))
      RETURNING a.user_id`,
    [sessionId],
  );
  return [...new Set([...dropped.rows, ...emptied.rows, ...stripped.rows].map((r) => r.user_id))];
}

/**
 * The organiser saves the event's matching questions (host, co-host, the pod's admin or a super admin: canActAsHost, as
 * the groups). Refused while the event is live or once it is over. A question left out is removed with its answers, and
 * an answer the organiser took away is taken out of everyone's answers. No questions at all removes them all: the event
 * goes back to matching exactly as before. Audited `questions.changed` with before and after.
 */
export async function saveEventQuestions(sessionId: string, actor: Actor, questions: EventMatchingQuestion[]): Promise<EventMatchingQuestion[]> {
  const exists = await query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1`, [sessionId]);
  if (!exists.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  await requireOrganiser(sessionId, actor);
  const next = normalised(questions);
  refuseIssues(validateEventQuestions(next));
  const saved = await transaction(async (client) => {
    const window = windowOf(await statusOf(readerOf(client), sessionId, true));
    if (window === 'live') throw new ConflictError(ErrorCodes.SESSION_IN_PROGRESS, QUESTIONS_LIVE_SENTENCE);
    if (window === 'ended') throw new ConflictError(ErrorCodes.EVENT_ENDED, QUESTIONS_ENDED_SENTENCE);
    const before = await getEventQuestions(sessionId, client);
    const affected = await writeQuestions(client, sessionId, actor.userId, next);
    const after = await getEventQuestions(sessionId, client);
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'questions.changed', automatic: false, subjectUserIds: affected,
      before: before.length > 0 ? before : null, after: after.length > 0 ? after : null,
    }, client);
    return after;
  });
  void fanoutEventQuestions(sessionId);
  void emitEventAuditChanged(sessionId);
  return saved;
}

// ─── What a screen reads ─────────────────────────────────────────────────────

function countsOf(questions: EventMatchingQuestion[], all: Array<{ answers: EventAnswers }>): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const q of questions) counts[q.key] = Object.fromEntries(q.options.map((o) => [o.key, 0]));
  for (const person of all) {
    for (const [key, optionKeys] of Object.entries(person.answers)) {
      const row = counts[key];
      if (!row) continue;
      for (const option of new Set(optionKeys)) if (option in row) row[option] += 1;
    }
  }
  return counts;
}

/**
 * The event's questions as a viewer reads them: anyone who can see the event gets the questions, their own answers and
 * the required questions they have not answered; the people running it also get every person's answers and how many
 * chose each answer. Someone who cannot see the event is told it does not exist, as for an unknown id.
 */
export async function readEventQuestions(sessionId: string, viewer: Actor): Promise<EventQuestionsView> {
  const facts = await readEventAccessFacts(sessionId, viewer.userId);
  if (!facts || !canSeeEvent(facts, viewer.role)) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  const questions = await getEventQuestions(sessionId);
  const mine = questions.length > 0 ? await answersOf(readerOf(), sessionId, viewer.userId) : {};
  const view: EventQuestionsView = { questions, mine, missingRequired: missingRequiredQuestions(questions, mine) };
  const { allowed } = await canActAsHost(viewer.userId, viewer.role, sessionId);
  if (!allowed) return view;
  if (questions.length === 0) return { ...view, answers: [], counts: {} };
  const rows = await query<{ user_id: string; key: string; option_keys: string[] }>(
    `SELECT a.user_id, q.key, a.option_keys
       FROM event_question_answers a JOIN event_matching_questions q ON q.id = a.question_id
      WHERE a.session_id = $1
      ORDER BY a.user_id, q.position
      LIMIT $2`,
    [sessionId, ORGANISER_ANSWERS_MAX],
  );
  const byUser = new Map<string, EventAnswers>();
  for (const row of rows.rows) {
    const answers = byUser.get(row.user_id) ?? {};
    answers[row.key] = row.option_keys;
    byUser.set(row.user_id, answers);
  }
  const answers = [...byUser].map(([userId, a]) => ({ userId, answers: a }));
  return { ...view, answers, counts: countsOf(questions, answers) };
}
