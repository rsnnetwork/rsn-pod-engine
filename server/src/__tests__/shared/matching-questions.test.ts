// ─── Extra matching questions, the shared rule (10 Nov 2026 spec, Part 3 Task 5; K5) ──────────────────────
//
// One module scores two people's answers for the engine (questionAffinity), checks an organiser's questions and cleans a
// person's answers. The affinity is a mean over the questions in [0, 1]: unanswered is neutral (0.5), a single-choice
// question gives 1 for the preferred outcome and 0 otherwise, a partial overlap on a several-answer question lands in
// between, and an answer the question no longer offers is ignored.

import {
  EVENT_QUESTION_WEIGHT, MATCHING_QUESTIONS_RULING, MAX_EVENT_QUESTIONS, MAX_QUESTION_OPTIONS, MIN_QUESTION_OPTIONS,
  cleanEventAnswers, missingRequiredQuestions, questionAffinity, somethingMissing, unansweredQuestions,
  validateEventQuestions, type EventMatchingQuestion,
} from '@rsn/shared';

const sector: EventMatchingQuestion = {
  key: 'sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: true,
  options: [{ key: 'fintech', label: 'Fintech' }, { key: 'health', label: 'Health' }, { key: 'climate', label: 'Climate' }],
};
const stage: EventMatchingQuestion = {
  key: 'stage', prompt: 'Which stage?', kind: 'single', prefer: 'different', required: false,
  options: [{ key: 'idea', label: 'Idea' }, { key: 'growth', label: 'Growth' }],
};
const topics: EventMatchingQuestion = {
  key: 'topics', prompt: 'Topics?', kind: 'multiple', prefer: 'same', required: false,
  options: ['a', 'b', 'c', 'd'].map((k) => ({ key: k, label: k.toUpperCase() })),
};

describe('the constants', () => {
  it('holds the brief\'s limits, weight and the ruling text', () => {
    expect([MAX_EVENT_QUESTIONS, MIN_QUESTION_OPTIONS, MAX_QUESTION_OPTIONS, EVENT_QUESTION_WEIGHT]).toEqual([5, 2, 8, 0.2]);
    expect(MATCHING_QUESTIONS_RULING).toBe(
      'Matching questions are soft preferences. They only choose among the meetings the event already allows. A block, a '
      + "report, an inviter and the person they invited, and the event's group rules always win, and so does the no-repeat "
      + 'rule. Questions never make a meeting that would otherwise be refused, never leave someone unmatched, and never cause '
      + 'a repeat.',
    );
  });
});

describe('questionAffinity', () => {
  it('is 0.5 with no questions, and 0.5 when either side has not answered', () => {
    expect(questionAffinity({ sector: ['fintech'] }, { sector: ['fintech'] }, [])).toBe(0.5);
    expect(questionAffinity(undefined, { sector: ['fintech'] }, [sector])).toBe(0.5);
    expect(questionAffinity({ sector: ['fintech'] }, {}, [sector])).toBe(0.5);
    expect(questionAffinity({}, {}, [sector, stage, topics])).toBe(0.5);
  });

  it('single choice, prefer same: 1 for the same answer, 0 for a different one', () => {
    expect(questionAffinity({ sector: ['fintech'] }, { sector: ['fintech'] }, [sector])).toBe(1);
    expect(questionAffinity({ sector: ['fintech'] }, { sector: ['health'] }, [sector])).toBe(0);
  });

  it('single choice, prefer different: 1 for a different answer, 0 for the same one', () => {
    expect(questionAffinity({ stage: ['idea'] }, { stage: ['growth'] }, [stage])).toBe(1);
    expect(questionAffinity({ stage: ['idea'] }, { stage: ['idea'] }, [stage])).toBe(0);
  });

  it('several answers: overlap over the smaller list, between the two extremes', () => {
    // {a,b} vs {b,c,d}: one shared over min(2,3) → o = 0.5 → same = 0.75.
    expect(questionAffinity({ topics: ['a', 'b'] }, { topics: ['b', 'c', 'd'] }, [topics])).toBeCloseTo(0.75, 10);
    // {a} inside {a,b,c}: o = 1 → 1.
    expect(questionAffinity({ topics: ['a'] }, { topics: ['a', 'b', 'c'] }, [topics])).toBe(1);
    expect(questionAffinity({ topics: ['a'] }, { topics: ['b'] }, [topics])).toBe(0);
    const different = { ...topics, prefer: 'different' as const };
    expect(questionAffinity({ topics: ['a', 'b'] }, { topics: ['b', 'c', 'd'] }, [different])).toBeCloseTo(0.25, 10);
  });

  it('ignores an answer the question no longer offers (it reads as unanswered)', () => {
    expect(questionAffinity({ sector: ['gone'] }, { sector: ['fintech'] }, [sector])).toBe(0.5);
    expect(questionAffinity({ sector: ['gone', 'fintech'] }, { sector: ['fintech'] }, [sector])).toBe(1);
  });

  it('is the mean over the questions, so several questions never weigh more than one', () => {
    // sector same (1), stage same answer but prefers different (0), topics unanswered (0.5): mean 0.5.
    const a = { sector: ['fintech'], stage: ['idea'] };
    const b = { sector: ['fintech'], stage: ['idea'] };
    expect(questionAffinity(a, b, [sector, stage, topics])).toBe(0.5);
    expect(questionAffinity(a, b, [sector, topics])).toBe(0.75);
  });

  it('is symmetric', () => {
    const a = { sector: ['health'], topics: ['a', 'b'] };
    const b = { sector: ['health'], topics: ['b', 'c', 'd'] };
    expect(questionAffinity(a, b, [sector, topics])).toBe(questionAffinity(b, a, [sector, topics]));
  });
});

