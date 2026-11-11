// server/src/__tests__/client/p3-questions.test.ts
// Part 3 Task 10 (10 Nov 2026 spec 02 "a small number of additional matching questions"; plan K5): the screens of
// Task 5's extra matching questions, on the preview client.
//
// 1. The words, verbatim from the brief: the organiser's card, its editor, its remove confirm, its empty and live lines,
//    and the member's "Before you join" sheet with "(optional)".
// 2. Real time: the questions read follows session:<id>:questions and session:<id>:participants; the matching board
//    and the call link follow the questions tag too; nobody writes into a cached answer.
// 3. The call link's details step draws the questions only when a required one is missing, or when the step is shown
//    anyway (then the optional ones too); never stops someone for an optional question alone.
// 4. The member's sheet opens on both 409 codes (EVENT_GROUP_REQUIRED, EVENT_ANSWERS_REQUIRED), from Register and from
//    the automatic registration, and Register is sent again with { groupKeys, answers }. It also draws the group tiles
//    a member on a group event never had. An approval event sends the answers with the request.
// 5. Answers show to organisers only: the participant list's chips and the board read only the organisers' `answers`.
// 6. The organiser's editor: keys from words, the shared validator's problems at their fields, at most five questions.
// 7. Tap targets: 44px controls, 56px answer tiles.
import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MATCHING_QUESTIONS_CARD_LINE, type CallEntryState, type CallLanding, type EventMatchingQuestion, type EventQuestionsView } from '@rsn/shared';
import { E as clientE } from '../../../../client/src/realtime/entities';
import { asksSentence, callScreenOf, detailsFieldsFor, somethingMissing } from '../../../../client/src/features/call/call-entry';
import {
  GROUPS_FIELD, QUESTIONS_COPY, answerField, answerFormDefaults, answerFormSchema, answerLabelsFor, answerLinesFor,
  answersOfForm, canAddQuestion, describeQuestion, entryChoices, keyFromWords, myAnswerLines, needsAnswers, newQuestionValues,
  optionCount, questionFormIssues, questionOfForm, questionsWith, questionsWithout, registerBodyWith, toggleChoice,
} from '../../../../client/src/features/sessions/questions/question-form';
import { NO_BOARD_ANSWERS, boardAnswersOf } from '../../../../client/src/features/schedule/board-answers';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const read = readClientSource;
const DIR = 'features/sessions/questions';
const CLIENT = path.join(__dirname, '../../../../client/src');

const SECTOR: EventMatchingQuestion = {
  key: 'which_sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: true,
  options: [{ key: 'fintech', label: 'Fintech' }, { key: 'health', label: 'Health' }],
};
const TOPICS: EventMatchingQuestion = {
  key: 'topics', prompt: 'Topics you like', kind: 'multiple', prefer: 'different', required: false,
  options: [{ key: 'ai', label: 'AI' }, { key: 'payments', label: 'Payments' }, { key: 'biotech', label: 'Biotech' }],
};

function organiserView(over: Partial<EventQuestionsView> = {}): EventQuestionsView {
  return {
    questions: [SECTOR, TOPICS], mine: {}, missingRequired: [],
    answers: [{ userId: 'u-ana', answers: { which_sector: ['health'], topics: ['ai', 'biotech'] } }, { userId: 'u-bo', answers: { which_sector: ['fintech'] } }],
    counts: { which_sector: { health: 1, fintech: 1 }, topics: { ai: 1, biotech: 1 } },
    ...over,
  };
}
/** What a member or guest reads: the questions and their own answers, nobody else's. */
function memberView(over: Partial<EventQuestionsView> = {}): EventQuestionsView {
  return { questions: [SECTOR, TOPICS], mine: { which_sector: ['health'] }, missingRequired: [], ...over };
}

const NOTHING: CallEntryState['missing'] = { displayName: false, group: false, admissionCode: false, questions: false };

