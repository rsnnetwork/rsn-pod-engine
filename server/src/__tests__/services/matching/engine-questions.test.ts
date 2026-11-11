// ─── Extra matching questions are a soft preference only (10 Nov 2026 spec, Part 3 Task 5; K5; Review Focus 5) ─────
//
// "Matching questions are soft preferences. They only choose among the meetings the event already allows. A block, a
// report, an inviter and the person they invited, and the event's group rules always win, and so does the no-repeat
// rule. Questions never make a meeting that would otherwise be refused, never leave someone unmatched, and never cause
// a repeat."
//
// The engine adds the answers as one weighted term (EVENT_QUESTION_WEIGHT) inside its pair score, which it computes only
// for pairs that passed every hard exclusion and the round's group rule, and it sorts pairs by how often two people met
// before it looks at a score. This file holds each of those, the all-guest event the spec is written for, the board's
// redistribution, and that an event without questions reads event_matching_questions once and nothing more (the golden
// suites hold its outputs byte-identical).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: mockQuery })),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({
  getBlockedPairsForUsers: jest.fn(async () => []),
  __esModule: true,
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  EVENT_QUESTION_WEIGHT, GROUP_PRESETS,
  type EncounterHistoryEntry, type EventAnswers, type EventMatchingQuestion, type HardConstraint, type MatchingConfig,
  type MatchingParticipant, type RoomCheckContext, type RoundAssignment,
} from '@rsn/shared';
import { MatchingEngineV1 } from '../../../services/matching/matching.engine';
import { pairKey } from '../../../services/matching/matching.interface';
import {
  generateSessionSchedule, generateSingleRound, prepareBoardRoundGenerator,
} from '../../../services/matching/matching.service';
import { redistributeRound } from '../../../services/schedule/redistribute';

const engine = new MatchingEngineV1();

const SECTOR: EventMatchingQuestion = {
  key: 'sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: true,
  options: [{ key: 'fintech', label: 'Fintech' }, { key: 'health', label: 'Health' }],
};
const WEIGHTS = {
  sharedInterests: 0.25, sharedReasons: 0.25, industryDiversity: 0.15, companyDiversity: 0.15, languageMatch: 0.1,
  encounterFreshness: 0,
};

/** A guest as the engine sees one: no profile at all, so every pair ties on everything but the answers. */
const guest = (userId: string): MatchingParticipant => ({
  userId, interests: [], reasonsToConnect: [], industry: null, company: null, languages: [], timezone: 'UTC', attributes: {},
});

function configOf(opts: {
  answers?: Record<string, EventAnswers>; questions?: EventMatchingQuestion[]; hardConstraints?: HardConstraint[];
  groupRules?: MatchingConfig['groupRules'];
} = {}): MatchingConfig {
  return {
    weights: { ...WEIGHTS },
    hardConstraints: opts.hardConstraints ?? [],
    numberOfRounds: 3,
    avoidDuplicates: true,
    globalOptimize: false,
    ...(opts.groupRules && { groupRules: opts.groupRules }),
    ...(opts.answers && { eventQuestions: { questions: opts.questions ?? [SECTOR], answersByUser: opts.answers } }),
  };
}

const roomsOf = (r: RoundAssignment) => r.pairs
  .map((p) => [p.participantAId, p.participantBId, p.participantCId].filter(Boolean).sort().join('+'))
  .sort();
const placed = (r: RoundAssignment) => r.pairs.flatMap((p) => [p.participantAId, p.participantBId, p.participantCId]).filter(Boolean);

// The order people come in decides ties: A, C, B, D, so without answers the first pair is A with C.
const PEOPLE = ['A', 'C', 'B', 'D'];
const BY_SECTOR: Record<string, EventAnswers> = {
  A: { sector: ['fintech'] }, B: { sector: ['fintech'] }, C: { sector: ['health'] }, D: { sector: ['health'] },
};