describe('validateEventQuestions', () => {
  const fields = (qs: EventMatchingQuestion[]) => validateEventQuestions(qs).map((i) => i.field);

  it('passes good questions and no questions at all', () => {
    expect(validateEventQuestions([sector, stage, topics])).toEqual([]);
    expect(validateEventQuestions([])).toEqual([]);
  });

  it('refuses a sixth question', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...sector, key: `q${i}` }));
    expect(fields(six)).toContain('questions');
  });

  it('refuses one answer to choose from, and nine', () => {
    expect(fields([{ ...sector, options: [{ key: 'only', label: 'Only' }] }])).toContain('questions.0.options');
    const nine = Array.from({ length: 9 }, (_, i) => ({ key: `o${i}`, label: `O${i}` }));
    expect(fields([{ ...topics, options: nine }])).toContain('questions.0.options');
  });

  it('refuses duplicate question keys and duplicate answer keys', () => {
    expect(fields([sector, { ...stage, key: 'sector' }])).toContain('questions.1.key');
    expect(fields([{ ...sector, options: [{ key: 'x', label: 'X' }, { key: 'x', label: 'Y' }] }])).toContain('questions.0.options.1.key');
  });

  it('refuses a bad key, an empty or over-long prompt or label, and an unknown kind or preference', () => {
    expect(fields([{ ...sector, key: 'Bad Key' }])).toContain('questions.0.key');
    expect(fields([{ ...sector, prompt: '   ' }])).toContain('questions.0.prompt');
    expect(fields([{ ...sector, prompt: 'x'.repeat(121) }])).toContain('questions.0.prompt');
    expect(fields([{ ...sector, options: [{ key: 'a', label: '' }, { key: 'b', label: 'x'.repeat(41) }] }]))
      .toEqual(['questions.0.options.0.label', 'questions.0.options.1.label']);
    expect(fields([{ ...sector, kind: 'free' as never, prefer: 'sometimes' as never }]))
      .toEqual(['questions.0.kind', 'questions.0.prefer']);
  });
});

describe('cleanEventAnswers', () => {
  it('drops a key that is not one of the questions and an answer the question does not offer; each option once', () => {
    expect(cleanEventAnswers([sector, topics], { sector: ['fintech'], gone: ['x'], topics: ['a', 'a', 'zzz', 'b'] }))
      .toEqual({ answers: { sector: ['fintech'], topics: ['a', 'b'] }, issues: [] });
  });

  it('keeps an empty list (it clears that answer) and reads nothing from nothing', () => {
    expect(cleanEventAnswers([sector], { sector: [] })).toEqual({ answers: { sector: [] }, issues: [] });
    expect(cleanEventAnswers([sector], undefined)).toEqual({ answers: {}, issues: [] });
  });

  it('says it at the field: two answers to a one-answer question, only unknown answers, a non-list', () => {
    expect(cleanEventAnswers([sector], { sector: ['fintech', 'health'] }).issues).toEqual([{ field: 'answers.sector', message: 'Choose one answer.' }]);
    expect(cleanEventAnswers([sector], { sector: ['nope'] }).issues[0].field).toBe('answers.sector');
    expect(cleanEventAnswers([sector], { sector: 'fintech' }).issues[0].field).toBe('answers.sector');
    expect(cleanEventAnswers([sector], ['fintech']).issues[0].field).toBe('answers');
  });
});

describe('missingRequiredQuestions and unansweredQuestions', () => {
  it('lists required questions with no usable answer', () => {
    expect(missingRequiredQuestions([sector, stage], {})).toEqual(['sector']);
    expect(missingRequiredQuestions([sector, stage], { sector: ['gone'] })).toEqual(['sector']);
    expect(missingRequiredQuestions([sector, stage], { sector: ['health'] })).toEqual([]);
  });

  it('lists the unanswered questions, required first', () => {
    const optionalFirst = [stage, topics, sector];
    expect(unansweredQuestions(optionalFirst, {}).map((q) => q.key)).toEqual(['sector', 'stage', 'topics']);
    expect(unansweredQuestions(optionalFirst, { sector: ['health'], topics: ['a'] }).map((q) => q.key)).toEqual(['stage']);
  });
});

describe('somethingMissing', () => {
  it('counts a required question as something missing', () => {
    const none = { displayName: false, group: false, admissionCode: false, questions: false };
    expect(somethingMissing(none)).toBe(false);
    expect(somethingMissing({ ...none, questions: true })).toBe(true);
    expect(somethingMissing({ ...none, group: true })).toBe(true);
  });
});