// ─── 1. The words ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('the questions say exactly the brief\'s words', () => {
  it('the organiser\'s card', () => {
    expect(QUESTIONS_COPY.title).toBe('Extra matching questions');
    expect(QUESTIONS_COPY.hint).toBe('Answers help RSN choose between allowed meetings. They never override blocks or group rules.');
    expect(QUESTIONS_COPY.hint).toBe(MATCHING_QUESTIONS_CARD_LINE);
    expect(QUESTIONS_COPY.add).toBe('Add question');
    expect(`${QUESTIONS_COPY.removeTitle} ${QUESTIONS_COPY.removeBody}`).toBe('Remove this question? Answers to it are deleted.');
    expect(QUESTIONS_COPY.none).toBe('No extra questions. Add one if your matching needs more than groups.');
    expect(QUESTIONS_COPY.locked).toBe("Questions can't change while the event is live.");
  });

  it('the editor', () => {
    expect(QUESTIONS_COPY.prompt).toBe('Question');
    expect(QUESTIONS_COPY.kinds).toEqual({ single: 'One answer', multiple: 'Several answers' });
    expect(QUESTIONS_COPY.answers).toBe('Answers');
    expect(QUESTIONS_COPY.addAnswer).toBe('Add answer');
    expect(QUESTIONS_COPY.prefers).toEqual({ same: 'Match people with the same answer', different: 'Match people with different answers' });
    expect(QUESTIONS_COPY.required).toBe('Required');
    expect(describeQuestion(SECTOR)).toBe('One answer · Match people with the same answer · Required');
    expect(describeQuestion(TOPICS)).toBe('Several answers · Match people with different answers · Optional');
  });

  it('the member\'s sheet', () => {
    expect(QUESTIONS_COPY.sheetTitle).toBe('Before you join');
    expect(QUESTIONS_COPY.optional).toBe('(optional)');
    const sheet = read(`${DIR}/MyEventAnswersSheet.tsx`);
    expect(sheet).toContain('title={join ? QUESTIONS_COPY.sheetTitle : QUESTIONS_COPY.yourAnswers}');
  });

  it('no screen of the questions says "session" or shows a raw id', () => {
    const files = fs.readdirSync(path.join(CLIENT, DIR)).map((f) => `${DIR}/${f}`);
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const rel of files) {
      const strings = Array.from(read(rel).matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)).map((m) => m[1] ?? m[2])
        .filter((s) => /\s/.test(s) && !s.startsWith('/') && !s.includes('${sessionId}'));
      for (const s of strings) expect({ rel, s, session: /\bsession\b/i.test(s) }).toEqual({ rel, s, session: false });
    }
  });
});

// ─── 2. Real time ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('every read of the questions follows the questions tag', () => {
  it('the questions read: session:<id>:questions and session:<id>:participants', () => {
    const hook = read(`${DIR}/useEventQuestions.ts`);
    expect(hook).toContain('meta: { entities: [E.sessionQuestions(sessionId), E.sessionParticipants(sessionId)] },');
    expect(clientE.sessionQuestions('s-1')).toBe('session:s-1:questions');
    expect(hook).toContain("api.get(`/sessions/${sessionId}/questions`)");
    expect(hook).toContain("api.put(`/sessions/${sessionId}/questions`, {");
    expect(hook).toContain("api.put(`/sessions/${sessionId}/questions/mine`, { answers })");
  });

  it('the matching board adds session:<id>:questions to its tags', () => {
    expect(read('features/schedule/useBoard.ts')).toContain(
      'meta: { entities: [E.sessionSchedule(sessionId), E.sessionGroups(sessionId), E.sessionParticipants(sessionId), E.sessionQuestions(sessionId)] }',
    );
  });

  it('the call link follows it once it knows the event', () => {
    expect(read('features/call/useCallLink.ts')).toMatch(/E\.sessionWaitlist\(sessionId\),\s*E\.sessionQuestions\(sessionId\),/);
  });

  it('nothing writes into a cached answer: the writes invalidate, the server answers', () => {
    for (const f of fs.readdirSync(path.join(CLIENT, DIR))) expect({ f, set: read(`${DIR}/${f}`).includes('setQueryData') }).toEqual({ f, set: false });
    const hook = read(`${DIR}/useEventQuestions.ts`);
    expect(hook.match(/qc\.invalidateQueries\(\{ queryKey: questionsKey\(sessionId\) \}\)/g)).toHaveLength(2);
  });
});

