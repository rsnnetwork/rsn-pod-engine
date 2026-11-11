// ─── The matching board's edits (10 Nov 2026 spec, Part 2 Task 8; 12/07, section 06 core interactions) ──────
//
// The real board service, the real room checker and the real engine (prepareBoardRoundGenerator through
// generateGroupedRound) run against fixtures/schedule-world.ts, a small fake database that keeps the rows each
// statement touches. What is stored, refused, audited and shown is read back from it.

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

import { GROUP_PRESETS, UserRole, type BoardOp, type ScheduleBoard } from '@rsn/shared';
import { applyBoardOp, generateBoard, getBoard } from '../../../services/schedule/schedule-board.service';
import { COHOST, EVENT, HOST, addPerson, resetWorld, world } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const CO = { userId: COHOST, role: UserRole.MEMBER };

const roomOf = (board: ScheduleBoard, round: number, userId: string) =>
  board.rounds[round - 1].rooms.find((r) => r.seats.some((s) => s.userId === userId)) ?? null;
const membersOf = (board: ScheduleBoard, round: number) =>
  board.rounds[round - 1].rooms.map((r) => r.seats.map((s) => s.userId).sort());
const basketOf = (board: ScheduleBoard, round: number) => board.rounds[round - 1].basket.map((p) => p.userId);

async function generated(rounds: number[] | 'all' = 'all'): Promise<ScheduleBoard> {
  const before = await getBoard(EVENT, OWNER);
  return (await generateBoard(EVENT, OWNER, before.revision, rounds)).board;
}
async function op(board: ScheduleBoard, change: BoardOp, actor = OWNER) {
  return applyBoardOp(EVENT, actor, board.revision, change);
}
const refusal = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (err) => err);

beforeEach(() => {
  resetWorld();
});

describe('the board before anything is generated', () => {
  it('0 participants: every round is there, empty, with nothing in the basket', async () => {
    const board = await getBoard(EVENT, OWNER);
    expect(board).toMatchObject({ sessionId: EVENT, revision: 0, publishedVersion: null, draftDiffersFromPublished: false, groupRules: null });
    expect(board.rounds.map((r) => [r.roundNumber, r.rooms.length, r.basket.length, r.editable])).toEqual([
      [1, 0, 0, true], [2, 0, 0, true], [3, 0, 0, true], [4, 0, 0, true], [5, 0, 0, true],
    ]);
    // Round 1 starts at the event's start; each later one a round, a rating window and 30 s after.
    expect(board.rounds[0].startsAt).toBe('2026-12-01T18:00:00.000Z');
    expect(board.rounds[1].startsAt).toBe('2026-12-01T18:09:00.000Z');
    const after = (await generateBoard(EVENT, OWNER, 0, 'all')).board;
    expect(after.rounds.every((r) => r.rooms.length === 0 && r.basket.length === 0)).toBe(true);
    expect(world.seats).toEqual([]);
  });

  it('1 participant: they are in every round\'s basket, and generating seats nobody', async () => {
    addPerson('solo', 'Sam Solo');
    const board = await getBoard(EVENT, OWNER);
    expect(board.rounds.map((r) => basketOf(board, r.roundNumber))).toEqual([['solo'], ['solo'], ['solo'], ['solo'], ['solo']]);
    expect(board.rounds[0].basket[0]).toMatchObject({ displayName: 'Sam Solo', status: 'registered', groupKeys: [] });
    const after = await generated();
    expect(after.rounds.every((r) => r.rooms.length === 0 && basketOf(after, r.roundNumber).join() === 'solo')).toBe(true);
  });

  it('the people running the event are never in a basket or a room', async () => {
    addPerson(HOST, 'Hana Host');
    addPerson('a');
    addPerson('b');
    const board = await generated();
    for (const round of board.rounds) {
      expect(round.basket.map((p) => p.userId)).not.toContain(HOST);
      expect(round.rooms.flatMap((r) => r.seats.map((s) => s.userId))).not.toContain(HOST);
    }
    expect(membersOf(board, 1)).toEqual([['a', 'b']]);
  });

  it('only an organiser reads or edits the board; an unknown event is unknown to everyone', async () => {
    addPerson('p1');
    await expect(getBoard(EVENT, { userId: 'p1', role: UserRole.MEMBER })).rejects.toMatchObject({ statusCode: 403 });
    await expect(generateBoard(EVENT, { userId: 'p1', role: UserRole.MEMBER }, 0, 'all')).rejects.toMatchObject({ statusCode: 403 });
    await expect(getBoard('00000000-0000-4000-8000-000000000999', OWNER)).rejects.toMatchObject({ statusCode: 404, message: "We couldn't find that event." });
    expect(world.schedule).toBeNull();
  });

  it('a video meeting has no rounds to plan', async () => {
    world.session.event_format = 'video_meeting';
    await expect(getBoard(EVENT, OWNER)).rejects.toMatchObject({ statusCode: 409, code: 'NOT_A_ROUNDS_EVENT' });
  });
});

