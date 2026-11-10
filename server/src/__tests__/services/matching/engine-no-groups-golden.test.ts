// ─── An event without groups matches exactly as it did before group rules (Part 2 Task 7, Review Focus 2) ───
//
// The live matcher runs real events on production. Group rules (Task 7) must leave an event with no event_groups
// rows untouched: same pairs, same trios, same byes, same reasons, same scores. This file holds the engine and the
// matching service to outputs recorded from the code as it was before the engine was touched (commit 3d98e241,
// fixture engine-golden-11.json). The only differences allowed are the two block fixes released with Task 7:
//   1. the odd person out never joins a pair one of whom they are kept from (a block, a report, an invite), and
//   2. the plan made at Start (generateSessionSchedule) keeps the same people apart as every later round does.
// Where a fix changes an output, the test shows that everything the fix does not touch is still the same.
//
// To re-record (only ever from the untouched engine): RECORD_ENGINE_GOLDEN=1 RECORD_ENGINE_GOLDEN_FROM=<commit>
// npx jest engine-no-groups-golden, then copy the file it names (in the OS temp folder) over the fixture. Tests
// never write inside the repo.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

const mockBlocks = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  getBlockedPairsForUsers: (...args: unknown[]) => mockBlocks(...args),
  __esModule: true,
}));

import type {
  EncounterHistoryEntry, HardConstraint, MatchingConfig, MatchingParticipant, MatchingWeights, RoundAssignment,
} from '@rsn/shared';
import { MatchingEngineV1 } from '../../../services/matching/matching.engine';
import { pairKey } from '../../../services/matching/matching.interface';
import { generateSessionSchedule, generateSingleRound } from '../../../services/matching/matching.service';

// ─── The fixture ─────────────────────────────────────────────────────────────

interface RawEncounter { userAId: string; userBId: string; timesMet: number; lastMetAt: string; mutualMeetAgain?: boolean; averageRating?: number }
interface ShapedPair {
  a: string; b: string; c: string | null; score: number; reasonTags: string[]; matchReason: string | null;
  fallbackUsed: boolean; repeatInEvent: boolean; premiumInfluenced: boolean;
}
interface ShapedRound {
  roundNumber: number; pairs: ShapedPair[]; byeParticipant: string | null; byeParticipants: string[]; warnings: string[];
  fallbackLevel?: number | null; usedRepeats?: boolean | null;
}
interface PersistedRow {
  round: number; a: string; b: string; c: string | null; score: number; reasonTags: string[]; matchReason: string | null;
  fallbackUsed: boolean; repeatInEvent: boolean; premiumInfluenced: boolean; templateId: string | null; confidence: number;
}
interface ServiceWorld { invites: Array<{ inviter_id: string; accepted_by_user_id: string }>; blocks: string[] }
interface Fixture {
  weights: MatchingWeights;
  participants: MatchingParticipant[];
  hardConstraints: HardConstraint[];
  encounterHistory: RawEncounter[];
  round3: { excludedPairs: string[] };
  trioBugIn11: { hardConstraints: HardConstraint[] };
  blockedTrio: { participants: MatchingParticipant[]; hardConstraints: HardConstraint[]; everyPairBlocked: HardConstraint[] };
  serviceWorlds: Record<string, ServiceWorld>;
  recorded?: {
    from: string;
    engine: {
      schedule: ShapedRound[]; round3: ShapedRound; trioBugIn11: ShapedRound[]; blockedTrio: ShapedRound; everyPairBlocked: ShapedRound;
    };
    service: Record<string, { singleRound: { round: ShapedRound; rows: PersistedRow[] }; schedule: { rounds: ShapedRound[]; rows: PersistedRow[] } }>;
  };
}

