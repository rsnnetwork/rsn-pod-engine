// ─── The engine keeps an event's group rules as hard constraints (Part 2 Task 7; spec 05, 07, 12/06) ──────
//
// An organiser who sorts people into groups (founders and funders) and says who may meet whom in each round gets
// exactly that from the matcher: the plan made at Start, a round made live, and the fallback ladder never put two
// people together whom the round's rule keeps apart. When a rule leaves people without a partner, they wait, or,
// when the organiser chose it, meet their own group (tagged same_group_fallback). The round says how many meetings
// the rule allows and who waits (groupShortfall, Task 5's sentence). An event without groups is held to its old
// output in engine-no-groups-golden.test.ts.

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

const mockGetEventGroupRules = jest.fn();
const mockGroupsForParticipants = jest.fn();
jest.mock('../../../services/session/event-groups.service', () => ({
  getEventGroupRules: (...args: unknown[]) => mockGetEventGroupRules(...args),
  groupsForParticipants: (...args: unknown[]) => mockGroupsForParticipants(...args),
  __esModule: true,
}));

import {
  GROUP_PRESETS, type EventGroupRules, type MatchingConfig, type MatchingParticipant, type RoundAssignment,
} from '@rsn/shared';
import { pairKey } from '../../../services/matching/matching.interface';
import {
  generateGroupedRound, generateSessionSchedule, generateSingleRound,
} from '../../../services/matching/matching.service';

const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';
const HOST_ID = 'host';

function person(userId: string): MatchingParticipant {
  return {
    userId, interests: [], reasonsToConnect: [], industry: null, company: null, languages: ['english'],
    timezone: 'UTC', attributes: {},
  };
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);

function rulesWith(rounds: EventGroupRules['rounds'], fallback: EventGroupRules['fallback'] = 'leave_unmatched'): EventGroupRules {
  return { ...GROUP_PRESETS.founders_funders, fallback, rounds };
}
const ALL_CROSS = [{ fromRound: 1, toRound: 5, mode: 'cross_group' as const, allowedPairs: [] }];

interface World { founders: string[]; funders: string[]; ungrouped?: string[]; rules: EventGroupRules; priorPairs?: string[][] }

function groupOf(world: World, id: string): 'founder' | 'funder' | null {
  if (world.founders.includes(id)) return 'founder';
  if (world.funders.includes(id)) return 'funder';
  return null;
}

/** A database for one event: its people, their groups and rules, and the rows the plan writes. */
function install(world: World): Array<{ round: number; members: string[]; reasonTags: string[]; matchReason: string | null }> {
  const rows: Array<{ round: number; members: string[]; reasonTags: string[]; matchReason: string | null }> = [];
  const everyone = [...world.founders, ...world.funders, ...(world.ungrouped ?? [])];
  mockGetSessionById.mockResolvedValue({
    id: SESSION_ID, podId: null, hostUserId: HOST_ID, config: { numberOfRounds: 5, matchingPolicy: 'within_event' },
  });
  mockGetEventGroupRules.mockResolvedValue(world.rules);
  mockGroupsForParticipants.mockResolvedValue(new Map(everyone.flatMap((id) => {
    const g = groupOf(world, id);
    return g ? [[id, [g]] as [string, string[]]] : [];
  })));
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM session_participants sp\s+JOIN users u/.test(sql)) return { rows: everyone.map(person) };
    if (/SELECT participant_a_id, participant_b_id, participant_c_id FROM matches/.test(sql)) {
      return {
        rows: (world.priorPairs ?? []).map(([a, b]) => ({ participant_a_id: a, participant_b_id: b, participant_c_id: null })),
      };
    }
    if (/INSERT INTO matches/.test(sql)) {
      for (let i = 0; i < params.length; i += 13) {
        rows.push({
          round: params[i + 1] as number,
          members: [params[i + 2], params[i + 3], params[i + 4]].filter((x): x is string => !!x),
          reasonTags: params[i + 6] as string[],
          matchReason: (params[i + 7] as string | null) ?? null,
        });
      }
    }
    return { rows: [], rowCount: 0 };
  });
  return rows;
}

const membersOf = (p: { participantAId: string; participantBId: string; participantCId?: string | null }) =>
  [p.participantAId, p.participantBId, p.participantCId].filter((x): x is string => !!x);

function roomPairs(members: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) out.push([members[i], members[j]]);
  return out;
}

const sameGroup = (world: World, a: string, b: string) => groupOf(world, a) !== null && groupOf(world, a) === groupOf(world, b);

/** Every pair met over these rounds, and how many times. */
function meetings(rounds: RoundAssignment[]): Map<string, number> {
  const met = new Map<string, number>();
  for (const r of rounds) {
    for (const p of r.pairs) for (const [a, b] of roomPairs(membersOf(p))) met.set(pairKey(a, b), (met.get(pairKey(a, b)) ?? 0) + 1);
  }
  return met;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetSessionById.mockReset();
  mockGetEventGroupRules.mockReset();
  mockGroupsForParticipants.mockReset();
});