describe('generate', () => {
  it('seats everyone in pairs in every round, without repeating a pair, and audits it with the new revision', async () => {
    for (const id of ['a', 'b', 'c', 'd']) addPerson(id);
    world.session.config.numberOfRounds = 3;
    const board = await generated();
    expect(board.revision).toBe(1);
    expect(board.draftDiffersFromPublished).toBe(true);
    const pairs = new Set<string>();
    for (const round of board.rounds) {
      expect(round.basket).toEqual([]);
      expect(round.rooms.map((r) => r.seats.length)).toEqual([2, 2]);
      expect(round.rooms.map((r) => r.roomNumber)).toEqual([1, 2]);
      for (const room of round.rooms) {
        expect(room.verdict.ok).toBe(true);
        expect(room.seats.every((s) => s.source === 'auto' && !s.slotLocked && !s.override)).toBe(true);
        const key = room.seats.map((s) => s.userId).sort().join('+');
        expect(pairs.has(key)).toBe(false);
        pairs.add(key);
      }
    }
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({ actor_id: HOST, action: 'schedule.generated' });
    expect(world.audit[0].details).toMatchObject({ automatic: false, after: { rounds: [1, 2, 3], revision: 1 } });
    expect(world.schedule).toMatchObject({ revision: 1, updated_by: HOST });
    expect(world.schedule!.generated_at).not.toBeNull();
  });

  it('round count lowered from 5 to 4: round 5\'s seats are still shown, then generate clears them', async () => {
    for (const id of ['a', 'b', 'c', 'd']) addPerson(id);
    await generated();
    world.session.config.numberOfRounds = 4;
    const lowered = await getBoard(EVENT, OWNER);
    expect(lowered.rounds).toHaveLength(5);
    expect(lowered.rounds[4]).toMatchObject({ roundNumber: 5, beyondLastRound: true, editable: false, capacity: null });
    expect(lowered.rounds[4].rooms.flatMap((r) => r.seats).length).toBe(4);
    await expect(op(lowered, { kind: 'unassign', round: 5, userId: 'a' })).rejects.toMatchObject({ statusCode: 400 });

    const cleared = (await generateBoard(EVENT, OWNER, lowered.revision, 'all')).board;
    expect(cleared.rounds).toHaveLength(4);
    expect(world.seats.filter((s) => s.round_number === 5)).toEqual([]);
  });
});