describe('the engine: answers choose among the meetings the event allows', () => {
  it('an all-guest event of four pairs the same sector together in round 1 (and, without answers, does not)', () => {
    const withAnswers = engine.generateRound(PEOPLE.map(guest), configOf({ answers: BY_SECTOR }), new Set(), [], 1);
    expect(roomsOf(withAnswers)).toEqual(['A+B', 'C+D']);
    const without = engine.generateRound(PEOPLE.map(guest), configOf(), new Set(), [], 1);
    expect(roomsOf(without)).toEqual(['A+C', 'B+D']);
  });

  it('a blocked pair with perfect answers is never made', () => {
    const block: HardConstraint = { type: 'user_block', params: { pairs: ['A:B'] } };
    for (const round of [1, 2, 3]) {
      const r = engine.generateRound(PEOPLE.map(guest), configOf({ answers: BY_SECTOR, hardConstraints: [block] }), new Set(), [], round);
      expect(roomsOf(r)).not.toContain('A+B');
      expect(placed(r)).toHaveLength(4);
    }
  });

  it('a pair an inviter rule keeps apart is never made, nor one a report keeps apart', () => {
    const invite: HardConstraint = { type: 'inviter_invitee_block', params: { pairs: ['C:D'] } };
    const report: HardConstraint = { type: 'exclude_pair', params: { userIds: ['A', 'B'] } };
    const r = engine.generateRound(PEOPLE.map(guest), configOf({ answers: BY_SECTOR, hardConstraints: [invite, report] }), new Set(), [], 1);
    expect(roomsOf(r)).not.toContain('A+B');
    expect(roomsOf(r)).not.toContain('C+D');
    expect(placed(r)).toHaveLength(4);
  });

  it('a cross-group round never seats two people of one group, however alike their answers', () => {
    const rules = { ...GROUP_PRESETS.founders_funders, rounds: [{ fromRound: 1, toRound: 3, mode: 'cross_group' as const, allowedPairs: [] }] };
    const groupRules = { rules, groupsByUser: { A: ['founder'], B: ['founder'], C: ['funder'], D: ['funder'] } };
    const r = engine.generateRound(PEOPLE.map(guest), configOf({ answers: BY_SECTOR, groupRules }), new Set(), [], 1);
    expect(roomsOf(r)).toEqual(['A+C', 'B+D'].sort());
    expect(roomsOf(r)).not.toContain('A+B');
  });

  it('a pair already met in the event is never made again because of answers (the no-repeat rule)', () => {
    const used = new Set([pairKey('A', 'B'), pairKey('C', 'D')]);
    const r = engine.generateRound(PEOPLE.map(guest), configOf({ answers: BY_SECTOR }), used, [], 2);
    expect(roomsOf(r)).not.toContain('A+B');
    expect(roomsOf(r)).not.toContain('C+D');
    expect(placed(r)).toHaveLength(4);
  });

  it('a never-met pair with different answers beats an already-met pair with the same answers', () => {
    // A and B met before (another event), as did C and D; encounterFreshness is 0 here, so only the times-met sort
    // keeps them apart.
    const history: EncounterHistoryEntry[] = [
      { userAId: 'A', userBId: 'B', timesMet: 1, lastMetAt: new Date('2026-10-01T10:00:00Z') },
      { userAId: 'C', userBId: 'D', timesMet: 1, lastMetAt: new Date('2026-10-01T10:00:00Z') },
    ];
    const r = engine.generateRound(PEOPLE.map(guest), configOf({ answers: BY_SECTOR }), new Set(), history, 1);
    expect(roomsOf(r)).not.toContain('A+B');
    expect(roomsOf(r)).not.toContain('C+D');
    expect(placed(r)).toHaveLength(4);
  });

  it('among fresh allowed pairs of members, the higher-affinity matching wins and the reason comes last', () => {
    // A and C share a language (so without answers they pair), as do B and D; A and B answer alike, as do C and D.
    const member = (userId: string, language: string): MatchingParticipant => ({ ...guest(userId), languages: [language] });
    const people = [member('A', 'english'), member('C', 'english'), member('B', 'french'), member('D', 'french')];
    const without = engine.generateRound(people, configOf(), new Set(), [], 1);
    expect(roomsOf(without)).toEqual(['A+C', 'B+D']);
    const withAnswers = engine.generateRound(people, configOf({ answers: BY_SECTOR }), new Set(), [], 1);
    expect(roomsOf(withAnswers)).toEqual(['A+B', 'C+D']);
    const ab = withAnswers.pairs.find((p) => [p.participantAId, p.participantBId].sort().join('+') === 'A+B')!;
    expect(ab.reasonTags[ab.reasonTags.length - 1]).toBe('event_answers');
    expect(ab.matchReason).toBe(ab.reasonTags[0]);
    expect(ab.matchReason).not.toBe('event_answers');
  });

  it('an optional question nobody answered is neutral: the same rooms as without questions', () => {
    const optional = { ...SECTOR, required: false };
    const none = engine.generateRound(PEOPLE.map(guest), configOf(), new Set(), [], 1);
    const unanswered = engine.generateRound(PEOPLE.map(guest), configOf({ answers: {}, questions: [optional] }), new Set(), [], 1);
    expect(roomsOf(unanswered)).toEqual(roomsOf(none));
    expect(unanswered.pairs.every((p) => !p.reasonTags.includes('event_answers'))).toBe(true);
  });

  it('a person who did not answer is neutral to everyone, and still placed', () => {
    const answers = { A: { sector: ['fintech'] }, B: { sector: ['fintech'] }, C: { sector: ['health'] } };
    const r = engine.generateRound(PEOPLE.map(guest), configOf({ answers }), new Set(), [], 1);
    expect(roomsOf(r)).toEqual(['A+B', 'C+D']);
    expect(placed(r)).toHaveLength(4);
  });

  it('never leaves someone unmatched: an odd leftover still joins a pair (the trio prefers alike answers)', () => {
    const five = ['A', 'C', 'B', 'D', 'E'];
    const answers = { ...BY_SECTOR, E: { sector: ['health'] } };
    const r = engine.generateRound(five.map(guest), configOf({ answers }), new Set(), [], 1);
    expect(placed(r)).toHaveLength(5);
    expect(roomsOf(r)).toContain('A+B');
    expect(roomsOf(r).some((room) => room.split('+').length === 3 && room.includes('E') && room.includes('C') && room.includes('D'))).toBe(true);
  });

  it('scores a neutral pair as one more term of 0.5 at the question weight, and adds nothing at all without questions', () => {
    const a = guest('A');
    const round4 = (x: number) => Math.round(x * 10000) / 10000;
    // A guest pair, everything but the answers: industry and company diversity (0.15 each) and no shared language
    // (0.2 x 0.1), over the five weights (0.9).
    const base = 0.15 + 0.15 + 0.02;
    expect(engine.scorePair(a, guest('B'), configOf(), []).score).toBe(round4(base / 0.9));
    expect(engine.scorePair(a, guest('B'), configOf({ answers: {} }), []).score).toBe(round4((base + 0.5 * EVENT_QUESTION_WEIGHT) / 1.1));
    expect(engine.scorePair(a, guest('B'), configOf({ answers: BY_SECTOR }), []).score).toBe(round4((base + EVENT_QUESTION_WEIGHT) / 1.1));
    expect(engine.scorePair(a, guest('C'), configOf({ answers: BY_SECTOR }), []).score).toBe(round4(base / 1.1));
    // A template may set its own weight for the answers.
    const heavier = configOf({ answers: BY_SECTOR });
    heavier.weights.eventQuestions = 0.4;
    expect(engine.scorePair(a, guest('B'), heavier, []).score).toBe(round4((base + 0.4) / 1.3));
    expect(engine.scorePair(a, guest('B'), configOf(), []).reasonTags).not.toContain('event_answers');
  });
});

