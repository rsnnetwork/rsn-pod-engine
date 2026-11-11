// ─── Extra matching questions for an event (10 Nov 2026 spec, Part 3 Task 5; section 02; plan K5) ──────────
//
// An organiser may ask up to five extra questions per event, each with 2 to 8 answers they write, one answer or
// several, and say whether people who answer alike or differently should meet. Guests answer them on the RSN Call
// link, members when they register on the event page. Pure functions, no I/O: the engine, the matching board's
// redistribution, the server's checks and the client's forms read the same rule from here.
//
// The ruling (K5), word for word, also in ENTITIES.md and on the organiser's card:
//
//   "Matching questions are soft preferences. They only choose among the meetings the event already allows. A block, a
//   report, an inviter and the person they invited, and the event's group rules always win, and so does the no-repeat
//   rule. Questions never make a meeting that would otherwise be refused, never leave someone unmatched, and never cause
//   a repeat."
//
// How that holds: the engine adds the answers as one more weighted term inside its pair score (EVENT_QUESTION_WEIGHT),
// which it computes only for pairs that already passed every hard exclusion and the round's group rule, and its pairs
// are sorted by how often two people have met before the score is looked at. An event with no questions adds no term
// at all, so it is matched exactly as before.
//
// Answers are the person's own for this event: only they and the event's organisers see them. They are never copied to
// the account and never read from another event.

import type { EventInputIssue } from './rules';

export const MAX_EVENT_QUESTIONS = 5;
export const MIN_QUESTION_OPTIONS = 2;
export const MAX_QUESTION_OPTIONS = 8;
/** The answers' weight in the engine's pair score: one intent-sized factor (the same as intentAlignment). */
export const EVENT_QUESTION_WEIGHT = 0.20;

/** The lengths the organiser's form and the server hold a question to (the database checks the same). */
export const QUESTION_LIMITS = {
  keyMaxLength: 32,
  promptMaxLength: 120,
  optionLabelMaxLength: 40,
} as const;

export const MATCHING_QUESTIONS_RULING =
  'Matching questions are soft preferences. They only choose among the meetings the event already allows. A block, a '
  + 'report, an inviter and the person they invited, and the event\'s group rules always win, and so does the no-repeat '
  + 'rule. Questions never make a meeting that would otherwise be refused, never leave someone unmatched, and never cause '
  + 'a repeat.';

/** The line the organiser's card shows under its questions. */
export const MATCHING_QUESTIONS_CARD_LINE =
  'Answers help RSN choose between allowed meetings. They never override blocks or group rules.';

/** One answer, or several. */
export type QuestionKind = 'single' | 'multiple';
/** Whether people who answer alike, or people who answer differently, are preferred as partners. */
export type QuestionPrefer = 'same' | 'different';

export interface EventQuestionOption {
  key: string;
  label: string;
}

export interface EventMatchingQuestion {
  key: string;
  prompt: string;
  kind: QuestionKind;
  prefer: QuestionPrefer;
  /** A required question is asked before a person's own first place; an optional one counts as neutral unanswered. */
  required: boolean;
  options: EventQuestionOption[];
}

/** A person's answers: question key → the option keys they chose. */
export type EventAnswers = Record<string, string[]>;

/**
 * GET /api/sessions/:id/questions. Everyone who can see the event reads its questions, their own answers (`mine`) and
 * which required questions they have not answered yet; the people running it also read every person's answers and how
 * many people chose each answer. Nobody else's answers ever reach anyone else.
 */
export interface EventQuestionsView {
  questions: EventMatchingQuestion[];
  mine: EventAnswers;
  missingRequired: string[];
  /** The organisers only: each person who answered, with their answers. */
  answers?: Array<{ userId: string; answers: EventAnswers }>;
  /** The organisers only: question key → option key → how many people chose it. */
  counts?: Record<string, Record<string, number>>;
}

const KEY_PATTERN = /^[a-z0-9_]{1,32}$/;

