// ─── Matching groups and round rules (10 Nov spec, sections 05, 02, 07) ─────────────────────────────────
//
// shared/src/events/group-rules.ts is the one definition of who may meet whom in a round of an event with groups:
// the engine, the matching board, live redistribution and the organiser's screens all read it. These tables pin
// the rule (groupsAllowed), the organiser's input check (validateGroupRules) and the capacity explanation the
// organiser reads before the event (explainRoundCapacity).

import {
  GROUP_PRESETS, explainRoundCapacity, groupPairKey, groupsAllowed, ruleForRound, validateGroupRules,
  type EventGroupRules, type RoundRule,
} from '../../../../shared/src/events/group-rules';
import { estimatedRoundStarts } from '../../../../shared/src/events/round-times';
import * as fs from 'fs';
import * as path from 'path';
import * as shared from '@rsn/shared';

const open: RoundRule = { fromRound: 1, toRound: 5, mode: 'open', allowedPairs: [] };
const cross: RoundRule = { fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] };

function rulesOf(groups: string[], rounds: RoundRule[], extra: Partial<EventGroupRules> = {}): EventGroupRules {
  return {
    groups: groups.map((key) => ({ key, label: `${key[0].toUpperCase()}${key.slice(1)}s` })),
    question: 'Which group are you in?',
    allowMultiple: false,
    fallback: 'leave_unmatched',
    rounds,
    ...extra,
  };
}

describe('groupPairKey', () => {
  it('names a pair the same whichever way round it is given', () => {
    expect(groupPairKey('funder', 'founder')).toBe('founder|funder');
    expect(groupPairKey('founder', 'funder')).toBe('founder|funder');
    expect(groupPairKey('mentor', 'mentor')).toBe('mentor|mentor');
  });
});

describe('ruleForRound', () => {
  const rules = rulesOf(['founder', 'funder'], [
    { fromRound: 1, toRound: 2, mode: 'cross_group', allowedPairs: [] },
    { fromRound: 4, toRound: 5, mode: 'custom', allowedPairs: ['founder|founder'] },
  ]);

  it('finds the range that covers the round', () => {
    expect(ruleForRound(rules, 1).mode).toBe('cross_group');
    expect(ruleForRound(rules, 2).mode).toBe('cross_group');
    expect(ruleForRound(rules, 5).mode).toBe('custom');
  });

  it('reads a round no range covers as open', () => {
    expect(ruleForRound(rules, 3)).toEqual({ fromRound: 3, toRound: 3, mode: 'open', allowedPairs: [] });
    expect(ruleForRound(rules, 9).mode).toBe('open');
  });
});

describe('groupsAllowed', () => {
  const custom: RoundRule = { fromRound: 1, toRound: 5, mode: 'custom', allowedPairs: ['a|b', 'c|c'] };

  it.each([
    // [rule, A, B, allowed]
    ['open', open, ['founder'], ['founder'], true],
    ['open, nobody has a group', open, [], [], true],
    ['open, one side has no group', open, ['founder'], [], true],
    ['cross, founder + funder', cross, ['founder'], ['funder'], true],
    ['cross, founder + founder', cross, ['founder'], ['founder'], false],
    ['cross, founder+funder meets a founder (multiple affiliations)', cross, ['founder', 'funder'], ['founder'], true],
    ['cross, a founder meets a founder+funder', cross, ['founder'], ['funder', 'founder'], true],
    ['cross, one side has no group', cross, ['founder'], [], false],
    ['cross, neither side has a group', cross, [], [], false],
    ['custom a|b', custom, ['a'], ['b'], true],
    ['custom b|a reads as a|b', custom, ['b'], ['a'], true],
    ['custom a|a not listed', custom, ['a'], ['a'], false],
    ['custom c|c (same group allowed)', custom, ['c'], ['c'], true],
    ['custom b|c not listed', custom, ['b'], ['c'], false],
    ['custom, multiple affiliations find a listed pair', custom, ['c', 'b'], ['a'], true],
    ['custom, one side has no group', custom, [], ['a'], false],
  ] as Array<[string, RoundRule, string[], string[], boolean]>)('%s', (_label, rule, a, b, expected) => {
    expect(groupsAllowed(rule, a, b)).toBe(expected);
    expect(groupsAllowed(rule, b, a)).toBe(expected);
  });
});

