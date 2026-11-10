// ─── Organisers and participants changing things at once (10 Nov 2026 spec, Part 2 Task 8; Review Focus 5) ───
//
// Two organisers drag on the same board, a participant registers or is regrouped while an organiser edits.
// Expected: no lost update (the event's schedule row is locked and its revision compared: the second write made
// against the same revision is refused with 409 SCHEDULE_CHANGED and the board as it is now), nobody in two rooms,
// new people appear in the basket, a regrouped person's room shows the rule problem instead of moving, and the
// private draft is told to the people running the event only.
//
// fixtures/schedule-world.ts models Postgres' row lock (SELECT ... FOR UPDATE waits for the holder to commit) and
// lets every statement yield, so two writes really interleave; with `honourLocks: false` the same race loses an
// update, which shows the harness sees the race and the lock is what prevents it.

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
const mockEmitEntities = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => ({}),
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
}));

import { GROUP_PRESETS, UserRole, type ScheduleBoard } from '@rsn/shared';
import { applyBoardOp, generateBoard, getBoard } from '../../../services/schedule/schedule-board.service';
import { COHOST, EVENT, HOST, addPerson, resetWorld, world } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const CO = { userId: COHOST, role: UserRole.MEMBER };

const roomOf = (board: ScheduleBoard, round: number, userId: string) =>
  board.rounds[round - 1].rooms.find((r) => r.seats.some((s) => s.userId === userId)) ?? null;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function generated(): Promise<ScheduleBoard> {
  return (await generateBoard(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, 'all')).board;
}

/** Nobody is stored twice in a round (the UNIQUE the migration declares, checked on what was written). */
function expectNobodyTwiceInARound(): void {
  const keys = world.seats.map((s) => `${s.round_number}:${s.user_id}`);
  expect(new Set(keys).size).toBe(keys.length);
}

beforeEach(() => {
  resetWorld();
  mockEmitEntities.mockReset();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) addPerson(id, `Person ${id.toUpperCase()}`);
  world.session.config.numberOfRounds = 3;
});