/** A question or option key as stored: lower-case letters, digits and underscores, 1 to 32 of them. */
export function isQuestionKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** The option keys of `answer` the question still has, each once. */
function usableKeys(question: EventMatchingQuestion, answer: readonly string[] | undefined): string[] {
  if (!answer || answer.length === 0) return [];
  const known = new Set(question.options.map((o) => o.key));
  return [...new Set(answer.filter((k) => known.has(k)))];
}

/** One question's affinity in [0, 1]; 0.5 when either side has not answered it. */
function questionScore(question: EventMatchingQuestion, a: EventAnswers | undefined, b: EventAnswers | undefined): number {
  const mine = usableKeys(question, a?.[question.key]);
  const theirs = usableKeys(question, b?.[question.key]);
  if (mine.length === 0 || theirs.length === 0) return 0.5;
  const theirSet = new Set(theirs);
  const shared = mine.filter((k) => theirSet.has(k)).length;
  const overlap = shared / Math.min(mine.length, theirs.length);
  const same = overlap > 0 ? 0.5 + 0.5 * overlap : 0;
  return question.prefer === 'same' ? same : 1 - same;
}

/**
 * How well two people's answers suit each other, in [0, 1]: the mean over the event's questions, so five questions never
 * weigh more than one. Per question, with only option keys the question still has: either side unanswered is 0.5
 * (neutral); otherwise o = |A ∩ B| / min(|A|, |B|), same = o > 0 ? 0.5 + 0.5·o : 0, and the question scores `same`
 * when it prefers the same answers, 1 − same when it prefers different ones. A single-choice question gives 1 for the
 * preferred outcome and 0 for the other. No questions: 0.5.
 */
export function questionAffinity(
  a: EventAnswers | undefined,
  b: EventAnswers | undefined,
  questions: readonly EventMatchingQuestion[],
): number {
  if (questions.length === 0) return 0.5;
  let total = 0;
  for (const q of questions) total += questionScore(q, a, b);
  return total / questions.length;
}

// ─── The organiser's input ───────────────────────────────────────────────────

function checkOptions(q: EventMatchingQuestion, i: number): EventInputIssue[] {
  const issues: EventInputIssue[] = [];
  const options = Array.isArray(q.options) ? q.options : [];
  if (options.length < MIN_QUESTION_OPTIONS || options.length > MAX_QUESTION_OPTIONS) {
    issues.push({
      field: `questions.${i}.options`,
      message: `Give a question ${MIN_QUESTION_OPTIONS} to ${MAX_QUESTION_OPTIONS} answers to choose from.`,
    });
  }
  const seen = new Set<string>();
  options.forEach((o, j) => {
    if (!isQuestionKey(o?.key)) {
      issues.push({ field: `questions.${i}.options.${j}.key`, message: 'An answer needs a short name made of letters and numbers.' });
    } else if (seen.has(o.key)) {
      issues.push({ field: `questions.${i}.options.${j}.key`, message: 'Two answers have the same name.' });
    } else {
      seen.add(o.key);
    }
    const label = typeof o?.label === 'string' ? o.label.trim() : '';
    if (label.length === 0 || label.length > QUESTION_LIMITS.optionLabelMaxLength) {
      issues.push({
        field: `questions.${i}.options.${j}.label`,
        message: `Write each answer in 1 to ${QUESTION_LIMITS.optionLabelMaxLength} characters.`,
      });
    }
  });
  return issues;
}

