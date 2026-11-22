// ─── Extra matching questions on the screens: the words, the forms' values and the small pure steps (Part 3 Task 10) ─
// An organiser asks up to five questions per event (Task 5's routes); guests answer them on the RSN Call link, members
// when they register on the event page. Answers are soft preferences (plan K5): they only choose among the meetings the
// event already allows. Pure (shared and zod only), so the server's test suite runs it. What is valid is the shared
// validateEventQuestions' (the server checks the same).
//
// Privacy: a person's answers reach only them and the event's organisers. The server sends every person's answers
// (`answers`) to organisers alone; every label helper here reads only that field, so a screen drawn for anyone else has
// nothing to show.
import { z } from 'zod';
import type { FieldErrors, Resolver } from 'react-hook-form';
import {
  MATCHING_QUESTIONS_CARD_LINE, MAX_EVENT_QUESTIONS, MAX_QUESTION_OPTIONS, MIN_QUESTION_OPTIONS, QUESTION_LIMITS,
  validateEventQuestions,
  type EventAnswers, type EventMatchingQuestion, type EventQuestionsView, type QuestionKind, type QuestionPrefer,
} from '@rsn/shared';

export const QUESTIONS_COPY = {
  title: 'Extra matching questions',
  hint: MATCHING_QUESTIONS_CARD_LINE,
  none: 'No extra questions. Add one if your matching needs more than groups.',
  locked: "Questions can't change while the event is live.",
  add: 'Add question',
  edit: 'Edit',
  remove: 'Remove',
  removeTitle: 'Remove this question?',
  removeBody: 'Answers to it are deleted.',
  removed: 'Question removed.',
  saved: 'Question saved.',
  save: 'Save question',
  editorTitleNew: 'Add question',
  editorTitleEdit: 'Edit question',
  prompt: 'Question',
  kindLegend: 'How many answers',
  kinds: { single: 'One answer', multiple: 'Several answers' } as Record<QuestionKind, string>,
  answers: 'Answers',
  addAnswer: 'Add answer',
  answerName: (n: number) => `Answer ${n}`,
  removeAnswer: (label: string) => `Remove ${label || 'this answer'}`,
  preferLegend: 'Who should meet',
  prefers: {
    same: 'Match people with the same answer',
    different: 'Match people with different answers',
  } as Record<QuestionPrefer, string>,
  required: 'Required',
  optional: '(optional)',
  chooseAll: 'Choose all that apply.',
  chooseAnswer: 'Choose an answer.',
  chooseGroup: 'Choose your group.',
  sameLabels: 'Two answers say the same thing.',
  people: (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`,
  error: 'The questions could not be read just now.',
  fallback: 'That did not go through. Please try again.',
  // The member's side.
  sheetTitle: 'Before you join',
  sheetIntro: 'This event asks a little more before you join. Your answers help choose who you meet.',
  yourAnswers: 'Your answers',
  yourAnswersHint: 'Only you and the organisers see them. You can change them until the event starts.',
  changeAnswers: 'Change answers',
  notAnswered: 'Not answered yet',
  answersSaved: 'Answers saved.',
  saveAnswers: 'Save answers',
} as const;

// ─── The organiser's editor ─────────────────────────────────────────────────────────────────────────────────────────

/** The editor's values for one question: a saved question keeps its keys (its answers keep pointing at it). */
export interface QuestionFormValues {
  key: string;
  prompt: string;
  kind: QuestionKind;
  prefer: QuestionPrefer;
  required: boolean;
  options: Array<{ key: string; label: string }>;
}

export function newQuestionValues(): QuestionFormValues {
  return { key: '', prompt: '', kind: 'single', prefer: 'same', required: false, options: [{ key: '', label: '' }, { key: '', label: '' }] };
}

export function questionFormValuesOf(q: EventMatchingQuestion | null | undefined): QuestionFormValues {
  if (!q) return newQuestionValues();
  return { key: q.key, prompt: q.prompt, kind: q.kind, prefer: q.prefer, required: q.required, options: q.options.map((o) => ({ key: o.key, label: o.label })) };
}

/** A key from words: lower-case letters, digits and '_', never one already taken; `fallback` when no letter is left. */
export function keyFromWords(words: string, taken: ReadonlySet<string>, fallback: string): string {
  let base = '';
  for (const ch of words.trim().toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) base += ch;
    else if (base && !base.endsWith('_')) base += '_';
    if (base.length >= QUESTION_LIMITS.keyMaxLength - 3) break;
  }
  while (base.endsWith('_')) base = base.slice(0, -1);
  if (!base) base = fallback;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

/** The form as the question the server stores: a new question and new answers are given keys from their words. */
export function questionOfForm(values: QuestionFormValues, others: readonly EventMatchingQuestion[]): EventMatchingQuestion {
  const takenQuestions = new Set(others.map((q) => q.key));
  const key = values.key || keyFromWords(values.prompt, takenQuestions, 'question');
  const takenOptions = new Set(values.options.map((o) => o.key).filter(Boolean));
  const options = values.options.map((o) => {
    if (o.key) return { key: o.key, label: o.label.trim() };
    const optionKey = keyFromWords(o.label, takenOptions, 'answer');
    takenOptions.add(optionKey);
    return { key: optionKey, label: o.label.trim() };
  });
  return { key, prompt: values.prompt.trim(), kind: values.kind, prefer: values.prefer, required: values.required, options };
}

/** The event's questions with this one put at `index` (a new one goes last). */
export function questionsWith(saved: readonly EventMatchingQuestion[], index: number | null, q: EventMatchingQuestion): EventMatchingQuestion[] {
  if (index === null || index < 0 || index >= saved.length) return [...saved, q];
  return saved.map((s, i) => (i === index ? q : s));
}

/** The event's questions without the one at `index`. */
export function questionsWithout(saved: readonly EventMatchingQuestion[], index: number): EventMatchingQuestion[] {
  return saved.filter((_, i) => i !== index);
}

/** "Add question" shows until the event asks five. */
export function canAddQuestion(saved: readonly EventMatchingQuestion[]): boolean {
  return saved.length < MAX_EVENT_QUESTIONS;
}

/** "One answer · Match people with the same answer · Required". */
export function describeQuestion(q: Pick<EventMatchingQuestion, 'kind' | 'prefer' | 'required'>): string {
  return [QUESTIONS_COPY.kinds[q.kind], QUESTIONS_COPY.prefers[q.prefer], q.required ? QUESTIONS_COPY.required : 'Optional'].join(' · ');
}

type ErrorNode = { type?: string; message?: string; [key: string]: unknown };

/** Every problem with the edited question, keyed by its field in the form ("prompt", "options.1.label"). */
export function questionFormIssues(values: QuestionFormValues, saved: readonly EventMatchingQuestion[], index: number | null): Record<string, string> {
  const q = questionOfForm(values, saved.filter((_, i) => i !== index));
  const list = questionsWith(saved, index, q);
  const at = index === null || index < 0 || index >= saved.length ? list.length - 1 : index;
  const prefix = `questions.${at}`;
  const issues: Record<string, string> = {};
  for (const issue of validateEventQuestions(list)) {
    if (issue.field !== prefix && !issue.field.startsWith(`${prefix}.`)) continue;
    // An answer's key comes from its words, so a problem with it is said at the words.
    const field = issue.field.slice(prefix.length + 1).replace(/^options\.(\d+)\.key$/, 'options.$1.label').replace(/^key$/, 'prompt');
    if (!(field in issues)) issues[field] = issue.message;
  }
  const seen = new Map<string, number>();
  values.options.forEach((o, j) => {
    const words = o.label.trim().toLowerCase();
    if (!words) return;
    if (seen.has(words) && !(`options.${j}.label` in issues)) issues[`options.${j}.label`] = QUESTIONS_COPY.sameLabels;
    else seen.set(words, j);
  });
  return issues;
}

const questionShape = z.object({
  key: z.string(),
  prompt: z.string().max(QUESTION_LIMITS.promptMaxLength, `Ask the question in 1 to ${QUESTION_LIMITS.promptMaxLength} characters.`),
  kind: z.enum(['single', 'multiple']),
  prefer: z.enum(['same', 'different']),
  required: z.boolean(),
  options: z.array(z.object({
    key: z.string(),
    label: z.string().max(QUESTION_LIMITS.optionLabelMaxLength, `Write each answer in 1 to ${QUESTION_LIMITS.optionLabelMaxLength} characters.`),
  })).min(MIN_QUESTION_OPTIONS, `Give a question ${MIN_QUESTION_OPTIONS} to ${MAX_QUESTION_OPTIONS} answers to choose from.`)
    .max(MAX_QUESTION_OPTIONS, `Give a question ${MIN_QUESTION_OPTIONS} to ${MAX_QUESTION_OPTIONS} answers to choose from.`),
});

/** react-hook-form's resolver for one question: Zod for the shape, the shared validator for the rest, at full paths. */
export function questionFormResolver(saved: readonly EventMatchingQuestion[], index: number | null): Resolver<QuestionFormValues> {
  const schema = questionShape.superRefine((values, ctx) => {
    for (const [field, message] of Object.entries(questionFormIssues(values, saved, index))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: field.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg)) });
    }
  });
  return async (values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data as QuestionFormValues, errors: {} };
    const errors: Record<string, ErrorNode> = {};
    for (const issue of parsed.error.issues) {
      let node: Record<string, unknown> = errors;
      issue.path.forEach((seg, i) => {
        const key = String(seg);
        const next = (node[key] ?? {}) as ErrorNode;
        if (i === issue.path.length - 1 && next.message === undefined) Object.assign(next, { type: issue.code, message: issue.message });
        node[key] = next;
        node = next;
      });
    }
    return { values: {}, errors: errors as FieldErrors<QuestionFormValues> };
  };
}

// ─── A person's answers (the member's sheet; the call link's details step) ──────────────────────────────────────────

/** The answer form's field for a question; `groups` is the event's group question (never a question key: prefixed). */
export const GROUPS_FIELD = 'groups';
export const answerField = (questionKey: string) => `answer_${questionKey}`;

export type AnswerFormValues = Record<string, string[]>;

/** The form's starting values: the person's own answers and group, as the server knows them. */
export function answerFormDefaults(questions: readonly EventMatchingQuestion[], mine: EventAnswers, groupKeys: readonly string[] = []): AnswerFormValues {
  const values: AnswerFormValues = { [GROUPS_FIELD]: [...groupKeys] };
  for (const q of questions) values[answerField(q.key)] = [...(mine[q.key] ?? [])];
  return values;
}

/**
 * The answers given in the form. An empty answer is left out (nothing to send with a registration), unless `clear` is
 * set: a person changing their answers sends it empty, which clears that optional answer on the server.
 */
export function answersOfForm(values: AnswerFormValues, questions: readonly EventMatchingQuestion[], clear = false): EventAnswers {
  const answers: EventAnswers = {};
  for (const q of questions) {
    const keys = values[answerField(q.key)] ?? [];
    if (keys.length > 0 || clear) answers[q.key] = [...keys];
  }
  return answers;
}

/** The answer form's schema: a required question needs an answer, a one-answer question takes one; a group is chosen. */
export function answerFormSchema(questions: readonly EventMatchingQuestion[], askGroup: boolean) {
  const shape: Record<string, z.ZodType<string[]>> = {
    [GROUPS_FIELD]: askGroup ? z.array(z.string()).min(1, QUESTIONS_COPY.chooseGroup) : z.array(z.string()),
  };
  for (const q of questions) {
    let field = z.array(z.string());
    if (q.required) field = field.min(1, QUESTIONS_COPY.chooseAnswer);
    if (q.kind === 'single') field = field.max(1, QUESTIONS_COPY.chooseAnswer);
    shape[answerField(q.key)] = field;
  }
  return z.object(shape);
}

/** The keys a tap leaves chosen: one answer replaces the last, several add or take away. */
export function toggleChoice(chosen: readonly string[], key: string, multiple: boolean): string[] {
  if (!multiple) return [key];
  return chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key];
}

// ─── Showing answers ────────────────────────────────────────────────────────────────────────────────────────────────

function labelsOf(q: EventMatchingQuestion, keys: readonly string[] | undefined): string[] {
  if (!keys || keys.length === 0) return [];
  return q.options.filter((o) => keys.includes(o.key)).map((o) => o.label);
}

/** One person's answers, a line per answered question ("Which sector?" → ["Health"]); organisers' read only. */
export function answerLinesFor(view: EventQuestionsView | undefined, userId: string): Array<{ prompt: string; labels: string[] }> {
  if (!view?.answers) return [];
  const theirs = view.answers.find((a) => a.userId === userId)?.answers;
  if (!theirs) return [];
  return view.questions.map((q) => ({ prompt: q.prompt, labels: labelsOf(q, theirs[q.key]) })).filter((l) => l.labels.length > 0);
}

/** One person's answers as short chips ("Health", "AI"), for the organisers' participant list and board. */
export function answerLabelsFor(view: EventQuestionsView | undefined, userId: string): string[] {
  return answerLinesFor(view, userId).flatMap((l) => l.labels);
}

/** The viewer's own answers, a line per answered question ("Which sector?: Health"). */
export function myAnswerLines(view: EventQuestionsView | undefined): string[] {
  if (!view) return [];
  return view.questions
    .map((q) => ({ prompt: q.prompt, labels: labelsOf(q, view.mine[q.key]) }))
    .filter((l) => l.labels.length > 0)
    .map((l) => `${/[?:]$/.test(l.prompt) ? l.prompt : `${l.prompt}:`} ${l.labels.join(', ')}`);
}

/** How many people chose each answer (the organisers' counts), 0 when nobody has. */
export function optionCount(view: EventQuestionsView | undefined, questionKey: string, optionKey: string): number {
  return view?.counts?.[questionKey]?.[optionKey] ?? 0;
}

/** The register retry's extra body: the group chosen and the answers given, each only when there is one. */
export function entryChoices(groupKeys: readonly string[], answers: EventAnswers): { groupKeys?: string[]; answers?: EventAnswers } {
  return {
    ...(groupKeys.length > 0 ? { groupKeys: [...groupKeys] } : {}),
    ...(Object.keys(answers).length > 0 ? { answers } : {}),
  };
}

/** The register refusals that the "Before you join" sheet answers: a group to choose, a required question unanswered. */
export const NEEDS_ANSWERS_CODES: ReadonlySet<string> = new Set(['EVENT_GROUP_REQUIRED', 'EVENT_ANSWERS_REQUIRED']);

export function needsAnswers(err: unknown): boolean {
  const code = (err as { response?: { data?: { error?: { code?: unknown } } } } | null)?.response?.data?.error?.code;
  return typeof code === 'string' && NEEDS_ANSWERS_CODES.has(code);
}

/**
 * The event page's register body: what it sent before (nothing, or `{ waitlist: true }` on a full event), plus the group
 * and answers the "Before you join" sheet gave, when it gave any.
 */
export function registerBodyWith<T extends object>(
  base: T | undefined, choices?: { groupKeys: readonly string[]; answers: EventAnswers },
): T | (Partial<T> & { groupKeys?: string[]; answers?: EventAnswers }) | undefined {
  const extra = choices ? entryChoices(choices.groupKeys, choices.answers) : {};
  return Object.keys(extra).length === 0 ? base : { ...(base ?? {}), ...extra } as Partial<T> & typeof extra;
}