describe('validateGroupRules', () => {
  const ok = rulesOf(['founder', 'funder'], [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }]);

  it('passes a well-formed set of rules', () => {
    expect(validateGroupRules(ok, 5)).toEqual([]);
  });

  it('refuses no groups and more than 12 groups', () => {
    expect(validateGroupRules({ ...ok, groups: [], rounds: [] }, 5).map((i) => i.field)).toContain('groups');
    const thirteen = Array.from({ length: 13 }, (_, i) => `g${i}`);
    const issues = validateGroupRules(rulesOf(thirteen, []), 5);
    expect(issues).toContainEqual({ field: 'groups', message: 'An event can have at most 12 groups.' });
  });

  it('refuses two groups with the same key, a malformed key, an empty or long label', () => {
    const issues = validateGroupRules({
      ...ok,
      groups: [
        { key: 'founder', label: 'Founders' },
        { key: 'founder', label: 'Other founders' },
        { key: 'Bad Key!', label: 'Bad' },
        { key: 'empty', label: '   ' },
        { key: 'long', label: 'x'.repeat(41) },
      ],
      rounds: [],
    }, 5);
    const fields = issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['groups.1.key', 'groups.2.key', 'groups.3.label', 'groups.4.label']));
  });

  it('refuses overlapping ranges (1-3 and 3-5)', () => {
    const issues = validateGroupRules(rulesOf(['founder', 'funder'], [
      { fromRound: 1, toRound: 3, mode: 'cross_group', allowedPairs: [] },
      { fromRound: 3, toRound: 5, mode: 'open', allowedPairs: [] },
    ]), 5);
    expect(issues).toContainEqual({ field: 'rounds.1', message: 'Rounds 3 to 5 overlap rounds 1 to 3.' });
  });

  it('refuses a range past the event\'s number of rounds, or one that starts before round 1 or ends before it starts', () => {
    expect(validateGroupRules(rulesOf(['founder', 'funder'], [
      { fromRound: 4, toRound: 7, mode: 'cross_group', allowedPairs: [] },
    ]), 5)).toContainEqual({ field: 'rounds.0', message: 'This event has 5 rounds, so a rule can cover rounds 1 to 5 only.' });
    expect(validateGroupRules(rulesOf(['founder', 'funder'], [
      { fromRound: 0, toRound: 2, mode: 'cross_group', allowedPairs: [] },
    ]), 5).map((i) => i.field)).toContain('rounds.0');
    expect(validateGroupRules(rulesOf(['founder', 'funder'], [
      { fromRound: 3, toRound: 2, mode: 'cross_group', allowedPairs: [] },
    ]), 5).map((i) => i.field)).toContain('rounds.0');
  });

  it('refuses a custom pair that names a group the event does not have', () => {
    const issues = validateGroupRules(rulesOf(['founder', 'funder'], [
      { fromRound: 1, toRound: 5, mode: 'custom', allowedPairs: ['founder|mentor'] },
    ]), 5);
    expect(issues).toContainEqual({ field: 'rounds.0.allowedPairs', message: 'A pair names a group this event does not have.' });
  });

  it('refuses a custom rule with no pair at all', () => {
    expect(validateGroupRules(rulesOf(['founder', 'funder'], [
      { fromRound: 1, toRound: 5, mode: 'custom', allowedPairs: [] },
    ]), 5).map((i) => i.field)).toContain('rounds.0.allowedPairs');
  });

  it('refuses meeting across groups with only one group', () => {
    expect(validateGroupRules(rulesOf(['founder'], [
      { fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] },
    ]), 5)).toContainEqual({ field: 'rounds.0.mode', message: 'Meeting across groups needs at least two groups.' });
  });

  it('refuses a question that is empty or longer than 120 characters', () => {
    expect(validateGroupRules({ ...ok, question: ' ' }, 5).map((i) => i.field)).toContain('question');
    expect(validateGroupRules({ ...ok, question: 'q'.repeat(121) }, 5).map((i) => i.field)).toContain('question');
  });
});