// ─── 3. The call link's details step ───────────────────────────────────────────────────────────────────────────────

describe('the call link asks the questions only when they are missing or the step is shown anyway', () => {
  it('detailsFieldsFor: required missing, or the step shown for something else; never for an optional one alone', () => {
    expect(detailsFieldsFor({ ...NOTHING, questions: true }, null, [SECTOR, TOPICS]).questions).toEqual([SECTOR, TOPICS]);
    expect(detailsFieldsFor({ ...NOTHING, displayName: true }, null, [TOPICS]).questions).toEqual([TOPICS]);
    expect(detailsFieldsFor({ ...NOTHING }, null, [TOPICS]).questions).toBeNull();
    expect(detailsFieldsFor({ ...NOTHING, questions: true }, null, null).questions).toBeNull();
    expect(detailsFieldsFor({ ...NOTHING, questions: true }, null, []).questions).toBeNull();
    // A caller from before Task 10 (no third argument) asks no questions.
    expect(detailsFieldsFor({ ...NOTHING, displayName: true }, null).questions).toBeNull();
  });

  it('a missing required answer keeps the person on the details step', () => {
    expect(somethingMissing({ ...NOTHING, questions: true })).toBe(true);
    expect(somethingMissing({ ...NOTHING })).toBe(false);
    const entry = (missing: CallEntryState['missing']): CallEntryState => ({
      step: 'details', sessionId: null, livePath: null, missing, refusal: null, startsAt: null, waitlistPosition: null,
    } as CallEntryState);
    const l = { lifecycle: 'registration_open' } as CallLanding;
    expect(callScreenOf({ landing: l, entry: entry({ ...NOTHING, questions: true }), phase: 'summary', started: true })).toBe('details');
    expect(callScreenOf({ landing: l, entry: entry({ ...NOTHING }), phase: 'summary', started: true })).toBe('joining');
  });

  it('the summary names the questions', () => {
    const asks = { displayName: true, group: null, admissionCode: false };
    expect(asksSentence({ ...asks, questions: [SECTOR] }, false)).toBe('This event will ask for: your email, your name, one matching question');
    expect(asksSentence({ ...asks, questions: [SECTOR, TOPICS] }, false)).toBe('This event will ask for: your email, your name, a few matching questions');
    expect(asksSentence({ ...asks, questions: null }, false)).toBe('This event will ask for: your email, your name');
  });

  function drawDetails(missing: CallEntryState['missing'], questions: EventMatchingQuestion[] | null): string {
    const mod = loadClientModule('features/call/CallDetailsStep.tsx', { 'lucide-react': iconStandIns });
    return renderToStaticMarkup(createElement(mod.default as never, {
      fields: detailsFieldsFor(missing, null, questions), refusal: null, approval: false, defaults: { admissionCode: '' },
      submit: async () => undefined, onClosed: () => undefined,
    } as never));
  }

  it('draws the name field AND the sector tiles; an optional question says (optional); tiles are 56px', () => {
    const html = drawDetails({ ...NOTHING, displayName: true, questions: true }, [SECTOR, TOPICS]);
    expect(html).toContain('>Your name</label>');
    expect(html).toContain('Which sector?');
    expect(html).toContain('Topics you like');
    expect(html.match(/\(optional\)/g)).toHaveLength(1);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/data-testid="choice-tile"/g)).toHaveLength(5);
    for (const tile of html.split('data-testid="choice-tile"').slice(1)) expect(tile.slice(0, 200)).toContain('min-h-[56px]');
  });

  it('draws no question when none is missing and nothing else is asked', () => {
    const html = drawDetails({ ...NOTHING, admissionCode: true }, null);
    expect(html).not.toContain('Which sector?');
    expect(html).not.toContain('choice-tile');
  });

  it('sends the answers given with the entry, and only those', () => {
    const step = read('features/call/CallDetailsStep.tsx');
    expect(step).toContain('if (fields.questions && Object.keys(answers).length > 0) answer.answers = answers;');
    expect(step).toContain("rules={{ validate: (v) => (!q.required || (Array.isArray(v) && v.length > 0) ? true : QUESTIONS_COPY.chooseAnswer) }}");
    expect(read('features/call/useCallLink.ts')).toContain('answers?: EventAnswers }');
    expect(read('features/call/CallLinkPage.tsx')).toContain('fields={detailsFieldsFor(state!.missing, event.asks.group, event.asks.questions ?? null)}');
  });
});

