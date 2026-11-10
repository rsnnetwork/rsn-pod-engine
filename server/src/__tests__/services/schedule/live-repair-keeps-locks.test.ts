// ─── A locked pairing survives the live event (10 Nov 2026 spec, Part 2 Task 9; Review Focus 3; 12/10, section 07) ──
//
// On an event with a published schedule the live repairs go through the board (Key decision D4). A meeting locked on
// the board keeps its people, its room number and its live `matches` row through a late joiner, a leaver from another
// room, the host's Re-match of its round and a host-requested repair. A leaver from the locked meeting leaves it
// flagged, the host is told once, and nobody is moved into it. The organiser marking someone late and publishing
// rewrites only the affected rooms (the others keep their row ids) and rings only the impacted. A planned room the
// checker refuses when its round starts is not started. A round the host changed live is written back to the board.
// The real services, checker and engine against fixtures/schedule-world.ts.

jest.mock('../../../db', () => {
  const w = require('../../fixtures/schedule-world');
  return { __esModule: true, query: w.query, transaction: w.transaction };
});
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/session/session.service', () => ({
  __esModule: true,
  getSessionById: () => require('../../fixtures/schedule-world').getSessionById(),
}));
jest.mock('../../../services/block/block.service', () => ({
  __esModule: true,
  getBlockedPairsForUsers: async () => require('../../fixtures/schedule-world').world.blocks.map(([a, b]: string[]) => `${a}:${b}`),
}));
jest.mock('../../../services/session/event-groups.service', () => ({
  __esModule: true,
  getEventGroupRules: async () => require('../../fixtures/schedule-world').world.rules,
  groupsForParticipants: async () => new Map(require('../../fixtures/schedule-world').world.groups),
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  __esModule: true,
  canActAsHost: async (userId: string) => ({
    allowed: require('../../fixtures/schedule-world').world.organisers.has(userId), effectiveRole: 'event_host',
  }),
}));
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => require('../../fixtures/schedule-world').fakeIo,
  emitEntities: jest.fn(async () => {}),
}));
jest.mock('../../../services/redis/redis.client', () => ({ __esModule: true, getRedisClient: () => null }));

import * as fs from 'fs';
import * as path from 'path';
import { UserRole, type BoardOp, type ScheduleBoard } from '@rsn/shared';
import { generateSingleRound, repairFutureRounds } from '../../../services/matching/matching.service';
import { applyBoardOp, generateBoard, getBoard } from '../../../services/schedule/schedule-board.service';
import { publishSchedule } from '../../../services/schedule/schedule-publish.service';
import {
  anyMatchLocked, lockedPeopleInRound, materialisePublished, refuseBrokenScheduledRooms, syncRoundIntoSchedule,
} from '../../../services/schedule/schedule-live.service';
import { COHOST, EVENT, HOST, addPerson, query, resetWorld, world, type LiveMatch } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const NAMES: Record<string, string> = { a: 'Ann', b: 'Ben', c: 'Cat', d: 'Dev', e: 'Eve', f: 'Fay', g: 'Gus', h: 'Hal' };

const membersOf = (m: LiveMatch) => [m.a, m.b, m.c].filter((id): id is string => !!id).sort();
const planned = (round: number) => world.matches.filter((m) => m.round_number === round && m.status === 'scheduled');
const rowWith = (round: number, userId: string) => planned(round).find((m) => membersOf(m).includes(userId)) ?? null;
const roomOf = (board: ScheduleBoard, round: number, userId: string) =>
  board.rounds[round - 1].rooms.find((r) => r.seats.some((s) => s.userId === userId)) ?? null;