describe('GROUP_PRESETS', () => {
  it('offers the four presets with their labels and questions, every round across groups', () => {
    expect(GROUP_PRESETS.founders_funders.groups.map((g) => g.label)).toEqual(['Founders', 'Funders']);
    expect(GROUP_PRESETS.founders_funders.question).toBe('Are you a founder or a funder?');
    expect(GROUP_PRESETS.teachers_pupils.groups.map((g) => g.label)).toEqual(['Teachers', 'Pupils']);
    expect(GROUP_PRESETS.teachers_pupils.question).toBe('Are you a teacher or a pupil?');
    expect(GROUP_PRESETS.employers_candidates.groups.map((g) => g.label)).toEqual(['Employers', 'Candidates']);
    expect(GROUP_PRESETS.employers_candidates.question).toBe('Are you hiring or looking for a role?');
    expect(GROUP_PRESETS.mentors_mentees.groups.map((g) => g.label)).toEqual(['Mentors', 'Mentees']);
    expect(GROUP_PRESETS.mentors_mentees.question).toBe('Are you a mentor or a mentee?');
    for (const preset of Object.values(GROUP_PRESETS)) {
      expect(preset.rounds).toBe('all_cross_group');
      expect(preset.allowMultiple).toBe(false);
      expect(preset.fallback).toBe('leave_unmatched');
      // A preset made into rules passes the organiser's own check.
      const rules: EventGroupRules = { ...preset, rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }] };
      expect(validateGroupRules(rules, 5)).toEqual([]);
    }
  });
});

describe('explainRoundCapacity', () => {
  const foundersFunders: EventGroupRules = {
    ...GROUP_PRESETS.founders_funders,
    rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
  };

  it('25 founders and 8 funders across groups: 8 meetings, 17 founders wait, in the organiser\'s words', () => {
    const capacity = explainRoundCapacity(foundersFunders, 1, { founder: 25, funder: 8 }, 5);
    expect(capacity.round).toBe(1);
    expect(capacity.maxMeetings).toBe(8);
    expect(capacity.waiting).toEqual({ founder: 17 });
    expect(capacity.sentence).toBe(
      'In each round at most 8 founder and funder meetings are possible, so 17 founders wait. '
      + 'Choose: leave them unmatched, or let them meet another founder.',
    );
  });

  it('one person waiting is said in the singular', () => {
    const capacity = explainRoundCapacity(foundersFunders, 1, { founder: 9, funder: 8 }, 5);
    expect(capacity.waiting).toEqual({ founder: 1 });
    expect(capacity.sentence).toBe(
      'In each round at most 8 founder and funder meetings are possible, so 1 founder waits. '
      + 'Choose: leave them unmatched, or let them meet another founder.',
    );
  });

  it('10 founders and 10 funders: nobody waits, so there is nothing to say', () => {
    const capacity = explainRoundCapacity(foundersFunders, 1, { founder: 10, funder: 10 }, 5);
    expect(capacity.maxMeetings).toBe(10);
    expect(capacity.waiting).toEqual({});
    expect(capacity.sentence).toBeNull();
  });

  it('an open round of 7: 3 meetings (the odd one joins a trio), nobody waits', () => {
    const rules = rulesOf(['founder', 'funder'], []);
    const capacity = explainRoundCapacity(rules, 1, { founder: 4, funder: 3 }, 5);
    expect(capacity.maxMeetings).toBe(3);
    expect(capacity.waiting).toEqual({});
    expect(capacity.sentence).toBeNull();
    expect(capacity.repeatsUnavoidableFor).toEqual([]);
  });

  it('three groups, custom a-b and b-c (bipartite): the exact meetings and who waits', () => {
    const rules = rulesOf(['a', 'b', 'c'], [{ fromRound: 1, toRound: 3, mode: 'custom', allowedPairs: ['a|b', 'b|c'] }]);
    // 4 a and 3 c compete for 5 b: 5 meetings, 2 of a or c wait, and no b waits.
    const capacity = explainRoundCapacity(rules, 2, { a: 4, b: 5, c: 3 }, 3);
    expect(capacity.maxMeetings).toBe(5);
    const waitingTotal = Object.values(capacity.waiting).reduce((s, n) => s + n, 0);
    expect(waitingTotal).toBe(2);
    expect(capacity.waiting.b).toBeUndefined();
    for (const n of Object.values(capacity.waiting)) expect(Number.isInteger(n)).toBe(true);
    expect(capacity.sentence).toMatch(/^In each round at most 5 meetings are possible, so /);

    // 2 a, 6 b, 1 c: b outnumbers its partners, 3 meetings, 3 b wait.
    const more = explainRoundCapacity(rules, 1, { a: 2, b: 6, c: 1 }, 3);
    expect(more.maxMeetings).toBe(3);
    expect(more.waiting).toEqual({ b: 3 });
  });

  it('a same-group pair allowed lets a group meet itself', () => {
    const rules = rulesOf(['mentor', 'mentee'], [{ fromRound: 1, toRound: 2, mode: 'custom', allowedPairs: ['mentor|mentor'] }]);
    const capacity = explainRoundCapacity(rules, 1, { mentor: 6, mentee: 4 }, 2);
    expect(capacity.maxMeetings).toBe(3);
    expect(capacity.waiting).toEqual({ mentee: 4 });
  });

  it('6 rounds across groups with 5 funders: founders cannot avoid meeting someone twice', () => {
    const rules: EventGroupRules = { ...foundersFunders, rounds: [{ fromRound: 1, toRound: 6, mode: 'cross_group', allowedPairs: [] }] };
    const capacity = explainRoundCapacity(rules, 1, { founder: 25, funder: 5 }, 6);
    expect(capacity.repeatsUnavoidableFor).toEqual(['founder']);
  });

  it('counts only the rounds that use the rule when it looks for repeats', () => {
    const rules: EventGroupRules = {
      ...foundersFunders,
      rounds: [{ fromRound: 1, toRound: 3, mode: 'cross_group', allowedPairs: [] }],
    };
    // Rounds 1-3 across groups with 5 funders: 3 rounds, 5 possible partners, no repeat forced.
    expect(explainRoundCapacity(rules, 2, { founder: 25, funder: 5 }, 6).repeatsUnavoidableFor).toEqual([]);
  });
});

