// ─── Live repairs start from the published version; the draft stays private (Part 2 Task 9, fix round 1) ───────
//
// Spec 07: "Draft changes stay private until saved or published" and "recalculate only affected unlocked
// assignments". A late joiner or a leaver while an organiser has unpublished edits on the board: the automatic
// version is the published one with only the affected rooms changed; the organiser's edit stays in the draft and
// unpublished; where the draft had its own changes in a room the live event changed, the draft keeps them and the
// board flags the round until the next publish. A confirmed round written back publishes only what the live room
// changed. Also: a late materialise never writes an older version over a newer one; a version that only removes rooms
// tells the plan screens; a failed "is there a version?" read abandons the repair instead of taking today's path; a
// planned room refused at write time or at round start is told to the host.
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

import { UserRole, type BoardOp, type ScheduleBoard, type ScheduleSnapshot } from '@rsn/shared';
import { repairFutureRounds } from '../../../services/matching/matching.service';
import { withMatchGenerationLock } from '../../../services/orchestration/state/session-state';
import { applyBoardOp, generateBoard, getBoard } from '../../../services/schedule/schedule-board.service';
import { publishSchedule } from '../../../services/schedule/schedule-publish.service';
import {
  materialisePublished, materialiseRounds, refuseBrokenScheduledRooms, syncRoundIntoSchedule,
} from '../../../services/schedule/schedule-live.service';
import { COHOST, EVENT, HOST, addPerson, resetWorld, world, type LiveMatch } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const NAMES: Record<string, string> = { a: 'Ann', b: 'Ben', c: 'Cat', d: 'Dev', e: 'Eve', f: 'Fay', g: 'Gus', h: 'Hal' };

const membersOf = (m: LiveMatch) => [m.a, m.b, m.c].filter((id): id is string => !!id).sort();
const planned = (round: number) => world.matches.filter((m) => m.round_number === round && m.status === 'scheduled');
const key = (ids: string[]) => [...ids].sort().join(',');
const latest = (): ScheduleSnapshot => JSON.parse([...world.versions].sort((x, y) => y.version - x.version)[0].snapshot);
const roomsIn = (s: ScheduleSnapshot, round: number) => s.rounds[round - 1].rooms.filter((r) => r.userIds.length > 0).map((r) => key(r.userIds)).sort();
const boardRooms = (b: ScheduleBoard, round: number) => b.rounds[round - 1].rooms.filter((r) => r.seats.length > 0).map((r) => key(r.seats.map((s) => s.userId))).sort();
const partnersIn = (s: ScheduleSnapshot, round: number, id: string) =>
  (s.rounds[round - 1].rooms.find((r) => r.userIds.includes(id))?.userIds ?? []).filter((x) => x !== id);

