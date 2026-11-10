// ─── Live repair of an event without a published schedule is unchanged (10 Nov 2026 spec, Part 2 Task 9) ────
//
// Task 9 sends the live repair of an event WITH a published schedule through the matching board (Key decision D4).
// An event without one must take today's path exactly: repairFutureRounds deletes the future rounds' scheduled
// matches and makes each round again with generateSingleRound. This file holds that path to outputs recorded from
// the code before Task 9 touched it (commit a4b2cd7c, fixture repair-golden-11.json), over Task 7's golden world
// (engine-golden-11.json): the same rows stored, round by round, with the same pairs, trios, reasons and scores,
// and the same answer to the caller.
//
// To re-record (only ever from code before Task 9): RECORD_REPAIR_GOLDEN=1 RECORD_REPAIR_GOLDEN_FROM=<commit>
// npx jest repair-no-board-golden, then copy the file it names (in the OS temp folder) over the fixture.

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

import type { MatchingParticipant } from '@rsn/shared';
import { repairFutureRounds } from '../../../services/matching/matching.service';

interface ServiceWorld { invites: Array<{ inviter_id: string; accepted_by_user_id: string }>; blocks: string[] }
interface EngineFixture {
  participants: MatchingParticipant[];
  round3: { excludedPairs: string[] };
  serviceWorlds: Record<string, ServiceWorld>;
}
interface PersistedRow {
  round: number; a: string; b: string; c: string | null; score: number; reasonTags: string[]; matchReason: string | null;
  fallbackUsed: boolean; repeatInEvent: boolean; premiumInfluenced: boolean; templateId: string | null; confidence: number;
}
interface RepairOutput {
  result: { regeneratedRounds: number[]; errors: Array<{ roundNumber: number; error: string }> };
  deletedFrom: Array<{ round: number | null; statuses: string }>;
  rows: PersistedRow[];
}
interface RepairFixture { from: string; cases: Record<string, RepairOutput> }

const ENGINE_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/engine-golden-11.json'), 'utf8')) as EngineFixture;
const REPAIR_FIXTURE_PATH = path.join(__dirname, '../../fixtures/repair-golden-11.json');
const RECORD = process.env.RECORD_REPAIR_GOLDEN === '1';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const HOST_ID = 'host';
const round4 = (x: number) => Math.round(x * 10000) / 10000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Each case: a world, the round to repair from, the reason, and who is in the main room (undefined: no signal). */
const CASES: Record<string, { world: string; from: number; reason: 'late_joiner' | 'left' | 'host_request'; present?: string[] }> = {
  inertFrom2LateJoiner: { world: 'inert', from: 2, reason: 'late_joiner' },
  blockingFrom3Left: { world: 'blocking', from: 3, reason: 'left' },
  inertFrom4HostPresentGate: {
    world: 'inert', from: 4, reason: 'host_request', present: ENGINE_FIXTURE.participants.slice(0, 9).map((p) => p.userId),
  },
};

function installWorld(world: ServiceWorld): RepairOutput {
  const out: RepairOutput = { result: { regeneratedRounds: [], errors: [] }, deletedFrom: [], rows: [] };
  mockGetSessionById.mockResolvedValue({
    id: SESSION_ID, podId: null, hostUserId: HOST_ID, config: { numberOfRounds: 5, matchingPolicy: 'within_event' },
  });
  mockBlocks.mockImplementation(async () => [...world.blocks]);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM session_participants sp\s+JOIN users u\s+ON u\.id = sp\.user_id\s+WHERE sp\.session_id = \$1 AND sp\.status NOT IN/.test(sql)) {
      return {
        rows: clone(ENGINE_FIXTURE.participants).map((p) => {
          const { requestedUserIds: _requested, ...row } = p;
          return row;
        }),
      };
    }
    if (/SELECT participant_a_id, participant_b_id, participant_c_id FROM matches/.test(sql)) {
      return {
        rows: ENGINE_FIXTURE.round3.excludedPairs.map((k) => {
          const [a, b] = k.split(':');
          return { participant_a_id: a, participant_b_id: b, participant_c_id: null };
        }),
      };
    }
    if (/FROM invites/.test(sql)) return { rows: clone(world.invites) };
    if (/FROM match_requests/.test(sql)) {
      return {
        rows: ENGINE_FIXTURE.participants.flatMap((p) => (p.requestedUserIds ?? []).map((r) => ({ requester_id: p.userId, requested_id: r }))),
      };
    }
    if (/^\s*DELETE FROM matches/.test(sql)) {
      const statuses = (/status (?:IN \(([^)]*)\)|= '([a-z_]+)')/.exec(sql) ?? []).slice(1).find(Boolean) ?? '';
      out.deletedFrom.push({ round: (params[1] as number | undefined) ?? null, statuses: statuses.replace(/\s+/g, '') });
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO matches/.test(sql)) {
      for (let i = 0; i < params.length; i += 13) {
        out.rows.push({
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
  return out;
}

async function runCase(name: string): Promise<RepairOutput> {
  const c = CASES[name];
  const out = installWorld(ENGINE_FIXTURE.serviceWorlds[c.world]);
  out.result = await repairFutureRounds(SESSION_ID, c.from, c.reason, c.present ? new Set(c.present) : undefined);
  return out;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetSessionById.mockReset();
  mockBlocks.mockReset();
});

(RECORD ? describe : describe.skip)('record the repair golden', () => {
  it('writes the outputs of the current repair into the fixture', async () => {
    const cases: Record<string, RepairOutput> = {};
    for (const name of Object.keys(CASES)) cases[name] = await runCase(name);
    const recorded: RepairFixture = { from: process.env.RECORD_REPAIR_GOLDEN_FROM ?? 'unknown', cases };
    const recordedPath = path.join(os.tmpdir(), 'repair-golden-11.json');
    fs.writeFileSync(recordedPath, `${JSON.stringify(recorded, null, 2)}\n`);
    process.stderr.write(`repair golden recorded to ${recordedPath}\n`);
  });
});

(RECORD ? describe.skip : describe)('an event without a published schedule: live repair', () => {
  const fixture = (): RepairFixture => JSON.parse(fs.readFileSync(REPAIR_FIXTURE_PATH, 'utf8')) as RepairFixture;

  it('was recorded from the code before Task 9', () => {
    expect(fixture().from).toBe('a4b2cd7c');
  });

  it.each(Object.keys(CASES))('%s: the same rounds made again, the same rows stored, the same answer', async (name) => {
    const now = await runCase(name);
    expect(now).toEqual(fixture().cases[name]);
  });

  it('asks once whether the event has a published schedule, and reads nothing else of the board', async () => {
    await runCase('inertFrom2LateJoiner');
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '));
    expect(sqls.filter((s) => /event_schedules/.test(s))).toHaveLength(1);
    expect(sqls.some((s) => /event_schedule_(assignments|versions|room_locks|absences)/.test(s))).toBe(false);
  });
});