async function op(change: BoardOp): Promise<ScheduleBoard> {
  return (await applyBoardOp(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, change)).board;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Nobody sits in two planned rooms of a round, and every row of a round is a room of two or three. */
function expectWellFormed(): void {
  for (let round = 1; round <= 5; round++) {
    const seated = planned(round).flatMap(membersOf);
    expect(new Set(seated).size).toBe(seated.length);
    for (const m of planned(round)) expect(membersOf(m).length).toBeGreaterThanOrEqual(2);
  }
}

interface Live { locked: LiveMatch; partner: string; room: number }

/**
 * Eight people on a board, every round generated; Ann's round-3 meeting locked; version 1 published before the event;
 * then the event starts with everyone there, so the live matches are version 1.
 */
async function liveEvent(): Promise<Live> {
  let board = (await generateBoard(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, 'all')).board;
  const room = roomOf(board, 3, 'a')!;
  board = await op({ kind: 'lock_room', round: 3, room: room.roomNumber });
  await publishSchedule(EVENT, OWNER, board.revision);
  world.session.status = 'lobby_open';
  world.session.current_round = 0;
  await materialisePublished(EVENT, { presentUserIds: new Set(PEOPLE), hostIds: [HOST, COHOST] });
  const locked = rowWith(3, 'a')!;
  expect(locked).toMatchObject({ locked: true, schedule_version: 1 });
  return { locked: { ...locked }, partner: membersOf(locked).find((id) => id !== 'a')!, room: room.roomNumber };
}

function expectLockedKept(live: Live): void {
  const row = world.matches.find((m) => m.id === live.locked.id)!;
  expect(row).toMatchObject({ status: 'scheduled', locked: true });
  expect(membersOf(row)).toEqual(membersOf(live.locked));
  expect(planned(3).filter((m) => membersOf(m).includes('a'))).toHaveLength(1);
  expect(world.locks).toContainEqual(expect.objectContaining({ round_number: 3, room_number: live.room }));
  const seats = world.seats.filter((s) => s.round_number === 3 && s.room_number === live.room).map((s) => s.user_id).sort();
  expect(seats).toEqual(membersOf(live.locked));
}

beforeEach(() => {
  resetWorld();
  for (const id of PEOPLE) addPerson(id, NAMES[id], 'in_lobby');
});

describe('a locked round-3 pair survives the live event (RF3)', () => {
  it('Start writes the published version: every room of every round, the lock copied', async () => {
    const live = await liveEvent();
    const v1 = JSON.parse(world.versions[0].snapshot) as { rounds: Array<{ round: number; rooms: Array<{ userIds: string[]; locked: boolean }> }> };
    for (const r of v1.rounds) {
      expect(planned(r.round).map((m) => ({ people: membersOf(m), locked: m.locked })).sort((x, y) => x.people.join().localeCompare(y.people.join())))
        .toEqual(r.rooms.map((room) => ({ people: [...room.userIds].sort(), locked: room.locked })).sort((x, y) => x.people.join().localeCompare(y.people.join())));
    }
    expect(live.locked.assignment_source).toBe('auto');
    expectWellFormed();
  });

  it('a late joiner is seated in every round without touching the locked meeting', async () => {
    const live = await liveEvent();
    addPerson('ivy', 'Ivy', 'in_lobby');
    const result = await repairFutureRounds(EVENT, 1, 'late_joiner', new Set([...PEOPLE, 'ivy']));
    expect(result.errors).toEqual([]);
    expect(result.regeneratedRounds.length).toBeGreaterThan(0);
    for (let round = 1; round <= 5; round++) expect(rowWith(round, 'ivy')).not.toBeNull();
    expect(world.versions.at(-1)).toMatchObject({ version: 2, automatic: true, published_by: null, reason: 'late_joiner' });
    expectLockedKept(live);
    expectWellFormed();
  });

  it('a leaver from another room leaves every planned room; the locked meeting is untouched', async () => {
    const live = await liveEvent();
    const leaver = PEOPLE.find((id) => !membersOf(live.locked).includes(id))!;
    world.participants.find((p) => p.user_id === leaver)!.status = 'left';
    await repairFutureRounds(EVENT, 1, 'left');
    for (let round = 1; round <= 5; round++) expect(rowWith(round, leaver)).toBeNull();
    expectLockedKept(live);
    expectWellFormed();
    // Nobody else lost a meeting in any round (seven people: pairs and one trio).
    for (let round = 1; round <= 5; round++) expect(planned(round).flatMap(membersOf)).toHaveLength(7);
  });

  it("the host's Re-match of round 3 keeps the locked meeting and leaves its people out of the engine", async () => {
    const live = await liveEvent();
    // The handler's own steps (handleHostRegenerateMatches): the locked people, the wipe that spares locked rows, and
    // the engine with them left out like the hosts.
    const lockedPeople = await lockedPeopleInRound(EVENT, 3);
    expect(lockedPeople.sort()).toEqual(membersOf(live.locked));
    await query('DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND locked = FALSE', [EVENT, 3]);
    await generateSingleRound(EVENT, 3, [HOST, COHOST, ...lockedPeople], { regenerate: true }, new Set(PEOPLE));
    expectLockedKept(live);
    expect(planned(3).flatMap(membersOf).sort()).toEqual([...PEOPLE].sort());
    expectWellFormed();
  });

  it('the Re-match handler does exactly those steps, and swap and exclude refuse a locked meeting', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../services/orchestration/handlers/matching-flow.ts'), 'utf8');
    const regenerate = source.slice(source.indexOf('export async function handleHostRegenerateMatches'), source.indexOf('export async function handleHostCancelPreview'));
    expect(regenerate).toContain('const lockedPeople = await lockedPeopleInRound(data.sessionId, roundNumber);');
    expect(regenerate.match(/DELETE FROM matches WHERE session_id = \$1 AND round_number = \$2 AND locked = FALSE/g)).toHaveLength(3);
    expect(regenerate).not.toMatch(/DELETE FROM matches WHERE session_id = \$1 AND round_number = \$2`/);
    expect(regenerate).toContain('...lockedPeople]');
    for (const handler of ['handleHostSwapMatch', 'handleHostExcludeFromRound']) {
      const body = source.slice(source.indexOf(`export async function ${handler}`));
      const firstWrite = body.indexOf('await query(');
      expect(body.indexOf('anyMatchLocked(')).toBeGreaterThan(0);
      expect(body.indexOf('anyMatchLocked(')).toBeLessThan(firstWrite);
      expect(body.slice(0, firstWrite)).toContain("socket.emit('error', { code: 'SCHEDULE_LOCKED', message: LOCKED_MATCH_MESSAGE });");
    }
  });

  it('a locked meeting reads as locked to the live swap and exclude guards; an unlocked one does not', async () => {
    const live = await liveEvent();
    const other = planned(3).find((m) => m.id !== live.locked.id)!;
    expect(await anyMatchLocked([other.id, live.locked.id])).toBe(true);
    expect(await anyMatchLocked([other.id])).toBe(false);
    expect(await anyMatchLocked([])).toBe(false);
  });

  it('a host-requested repair keeps the locked meeting', async () => {
    const live = await liveEvent();
    world.participants.find((p) => p.user_id === PEOPLE.find((id) => !membersOf(live.locked).includes(id))!)!.status = 'no_show';
    await repairFutureRounds(EVENT, 1, 'host_request');
    expectLockedKept(live);
    expectWellFormed();
  });

  it('a leaver from the locked meeting: it is flagged, the host is told once, nobody is moved into it', async () => {
    const live = await liveEvent();
    world.participants.find((p) => p.user_id === live.partner)!.status = 'left';
    await repairFutureRounds(EVENT, 1, 'left');

    // The locked meeting keeps its people and its row; nobody new joins it.
    expectLockedKept(live);
    const board = await getBoard(EVENT, OWNER);
    const room = board.rounds[2].rooms.find((r) => r.roomNumber === live.room)!;
    expect(room.locked).toBe(true);
    expect(room.seats.map((s) => s.userId).sort()).toEqual(membersOf(live.locked));
    expect(room.verdict.warnings).toContainEqual({ kind: 'vacancy', userIds: [live.partner] });
    // Every other round lets the leaver go.
    for (const round of [1, 2, 4, 5]) expect(rowWith(round, live.partner)).toBeNull();

    const told = world.emits.filter((e) => e.event === 'host:action_confirmed');
    const summary = `A locked meeting in round 3 lost ${NAMES[live.partner]}.`;
    expect(told.map((e) => e.room).sort()).toEqual([`user:${COHOST}`, `user:${HOST}`]);
    expect(told.every((e) => (e.payload as { summary: string }).summary === summary)).toBe(true);

    // A second repair finds them already gone: the host is not told again.
    await repairFutureRounds(EVENT, 1, 'left');
    expect(world.emits.filter((e) => e.event === 'host:action_confirmed')).toHaveLength(2);
    expectLockedKept(live);
  });
});

describe('12/10: someone late from round 3, published while live', () => {
  it('only the affected rooms change, their rows are rewritten, every other row keeps its id, and only the impacted are rung', async () => {
    const live = await liveEvent();
    const late = PEOPLE.find((id) => !membersOf(live.locked).includes(id))!;
    const before = new Map(world.matches.filter((m) => m.status === 'scheduled').map((m) => [`${m.round_number}|${membersOf(m).join(',')}`, m.id]));
    world.notifications.length = 0;

    await op({ kind: 'mark_late', userId: late, fromRound: 3 });
    const board = await op({ kind: 'redistribute', rounds: [1, 2] });
    const result = await publishSchedule(EVENT, OWNER, board.revision);
    await settle();

    // Rounds 1 and 2 no longer seat them; rounds 3 to 5 still do.
    expect(rowWith(1, late)).toBeNull();
    expect(rowWith(2, late)).toBeNull();
    for (const round of [3, 4, 5]) expect(rowWith(round, late)).not.toBeNull();
    // A room the version kept kept its row; only rooms of rounds 1 and 2 were rewritten.
    const after = world.matches.filter((m) => m.status === 'scheduled');
    let kept = 0;
    for (const m of after) {
      const id = before.get(`${m.round_number}|${membersOf(m).join(',')}`);
      if (id) {
        expect(m.id).toBe(id);
        kept += 1;
      } else {
        expect([1, 2]).toContain(m.round_number);
      }
    }
    expect(kept).toBeGreaterThanOrEqual(after.length - 4);
    for (const round of [3, 4, 5]) {
      for (const m of planned(round)) expect(before.get(`${round}|${membersOf(m).join(',')}`)).toBe(m.id);
    }
    // The impacted are exactly the people whose meetings in rounds 1 and 2 changed, and only they are rung.
    expect(result.impactedUserIds).toContain(late);
    expect(world.notifications.map((n) => n.user_id).sort()).toEqual([...result.impactedUserIds].sort());
    expect(world.notifications.every((n) => n.title === 'Your meetings for Founders Night changed')).toBe(true);
    expectLockedKept(live);
    expectWellFormed();
  });
});

describe('the live event checks what it starts', () => {
  it('a block made after Start: the planned room is not started, every other room is', async () => {
    await liveEvent();
    const target = planned(2).find((m) => !m.locked)!;
    const [x, y] = membersOf(target);
    world.blocks.push([x, y]);
    const cancelled = await refuseBrokenScheduledRooms(EVENT, 2);
    expect(cancelled).toEqual([target.id]);
    expect(world.matches.find((m) => m.id === target.id)!.status).toBe('cancelled');
    expect(planned(2).every((m) => m.id !== target.id)).toBe(true);
  });

  it('a room the engine made live (not from a version) is never read', async () => {
    world.matches.length = 0;
    const engineRow = { round_number: 1, a: 'a', b: 'b' };
    world.blocks.push(['a', 'b']);
    const { addMatch } = require('../../fixtures/schedule-world');
    const row = addMatch(engineRow);
    expect(await refuseBrokenScheduledRooms(EVENT, 1)).toEqual([]);
    expect(world.matches.find((m) => m.id === row.id)!.status).toBe('scheduled');
  });

  it('a round the host changed live is written back to the board as a manual version; nobody is rung for it', async () => {
    await liveEvent();
    // Round 1 starts after the host swapped two people between two rooms in the preview.
    const [r1, r2] = planned(1);
    const [x] = membersOf(r1);
    const [y] = membersOf(r2);
    const swap = (m: LiveMatch, from: string, to: string) => {
      const people = membersOf(m).map((id) => (id === from ? to : id)).sort();
      Object.assign(m, { a: people[0], b: people[1], c: people[2] ?? null });
    };
    swap(r1, x, y);
    swap(r2, y, x);
    for (const m of world.matches) if (m.round_number === 1) m.status = 'active';
    world.session.status = 'round_active';
    world.session.current_round = 1;
    world.notifications.length = 0;
    const versions = world.versions.length;

    await syncRoundIntoSchedule(EVENT, 1, HOST);

    const board = await getBoard(EVENT, OWNER);
    const rooms = board.rounds[0].rooms.map((r) => r.seats.map((s) => s.userId).sort().join(',')).sort();
    expect(rooms).toEqual(world.matches.filter((m) => m.round_number === 1).map((m) => membersOf(m).join(',')).sort());
    expect(world.versions).toHaveLength(versions + 1);
    expect(world.versions.at(-1)).toMatchObject({ automatic: false, published_by: HOST, reason: 'live_edit', impacted_count: 0 });
    expect(world.notifications).toEqual([]);
    expect(board.draftDiffersFromPublished).toBe(false);

    // Written back once: the same round again changes nothing.
    await syncRoundIntoSchedule(EVENT, 1, HOST);
    expect(world.versions).toHaveLength(versions + 1);
  });
});

describe('the live handlers take the board path only for an event with a published version', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../../services', file), 'utf8');

  it('Match People never wipes a published round: it repairs it through the board, keeping locks', () => {
    const source = read('orchestration/handlers/matching-flow.ts');
    const generate = source.slice(source.indexOf('export async function handleHostGenerateMatches'), source.indexOf('export async function handleHostConfirmRound'));
    const boardAt = generate.indexOf('const onBoard = await hasPublishedSchedule(data.sessionId);');
    const wipeAt = generate.indexOf("`DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled'`");
    expect(boardAt).toBeGreaterThan(0);
    expect(boardAt).toBeLessThan(wipeAt);
    expect(generate).toContain("await repairAffectedRounds(data.sessionId, nextRound, {");
    // The published round is shown through the pre-plan branch; without a version that branch reads exactly as before.
    expect(generate).toMatch(/const canSurfacePrePlan = sameMembers && !planRepeatsPriorRound && !planBreaksRules && matchingPolicy !== 'platform_wide' && !onBoard\s+\|\| boardRoundReady;/);
    expect(generate).toContain("boardRoundReady = (await matchingService.getMatchesByRound(data.sessionId, nextRound)).some(m => m.status === 'scheduled');");
  });

  it('a confirmed round is written back to the board after the locks are free, only for a published event', () => {
    const source = read('orchestration/handlers/matching-flow.ts');
    const confirm = source.slice(source.indexOf('export async function handleHostConfirmRound'), source.indexOf('export async function handleHostSwapMatch'));
    expect(confirm).toMatch(/if \(!\(await hasPublishedSchedule\(data\.sessionId\)\)\) return;\s+await withMatchGenerationLock\(data\.sessionId, \(\) => syncRoundIntoSchedule\(data\.sessionId, round, actorId\)\);/);
  });

  it('every round start checks the published rooms first; repairFutureRounds asks before it deletes anything', () => {
    const lifecycle = read('orchestration/handlers/round-lifecycle.ts');
    const transition = lifecycle.slice(lifecycle.indexOf('export async function transitionToRound'));
    expect(transition.indexOf('await refuseBrokenScheduledRooms(sessionId, roundNumber);'))
      .toBeLessThan(transition.indexOf('let matches = (await matchingService.getMatchesByRound(sessionId, roundNumber))'));
    const matching = read('matching/matching.service.ts');
    const repair = matching.slice(matching.indexOf('export async function repairFutureRounds'), matching.indexOf('async function getExistingRounds'));
    expect(repair.indexOf('if (await scheduleLive.hasPublishedSchedule(sessionId))')).toBeLessThan(repair.indexOf('DELETE FROM matches'));
    expect(repair).toContain("WHERE session_id = $1 AND round_number >= $2 AND status = 'scheduled' AND locked = FALSE");
    expect(matching).toContain("WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled') AND locked = FALSE");
  });
});