describe('edits (12/07)', () => {
  beforeEach(() => {
    for (const id of ['a', 'b', 'c', 'd']) addPerson(id, `Person ${id.toUpperCase()}`);
    world.session.config.numberOfRounds = 2;
  });

  it('a swap across two rooms keeps both people assigned: 4 people in 2 rooms before and after', async () => {
    const board = await generated();
    const [first, second] = board.rounds[0].rooms;
    const a = first.seats[0].userId;
    const b = second.seats[0].userId;
    const { board: after, changed } = await op(board, { kind: 'swap', round: 1, userId: a, withUserId: b });
    expect(after.rounds[0].rooms.map((r) => r.seats.length)).toEqual([2, 2]);
    expect(after.rounds[0].basket).toEqual([]);
    expect(roomOf(after, 1, a)!.roomNumber).toBe(second.roomNumber);
    expect(roomOf(after, 1, b)!.roomNumber).toBe(first.roomNumber);
    expect(roomOf(after, 1, a)!.seats.find((s) => s.userId === a)!.source).toBe('manual');
    expect(changed).toEqual([{ round: 1, userIds: [a, b].sort() }]);
    expect(after.revision).toBe(board.revision + 1);
    expect(world.audit.at(-1)).toMatchObject({ action: 'schedule.edited', details: { round: 1, subjectUserIds: [a, b].sort() } });
  });

  it('a move into an empty seat leaves the old seat empty; a move to a new room number opens that room', async () => {
    const board = await generated();
    const [first, second] = board.rounds[0].rooms;
    const stay = first.seats[0].userId;
    const leaving = first.seats[1].userId;
    let now = (await op(board, { kind: 'unassign', round: 1, userId: leaving })).board;
    expect(roomOf(now, 1, stay)!.seats.map((s) => s.userId)).toEqual([stay]);

    const mover = second.seats[0].userId;
    const alone = second.seats[1].userId;
    now = (await op(now, { kind: 'move', round: 1, userId: mover, toRoom: first.roomNumber })).board;
    expect(roomOf(now, 1, mover)!.seats.map((s) => s.userId)).toEqual([stay, mover]);
    const old = roomOf(now, 1, alone)!;
    expect(old.seats.map((s) => s.userId)).toEqual([alone]);
    expect(old.verdict.warnings).toContainEqual({ kind: 'vacancy', userIds: [alone] });

    now = (await op(now, { kind: 'move', round: 1, userId: alone, toRoom: 9 })).board;
    expect(now.rounds[0].rooms.map((r) => r.roomNumber)).toEqual([first.roomNumber, 9]);
    expect(basketOf(now, 1)).toEqual([leaving]);
  });

  it('unassign puts them in the basket and nothing else: still registered, not checked out, not removed', async () => {
    const board = await generated();
    const a = board.rounds[0].rooms[0].seats[0].userId;
    const after = (await op(board, { kind: 'unassign', round: 1, userId: a })).board;
    expect(after.rounds[0].basket).toEqual([expect.objectContaining({ userId: a, status: 'registered' })]);
    expect(after.people.find((p) => p.userId === a)!.status).toBe('registered');
    expect(roomOf(after, 2, a)).not.toBeNull();
    expect(world.participants.find((p) => p.user_id === a)!.status).toBe('registered');
    expect(world.sql.some((s) => /session_participants/.test(s) && !/^SELECT/.test(s))).toBe(false);
  });

  it('a removed participant\'s seat shows them as not in the event, with the gap flagged, and is not dropped', async () => {
    const board = await generated();
    const gone = board.rounds[0].rooms[0].seats[0].userId;
    world.participants.find((p) => p.user_id === gone)!.status = 'removed';
    const after = await getBoard(EVENT, OWNER);
    const room = roomOf(after, 1, gone)!;
    expect(room.seats.find((s) => s.userId === gone)!.status).toBe('not_in_event');
    expect(room.verdict.warnings).toContainEqual({ kind: 'vacancy', userIds: [gone] });
    expect(basketOf(after, 1)).not.toContain(gone);
    expect(after.people.find((p) => p.userId === gone)!.status).toBe('not_in_event');
    await expect(op(after, { kind: 'move', round: 1, userId: gone, toRoom: 7 })).rejects.toMatchObject({ statusCode: 409, code: 'SCHEDULE_RULE' });
  });

  it('a repeat is allowed and says so', async () => {
    const board = await generated();
    const r1 = board.rounds[0].rooms[0].seats.map((s) => s.userId);
    // Seat round 2's first person with their round-1 partner: they met in round 1.
    const [x, y] = r1;
    let now = (await op(board, { kind: 'unassign', round: 2, userId: y })).board;
    const xRoom = roomOf(now, 2, x)!;
    if (xRoom.seats.length > 1) now = (await op(now, { kind: 'unassign', round: 2, userId: xRoom.seats.find((s) => s.userId !== x)!.userId })).board;
    now = (await op(now, { kind: 'move', round: 2, userId: y, toRoom: xRoom.roomNumber })).board;
    expect(roomOf(now, 2, y)!.verdict).toMatchObject({ ok: true });
    expect(roomOf(now, 2, y)!.verdict.warnings).toContainEqual({ kind: 'repeat', userIds: [x, y] });
  });

  it('a started round is not edited; a live event\'s later rounds are', async () => {
    const board = await generated();
    world.session.status = 'round_active';
    world.session.current_round = 1;
    const live = await getBoard(EVENT, OWNER);
    expect(live.rounds.map((r) => r.editable)).toEqual([false, true]);
    const a = live.rounds[0].rooms[0].seats[0].userId;
    await expect(op(live, { kind: 'unassign', round: 1, userId: a })).rejects.toMatchObject({
      statusCode: 409, code: 'SCHEDULE_ROUND_STARTED', message: 'This round has already started.',
    });
    await expect(op(live, { kind: 'unassign', round: 2, userId: a })).resolves.toMatchObject({ changed: [{ round: 2, userIds: [a] }] });
    expect(board.revision).toBe(1);
  });

  it('an ended event\'s board is read-only', async () => {
    const board = await generated();
    world.session.status = 'completed';
    await expect(op(board, { kind: 'redistribute', rounds: 'all' })).rejects.toMatchObject({ statusCode: 409, code: 'EVENT_ENDED' });
    expect((await getBoard(EVENT, OWNER)).rounds.every((r) => !r.editable)).toBe(true);
  });

  it('a change that changes nothing writes nothing and keeps the revision', async () => {
    const board = await generated();
    const auditRows = world.audit.length;
    const room = board.rounds[0].rooms[0];
    const result = await op(board, { kind: 'move', round: 1, userId: room.seats[0].userId, toRoom: room.roomNumber });
    expect(result).toMatchObject({ changed: [], board: { revision: board.revision } });
    expect(world.audit).toHaveLength(auditRows);
  });
});