const FIXTURE_PATH = path.join(__dirname, '../../fixtures/engine-golden-11.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
const RECORD = process.env.RECORD_ENGINE_GOLDEN === '1';

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const encounters = (): EncounterHistoryEntry[] =>
  fixture.encounterHistory.map((e) => ({ ...e, lastMetAt: new Date(e.lastMetAt) }));
const config = (hardConstraints: HardConstraint[], numberOfRounds = 5): MatchingConfig => ({
  weights: clone(fixture.weights), hardConstraints: clone(hardConstraints), numberOfRounds,
  avoidDuplicates: true, globalOptimize: true,
});

function shapeRound(r: RoundAssignment, service = false): ShapedRound {
  const shaped: ShapedRound = {
    roundNumber: r.roundNumber,
    pairs: r.pairs.map((p) => ({
      a: p.participantAId, b: p.participantBId, c: p.participantCId ?? null, score: round4(p.score),
      reasonTags: [...p.reasonTags], matchReason: p.matchReason ?? null, fallbackUsed: p.fallbackUsed === true,
      repeatInEvent: p.repeatInEvent === true, premiumInfluenced: p.premiumInfluenced === true,
    })),
    byeParticipant: r.byeParticipant,
    byeParticipants: r.byeParticipants ?? [],
    warnings: r.warnings ?? [],
  };
  if (service) {
    shaped.fallbackLevel = r.fallbackLevel ?? null;
    shaped.usedRepeats = r.usedRepeats ?? null;
  }
  return shaped;
}

const engine = new MatchingEngineV1();

async function engineOutputs() {
  const schedule = await engine.generateSchedule({
    sessionId: 'golden', participants: clone(fixture.participants), config: config(fixture.hardConstraints),
    encounterHistory: encounters(), previousRounds: [],
  });
  const round3 = engine.generateRound(
    clone(fixture.participants), config(fixture.hardConstraints), new Set(fixture.round3.excludedPairs.map((k) => {
      const [a, b] = k.split(':');
      return pairKey(a, b);
    })), encounters(), 3, { regenerate: false },
  );
  const trioBugIn11 = await engine.generateSchedule({
    sessionId: 'golden', participants: clone(fixture.participants), config: config(fixture.trioBugIn11.hardConstraints),
    encounterHistory: encounters(), previousRounds: [],
  });
  const blockedTrio = engine.generateRound(
    clone(fixture.blockedTrio.participants), config(fixture.blockedTrio.hardConstraints, 1), new Set(), [], 1,
  );
  const everyPairBlocked = engine.generateRound(
    clone(fixture.blockedTrio.participants), config(fixture.blockedTrio.everyPairBlocked, 1), new Set(), [], 1,
  );
  return {
    schedule: schedule.rounds.map((r) => shapeRound(r)),
    round3: shapeRound(round3),
    trioBugIn11: trioBugIn11.rounds.map((r) => shapeRound(r)),
    blockedTrio: shapeRound(blockedTrio),
    everyPairBlocked: shapeRound(everyPairBlocked),
  };
}

// ─── The matching service over a database that answers from the fixture ─────

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const HOST_ID = 'host';

function installWorld(world: ServiceWorld): PersistedRow[] {
  const rows: PersistedRow[] = [];
  mockGetSessionById.mockResolvedValue({
    id: SESSION_ID, podId: null, hostUserId: HOST_ID, config: { numberOfRounds: 5, matchingPolicy: 'within_event' },
  });
  mockBlocks.mockImplementation(async () => [...world.blocks]);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM session_participants sp\s+JOIN users u/.test(sql)) {
      // Each read hands out fresh rows: the service writes onto them (requests, intent).
      return {
        rows: clone(fixture.participants).map((p) => {
          const { requestedUserIds: _requested, ...row } = p;
          return row;
        }),
      };
    }
    if (/SELECT participant_a_id, participant_b_id, participant_c_id FROM matches/.test(sql)) {
      return {
        rows: fixture.round3.excludedPairs.map((k) => {
          const [a, b] = k.split(':');
          return { participant_a_id: a, participant_b_id: b, participant_c_id: null };
        }),
      };
    }
    if (/FROM invites/.test(sql)) return { rows: clone(world.invites) };
    if (/FROM match_requests/.test(sql)) {
      return {
        rows: fixture.participants.flatMap((p) => (p.requestedUserIds ?? []).map((r) => ({ requester_id: p.userId, requested_id: r }))),
      };
    }
    if (/INSERT INTO matches/.test(sql)) {
      for (let i = 0; i < params.length; i += 13) {
        rows.push({
          round: params[i + 1] as number, a: params[i + 2] as string, b: params[i + 3] as string,
          c: (params[i + 4] as string | null) ?? null, score: round4(params[i + 5] as number),
          reasonTags: [...(params[i + 6] as string[])], matchReason: (params[i + 7] as string | null) ?? null,
          fallbackUsed: params[i + 8] as boolean, repeatInEvent: params[i + 9] as boolean,
          premiumInfluenced: params[i + 10] as boolean, templateId: (params[i + 11] as string | null) ?? null,
          confidence: round4(params[i + 12] as number),
        });
      }
      return { rows: [], rowCount: params.length / 13 };
    }
    return { rows: [], rowCount: 0 };
  });
  return rows;
}

async function serviceOutputs(world: ServiceWorld) {
  const singleRows = installWorld(world);
  const single = await generateSingleRound(SESSION_ID, 3, [HOST_ID]);
  const singleRound = { round: shapeRound(single, true), rows: singleRows };
  const scheduleRows = installWorld(world);
  const plan = await generateSessionSchedule(SESSION_ID, undefined, [HOST_ID]);
  const schedule = { rounds: plan.rounds.map((r) => shapeRound(r)), rows: scheduleRows };
  return { singleRound, schedule };
}