// ─── 4. The member's sheet ─────────────────────────────────────────────────────────────────────────────────────────

describe('"Before you join" opens on both refusals and registers again with what it gave', () => {
  const page = read('features/sessions/SessionDetailPage.tsx');
  const failure = (code: string) => ({ response: { status: 409, data: { error: { code, message: 'x' } } } });

  it('needsAnswers: EVENT_GROUP_REQUIRED and EVENT_ANSWERS_REQUIRED, nothing else', () => {
    expect(needsAnswers(failure('EVENT_GROUP_REQUIRED'))).toBe(true);
    expect(needsAnswers(failure('EVENT_ANSWERS_REQUIRED'))).toBe(true);
    expect(needsAnswers(failure('SESSION_FULL'))).toBe(false);
    expect(needsAnswers(failure('SESSION_ALREADY_REGISTERED'))).toBe(false);
    expect(needsAnswers(new Error('network'))).toBe(false);
    expect(needsAnswers(null)).toBe(false);
  });

  it('opens from Register and from the automatic registration', () => {
    expect(page).toContain('if (needsAnswers(err)) return void setAnswersSheetOpen(true);');
    expect(page).toMatch(/\} else if \(needsAnswers\(err\)\) \{[^}]*setAnswersSheetOpen\(true\);/);
    expect(page).toMatch(/<MyEventAnswersSheet\s+sessionId=\{sessionId\}\s+open=\{answersSheetOpen\}[\s\S]*?mode="join"[\s\S]*?onJoin=\{registerWithAnswers\}/);
  });

  it('retries /register with the body: the old body plus { groupKeys, answers }', () => {
    expect(page).toContain('mutationFn: (choices?: GivenAnswers) => api.post(`/sessions/${sessionId}/register`, registerBodyWith(registerBody(access), choices)),');
    expect(page).toContain('return registerMutation.mutateAsync(given);');
    expect(page).toContain('registerMutation.mutate(undefined);');
    // Nothing given: exactly the body sent before (nothing, or the waiting list on a full event).
    expect(registerBodyWith(undefined)).toBeUndefined();
    expect(registerBodyWith({ waitlist: true as const })).toEqual({ waitlist: true });
    expect(registerBodyWith(undefined, { groupKeys: [], answers: {} })).toBeUndefined();
    expect(registerBodyWith(undefined, { groupKeys: ['founder'], answers: { which_sector: ['health'] } }))
      .toEqual({ groupKeys: ['founder'], answers: { which_sector: ['health'] } });
    expect(registerBodyWith({ waitlist: true as const }, { groupKeys: [], answers: { which_sector: ['health'] } }))
      .toEqual({ waitlist: true, answers: { which_sector: ['health'] } });
    expect(entryChoices(['a'], {})).toEqual({ groupKeys: ['a'] });
  });

  it('closes once the registration goes through', () => {
    expect(page).toMatch(/onSuccess: \(res\) => \{\s*setAnswersSheetOpen\(false\);/);
  });

  it('closes on already registered or full, so no stale sheet sits over a Registered or full page', () => {
    const onError = page.slice(page.indexOf('onError: (err: any) => {', page.indexOf('const registerMutation')), page.indexOf('onSettled: () => {', page.indexOf('const registerMutation')));
    expect(onError).toContain("if (errCode === 'SESSION_ALREADY_REGISTERED' || errCode === 'SESSION_FULL') setAnswersSheetOpen(false);");
    // Before the branches that toast and refetch, so the sheet is gone whichever of the two came back.
    expect(onError.indexOf('setAnswersSheetOpen(false)')).toBeLessThan(onError.indexOf("if (errCode === 'SESSION_ALREADY_REGISTERED') {"));
    // A refusal for answers keeps it open.
    expect(onError).toMatch(/\} else if \(needsAnswers\(err\)\) \{[^}]*setAnswersSheetOpen\(true\);/);
  });

  function drawForm(props: Record<string, unknown>): string {
    const mod = loadClientModule(`${DIR}/EventAnswersForm.tsx`, { 'lucide-react': iconStandIns });
    return renderToStaticMarkup(createElement(mod.default as never, { formId: 'f', mine: {}, onSubmit: () => undefined, ...props } as never));
  }

  it('draws the group tiles a member on a group event never had, then the questions, required first', () => {
    const html = drawForm({
      group: { question: 'Are you a founder or a funder?', multiple: false, options: [{ key: 'founder', label: 'Founder' }, { key: 'funder', label: 'Funder' }] },
      questions: [TOPICS, SECTOR],
    });
    const at = (s: string) => html.indexOf(s);
    expect(at('Are you a founder or a funder?')).toBeGreaterThan(-1);
    expect(at('Are you a founder or a funder?')).toBeLessThan(at('Which sector?'));
    expect(at('Which sector?')).toBeLessThan(at('Topics you like'));
    expect(html.match(/\(optional\)/g)).toHaveLength(1);
    expect(html.match(/data-testid="choice-tile"/g)).toHaveLength(7);
  });

  it('the sheet asks a group only when the event has groups and the person has none', () => {
    const sheet = read(`${DIR}/MyEventAnswersSheet.tsx`);
    expect(sheet).toContain('const group: GroupAsk | null = join && groupView && groupView.groups.length > 0 && groupView.mine.length === 0');
    expect(sheet).toContain('const groups = useEventGroups(sessionId, open && join);');
  });

  it('the form: a required answer and a chosen group are needed; one answer takes one', () => {
    const schema = answerFormSchema([SECTOR, TOPICS], true);
    const ok = { [GROUPS_FIELD]: ['founder'], [answerField('which_sector')]: ['health'], [answerField('topics')]: [] };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, [answerField('which_sector')]: [] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, [answerField('which_sector')]: ['health', 'fintech'] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, [GROUPS_FIELD]: [] }).success).toBe(false);
    expect(answerFormSchema([TOPICS], false).safeParse({ [GROUPS_FIELD]: [], [answerField('topics')]: [] }).success).toBe(true);
    expect(answersOfForm(ok, [SECTOR, TOPICS])).toEqual({ which_sector: ['health'] });
    expect(answersOfForm(ok, [SECTOR, TOPICS], true)).toEqual({ which_sector: ['health'], topics: [] });
    expect(answerFormDefaults([SECTOR], { which_sector: ['fintech'] })).toEqual({ [GROUPS_FIELD]: [], [answerField('which_sector')]: ['fintech'] });
    expect(toggleChoice(['a'], 'b', false)).toEqual(['b']);
    expect(toggleChoice(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleChoice(['a', 'b'], 'a', true)).toEqual(['b']);
  });

  it('an approval event sends the answers with the request (a /register there is refused, answers and all)', () => {
    const actions = read('features/sessions/EventAccessActions.tsx');
    expect(actions).toContain('mutationFn: (answers?: EventAnswers) => api.post(`/sessions/${sessionId}/requests`, {');
    expect(actions).toContain('...(answers && Object.keys(answers).length > 0 ? { answers } : {}),');
    expect(actions).toContain("const questions = useEventQuestions(sessionId, sheetOpen && mode === 'request');");
    expect(actions).toContain('onSubmit={({ answers }) => ask.mutate(answers)}');
  });

  it('"Your answers" for someone with a place, a request or a number in the line, before the event, never for organisers', () => {
    expect(page).toContain("const showMyAnswers = !isHost && !viewerIsCohost && phase === 'pre' && (isRegistered || waitingInLine || access?.myRequest === 'pending');");
    expect(page).toContain('{showMyAnswers && sessionId && <MyAnswersRow sessionId={sessionId} view={questionsView.data} />}');
    expect(myAnswerLines(memberView())).toEqual(['Which sector? Health']);
    expect(myAnswerLines(memberView({ mine: {} }))).toEqual([]);
  });
});

