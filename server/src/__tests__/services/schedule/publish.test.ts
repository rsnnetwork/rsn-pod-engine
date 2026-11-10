// ─── Publishing the matching board as numbered versions (10 Nov 2026 spec, Part 2 Task 9; sections 06, 07) ────
//
// Publishing is refused while the draft has conflicts, with the list; a clean draft becomes version 1, which before
// the event tells nobody but the screens; an edit published as version 2 rings a bell for the people whose meetings
// changed and nobody else; a participant reads the latest version, never the draft; a version never changes after it
// is written; every version is audited with its number. The real board and publish services, the checker and the
// engine, against fixtures/schedule-world.ts.

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
import { emitEntities } from '../../../realtime/emit';
import { applyBoardOp, generateBoard, getBoard } from '../../../services/schedule/schedule-board.service';
import {
  getMySchedule, listScheduleVersions, previewPublish, publishSchedule,
} from '../../../services/schedule/schedule-publish.service';
import { EVENT, HOST, addPerson, resetWorld, world } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f'];
const NAMES: Record<string, string> = { a: 'Ann', b: 'Ben', c: 'Cat', d: 'Dev', e: 'Eve', f: 'Fay' };

const roomOf = (board: ScheduleBoard, round: number, userId: string) =>
  board.rounds[round - 1].rooms.find((r) => r.seats.some((s) => s.userId === userId)) ?? null;
const partnersOf = (board: ScheduleBoard, round: number, userId: string) =>
  (roomOf(board, round, userId)?.seats ?? []).map((s) => s.userId).filter((id) => id !== userId).sort();

async function op(board: ScheduleBoard, change: BoardOp): Promise<ScheduleBoard> {
  return (await applyBoardOp(EVENT, OWNER, board.revision, change)).board;
}
async function generated(): Promise<ScheduleBoard> {
  return (await generateBoard(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, 'all')).board;
}
/** Lets the fire-and-forget fan-outs finish (each fixture statement yields to the event loop once). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
/** Publish, then the board as it is now (a publish moves the revision). */
async function publishAndRead(revision: number, opts?: { note?: string }): Promise<ScheduleBoard> {
  await publishSchedule(EVENT, OWNER, revision, opts);
  return getBoard(EVENT, OWNER);
}
/** Two people in different rooms of a round, neither room's people having met the other in any round. */
function swappable(board: ScheduleBoard, round: number): [string, string] {
  const rooms = board.rounds[round - 1].rooms;
  return [rooms[0].seats[0].userId, rooms[1].seats[0].userId];
}

beforeEach(() => {
  resetWorld();
  for (const id of PEOPLE) addPerson(id, NAMES[id]);
  (emitEntities as jest.Mock).mockClear();
});