function checkQuestion(q: EventMatchingQuestion, i: number, seen: Set<string>): EventInputIssue[] {
  const issues: EventInputIssue[] = [];
  if (!isQuestionKey(q.key)) {
    issues.push({ field: `questions.${i}.key`, message: 'A question needs a short name made of letters and numbers.' });
  } else if (seen.has(q.key)) {
    issues.push({ field: `questions.${i}.key`, message: 'Two questions have the same name.' });
  } else {
    seen.add(q.key);
  }
  const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
  if (prompt.length === 0 || prompt.length > QUESTION_LIMITS.promptMaxLength) {
    issues.push({ field: `questions.${i}.prompt`, message: `Ask the question in 1 to ${QUESTION_LIMITS.promptMaxLength} characters.` });
  }
  if (q.kind !== 'single' && q.kind !== 'multiple') {
    issues.push({ field: `questions.${i}.kind`, message: 'Choose one answer or several answers.' });
  }
  if (q.prefer !== 'same' && q.prefer !== 'different') {
    issues.push({ field: `questions.${i}.prefer`, message: 'Choose whether people with the same or different answers meet.' });
  }
  return [...issues, ...checkOptions(q, i)];
}

/**
 * Everything wrong with an organiser's questions, said at the field: at most five, distinct well-formed keys, a prompt,
 * one answer or several, same or different preferred, and 2 to 8 answers with distinct keys and labels. No questions at
 * all is fine (the event goes back to having none).
 */
export function validateEventQuestions(questions: readonly EventMatchingQuestion[]): EventInputIssue[] {
  const issues: EventInputIssue[] = [];
  if (questions.length > MAX_EVENT_QUESTIONS) {
    issues.push({ field: 'questions', message: `An event can ask at most ${MAX_EVENT_QUESTIONS} matching questions.` });
  }
  const seen = new Set<string>();
  questions.forEach((q, i) => issues.push(...checkQuestion(q, i, seen)));
  return issues;
}

// ─── A person's answers ──────────────────────────────────────────────────────

const ANSWER_FROM_LIST = "Choose from this question's answers.";

function cleanOne(q: EventMatchingQuestion, value: unknown): { keys: string[] | null; issue: string | null } {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return { keys: null, issue: ANSWER_FROM_LIST };
  const given = [...new Set(value as string[])];
  const keys = usableKeys(q, given);
  if (given.length > 0 && keys.length === 0) return { keys: null, issue: ANSWER_FROM_LIST };
  if (q.kind === 'single' && keys.length > 1) return { keys: null, issue: 'Choose one answer.' };
  return { keys, issue: null };
}

/**
 * A person's answers as the event knows them: a key that is not one of the event's questions is dropped (the question
 * may have gone since the form was opened), as is an answer the question no longer offers; each option once. An empty
 * list clears that answer. Said at the field: something that is not a list of answers, a list of only answers the
 * question does not offer, and more than one answer to a one-answer question.
 */
export function cleanEventAnswers(
  questions: readonly EventMatchingQuestion[],
  raw: unknown,
): { answers: EventAnswers; issues: EventInputIssue[] } {
  if (raw === undefined || raw === null) return { answers: {}, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { answers: {}, issues: [{ field: 'answers', message: 'Those answers could not be read. Try again.' }] };
  }
  const byKey = new Map(questions.map((q) => [q.key, q]));
  const answers: EventAnswers = {};
  const issues: EventInputIssue[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const q = byKey.get(key);
    if (!q) continue;
    const { keys, issue } = cleanOne(q, value);
    if (issue) issues.push({ field: `answers.${key}`, message: issue });
    else if (keys) answers[key] = keys;
  }
  return { answers, issues };
}

/** The keys of the required questions these answers leave unanswered (an answer the question no longer offers is none). */
export function missingRequiredQuestions(questions: readonly EventMatchingQuestion[], answers: EventAnswers): string[] {
  return questions.filter((q) => q.required && usableKeys(q, answers[q.key]).length === 0).map((q) => q.key);
}

/** The questions these answers leave unanswered, required ones first, each group in the event's order. */
export function unansweredQuestions(questions: readonly EventMatchingQuestion[], answers: EventAnswers): EventMatchingQuestion[] {
  const open = questions.filter((q) => usableKeys(q, answers[q.key]).length === 0);
  return [...open.filter((q) => q.required), ...open.filter((q) => !q.required)];
}