describe('the plan made at Start, on an event with groups', () => {
  it('6 founders and 6 funders meeting across groups for 5 rounds: never two of one group, never anyone twice', async () => {
    const world: World = { founders: ids('f', 6), funders: ids('u', 6), rules: rulesWith(ALL_CROSS) };
    const rows = install(world);
    const plan = await generateSessionSchedule(SESSION_ID, undefined, [HOST_ID]);
    expect(plan.rounds).toHaveLength(5);
    for (const r of plan.rounds) {
      expect(r.pairs).toHaveLength(6);
      expect(r.byeParticipants).toEqual([]);
      for (const p of r.pairs) for (const [a, b] of roomPairs(membersOf(p))) expect(sameGroup(world, a, b)).toBe(false);
      expect(r.groupShortfall).toMatchObject({ round: r.roundNumber, maxMeetings: 6, waiting: {}, sentence: null });
    }
    expect([...meetings(plan.rounds).values()].every((n) => n === 1)).toBe(true);
    // What is stored is what was planned.
    expect(rows).toHaveLength(30);
    for (const row of rows) for (const [a, b] of roomPairs(row.members)) expect(sameGroup(world, a, b)).toBe(false);
  });

  it('rounds 1-2 across groups, 3-5 open: two people of one group meet only in rounds 3 to 5', async () => {
    const world: World = {
      founders: ids('f', 6), funders: ids('u', 6),
      rules: rulesWith([{ fromRound: 1, toRound: 2, mode: 'cross_group', allowedPairs: [] }]),
    };
    install(world);
    const plan = await generateSessionSchedule(SESSION_ID, undefined, [HOST_ID]);
    const sameGroupRounds = plan.rounds
      .filter((r) => r.pairs.some((p) => roomPairs(membersOf(p)).some(([a, b]) => sameGroup(world, a, b))))
      .map((r) => r.roundNumber);
    expect(sameGroupRounds.length).toBeGreaterThan(0);
    expect(sameGroupRounds.every((n) => n >= 3)).toBe(true);
    expect([...meetings(plan.rounds).values()].every((n) => n === 1)).toBe(true);
  });

  it('25 founders and 8 funders, leave them unmatched: 8 meetings and 17 waiting each round, said to the organiser', async () => {
    const world: World = { founders: ids('f', 25), funders: ids('u', 8), rules: rulesWith(ALL_CROSS) };
    install(world);
    const plan = await generateSessionSchedule(SESSION_ID, undefined, [HOST_ID]);
    const sentence = 'In each round at most 8 founder and funder meetings are possible, so 17 founders wait. '
      + 'Choose: leave them unmatched, or let them meet another founder.';
    for (const r of plan.rounds) {
      expect(r.pairs).toHaveLength(8);
      expect(r.pairs.every((p) => !p.participantCId)).toBe(true);
      for (const p of r.pairs) expect(sameGroup(world, p.participantAId, p.participantBId)).toBe(false);
      expect(r.byeParticipants).toHaveLength(17);
      expect(r.byeParticipants!.every((id) => world.founders.includes(id))).toBe(true);
      expect(r.groupShortfall?.sentence).toBe(sentence);
      expect(r.groupShortfall?.waiting).toEqual({ founder: 17 });
      expect(r.warnings).toContain(sentence);
    }
    expect([...meetings(plan.rounds).values()].every((n) => n === 1)).toBe(true);
  });

  it('the same event letting them meet their own group: the 17 founders pair among themselves, tagged', async () => {
    const world: World = { founders: ids('f', 25), funders: ids('u', 8), rules: rulesWith(ALL_CROSS, 'same_group_meeting') };
    const rows = install(world);
    const plan = await generateSessionSchedule(SESSION_ID, undefined, [HOST_ID]);
    for (const r of plan.rounds) {
      const cross = r.pairs.filter((p) => !p.reasonTags.includes('same_group_fallback'));
      const fallback = r.pairs.filter((p) => p.reasonTags.includes('same_group_fallback'));
      expect(cross).toHaveLength(8);
      for (const p of cross) for (const [a, b] of roomPairs(membersOf(p))) expect(sameGroup(world, a, b)).toBe(false);
      // 17 founders: 8 rooms, one of them a trio (or a pair fewer and one waiting).
      const seated = fallback.flatMap(membersOf);
      expect(seated.every((id) => world.founders.includes(id))).toBe(true);
      expect(seated.length + (r.byeParticipants ?? []).length).toBe(17);
      expect((r.byeParticipants ?? []).length).toBeLessThanOrEqual(1);
      expect(fallback.filter((p) => p.participantCId).length + (r.byeParticipants ?? []).length).toBe(1);
      for (const p of fallback) expect(p.matchReason).toBe('same_group_fallback');
    }
    // Nobody meets the same partner twice. (The odd person out joining a trio follows the engine's trio rule for
    // every event, which checks who they are kept from but not who they met before, so only a trio's third seat
    // may repeat.)
    const pairsOfTwo = plan.rounds.flatMap((r) => r.pairs.map((p) => pairKey(p.participantAId, p.participantBId)));
    expect(new Set(pairsOfTwo).size).toBe(pairsOfTwo.length);
    expect(rows.filter((row) => row.reasonTags.includes('same_group_fallback')).every((row) => row.matchReason === 'same_group_fallback')).toBe(true);
  });
});