describe('the board\'s redistribution: answers order the candidates after fairness', () => {
  const ctx: RoomCheckContext = {
    round: 1, rules: null, groupsOf: () => [], hardExcluded: () => false, metBefore: () => false, maxRoomSize: 3,
  };
  const noEngine = () => ({ roundNumber: 1, pairs: [], byeParticipant: null });

  // The room's second seat is the step-2 choice; the one left over then joins as a trio (step 4).
  it('a room of one takes the basket person whose answers suit best, else registration order', () => {
    const base = {
      round: 1, seated: new Map([[1, ['A']]]), lockedRooms: new Set<number>(), lockedSlots: new Set<string>(),
      basket: ['C', 'B'], ctx, generate: noEngine,
    };
    expect(redistributeRound(base).seated.get(1)!.slice(0, 2)).toEqual(['A', 'C']);
    const affinity = (x: string, y: string) => (BY_SECTOR[x]?.sector[0] === BY_SECTOR[y]?.sector[0] ? 1 : 0);
    expect(redistributeRound({ ...base, affinity }).seated.get(1)!.slice(0, 2)).toEqual(['A', 'B']);
  });

  it('fewer meetings still comes before answers', () => {
    const affinity = (x: string, y: string) => (BY_SECTOR[x]?.sector[0] === BY_SECTOR[y]?.sector[0] ? 1 : 0);
    const r = redistributeRound({
      round: 1, seated: new Map([[1, ['A']]]), lockedRooms: new Set<number>(), lockedSlots: new Set<string>(),
      basket: ['C', 'B'], ctx, generate: noEngine, affinity, meetingsOf: (id) => (id === 'B' ? 2 : 0),
    });
    expect(r.seated.get(1)!.slice(0, 2)).toEqual(['A', 'C']);
  });
});

// ─── The matching service: one read for an event without questions, the answers for one with them ─────────

const SESSION_ID = '00000000-0000-4000-8000-000000000005';
const QUESTION_ROW = {
  id: 'q-1', key: 'sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: true,
  options: SECTOR.options,
};