// ─── 5. Organisers only ────────────────────────────────────────────────────────────────────────────────────────────

describe('answers show to organisers only', () => {
  it('the labels read only the organisers\' `answers`: a member\'s read has nobody\'s', () => {
    expect(answerLabelsFor(organiserView(), 'u-ana')).toEqual(['Health', 'AI', 'Biotech']);
    expect(answerLinesFor(organiserView(), 'u-bo')).toEqual([{ prompt: 'Which sector?', labels: ['Fintech'] }]);
    expect(answerLabelsFor(organiserView(), 'u-nobody')).toEqual([]);
    // A member's own read carries their own answers in `mine` and no `answers`: no chip for anyone, themselves included.
    expect(answerLabelsFor(memberView(), 'u-ana')).toEqual([]);
    expect(answerLabelsFor(undefined, 'u-ana')).toEqual([]);
    expect(optionCount(organiserView(), 'which_sector', 'health')).toBe(1);
    expect(optionCount(memberView(), 'which_sector', 'health')).toBe(0);
  });

  it('the participant list\'s chips draw nothing for a member\'s read', () => {
    const mod = loadClientModule(`${DIR}/AnswerChips.tsx`, {});
    const draw = (view: EventQuestionsView) => renderToStaticMarkup(createElement(mod.default as never, { view, userId: 'u-ana' } as never));
    expect(draw(organiserView())).toContain('data-testid="participant-answer-chips"');
    expect(draw(organiserView())).toContain('Health');
    expect(draw(memberView())).toBe('');
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toContain('{p.userId && <AnswerChips view={questionsView.data} userId={p.userId} />}');
  });

  it('the board: no answers in the read, no answers on a seat', () => {
    expect(boardAnswersOf(memberView())).toBe(NO_BOARD_ANSWERS);
    expect(boardAnswersOf(undefined)).toBe(NO_BOARD_ANSWERS);
    expect(boardAnswersOf(organiserView()).labelsFor('u-ana')).toEqual(['Health', 'AI', 'Biotech']);
    expect(boardAnswersOf(organiserView()).linesFor('u-bo')).toEqual([{ prompt: 'Which sector?', labels: ['Fintech'] }]);
    const board = read('features/schedule/MatchingBoardPage.tsx');
    expect(board).toContain('const answers = useMemo(() => boardAnswersOf(questions.data), [questions.data]);');
    expect(board).toContain('<BoardAnswersContext.Provider value={answers}>');
    expect(read('features/schedule/SeatChip.tsx')).toContain('const answers = useContext(BoardAnswersContext).labelsFor(person.userId);');
    expect(read('features/schedule/PersonTimeline.tsx')).toContain('const answers = useContext(BoardAnswersContext).linesFor(person.userId);');
  });

  it('a seat outside an organiser\'s board shows no answers', () => {
    const mod = loadClientModule('features/schedule/SeatChip.tsx', { 'lucide-react': iconStandIns });
    const html = renderToStaticMarkup(createElement(mod.default as never, {
      person: { userId: 'u-ana', displayName: 'Ana', status: 'registered', groupKeys: [] }, groups: [], source: { kind: 'basket', round: 1, userId: 'u-ana' },
      dropTarget: null, draggable: false, selected: false, picked: false, onSelect: () => undefined, onDragStart: () => undefined,
      onDragEnd: () => undefined, onDropOn: () => undefined, dragging: false,
    } as never));
    expect(html).toContain('Ana');
    expect(html).not.toContain('seat-answers');
  });

  it('no guest screen reads anyone\'s answers', () => {
    for (const f of fs.readdirSync(path.join(CLIENT, 'features/call'))) {
      const src = read(`features/call/${f}`);
      expect({ f, reads: /answerLabelsFor|answerLinesFor|AnswerChips|BoardAnswersContext|\.answers\?\.find/.test(src) }).toEqual({ f, reads: false });
    }
  });
});

