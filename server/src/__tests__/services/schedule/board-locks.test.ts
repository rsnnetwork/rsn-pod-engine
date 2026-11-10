// ─── A locked pairing is never lost (10 Nov 2026 spec, Part 2 Task 8; Review Focus 3; 12/09, section 07) ────
//
// A meeting the organiser locked keeps its people and its room number through every generate and redistribute;
// a locked seat keeps its person while the rest of its room refills; marking someone late never empties a locked
// seat, it flags the vacancy; a locked meeting that loses someone is flagged, never silently refilled. Moving,
// swapping or unassigning anyone in a locked meeting or seat is refused until it is unlocked.
// The real board service, checker and engine against fixtures/schedule-world.ts.

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
jest.mock('../../../realtime/emit', () => ({ __esModule: true, getRealtimeIo: () => ({}), emitEntities: jest.fn() }));

import { UserRole, type BoardOp, type ScheduleBoard } from '@rsn/shared';
import { applyBoardOp, generateBoard, getBoard } from '../../../services/schedule/schedule-board.service';
import { EVENT, HOST, addPerson, resetWorld, world } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f'];

const roomOf = (board: ScheduleBoard, round: number, userId: string) =>
  board.rounds[round - 1].rooms.find((r) => r.seats.some((s) => s.userId === userId)) ?? null;
const together = (board: ScheduleBoard, round: number, x: string, y: string) => {
  const room = roomOf(board, round, x);
  return !!room && room.seats.some((s) => s.userId === y);
};

async function op(board: ScheduleBoard, change: BoardOp): Promise<ScheduleBoard> {
  return (await applyBoardOp(EVENT, OWNER, board.revision, change)).board;
}
async function generateAll(board: ScheduleBoard): Promise<ScheduleBoard> {
  return (await generateBoard(EVENT, OWNER, board.revision, 'all')).board;
}

beforeEach(() => {
  resetWorld();
  for (const id of PEOPLE) addPerson(id, `Person ${id.toUpperCase()}`);
});

/** A and B, who the engine did not pair in round 2, made a manual pair in room 50 of round 2, then locked. */
async function lockedManualPair(): Promise<{ board: ScheduleBoard; x: string; y: string }> {
  let board = await generateAll(await getBoard(EVENT, OWNER));
  const x = 'a';
  const y = PEOPLE.find((id) => id !== x && !together(board, 2, x, id))!;
  board = await op(board, { kind: 'unassign', round: 2, userId: x });
  board = await op(board, { kind: 'unassign', round: 2, userId: y });
  board = await op(board, { kind: 'move', round: 2, userId: x, toRoom: 50 });
  board = await op(board, { kind: 'move', round: 2, userId: y, toRoom: 50 });
  board = await op(board, { kind: 'lock_room', round: 2, room: 50 });
  return { board, x, y };
}