describe('publishing refuses a draft with conflicts', () => {
  it('a block between two people seated together blocks publishing, with the list; nothing is written', async () => {
    const board = await generated();
    const room = board.rounds[0].rooms[0];
    const [x, y] = room.seats.map((s) => s.userId);
    world.blocks.push([x, y]);

    const preview = await previewPublish(EVENT, OWNER);
    const expected = { round: 1, room: room.roomNumber, message: `${NAMES[x]} and ${NAMES[y]} can't be in the same meeting.` };
    expect(preview.blocking).toContainEqual(expected);
    expect(preview.nextVersion).toBe(1);

    await expect(publishSchedule(EVENT, OWNER, board.revision)).rejects.toMatchObject({
      statusCode: 409, code: 'SCHEDULE_HAS_CONFLICTS', message: 'Fix the conflicts before publishing.',
      details: { blocking: expect.arrayContaining([expected]) },
    });
    expect(world.versions).toEqual([]);
    expect(world.schedule!.published_version).toBeNull();
    expect(world.audit.filter((r) => r.action === 'schedule.published')).toEqual([]);
  });

  it('an empty board is not published: there is nothing to follow', async () => {
    const board = await getBoard(EVENT, OWNER);
    await expect(publishSchedule(EVENT, OWNER, board.revision)).rejects.toMatchObject({
      code: 'SCHEDULE_HAS_CONFLICTS',
      details: { blocking: [{ round: 1, room: null, message: 'There are no meetings to publish yet. Generate the board first.' }] },
    });
  });

  it('a publish made against an older board is refused with the board as it is now', async () => {
    const board = await generated();
    await op(board, { kind: 'lock_room', round: 1, room: board.rounds[0].rooms[0].roomNumber });
    await expect(publishSchedule(EVENT, OWNER, board.revision)).rejects.toMatchObject({
      code: 'SCHEDULE_CHANGED', details: { board: expect.objectContaining({ revision: board.revision + 1 }) },
    });
    expect(world.versions).toEqual([]);
  });

  it('only the people running the event publish', async () => {
    const board = await generated();
    await expect(publishSchedule(EVENT, { userId: 'a', role: UserRole.MEMBER }, board.revision))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('versions', () => {
  it('a clean draft becomes version 1; before the event nobody gets a bell, the screens are told', async () => {
    const board = await generated();
    const result = await publishSchedule(EVENT, OWNER, board.revision, { note: 'First plan' });

    expect(result.version).toBe(1);
    expect([...result.impactedUserIds].sort()).toEqual(PEOPLE);
    expect(world.versions).toHaveLength(1);
    expect(world.versions[0]).toMatchObject({ version: 1, published_by: HOST, automatic: false, note: 'First plan', impacted_count: 6 });
    expect(world.schedule!.published_version).toBe(1);
    expect(world.notifications).toEqual([]);
    // The organisers' boards and everyone in the event are told.
    await settle();
    const tags = (emitEntities as jest.Mock).mock.calls.flatMap((c) => c[2] as string[]);
    expect(tags).toEqual(expect.arrayContaining([`session:${EVENT}:schedule`, `session:${EVENT}:published-schedule`]));
    // The draft now equals what was published.
    const after = await getBoard(EVENT, OWNER);
    // Publishing moved the revision (the draft did not change): a second click on the same board is refused.
    expect(result.revision).toBe(board.revision + 1);
    expect(after).toMatchObject({ publishedVersion: 1, draftDiffersFromPublished: false, revision: board.revision + 1 });
    // Every round of the version holds the board's rooms, by number.
    const snapshot = JSON.parse(world.versions[0].snapshot) as ScheduleSnapshot;
    expect(snapshot.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4, 5]);
    for (const round of after.rounds) {
      expect(snapshot.rounds[round.roundNumber - 1].rooms.map((r) => ({ room: r.room, userIds: r.userIds })))
        .toEqual(round.rooms.map((r) => ({ room: r.roomNumber, userIds: r.seats.map((s) => s.userId).sort() })));
    }
  });

  it('an edit published as version 2 rings a bell for exactly the people whose meetings changed', async () => {
    let board = await generated();
    board = await publishAndRead(board.revision);
    const [x, y] = swappable(board, 2);
    const changedPeople = [...new Set([x, y, ...partnersOf(board, 2, x), ...partnersOf(board, 2, y)])].sort();
    board = await op(board, { kind: 'swap', round: 2, userId: x, withUserId: y });
    expect(board.draftDiffersFromPublished).toBe(true);
    expect((await previewPublish(EVENT, OWNER)).impactedUserIds).toEqual(changedPeople);

    const result = await publishSchedule(EVENT, OWNER, board.revision);

    expect(result).toEqual({ version: 2, impactedUserIds: changedPeople, revision: board.revision + 1 });
    expect(changedPeople.length).toBeGreaterThanOrEqual(2);
    expect(changedPeople.length).toBeLessThanOrEqual(4);
    expect(world.notifications.map((n) => n.user_id).sort()).toEqual(changedPeople);
    for (const bell of world.notifications) {
      expect(bell).toMatchObject({
        type: 'event_schedule_changed', title: 'Your meetings for Founders Night changed', link: `/sessions/${EVENT}`,
      });
    }
    // Nobody else is rung.
    for (const id of PEOPLE.filter((p) => !changedPeople.includes(p))) {
      expect(world.notifications.some((n) => n.user_id === id)).toBe(false);
    }
    // One audit row per version, carrying its number.
    const published = world.audit.filter((r) => r.action === 'schedule.published');
    expect(published.map((r) => r.details.scheduleVersion)).toEqual([1, 2]);
    expect(published[1]).toMatchObject({ actor_id: HOST, details: { automatic: false, subjectUserIds: changedPeople } });
  });

  it('a participant reads version 2, never a change only in the draft', async () => {
    let board = await generated();
    board = await publishAndRead(board.revision);
    const [x, y] = swappable(board, 2);
    board = await op(board, { kind: 'swap', round: 2, userId: x, withUserId: y });
    await publishSchedule(EVENT, OWNER, board.revision);
    const published = await getBoard(EVENT, OWNER);

    // A later edit, not published.
    const [p, q] = swappable(published, 3);
    const draftOnly = await op(published, { kind: 'swap', round: 3, userId: p, withUserId: q });
    expect(draftOnly.draftDiffersFromPublished).toBe(true);

    for (const id of [x, p]) {
      const mine = (await getMySchedule(EVENT, id))!;
      expect(mine.version).toBe(2);
      expect(mine.rounds).toHaveLength(5);
      for (const round of mine.rounds) {
        const expected = partnersOf(published, round.round, id).map((partner) => NAMES[partner]).sort();
        expect(round.partners.map((partner) => partner.displayName).sort()).toEqual(expected);
        expect(round.room).toBe(roomOf(published, round.round, id)!.roomNumber);
        expect(round.startsAt).toEqual(expect.any(String));
      }
    }
    expect((await getMySchedule(EVENT, x))!.rounds[0].partners[0]).toEqual({
      displayName: expect.any(String), avatarUrl: expect.stringMatching(/^https:/), groupLabels: [],
    });
  });

  it('a version never changes: a later draft edit and version 3 leave version 2 as it was written', async () => {
    let board = await generated();
    board = await publishAndRead(board.revision);
    const [x, y] = swappable(board, 2);
    board = await op(board, { kind: 'swap', round: 2, userId: x, withUserId: y });
    board = await publishAndRead(board.revision);
    const v2 = world.versions.find((v) => v.version === 2)!.snapshot;

    const [p, q] = swappable(board, 4);
    board = await op(board, { kind: 'swap', round: 4, userId: p, withUserId: q });
    board = await op(board, { kind: 'lock_room', round: 1, room: board.rounds[0].rooms[0].roomNumber });
    await publishSchedule(EVENT, OWNER, board.revision);

    expect(world.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(world.versions.find((v) => v.version === 2)!.snapshot).toBe(v2);
    expect(world.sql.some((s) => /^UPDATE event_schedule_versions/.test(s))).toBe(false);
    expect(JSON.parse(world.versions[2].snapshot).rounds[0].rooms[0].locked).toBe(true);
  });

  it('nothing is published before the first version: a participant reads null', async () => {
    await generated();
    expect(await getMySchedule(EVENT, 'a')).toBeNull();
  });

  it('someone with no place in the event is refused; an event that does not exist reads as not found', async () => {
    const board = await generated();
    await publishSchedule(EVENT, OWNER, board.revision);
    world.users.set('stranger', { display_name: 'Stranger', role: 'member', status: 'active' });
    await expect(getMySchedule(EVENT, 'stranger')).rejects.toMatchObject({ statusCode: 403 });
    await expect(getMySchedule('00000000-0000-4000-8000-0000000000aa', 'a')).rejects.toMatchObject({ statusCode: 404 });
    // An organiser without a seat reads the version, with no meetings of their own.
    const host = (await getMySchedule(EVENT, HOST))!;
    expect(host.rounds.every((r) => r.room === null && r.partners.length === 0)).toBe(true);
  });

  it('the organisers list every version: number, when, by whom, why, how many it changed', async () => {
    let board = await generated();
    board = await publishAndRead(board.revision, { note: 'First plan' });
    const [x, y] = swappable(board, 2);
    board = await op(board, { kind: 'swap', round: 2, userId: x, withUserId: y });
    await publishSchedule(EVENT, OWNER, board.revision);

    const versions = await listScheduleVersions(EVENT, OWNER);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]).toEqual({
      version: 1, publishedAt: expect.any(String), publishedBy: { userId: HOST, displayName: 'Hana Host' },
      automatic: false, reason: null, note: 'First plan', impactedCount: 6,
    });
    await expect(listScheduleVersions(EVENT, { userId: 'a', role: UserRole.MEMBER })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('while the event is live, even a first version rings the people it seats in rounds not yet started', async () => {
    const board = await generated();
    world.session.status = 'round_active';
    world.session.current_round = 2;
    const result = await publishSchedule(EVENT, OWNER, board.revision);
    // Rounds 1 and 2 have started: only meetings in rounds 3 to 5 count, and everyone has one there.
    expect(result.impactedUserIds).toEqual(PEOPLE);
    expect(world.notifications.map((n) => n.user_id).sort()).toEqual(PEOPLE);
  });
});

describe('a publish is made once', () => {
  it('a double click: the second POST with the same revision is refused (SCHEDULE_CHANGED); one version, one audit row', async () => {
    const board = await generated();
    const both = await Promise.allSettled([
      publishSchedule(EVENT, OWNER, board.revision),
      publishSchedule(EVENT, OWNER, board.revision),
    ]);
    const won = both.filter((r) => r.status === 'fulfilled');
    const lost = both.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ statusCode: 409, code: 'SCHEDULE_CHANGED' });
    expect(world.versions.map((v) => v.version)).toEqual([1]);
    expect(world.audit.filter((r) => r.action === 'schedule.published')).toHaveLength(1);

    // And one after the other, the same revision again.
    await expect(publishSchedule(EVENT, OWNER, board.revision)).rejects.toMatchObject({ code: 'SCHEDULE_CHANGED' });
    expect(world.versions).toHaveLength(1);
  });

  it('publishing a board that equals the latest version writes nothing and answers that version', async () => {
    const board = await generated();
    const first = await publishSchedule(EVENT, OWNER, board.revision);
    world.notifications.length = 0;
    const audits = world.audit.length;
    const again = await publishSchedule(EVENT, OWNER, first.revision);
    expect(again).toEqual({ version: 1, impactedUserIds: [], revision: first.revision });
    expect(world.versions).toHaveLength(1);
    expect(world.audit).toHaveLength(audits);
    expect(world.notifications).toEqual([]);
    expect(world.schedule!.revision).toBe(first.revision);
  });
});