describe('one round, on an event with groups', () => {
  const baseConfig = (rules: EventGroupRules, groupsByUser: Record<string, string[]>): MatchingConfig => ({
    weights: { sharedInterests: 0.25, sharedReasons: 0.25, industryDiversity: 0.15, companyDiversity: 0.15, languageMatch: 0.1, encounterFreshness: 0.1 },
    hardConstraints: [], numberOfRounds: 5, avoidDuplicates: true, globalOptimize: false, groupRules: { rules, groupsByUser },
  });

  it('a person with no group under a cross-group rule waits, and the round says why', () => {
    const people = ['f01', 'f02', 'u01', 'u02', 'x01'];
    const round = generateGroupedRound({
      participants: people.map(person),
      config: baseConfig(rulesWith(ALL_CROSS), { f01: ['founder'], f02: ['founder'], u01: ['funder'], u02: ['funder'] }),
      excludedPairs: new Set(), encounterHistory: [], round: 1,
    });
    expect(round.pairs.flatMap(membersOf).sort()).toEqual(['f01', 'f02', 'u01', 'u02']);
    expect(round.byeParticipants).toEqual(['x01']);
    expect(round.groupShortfall?.ungrouped).toBe(1);
    expect(round.warnings?.some((w) => /1 person has no group yet/.test(w))).toBe(true);
  });

  it('the odd person out joins a pair only when the rule lets them meet both, else waits', () => {
    // f01-u01 and f02-u02 pair across groups; f03 can't join either pair (it holds a founder).
    const round = generateGroupedRound({
      participants: ['f01', 'u01', 'f02', 'u02', 'f03'].map(person),
      config: baseConfig(rulesWith(ALL_CROSS), {
        f01: ['founder'], f02: ['founder'], f03: ['founder'], u01: ['funder'], u02: ['funder'],
      }),
      excludedPairs: new Set(), encounterHistory: [], round: 1,
    });
    expect(round.pairs.every((p) => !p.participantCId)).toBe(true);
    expect(round.byeParticipants).toEqual(['f03']);
  });

  it('a key the rules no longer have reads as no group (as the room checker reads it)', () => {
    const round = generateGroupedRound({
      participants: ['f01', 'u01', 'z01'].map(person),
      config: baseConfig(rulesWith(ALL_CROSS), { f01: ['founder'], u01: ['funder'], z01: ['retired_group'] }),
      excludedPairs: new Set(), encounterHistory: [], round: 1,
    });
    expect(round.pairs.flatMap(membersOf).sort()).toEqual(['f01', 'u01']);
    expect(round.byeParticipants).toEqual(['z01']);
  });

  it('an open round of a group event pairs everyone, as an event without groups would', () => {
    const rules = rulesWith([{ fromRound: 1, toRound: 1, mode: 'cross_group', allowedPairs: [] }]);
    const round = generateGroupedRound({
      participants: ['f01', 'f02', 'f03', 'f04'].map(person),
      config: baseConfig(rules, { f01: ['founder'], f02: ['founder'], f03: ['founder'], f04: ['founder'] }),
      excludedPairs: new Set(), encounterHistory: [], round: 2,
    });
    expect(round.pairs).toHaveLength(2);
    expect(round.byeParticipants).toEqual([]);
    expect(round.groupShortfall?.sentence).toBeNull();
  });
});

describe('a round made live, on an event with groups', () => {
  it('keeps the rule, and the fallback ladder relaxes no repeat for the people the rule leaves waiting', async () => {
    const world: World = {
      founders: ids('f', 25), funders: ids('u', 8), rules: rulesWith(ALL_CROSS),
      // Round 1 already met: each funder and one founder.
      priorPairs: ids('u', 8).map((u, i) => [`f${String(i + 1).padStart(2, '0')}`, u]),
    };
    const rows = install(world);
    const round = await generateSingleRound(SESSION_ID, 2, [HOST_ID]);
    expect(round.fallbackLevel).toBe(0);
    expect(round.usedRepeats).toBe(false);
    expect(round.pairs).toHaveLength(8);
    for (const p of round.pairs) expect(sameGroup(world, p.participantAId, p.participantBId)).toBe(false);
    const prior = new Set(world.priorPairs!.map(([a, b]) => pairKey(a, b)));
    for (const p of round.pairs) expect(prior.has(pairKey(p.participantAId, p.participantBId))).toBe(false);
    expect(rows).toHaveLength(8);
  });

  it('reads the groups only for an event that has them', async () => {
    const world: World = { founders: ids('f', 4), funders: ids('u', 4), rules: rulesWith(ALL_CROSS) };
    install(world);
    await generateSingleRound(SESSION_ID, 1, [HOST_ID]);
    expect(mockGroupsForParticipants).toHaveBeenCalledTimes(1);

    mockGetEventGroupRules.mockResolvedValue(null);
    mockGroupsForParticipants.mockClear();
    await generateSingleRound(SESSION_ID, 1, [HOST_ID]);
    expect(mockGroupsForParticipants).not.toHaveBeenCalled();
  });
});