// ─── Helpers for the allowed differences ────────────────────────────────────

/** Every pair key the plan makes people meet in (each pair, and the three of a trio). */
function metPairs(rounds: Array<{ pairs: ShapedPair[] }>): Set<string> {
  const out = new Set<string>();
  for (const r of rounds) {
    for (const p of r.pairs) {
      out.add(pairKey(p.a, p.b));
      if (p.c) {
        out.add(pairKey(p.a, p.c));
        out.add(pairKey(p.b, p.c));
      }
    }
  }
  return out;
}

/** A round as it reads without its odd person out: who was paired with whom, and why, before the trio step. */
function withoutTrios(r: ShapedRound) {
  return r.pairs.map((p) => ({ ...p, c: null, reasonTags: p.reasonTags.filter((t) => t !== 'trio') }));
}

const keysOf = (constraints: HardConstraint[]) => new Set(constraints.flatMap((c) =>
  ((c.params.pairs as string[] | undefined) ?? []).map((t) => {
    const [a, b] = t.split(':');
    return pairKey(a, b);
  })));

// ─── Recording (only from the untouched engine) ─────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
  mockGetSessionById.mockReset();
  mockBlocks.mockReset();
});

(RECORD ? describe : describe.skip)('record the golden outputs', () => {
  it('writes the outputs of the current code into the fixture', async () => {
    const service: NonNullable<Fixture['recorded']>['service'] = {};
    for (const [name, world] of Object.entries(fixture.serviceWorlds)) service[name] = await serviceOutputs(world);
    fixture.recorded = { from: process.env.RECORD_ENGINE_GOLDEN_FROM ?? 'unknown', engine: await engineOutputs(), service };
    const recordedPath = path.join(os.tmpdir(), 'engine-golden-11.json');
    fs.writeFileSync(recordedPath, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stderr.write(`engine golden recorded to ${recordedPath}\n`);
  });
});

// ─── The golden ──────────────────────────────────────────────────────────────

(RECORD ? describe.skip : describe)('an event without groups: the engine', () => {
  const recorded = fixture.recorded!;
  const hard = keysOf(fixture.hardConstraints);

  it('was recorded from the engine before group rules existed', () => {
    expect(recorded.from).toBe('3d98e241');
  });

  it('the recorded fixture never sat a kept-apart pair together, so the trio fix cannot change it', () => {
    expect([...metPairs(recorded.engine.schedule)].filter((k) => hard.has(k))).toEqual([]);
    expect([...metPairs([recorded.engine.round3])].filter((k) => hard.has(k))).toEqual([]);
  });

  it('plans five rounds exactly as before: pairs, trios, byes, reasons and scores', async () => {
    const now = await engineOutputs();
    expect(now.schedule).toEqual(recorded.engine.schedule);
  });

  it('makes round 3 on its own exactly as before', async () => {
    const now = await engineOutputs();
    expect(now.round3).toEqual(recorded.engine.round3);
  });

  it('in the same event with another block, the old engine sat the blocked pair together in trios (the bug)', () => {
    const blocked = keysOf(fixture.trioBugIn11.hardConstraints);
    const hit = recorded.engine.trioBugIn11.filter((r) => [...metPairs([r])].some((k) => blocked.has(k)));
    expect(hit.map((r) => r.roundNumber)).toEqual([2, 4, 5]);
  });

  it('now nobody sits with someone they are kept from, and every pair of two is the same as before', async () => {
    const now = (await engineOutputs()).trioBugIn11;
    const blocked = keysOf(fixture.trioBugIn11.hardConstraints);
    expect([...metPairs(now)].filter((k) => blocked.has(k))).toEqual([]);
    // The trio step runs after the pairs are chosen and the plan's no-repeat memory holds only the pairs of two, so
    // moving the odd person out changes no other pairing in this round or any later one.
    expect(now.map(withoutTrios)).toEqual(recorded.engine.trioBugIn11.map(withoutTrios));
    // Rounds whose odd person out was not kept from their pair are exactly as before.
    for (const [i, r] of recorded.engine.trioBugIn11.entries()) {
      if (![...metPairs([r])].some((k) => blocked.has(k))) expect(now[i]).toEqual(r);
    }
    // Everyone still meets someone in every round.
    for (const r of now) expect(r.pairs.flatMap((p) => [p.a, p.b, p.c]).filter(Boolean)).toHaveLength(11);
  });

  it('the recorded blocked-trio case shows the old bug: the odd person out joined someone they blocked', () => {
    const blocked = keysOf(fixture.blockedTrio.hardConstraints);
    expect([...metPairs([recorded.engine.blockedTrio])].filter((k) => blocked.has(k))).toEqual([pairKey('t_a', 't_e')]);
  });

  it('now the odd person out never joins someone they are kept from: they join the next best pair', async () => {
    const now = (await engineOutputs()).blockedTrio;
    const blocked = keysOf(fixture.blockedTrio.hardConstraints);
    expect([...metPairs([now])].filter((k) => blocked.has(k))).toEqual([]);
    const trio = now.pairs.find((p) => p.c);
    expect(trio && [trio.a, trio.b, trio.c].sort()).toEqual(['t_c', 't_d', 't_e']);
    expect(now.byeParticipants).toEqual([]);
  });

  it('and the pairs the fix does not touch are the same pairs, with the same reasons and scores', async () => {
    const now = (await engineOutputs()).blockedTrio;
    expect(withoutTrios(now)).toEqual(withoutTrios(recorded.engine.blockedTrio));
  });

  it('when every pair holds someone the odd person out is kept from, they wait (a bye) instead', async () => {
    const now = (await engineOutputs()).everyPairBlocked;
    const blocked = keysOf(fixture.blockedTrio.everyPairBlocked);
    expect([...metPairs([now])].filter((k) => blocked.has(k))).toEqual([]);
    expect(now.pairs.every((p) => p.c === null)).toBe(true);
    expect(now.byeParticipant).toBe('t_e');
    expect(now.byeParticipants).toEqual(['t_e']);
    expect(withoutTrios(now)).toEqual(withoutTrios(recorded.engine.everyPairBlocked));
  });
});

(RECORD ? describe.skip : describe)('an event without groups: the matching service', () => {
  const recorded = fixture.recorded!;

  it.each(Object.keys(fixture.serviceWorlds))('a live round (%s) is made and stored exactly as before', async (name) => {
    const now = await serviceOutputs(fixture.serviceWorlds[name]);
    expect(now.singleRound).toEqual(recorded.service[name].singleRound);
  });

  it('the plan made at Start is the same plan where its pairs were never kept apart', async () => {
    const world = fixture.serviceWorlds.inert;
    const kept = new Set([
      ...world.blocks, ...world.invites.map((i) => `${i.inviter_id}:${i.accepted_by_user_id}`),
    ].map((t) => {
      const [a, b] = t.split(':');
      return pairKey(a, b);
    }));
    // This world's blocks and invite name pairs the old plan never used, so loading them changes nothing.
    expect([...metPairs(recorded.service.inert.schedule.rounds)].filter((k) => kept.has(k))).toEqual([]);
    const now = await serviceOutputs(world);
    expect(now.schedule).toEqual(recorded.service.inert.schedule);
  });

  it('the old plan made at Start sat blocked people together (the bug)', () => {
    const world = fixture.serviceWorlds.blocking;
    const blocked = new Set(world.blocks.map((t) => {
      const [a, b] = t.split(':');
      return pairKey(a, b);
    }));
    expect([...metPairs(recorded.service.blocking.schedule.rounds)].filter((k) => blocked.has(k)).length).toBeGreaterThan(0);
  });

  it('now the plan made at Start keeps them apart, as every later round already did', async () => {
    const world = fixture.serviceWorlds.blocking;
    const kept = new Set([
      ...world.blocks, ...world.invites.map((i) => `${i.inviter_id}:${i.accepted_by_user_id}`),
    ].map((t) => {
      const [a, b] = t.split(':');
      return pairKey(a, b);
    }));
    const now = await serviceOutputs(world);
    expect([...metPairs(now.schedule.rounds)].filter((k) => kept.has(k))).toEqual([]);
    for (const row of now.schedule.rows) {
      const people = [row.a, row.b, row.c].filter((x): x is string => !!x);
      for (let i = 0; i < people.length; i++) {
        for (let j = i + 1; j < people.length; j++) expect(kept.has(pairKey(people[i], people[j]))).toBe(false);
      }
    }
    // Everyone is still placed in every round: keeping them apart costs nobody a meeting.
    for (const round of now.schedule.rounds) {
      const placed = round.pairs.flatMap((p) => [p.a, p.b, p.c]).filter(Boolean);
      expect(placed).toHaveLength(fixture.participants.length);
    }
  });

  it('asks the database for the event\'s groups, finds none, and reads nothing more about groups', async () => {
    installWorld(fixture.serviceWorlds.inert);
    await generateSingleRound(SESSION_ID, 3, [HOST_ID]);
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls.filter((s) => /FROM event_groups/.test(s))).toHaveLength(1);
    expect(sqls.some((s) => /event_participant_groups|event_round_rules|event_matching_rules/.test(s))).toBe(false);
  });
});