// ─── 6. The organiser's editor ─────────────────────────────────────────────────────────────────────────────────────

describe('the organiser\'s card and editor', () => {
  it('sits after the groups card, for organisers of a rounds event, before it and (locked) while live', () => {
    const settings = read('features/sessions/OrganiserSettings.tsx');
    const groups = settings.indexOf('<EventGroupsCard');
    const questions = settings.indexOf('<EventQuestionsCard');
    expect(groups).toBeGreaterThan(-1);
    expect(questions).toBeGreaterThan(groups);
    expect(settings).toContain("{mayRunEvent && (before || phase === 'live') && isRoundsEvent && <EventQuestionsCard sessionId={event.id} locked={phase === 'live'} />}");
    const card = read(`${DIR}/EventQuestionsCard.tsx`);
    expect(card).toContain('if (view.data && view.data.answers === undefined) return null;');
    expect(card).toContain('action={view.data && !locked && canAddQuestion(saved) && (');
    expect(card).toContain('{!locked && (');
    expect(card).toContain("tone: 'danger'");
  });

  it('"Add question" hides at five', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...SECTOR, key: `q${i}` }));
    expect(canAddQuestion(five.slice(0, 4))).toBe(true);
    expect(canAddQuestion(five)).toBe(false);
  });

  it('a new question and its answers get keys from their words; a saved one keeps its own', () => {
    const q = questionOfForm({ ...newQuestionValues(), prompt: 'Which sector?', options: [{ key: '', label: 'Fintech' }, { key: '', label: 'Health care' }] }, []);
    expect(q).toEqual({ key: 'which_sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: false,
      options: [{ key: 'fintech', label: 'Fintech' }, { key: 'health_care', label: 'Health care' }] });
    const again = questionOfForm({ ...newQuestionValues(), prompt: 'Which sector?', options: [{ key: '', label: '¿¿' }, { key: '', label: '!!' }] }, [SECTOR]);
    expect(again.key).toBe('which_sector_2');
    expect(again.options.map((o) => o.key)).toEqual(['answer', 'answer_2']);
    const renamed = questionOfForm({ ...newQuestionValues(), key: 'which_sector', prompt: 'Sector?', options: [{ key: 'fintech', label: 'Finance' }, { key: '', label: 'Health' }] }, []);
    expect(renamed.key).toBe('which_sector');
    expect(renamed.options).toEqual([{ key: 'fintech', label: 'Finance' }, { key: 'health', label: 'Health' }]);
    expect(keyFromWords('  ', new Set(), 'question')).toBe('question');
  });

  it('the shared validator\'s problems land at the editor\'s fields', () => {
    const issues = questionFormIssues({ ...newQuestionValues(), prompt: '', options: [{ key: '', label: 'Yes' }, { key: '', label: '' }] }, [], null);
    expect(issues.prompt).toBe('Ask the question in 1 to 120 characters.');
    expect(issues['options.1.label']).toBe('Write each answer in 1 to 40 characters.');
    const same = questionFormIssues({ ...newQuestionValues(), prompt: 'Q?', options: [{ key: '', label: 'Yes' }, { key: '', label: 'yes' }] }, [], null);
    expect(same['options.1.label']).toBe(QUESTIONS_COPY.sameLabels);
    const fine = questionFormIssues({ ...newQuestionValues(), prompt: 'Q?', options: [{ key: '', label: 'Yes' }, { key: '', label: 'No' }] }, [SECTOR], null);
    expect(fine).toEqual({});
    // Editing the second of two questions checks that one, at its own index.
    const edit = questionFormIssues({ ...newQuestionValues(), key: 'topics', prompt: '', options: TOPICS.options }, [SECTOR, TOPICS], 1);
    expect(Object.keys(edit)).toEqual(['prompt']);
  });

  it('save puts the question in its place; remove takes it out', () => {
    const edited = { ...TOPICS, prompt: 'Topics?' };
    expect(questionsWith([SECTOR, TOPICS], 1, edited)).toEqual([SECTOR, edited]);
    expect(questionsWith([SECTOR], null, TOPICS)).toEqual([SECTOR, TOPICS]);
    expect(questionsWithout([SECTOR, TOPICS], 0)).toEqual([TOPICS]);
  });

  it('the editor is react-hook-form over the shared validator, in a Sheet portalled to <body>', () => {
    const editor = read(`${DIR}/QuestionsEditorSheet.tsx`);
    expect(editor).toContain("import Sheet from '@/features/reason/ui/Sheet';");
    expect(editor).toContain('const resolver = useMemo(() => questionFormResolver(saved, index), [saved, index]);');
    expect(editor).toContain('useForm<QuestionFormValues>({ defaultValues: questionFormValuesOf(current), resolver })');
    expect(editor).toContain('{options.fields.length < MAX_QUESTION_OPTIONS && (');
    expect(editor).toContain('{options.fields.length > MIN_QUESTION_OPTIONS && (');
    expect(read('features/reason/ui/Sheet.tsx')).toContain('createPortal');
  });
});