async function op(change: BoardOp): Promise<ScheduleBoard> {
  return (await applyBoardOp(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, change)).board;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Eight people, every round generated, version 1 published, the event started with everyone there. */
async function liveEvent(): Promise<void> {
  const board = (await generateBoard(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, 'all')).board;
  await publishSchedule(EVENT, OWNER, board.revision);
  world.session.status = 'lobby_open';
  world.session.current_round = 0;
  await materialisePublished(EVENT, { presentUserIds: new Set(PEOPLE), hostIds: [HOST, COHOST] });
}

/** The planned rooms of every round equal a version's rooms of two or more. */
function expectMatchesFollow(s: ScheduleSnapshot): void {
  for (const r of s.rounds) {
    expect(planned(r.round).map((m) => key(membersOf(m))).sort())
      .toEqual(r.rooms.filter((room) => room.userIds.length >= 2).map((room) => key(room.userIds)).sort());
  }
}

beforeEach(() => {
  resetWorld();
  for (const id of PEOPLE) addPerson(id, NAMES[id], 'in_lobby');
});

describe('an automatic repair never publishes the organisers\' unpublished edits', () => {
  it('a leaver while an organiser has a pending swap: the swap stays in the draft and unpublished; only the affected rooms change', async () => {
    await liveEvent();
    const v1 = latest();
    // The organiser swaps two people of round 5 on the board, and does not publish.
    const board = await getBoard(EVENT, OWNER);
    const [r1, r2] = board.rounds[4].rooms;
    const swapped = await op({ kind: 'swap', round: 5, userId: r1.seats[0].userId, withUserId: r2.seats[0].userId });
    const pending = boardRooms(swapped, 5);
    expect(pending).not.toEqual(roomsIn(v1, 5));

    // Someone who is in neither swapped room of round 5 leaves.
    const swappedPeople = new Set([...r1.seats, ...r2.seats].map((s) => s.userId));
    const leaver = PEOPLE.find((id) => !swappedPeople.has(id))!;
    world.participants.find((p) => p.user_id === leaver)!.status = 'left';
    await repairFutureRounds(EVENT, 1, 'left');

    const v2 = latest();
    expect(world.versions.at(-1)).toMatchObject({ version: 2, automatic: true, reason: 'left', published_by: null });
    for (let round = 1; round <= 5; round++) {
      const before = roomsIn(v1, round);
      const after = roomsIn(v2, round);
      // The leaver is gone; the organiser's unpublished swap is not in the version.
      expect(after.join('|')).not.toContain(leaver);
      const partners = partnersIn(v1, round, leaver);
      const added = after.filter((r) => !before.includes(r));
      const removed = before.filter((r) => !after.includes(r));
      // Only the leaver's room and the room their partner joined changed.
      expect(removed.length).toBeLessThanOrEqual(2);
      expect(added.length).toBeLessThanOrEqual(1);
      for (const room of added) expect(partners.some((p) => room.split(',').includes(p))).toBe(true);
      for (const room of removed) {
        const people = room.split(',');
        expect(people.includes(leaver) || added.some((a) => people.every((p) => a.split(',').includes(p)))).toBe(true);
      }
    }
    // The draft still has the swap, unpublished, and took the repair everywhere else.
    const draft = await getBoard(EVENT, OWNER);
    expect(draft.draftDiffersFromPublished).toBe(true);
    for (const round of [1, 2, 3, 4]) expect(boardRooms(draft, round)).toEqual(roomsIn(v2, round));
    const r5 = boardRooms(draft, 5);
    expect(r5).not.toEqual(roomsIn(v2, 5));
    // Round 5 took the repair when it touched other rooms than the swap; when the leaver's partner joined one of the
    // swapped rooms, the draft kept its own and the board flags round 5.
    const repaired = roomsIn(v2, 5).filter((r) => !roomsIn(v1, 5).includes(r));
    if (!repaired.every((room) => r5.includes(room))) {
      expect(draft.liveConflicts.map((c) => c.round)).toEqual([5]);
      expect(r5).toEqual(pending);
    } else {
      expect(draft.liveConflicts).toEqual([]);
    }
    expectMatchesFollow(v2);
  });

  it('where the draft changed the same room, the draft keeps its own and the board flags the round until a publish', async () => {
    await liveEvent();
    const v1 = latest();
    const leaver = 'a';
    const partner = partnersIn(v1, 4, leaver)[0];
    // The organiser takes the leaver's round-4 partner out of their meeting, and does not publish.
    await op({ kind: 'unassign', round: 4, userId: partner });
    world.participants.find((p) => p.user_id === leaver)!.status = 'left';
    await repairFutureRounds(EVENT, 1, 'left');

    const v2 = latest();
    // The version seats the partner again in round 4; the draft keeps the organiser's choice (the partner waiting).
    expect(v2.rounds[3].rooms.some((r) => r.userIds.includes(partner))).toBe(true);
    let board = await getBoard(EVENT, OWNER);
    expect(board.rounds[3].basket.map((p) => p.userId)).toContain(partner);
    expect(board.liveConflicts).toEqual([expect.objectContaining({ round: 4, room: null, message: expect.stringContaining('The live event changed round 4') })]);
    expect(board.liveConflicts[0].message).toContain(NAMES[partner]);
    // The publish preview shows it first.
    const { previewPublish } = await import('../../../services/schedule/schedule-publish.service');
    expect((await previewPublish(EVENT, OWNER)).warnings[0]).toEqual(board.liveConflicts[0]);

    // An organiser's publish settles it.
    board = await op({ kind: 'redistribute', rounds: [4] });
    await publishSchedule(EVENT, OWNER, board.revision);
    expect((await getBoard(EVENT, OWNER)).liveConflicts).toEqual([]);
  });

  it('a confirmed round written back publishes only what the live room changed, as the confirming host', async () => {
    await liveEvent();
    const v1 = latest();
    // Another organiser's pending edit in round 3.
    const board = await getBoard(EVENT, OWNER);
    const [p1, p2] = board.rounds[2].rooms;
    await applyBoardOp(EVENT, { userId: COHOST, role: UserRole.MEMBER }, board.revision,
      { kind: 'swap', round: 3, userId: p1.seats[0].userId, withUserId: p2.seats[0].userId });
    // Round 1 starts after the host swapped two people live.
    const [m1, m2] = planned(1);
    const x = membersOf(m1)[0];
    const y = membersOf(m2)[0];
    const swapIn = (m: LiveMatch, from: string, to: string) => {
      const people = membersOf(m).map((id) => (id === from ? to : id)).sort();
      Object.assign(m, { a: people[0], b: people[1], c: people[2] ?? null });
    };
    swapIn(m1, x, y);
    swapIn(m2, y, x);
    for (const m of world.matches) if (m.round_number === 1) m.status = 'active';
    world.session.status = 'round_active';
    world.session.current_round = 1;

    await syncRoundIntoSchedule(EVENT, 1, HOST);

    const v2 = latest();
    expect(world.versions.at(-1)).toMatchObject({ version: 2, automatic: false, published_by: HOST, reason: 'live_edit' });
    expect(roomsIn(v2, 1)).toEqual(world.matches.filter((m) => m.round_number === 1).map((m) => key(membersOf(m))).sort());
    // Every other round is exactly version 1: the co-host's pending swap was not published.
    for (const round of [2, 3, 4, 5]) expect(roomsIn(v2, round)).toEqual(roomsIn(v1, round));
    const draft = await getBoard(EVENT, OWNER);
    expect(boardRooms(draft, 1)).toEqual(roomsIn(v2, 1));
    expect(boardRooms(draft, 3)).not.toEqual(roomsIn(v2, 3));
    expect(draft.draftDiffersFromPublished).toBe(true);
  });
});

describe('the live matches always follow the newest version', () => {
  it('an older version is never written over a newer one', async () => {
    await liveEvent();
    addPerson('ivy', 'Ivy', 'in_lobby');
    await repairFutureRounds(EVENT, 1, 'late_joiner', new Set([...PEOPLE, 'ivy']));
    expect(world.versions.length).toBeGreaterThanOrEqual(2);
    const before = world.matches.map((m) => ({ ...m }));
    const written = await materialiseRounds(EVENT, 1, 1, { onlyChangedRooms: true });
    expect(written).toEqual({ changedRooms: [], changedRounds: [], refusedRooms: [] });
    expect(world.matches).toEqual(before);
  });

  it('the race: an organiser publishes while a repair holds the lock; the repair\'s newer version stays in the live matches', async () => {
    await liveEvent();
    let release!: () => void;
    const held = withMatchGenerationLock(EVENT, () => new Promise<void>((resolve) => { release = resolve; }));
    const board = await op({ kind: 'swap', round: 4, userId: (await getBoard(EVENT, OWNER)).rounds[3].rooms[0].seats[0].userId, withUserId: (await getBoard(EVENT, OWNER)).rounds[3].rooms[1].seats[0].userId });
    const publishing = publishSchedule(EVENT, OWNER, board.revision);
    while (world.versions.length < 2) await settle();
    // While the organiser's materialise waits for the lock, a late joiner's repair (which runs under the held lock)
    // publishes a newer version and writes it.
    addPerson('ivy', 'Ivy', 'in_lobby');
    await repairFutureRounds(EVENT, 1, 'late_joiner', new Set([...PEOPLE, 'ivy']));
    expect(world.versions.length).toBe(3);
    release();
    await held;
    await publishing;
    await settle();
    expectMatchesFollow(latest());
    for (let round = 1; round <= 5; round++) expect(planned(round).flatMap(membersOf)).toContain('ivy');
  });

  it('a version that only removes a room tells the plan screens', async () => {
    await liveEvent();
    const board = await getBoard(EVENT, OWNER);
    const room = board.rounds[3].rooms[0];
    for (const s of room.seats) await op({ kind: 'unassign', round: 4, userId: s.userId });
    world.emits.length = 0;
    await publishSchedule(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision);
    await settle();
    expect(planned(4).some((m) => key(membersOf(m)) === key(room.seats.map((s) => s.userId)))).toBe(false);
    expect(world.emits).toContainEqual({
      room: `session:${EVENT}`, event: 'host:event_plan_repaired', payload: expect.objectContaining({ regeneratedRounds: [4] }),
    });
  });

  it('a repair that only removes rooms answers those rounds, so its callers tell the plan screens', async () => {
    await liveEvent();
    // Ann's round-2 partner cannot be seated again: blocked with everyone else.
    const v1 = latest();
    const partner = partnersIn(v1, 2, 'a')[0];
    for (const other of PEOPLE) if (other !== partner) world.blocks.push([partner, other]);
    world.participants.find((p) => p.user_id === 'a')!.status = 'left';
    const result = await repairFutureRounds(EVENT, 2, 'left');
    expect(result.regeneratedRounds).toContain(2);
  });
});

describe('a failed read never runs an event with a published schedule down today\'s path', () => {
  it('the repair is abandoned: it throws, and no planned match is deleted or regenerated', async () => {
    await liveEvent();
    const before = world.matches.map((m) => ({ ...m }));
    world.failVersionRead = true;
    world.sql.length = 0;
    await expect(repairFutureRounds(EVENT, 1, 'left')).rejects.toThrow('Connection terminated unexpectedly');
    expect(world.sql.some((s) => /^DELETE FROM matches/.test(s) || /^INSERT INTO matches/.test(s))).toBe(false);
    expect(world.matches).toEqual(before);
  });
});

describe('the host is told about planned meetings that cannot happen', () => {
  it('a room refused when its round starts: the host and co-host read who and which round', async () => {
    await liveEvent();
    const target = planned(2)[0];
    const [x, y] = membersOf(target);
    world.blocks.push([x, y]);
    world.emits.length = 0;
    await refuseBrokenScheduledRooms(EVENT, 2);
    const told = world.emits.filter((e) => e.event === 'host:action_confirmed');
    expect(told.map((e) => e.room).sort()).toEqual([`user:${COHOST}`, `user:${HOST}`]);
    expect((told[0].payload as { summary: string }).summary)
      .toBe(`Round 2: ${[NAMES[x], NAMES[y]].join(' and ')} can't meet now, so their meeting was not started.`);
  });

  it('a room refused when a version is written: the host is told it was not set up', async () => {
    const board = (await generateBoard(EVENT, OWNER, 0, 'all')).board;
    await publishSchedule(EVENT, OWNER, board.revision);
    const room = latest().rounds[2].rooms[0];
    world.blocks.push([room.userIds[0], room.userIds[1]]);
    world.session.status = 'lobby_open';
    world.emits.length = 0;
    await materialiseRounds(EVENT, 1, 1, { onlyChangedRooms: false });
    const told = world.emits.filter((e) => e.event === 'host:action_confirmed').map((e) => (e.payload as { summary: string }).summary);
    expect(told).toContain(`Round 3: ${room.userIds.map((id) => NAMES[id]).join(' and ')} can't meet now, so their meeting was not set up.`);
    expect(planned(3).some((m) => key(membersOf(m)) === key(room.userIds))).toBe(false);
  });
});