describe('the shared package exports the group rules as values (Rollup interop rule in shared/src/index.ts)', () => {
  it('names each function and the presets on the package', () => {
    expect(typeof shared.groupPairKey).toBe('function');
    expect(typeof shared.ruleForRound).toBe('function');
    expect(typeof shared.groupsAllowed).toBe('function');
    expect(typeof shared.validateGroupRules).toBe('function');
    expect(typeof shared.explainRoundCapacity).toBe('function');
    expect(shared.GROUP_PRESETS).toBe(GROUP_PRESETS);
    expect(typeof shared.checkRoom).toBe('function');
    expect(typeof shared.checkRound).toBe('function');
    expect(typeof shared.estimatedRoundStarts).toBe('function');
  });

  it('writes each one as an explicit named export, not only through export *', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../../shared/src/index.ts'), 'utf8');
    for (const name of [
      'groupPairKey', 'ruleForRound', 'groupsAllowed', 'validateGroupRules', 'explainRoundCapacity', 'GROUP_PRESETS',
      'checkRoom', 'checkRound', 'estimatedRoundStarts',
    ]) {
      expect(src).toMatch(new RegExp(`export const ${name} = `));
    }
  });
});

describe('estimatedRoundStarts (shared/src/events/round-times.ts)', () => {
  it('starts round r at (r - 1) × (round + rating window + 30 s) after the scheduled start', () => {
    const starts = estimatedRoundStarts('2026-12-01T18:00:00.000Z', { numberOfRounds: 3, roundDurationSeconds: 480, ratingWindowSeconds: 30 });
    expect(starts).toEqual(['2026-12-01T18:00:00.000Z', '2026-12-01T18:09:00.000Z', '2026-12-01T18:18:00.000Z']);
  });

  it('reads a Date as well as a string, and falls back to 8 minutes and 30 seconds as the token lifetime does', () => {
    const starts = estimatedRoundStarts(new Date('2026-12-01T18:00:00.000Z'), { numberOfRounds: 2, roundDurationSeconds: 0, ratingWindowSeconds: 0 });
    expect(starts).toEqual(['2026-12-01T18:00:00.000Z', '2026-12-01T18:09:00.000Z']);
  });

  it('gives a null for every round when the event has no start time', () => {
    expect(estimatedRoundStarts(null, { numberOfRounds: 3, roundDurationSeconds: 300, ratingWindowSeconds: 20 })).toEqual([null, null, null]);
    expect(estimatedRoundStarts('not a date', { numberOfRounds: 1, roundDurationSeconds: 300, ratingWindowSeconds: 20 })).toEqual([null]);
  });
});