// ─── 7. Tap targets ────────────────────────────────────────────────────────────────────────────────────────────────

describe('every control is at least 44px; answer tiles 56px', () => {
  it('each <button> in the questions screens is a 44px house button or says min-h-[44px]', () => {
    for (const f of fs.readdirSync(path.join(CLIENT, DIR)).filter((n) => n.endsWith('.tsx'))) {
      const src = read(`${DIR}/${f}`);
      for (let at = src.indexOf('<button'); at > -1; at = src.indexOf('<button', at + 1)) {
        const tag = src.slice(at, src.indexOf('className=', at) + 140);
        const ok = /className=\{(PRIMARY_BUTTON|QUIET_BUTTON|DANGER_BUTTON|saved\.length > 0 \? QUIET_BUTTON : PRIMARY_BUTTON)\}/.test(tag) || tag.includes('min-h-[44px]');
        expect({ f, tag: tag.slice(0, 80), ok }).toEqual({ f, tag: tag.slice(0, 80), ok: true });
      }
    }
    expect(read('features/sessions/organiser-ui.tsx')).toContain("const BUTTON = 'inline-flex min-h-[44px] min-w-[44px]");
  });

  it('the editor\'s choices and the required box are 44px rows; the tiles are 56px', () => {
    const editor = read(`${DIR}/QuestionsEditorSheet.tsx`);
    expect(editor).toContain("const CHOICE = 'flex min-h-[44px] cursor-pointer");
    expect(editor).toContain('<label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-gray-700">');
    expect(read(`${DIR}/ChoiceTiles.tsx`)).toContain("'flex min-h-[56px] min-w-0 cursor-pointer items-center");
  });
});