describe('locks across regeneration (12/09)', () => {
  it('a locked manual pair in round 2 survives generate(all) three times: same two people, same room number', async () => {
    let { board, x, y } = await lockedManualPair();
    expect(roomOf(board, 2, x)).toMatchObject({ roomNumber: 50, locked: true });
    for (let i = 0; i < 3; i++) {
      board = await generateAll(board);
      const room = board.rounds[1].rooms.find((r) => r.roomNumber === 50)!;
      expect(room.locked).toBe(true);
      expect(room.seats.map((s) => s.userId).sort()).toEqual([x, y].sort());
      expect(room.seats.every((s) => s.source === 'manual')).toBe(true);
      // The locked meeting is avoided in every other round, earlier ones included.
      for (const round of [1, 3, 4, 5]) expect(together(board, round, x, y)).toBe(false);
      // Everyone else in round 2 is still seated, in rooms numbered after the locked one.
      expect(board.rounds[1].basket).toEqual([]);
      expect(board.rounds[1].rooms.filter((r) => r.roomNumber !== 50).every((r) => r.roomNumber > 50)).toBe(true);
    }
    expect(world.locks).toEqual([{ round_number: 2, room_number: 50, locked_by: HOST }]);
    expect(world.audit.filter((r) => r.action === 'schedule.locked')).toHaveLength(1);
  });

  it('a locked seat keeps its person while the room\'s other seat refills', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    const room = board.rounds[0].rooms[0];
    const keeper = room.seats[0].userId;
    board = await op(board, { kind: 'lock_slot', round: 1, userId: keeper });
    for (let i = 0; i < 2; i++) {
      board = await generateAll(board);
      const now = roomOf(board, 1, keeper)!;
      expect(now.roomNumber).toBe(room.roomNumber);
      expect(now.locked).toBe(false);
      expect(now.seats.find((s) => s.userId === keeper)!.slotLocked).toBe(true);
      expect(now.seats).toHaveLength(2);
      expect(board.rounds[0].basket).toEqual([]);
    }
  });

  it('mark_late never empties a locked seat: the meeting keeps them and shows the vacancy', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    const r1 = roomOf(board, 1, 'a')!;
    board = await op(board, { kind: 'lock_room', round: 1, room: r1.roomNumber });
    const r2Partner = roomOf(board, 2, 'a')!.seats.find((s) => s.userId !== 'a')!.userId;
    // Someone who registered after the board was generated waits in every round's basket.
    addPerson('newcomer');
    board = await op(await getBoard(EVENT, OWNER), { kind: 'mark_late', userId: 'a', fromRound: 3 });

    const locked = roomOf(board, 1, 'a')!;
    expect(locked.roomNumber).toBe(r1.roomNumber);
    expect(locked.seats.map((s) => s.userId)).toEqual(r1.seats.map((s) => s.userId));
    expect(locked.seats.find((s) => s.userId === 'a')!.status).toBe('absent');
    expect(locked.verdict.warnings).toContainEqual({ kind: 'vacancy', userIds: ['a'] });

    // Round 2 was not locked: A's seat emptied, A is not waiting in that round, and the newcomer took the open seat.
    expect(roomOf(board, 2, 'a')).toBeNull();
    expect(board.rounds[1].basket.map((p) => p.userId)).not.toContain('a');
    expect(roomOf(board, 2, r2Partner)!.seats.map((s) => s.userId)).toEqual([r2Partner, 'newcomer']);
    // Round 1's locked meeting was not refilled: the newcomer still waits there.
    expect(board.rounds[0].basket.map((p) => p.userId)).toEqual(['newcomer']);
    // From round 3 A is expected again, and still seated.
    expect(roomOf(board, 3, 'a')!.seats.find((s) => s.userId === 'a')!.status).toBe('registered');
    expect(world.absences).toEqual([{ user_id: 'a', kind: 'late', from_round: 1, to_round: 2, created_by: HOST }]);

    // Clearing the absence brings A back to round 2's basket; the locked round-1 seat never moved.
    board = await op(board, { kind: 'clear_absence', userId: 'a' });
    expect(board.rounds[1].basket.map((p) => p.userId)).toContain('a');
    expect(roomOf(board, 1, 'a')!.verdict.warnings.some((w) => w.kind === 'vacancy')).toBe(false);
  });

  it('a locked meeting that loses someone is flagged and never refilled, by redistribute or generate', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    const room = roomOf(board, 1, 'a')!;
    const other = room.seats.find((s) => s.userId !== 'a')!.userId;
    board = await op(board, { kind: 'lock_room', round: 1, room: room.roomNumber });
    world.participants.find((p) => p.user_id === other)!.status = 'removed';
    addPerson('late1');
    board = await op(await getBoard(EVENT, OWNER), { kind: 'redistribute', rounds: [1] });
    board = await generateAll(board);
    const kept = roomOf(board, 1, 'a')!;
    expect(kept.seats.map((s) => s.userId)).toEqual(room.seats.map((s) => s.userId));
    expect(kept.verdict.warnings).toContainEqual({ kind: 'vacancy', userIds: [other] });
    expect(roomOf(board, 1, 'late1')?.roomNumber).not.toBe(room.roomNumber);
  });

  it('moving, swapping or unassigning anyone in a locked meeting or seat is refused until it is unlocked', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    const [locked, open] = board.rounds[0].rooms;
    board = await op(board, { kind: 'lock_room', round: 1, room: locked.roomNumber });
    const inside = locked.seats[0].userId;
    const outside = open.seats[0].userId;
    const refusals: BoardOp[] = [
      { kind: 'unassign', round: 1, userId: inside },
      { kind: 'move', round: 1, userId: inside, toRoom: 70 },
      { kind: 'move', round: 1, userId: outside, toRoom: locked.roomNumber },
      { kind: 'swap', round: 1, userId: outside, withUserId: inside },
    ];
    for (const change of refusals) {
      await expect(applyBoardOp(EVENT, OWNER, board.revision, change)).rejects.toMatchObject({
        statusCode: 409, code: 'SCHEDULE_LOCKED', message: 'This meeting is locked. Unlock it first.',
      });
    }
    board = await op(board, { kind: 'lock_slot', round: 1, userId: outside });
    await expect(applyBoardOp(EVENT, OWNER, board.revision, { kind: 'unassign', round: 1, userId: outside }))
      .rejects.toMatchObject({ code: 'SCHEDULE_LOCKED' });

    board = await op(board, { kind: 'unlock_room', round: 1, room: locked.roomNumber });
    board = await op(board, { kind: 'unassign', round: 1, userId: inside });
    expect(board.rounds[0].basket.map((p) => p.userId)).toEqual([inside]);
    expect(world.audit.filter((r) => r.action === 'schedule.unlocked')).toHaveLength(1);
  });
});