describe('two organisers on one board', () => {
  it('the same revision twice: exactly one write lands, the other is refused with the winner\'s board', async () => {
    const board = await generated();
    const [first, second] = board.rounds[0].rooms;
    const x = first.seats[0].userId;
    const y = second.seats[0].userId;
    const results = await Promise.allSettled([
      applyBoardOp(EVENT, OWNER, board.revision, { kind: 'unassign', round: 1, userId: x }),
      applyBoardOp(EVENT, CO, board.revision, { kind: 'move', round: 1, userId: y, toRoom: 40 }),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof applyBoardOp>>> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({
      statusCode: 409, code: 'SCHEDULE_CHANGED',
      message: 'The board changed while you were editing. It is up to date now; try again.',
    });
    const current = lost[0].reason.details.board as ScheduleBoard;
    expect(current.revision).toBe(board.revision + 1);
    // The board the loser is sent is the winner's (canOverride is about who reads it, so it is left out).
    expect({ ...current, canOverride: null }).toEqual({ ...won[0].value.board, canOverride: null });
    expect(world.schedule!.revision).toBe(board.revision + 1);
    expect(world.audit.filter((r) => r.action === 'schedule.edited')).toHaveLength(1);
    expectNobodyTwiceInARound();

    // The refused organiser tries again on the board they were sent, and it lands.
    const retry = await applyBoardOp(EVENT, CO, current.revision, { kind: 'move', round: 1, userId: y, toRoom: 40 });
    expect(retry.board.revision).toBe(board.revision + 2);
  });

  it('without the row lock the same race gets past the revision check: the harness sees it', async () => {
    const board = await generated();
    world.honourLocks = false;
    const [first, second] = board.rounds[0].rooms;
    const results = await Promise.allSettled([
      applyBoardOp(EVENT, OWNER, board.revision, { kind: 'unassign', round: 1, userId: first.seats[0].userId }),
      applyBoardOp(EVENT, CO, board.revision, { kind: 'unassign', round: 1, userId: second.seats[0].userId }),
    ]);
    // Both read the same revision, so neither is told the board changed; the two rewrites of round 1 collide and
    // only the UNIQUE seat constraint stops the second, with a raw database error instead of the current board.
    const refusedAsStale = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'SCHEDULE_CHANGED');
    expect(refusedAsStale).toHaveLength(0);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(String(failed[0].reason)).toMatch(/duplicate key value violates unique constraint/);
  });

  it('a stale generate is refused too, and a write against an older revision never lands', async () => {
    const board = await generated();
    await applyBoardOp(EVENT, OWNER, board.revision, { kind: 'unassign', round: 2, userId: 'a' });
    await expect(generateBoard(EVENT, CO, board.revision, 'all')).rejects.toMatchObject({ code: 'SCHEDULE_CHANGED' });
    await expect(applyBoardOp(EVENT, CO, 0, { kind: 'redistribute', rounds: 'all' })).rejects.toMatchObject({ code: 'SCHEDULE_CHANGED' });
    expect((await getBoard(EVENT, OWNER)).rounds[1].basket.map((p) => p.userId)).toEqual(['a']);
  });
});

describe('participants changing while an organiser edits', () => {
  it('someone who registers between two reads is in every round\'s basket, and the organiser\'s next write still lands', async () => {
    const board = await generated();
    addPerson('late', 'Lee Late');
    const read = await getBoard(EVENT, OWNER);
    expect(read.revision).toBe(board.revision);
    expect(read.rounds.map((r) => r.basket.map((p) => p.userId))).toEqual([['late'], ['late'], ['late']]);
    expect(read.people.map((p) => p.userId)).toContain('late');
    const after = await applyBoardOp(EVENT, OWNER, board.revision, { kind: 'redistribute', rounds: 'all' });
    for (const round of after.board.rounds) {
      expect(round.basket).toEqual([]);
      expect(roomOf(after.board, round.roundNumber, 'late')!.seats.length).toBe(3);
    }
    expectNobodyTwiceInARound();
  });

  it('an organiser regrouping someone makes their room break the rule where it stands; nobody is moved', async () => {
    world.rules = { ...GROUP_PRESETS.founders_funders, rounds: [{ fromRound: 1, toRound: 3, mode: 'cross_group', allowedPairs: [] }] };
    for (const [id, group] of [['a', 'founder'], ['b', 'founder'], ['c', 'founder'], ['d', 'funder'], ['e', 'funder'], ['f', 'funder']]) {
      world.groups.set(id, [group]);
    }
    const board = await generated();
    const room = roomOf(board, 1, 'a')!;
    expect(room.verdict.ok).toBe(true);
    const partner = room.seats.find((s) => s.userId !== 'a')!.userId;
    const seatsBefore = JSON.stringify(world.seats);

    world.groups.set(partner, ['founder']);
    const after = await getBoard(EVENT, OWNER);
    const same = roomOf(after, 1, 'a')!;
    expect(same.roomNumber).toBe(room.roomNumber);
    expect(same.seats.map((s) => s.userId)).toEqual(room.seats.map((s) => s.userId));
    expect(same.verdict.ok).toBe(false);
    const problem = same.verdict.problems.find((p) => p.kind === 'group_rule')!;
    expect([...problem.userIds].sort()).toEqual(['a', partner].sort());
    expect(after.revision).toBe(board.revision);
    expect(JSON.stringify(world.seats)).toBe(seatsBefore);
  });
});

describe('who is told', () => {
  it('a draft edit tells the host and co-hosts on session:<id>:schedule; no participant is told anything', async () => {
    const board = await generated();
    await flush();
    mockEmitEntities.mockReset();
    await applyBoardOp(EVENT, OWNER, board.revision, { kind: 'unassign', round: 1, userId: 'a' });
    for (let i = 0; i < 5; i++) await flush();
    const calls = mockEmitEntities.mock.calls as Array<[unknown, string[], string[]]>;
    const scheduleCalls = calls.filter(([, , tags]) => tags.includes(`session:${EVENT}:schedule`));
    expect(scheduleCalls).toHaveLength(1);
    expect([...scheduleCalls[0][1]].sort()).toEqual([COHOST, HOST].sort());
    const participants = world.participants.map((p) => p.user_id);
    for (const [, recipients] of calls) {
      for (const id of recipients) expect(participants).not.toContain(id);
    }
    // The organisers' history is told too (the audit row), to the same people.
    expect(calls.some(([, , tags]) => tags.includes(`session:${EVENT}:audit`))).toBe(true);
  });

  it('a read tells nobody, and a write that changes nothing tells nobody', async () => {
    const board = await generated();
    await flush();
    mockEmitEntities.mockReset();
    await getBoard(EVENT, OWNER);
    await applyBoardOp(EVENT, OWNER, board.revision, { kind: 'unlock_room', round: 1, room: 99 });
    for (let i = 0; i < 5; i++) await flush();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });
});