function installWorld(opts: { questions: boolean }) {
  mockGetSessionById.mockResolvedValue({ id: SESSION_ID, podId: null, hostUserId: 'host', config: { numberOfRounds: 3 } });
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM session_participants sp\s+JOIN users u/.test(sql) || /FROM users u\s+WHERE u\.id = ANY/.test(sql)) {
      return { rows: PEOPLE.map(guest) };
    }
    if (/FROM event_matching_questions/.test(sql) && !/event_question_answers/.test(sql)) {
      return { rows: opts.questions ? [QUESTION_ROW] : [] };
    }
    if (/FROM event_question_answers/.test(sql)) {
      return {
        rows: Object.entries(BY_SECTOR).map(([userId, a]) => ({ user_id: userId, key: 'sector', option_keys: a.sector })),
      };
    }
    return { rows: [], rowCount: 0 };
  });
}
const sqls = () => mockQuery.mock.calls.map(([sql]) => String(sql));

describe('the matching service and the questions', () => {
  it('an event without questions: exactly one read of event_matching_questions, none of event_question_answers', async () => {
    for (const run of [
      () => generateSingleRound(SESSION_ID, 1, ['host']),
      () => generateSessionSchedule(SESSION_ID, undefined, ['host']),
      () => prepareBoardRoundGenerator(SESSION_ID, PEOPLE),
    ]) {
      mockQuery.mockReset();
      installWorld({ questions: false });
      await run();
      expect(sqls().filter((s) => /FROM event_matching_questions/.test(s))).toHaveLength(1);
      expect(sqls().some((s) => /event_question_answers/.test(s))).toBe(false);
    }
  });

  it('the board\'s generator carries no affinity without questions, and one with them', async () => {
    installWorld({ questions: false });
    expect((await prepareBoardRoundGenerator(SESSION_ID, PEOPLE)).affinity).toBeUndefined();
    mockQuery.mockReset();
    installWorld({ questions: true });
    const generator = await prepareBoardRoundGenerator(SESSION_ID, PEOPLE);
    expect(generator.affinity?.('A', 'B')).toBe(1);
    expect(generator.affinity?.('A', 'C')).toBe(0);
    expect(roomsOf(generator(PEOPLE, 1, new Set()))).toEqual(['A+B', 'C+D']);
  });

  it('Live Match and the plan made at Start pair the same sector together on an all-guest event', async () => {
    installWorld({ questions: true });
    expect(roomsOf(await generateSingleRound(SESSION_ID, 1, ['host']))).toEqual(['A+B', 'C+D']);
    mockQuery.mockReset();
    installWorld({ questions: true });
    const plan = await generateSessionSchedule(SESSION_ID, undefined, ['host']);
    expect(roomsOf(plan.rounds[0])).toEqual(['A+B', 'C+D']);
    // The answers were read for the people being paired only.
    const answerRead = mockQuery.mock.calls.find(([sql]) => /FROM event_question_answers/.test(String(sql)));
    expect(answerRead?.[1]).toEqual([SESSION_ID, PEOPLE]);
  });

  it('a failed question read never stops matching: the round is made without them', async () => {
    installWorld({ questions: true });
    const answering = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/event_matching_questions/.test(sql)) throw new Error('relation does not exist');
      return answering(sql, params);
    });
    expect(roomsOf(await generateSingleRound(SESSION_ID, 1, ['host']))).toEqual(['A+C', 'B+D']);
  });
});

describe('source: the term sits after every hard filter and below the times-met sort', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../services/matching/matching.engine.ts'), 'utf8');

  it('adds the term only when the event has questions (no zero weight otherwise), as the score\'s last block', () => {
    const block = src.slice(src.indexOf('private computePairScore('), src.indexOf('private buildEncounterMap('));
    expect(block).toMatch(/if \(questions\) \{[\s\S]*weights\.eventQuestions \?\? EVENT_QUESTION_WEIGHT/);
    expect(block.indexOf('if (questions)')).toBeGreaterThan(block.indexOf('mutualMeetAgainBoost'));
    expect(block.indexOf('if (questions)')).toBeLessThan(block.indexOf('const normalizedScore'));
  });

  it('scores candidates after the used-pair, hard-exclusion and group-rule skips, and sorts by times met first', () => {
    const round = src.slice(src.indexOf('private generateSingleRound('), src.indexOf('private computePairScore('));
    const skip = round.indexOf('hardExclusions.has(key)');
    const gate = round.indexOf('!mayMeet(participants[i].userId, participants[j].userId)');
    const score = round.indexOf('config.weights, encounterMap, config.eventQuestions');
    expect(skip).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(skip);
    expect(score).toBeGreaterThan(gate);
    expect(round).toContain('candidates.sort((a, b) => (a.timesMet - b.timesMet) || (b.score - a.score));');
  });
});