// Controller ruling (fix round 1): Review Focus 3 and spec 07 ("Allow no show and late arrival status. Refill
// vacancies") outrank the brief's "status is not removed". Someone who left or did not come stays listed (labelled),
// is never seated automatically, leaves a flagged vacancy in a locked meeting, and may be seated by hand.
describe('people who left or did not come', () => {
  const setStatus = (id: string, status: string) => { world.participants.find((p) => p.user_id === id)!.status = status; };
  const seatedIn = (board: ScheduleBoard, round: number) => board.rounds[round - 1].rooms.flatMap((r) => r.seats.map((s) => s.userId));

  it('a locked meeting that loses someone who left is flagged and not refilled; they stay seated and listed', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    const room = roomOf(board, 1, 'a')!;
    const leaver = room.seats.find((s) => s.userId !== 'a')!.userId;
    board = await op(board, { kind: 'lock_room', round: 1, room: room.roomNumber });
    setStatus(leaver, 'left');
    addPerson('newcomer');
    board = await op(await getBoard(EVENT, OWNER), { kind: 'redistribute', rounds: 'all' });
    board = await generateAll(board);
    const kept = roomOf(board, 1, 'a')!;
    expect(kept.roomNumber).toBe(room.roomNumber);
    expect(kept.seats.map((s) => s.userId)).toEqual(room.seats.map((s) => s.userId));
    expect(kept.seats.find((s) => s.userId === leaver)!.status).toBe('left');
    expect(kept.verdict.warnings).toContainEqual({ kind: 'vacancy', userIds: [leaver] });
    expect(board.people.find((p) => p.userId === leaver)!.status).toBe('left');
    expect(roomOf(board, 1, 'newcomer')?.roomNumber).not.toBe(room.roomNumber);
  });

  it('people who left or did not come stay in every basket, labelled, and generate and redistribute never seat them', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    setStatus('b', 'left');
    setStatus('c', 'no_show');
    board = await generateAll(await getBoard(EVENT, OWNER));
    for (const round of board.rounds) {
      expect(seatedIn(board, round.roundNumber)).not.toContain('b');
      expect(seatedIn(board, round.roundNumber)).not.toContain('c');
      expect(round.basket.filter((p) => p.userId === 'b' || p.userId === 'c').map((p) => [p.userId, p.status]))
        .toEqual([['b', 'left'], ['c', 'no_show']]);
      // The four still coming are all seated, and the capacity counts only them.
      expect(seatedIn(board, round.roundNumber).sort()).toEqual(['a', 'd', 'e', 'f']);
    }
    board = await op(board, { kind: 'redistribute', rounds: 'all' });
    expect(board.rounds.every((r) => !seatedIn(board, r.roundNumber).includes('b') && !seatedIn(board, r.roundNumber).includes('c'))).toBe(true);
    expect(world.participants.find((p) => p.user_id === 'b')!.status).toBe('left');
  });

  it('an organiser may seat someone who left by hand (a late arrival back), and the room checker still applies', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    setStatus('b', 'left');
    board = await generateAll(await getBoard(EVENT, OWNER));
    const lone = board.rounds[0].rooms[0];
    const partner = lone.seats[0].userId;
    const out = lone.seats[lone.seats.length - 1].userId;
    const remaining = lone.seats.map((s) => s.userId).filter((id) => id !== out);
    board = await op(board, { kind: 'unassign', round: 1, userId: out });
    world.blocks.push(['b', partner]);
    await expect(applyBoardOp(EVENT, OWNER, board.revision, { kind: 'move', round: 1, userId: 'b', toRoom: lone.roomNumber }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SCHEDULE_RULE' });
    world.blocks.length = 0;
    board = await op(board, { kind: 'move', round: 1, userId: 'b', toRoom: lone.roomNumber });
    const room = roomOf(board, 1, 'b')!;
    expect(room.seats.map((s) => s.userId)).toEqual([...remaining, 'b']);
    expect(room.seats.find((s) => s.userId === 'b')).toMatchObject({ status: 'left', source: 'manual' });
    expect(board.rounds[0].basket.map((p) => p.userId)).not.toContain('b');
    // Back in the live event, they are simply present and the gap is gone.
    setStatus('b', 'in_lobby');
    const back = roomOf(await getBoard(EVENT, OWNER), 1, 'b')!;
    expect(back.verdict.warnings.some((w) => w.kind === 'vacancy')).toBe(false);
  });

  it('a locked meeting emptied by deleted accounts keeps its number: generate never gives it to a new room', async () => {
    let board = await generateAll(await getBoard(EVENT, OWNER));
    const room = board.rounds[0].rooms[0];
    board = await op(board, { kind: 'lock_room', round: 1, room: room.roomNumber });
    // Both accounts are deleted for good: their seats go with them (ON DELETE CASCADE), the lock row stays.
    const gone = room.seats.map((s) => s.userId);
    world.seats = world.seats.filter((s) => !gone.includes(s.user_id));
    world.participants = world.participants.filter((p) => !gone.includes(p.user_id));
    for (const id of gone) world.users.delete(id);
    addPerson('n1');
    addPerson('n2');
    board = await generateAll(await getBoard(EVENT, OWNER));
    const locked = board.rounds[0].rooms.find((r) => r.roomNumber === room.roomNumber)!;
    expect(locked).toMatchObject({ locked: true, seats: [] });
    expect(locked.verdict.warnings.map((w) => w.kind)).toContain('vacancy');
    expect(board.rounds[0].rooms.filter((r) => r.roomNumber === room.roomNumber)).toHaveLength(1);
    expect(board.rounds[0].basket).toEqual([]);
    expect(world.seats.filter((s) => s.round_number === 1 && s.room_number === room.roomNumber)).toEqual([]);
  });
});