describe('a group-rule refusal (founders meet funders)', () => {
  beforeEach(() => {
    world.rules = { ...GROUP_PRESETS.founders_funders, rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }] };
    for (const [id, name, group] of [['f1', 'Fay', 'founder'], ['f2', 'Finn', 'founder'], ['f3', 'Flo', 'founder'],
      ['u1', 'Uma', 'funder'], ['u2', 'Ugo', 'funder'], ['u3', 'Una', 'funder']]) {
      addPerson(id, name);
      world.groups.set(id, [group]);
    }
    world.session.config.numberOfRounds = 1;
  });

  it('says who cannot meet and why, and offers the rooms they may join and the basket', async () => {
    let board = await generated();
    expect(board.rounds[0].rooms.every((r) => r.verdict.ok && r.seats.length === 2)).toBe(true);
    expect(board.rounds[0].capacity).toMatchObject({ round: 1, maxMeetings: 3 });
    board = (await op(board, { kind: 'unassign', round: 1, userId: 'f3' })).board;
    const lonely = roomOf(board, 1, 'u3')!.roomNumber;
    const target = roomOf(board, 1, 'f1')!.roomNumber;

    const err = await refusal(op(board, { kind: 'move', round: 1, userId: 'f3', toRoom: target }));
    expect(err).toMatchObject({ statusCode: 409, code: 'SCHEDULE_GROUP_RULE' });
    expect(err.message).toMatch(/^Flo and Fay can't meet in this round: /);
    expect(err.details.alternatives).toEqual([
      { room: lonely, note: `Room ${lonely}, with Una` },
      { room: 0, note: 'Leave them in the basket' },
    ]);
    expect(world.seats.find((s) => s.user_id === 'f3')).toBeUndefined();
  });

  it('a co-host may not override it; the event owner may, and the seat and the audit row say so', async () => {
    let board = await generated();
    board = (await op(board, { kind: 'unassign', round: 1, userId: 'f3' })).board;
    const target = roomOf(board, 1, 'f1')!.roomNumber;
    const move: BoardOp = { kind: 'move', round: 1, userId: 'f3', toRoom: target, override: true, reason: 'They co-founded a fund' };
    await expect(op(board, move, CO)).rejects.toMatchObject({
      statusCode: 403, code: 'GROUP_OVERRIDE_FORBIDDEN', message: "Only the event's owner can override group rules.",
    });
    const after = (await op(board, move)).board;
    const room = roomOf(after, 1, 'f3')!;
    expect(room.seats.find((s) => s.userId === 'f3')).toMatchObject({ override: true, source: 'manual' });
    expect(room.verdict.ok).toBe(true);
    expect(room.verdict.warnings.map((w) => w.kind)).toContain('override');
    expect(world.audit.at(-1)).toMatchObject({ action: 'schedule.edited', details: { reason: 'They co-founded a fund', after: { override: true } } });
    expect(after.canOverride).toBe(true);
    expect((await getBoard(EVENT, CO)).canOverride).toBe(false);
  });

  // Part 3 Task 12: the owner may let the event's co-hosts override too (event_matching_rules.override_by).
  it("with the owner's 'owner and co-hosts', a co-host's override goes ahead and is audited; a pod director who is not a co-host is still refused", async () => {
    world.overrideBy = 'owner_and_cohosts';
    const DIRECTOR = { userId: 'director', role: UserRole.MEMBER };
    world.users.set('director', { display_name: 'Dee Director', role: 'member', status: 'active' });
    world.organisers.add('director');
    let board = await generated();
    board = (await op(board, { kind: 'unassign', round: 1, userId: 'f3' })).board;
    const target = roomOf(board, 1, 'f1')!.roomNumber;
    const move: BoardOp = { kind: 'move', round: 1, userId: 'f3', toRoom: target, override: true, reason: 'Same fund' };

    await expect(op(board, move, DIRECTOR)).rejects.toMatchObject({
      statusCode: 403, code: 'GROUP_OVERRIDE_FORBIDDEN', message: "Only the event's owner and co-hosts can override group rules.",
    });
    expect((await getBoard(EVENT, DIRECTOR)).canOverride).toBe(false);
    expect((await getBoard(EVENT, CO)).canOverride).toBe(true);

    const after = (await op(board, move, CO)).board;
    expect(roomOf(after, 1, 'f3')!.seats.find((s) => s.userId === 'f3')).toMatchObject({ override: true, source: 'manual' });
    expect(world.audit.at(-1)).toMatchObject({
      actor_id: COHOST, action: 'schedule.edited', details: { reason: 'Same fund', after: { override: true } },
    });
  });

  it("the owner switching back to 'owner' takes it from the co-hosts at once (403 GROUP_OVERRIDE_FORBIDDEN)", async () => {
    world.overrideBy = 'owner_and_cohosts';
    let board = await generated();
    board = (await op(board, { kind: 'unassign', round: 1, userId: 'f3' })).board;
    const target = roomOf(board, 1, 'f1')!.roomNumber;
    world.overrideBy = 'owner';
    await expect(op(board, { kind: 'move', round: 1, userId: 'f3', toRoom: target, override: true }, CO))
      .rejects.toMatchObject({ statusCode: 403, code: 'GROUP_OVERRIDE_FORBIDDEN', message: "Only the event's owner can override group rules." });
    expect((await getBoard(EVENT, CO)).canOverride).toBe(false);
    expect((await getBoard(EVENT, OWNER)).canOverride).toBe(true);
  });

  it('a block is never overridden', async () => {
    world.blocks.push(['f3', 'u1']);
    let board = await generated();
    board = (await op(board, { kind: 'unassign', round: 1, userId: 'f3' })).board;
    const err = await refusal(op(board, { kind: 'move', round: 1, userId: 'f3', toRoom: roomOf(board, 1, 'u1')!.roomNumber, override: true }));
    expect(err).toMatchObject({ statusCode: 409, code: 'SCHEDULE_RULE' });
    expect(err.message).toBe("Flo and Uma can't be in the same meeting.");
  });

  it('a meeting holds at most three people', async () => {
    world.rules = null;
    let board = await generated();
    const [first, second] = board.rounds[0].rooms;
    board = (await op(board, { kind: 'move', round: 1, userId: second.seats[0].userId, toRoom: first.roomNumber })).board;
    const err = await refusal(op(board, { kind: 'move', round: 1, userId: second.seats[1].userId, toRoom: first.roomNumber }));
    expect(err).toMatchObject({ statusCode: 409, code: 'SCHEDULE_RULE', message: 'A meeting holds at most three people.' });
  });
});
