// ─── Start follows the published schedule (10 Nov 2026 spec, Part 2 Task 9; Key decision D4) ──────────────────
//
// An event with a published version starts from it: every round of the latest version is written into the live
// matches (the same people per round, locks copied), and someone the version seats who is not there at Start is
// repaired out by an automatic version in which only the rooms around them change. An event without a version is
// left to the engine's plan exactly as before (start-uses-published-handler.test.ts holds the handler to that).
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

import { UserRole, type ScheduleSnapshot } from '@rsn/shared';
import { generateBoard, getBoard, applyBoardOp } from '../../../services/schedule/schedule-board.service';
import { publishSchedule } from '../../../services/schedule/schedule-publish.service';
import { hasPublishedSchedule, materialisePublished } from '../../../services/schedule/schedule-live.service';
import { COHOST, EVENT, HOST, addPerson, nextMatchNumber, resetWorld, world, type LiveMatch } from '../../fixtures/schedule-world';

const OWNER = { userId: HOST, role: UserRole.MEMBER };
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const membersOf = (m: LiveMatch) => [m.a, m.b, m.c].filter((id): id is string => !!id).sort();
const planned = (round: number) => world.matches.filter((m) => m.round_number === round && m.status === 'scheduled');
const key = (ids: string[]) => [...ids].sort().join(',');
const idNumber = (m: LiveMatch) => Number(m.id.slice(1));

/** The board generated for everyone, round 2's first meeting locked, version 1 published before the event. */
async function published(): Promise<ScheduleSnapshot> {
  let board = (await generateBoard(EVENT, OWNER, (await getBoard(EVENT, OWNER)).revision, 'all')).board;
  board = (await applyBoardOp(EVENT, OWNER, board.revision, { kind: 'lock_room', round: 2, room: board.rounds[1].rooms[0].roomNumber })).board;
  await publishSchedule(EVENT, OWNER, board.revision);
  world.session.status = 'lobby_open';
  return JSON.parse(world.versions[0].snapshot) as ScheduleSnapshot;
}

beforeEach(() => {
  resetWorld();
  for (const id of PEOPLE) addPerson(id, id.toUpperCase(), 'in_lobby');
});

describe('Start on an event with a published version', () => {
  it('writes exactly its rooms into the live matches: the same people per round, locks copied, nothing else', async () => {
    const v1 = await published();
    expect(await hasPublishedSchedule(EVENT)).toBe(true);

    const output = await materialisePublished(EVENT, { presentUserIds: new Set(PEOPLE), hostIds: [HOST, COHOST] });

    for (const r of v1.rounds) {
      const rows = planned(r.round).map((m) => ({ people: key(membersOf(m)), locked: m.locked, version: m.schedule_version }));
      const rooms = r.rooms.filter((room) => room.userIds.length >= 2)
        .map((room) => ({ people: key(room.userIds), locked: room.locked, version: 1 }));
      expect(rows.sort((x, y) => x.people.localeCompare(y.people))).toEqual(rooms.sort((x, y) => x.people.localeCompare(y.people)));
    }
    expect(world.matches.filter((m) => m.locked)).toHaveLength(1);
    expect(world.matches.find((m) => m.locked)!.round_number).toBe(2);
    // Everyone there, everyone seated: no repair, no second version, nobody rung.
    expect(world.versions).toHaveLength(1);
    expect(world.notifications).toEqual([]);
    // The host's plan strip reads the same rounds as the engine's plan would report them.
    expect(output.rounds.map((r) => r.roundNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(output.rounds.reduce((n, r) => n + r.pairs.length, 0)).toBe(world.matches.length);
    expect(output.metadata.participantCount).toBe(PEOPLE.length);
  });

  it('someone absent at Start is repaired out: only the rooms around them change, by an automatic version', async () => {
    const v1 = await published();
    const absent = 'h';
    expect(world.matches).toEqual([]);
    const firstNumber = nextMatchNumber();
    const firstPassRows = v1.rounds.reduce((n, r) => n + r.rooms.filter((room) => room.userIds.length >= 2).length, 0);

    await materialisePublished(EVENT, { presentUserIds: new Set(PEOPLE.filter((id) => id !== absent)), hostIds: [HOST, COHOST] });

    expect(world.versions.map((v) => ({ version: v.version, automatic: v.automatic, reason: v.reason })))
      .toEqual([{ version: 1, automatic: false, reason: null }, { version: 2, automatic: true, reason: 'left' }]);
    const v2 = JSON.parse(world.versions[1].snapshot) as ScheduleSnapshot;
    for (const r of v1.rounds) {
      // Nobody waits but the absent person; the absent person is seated nowhere.
      expect(planned(r.round).flatMap(membersOf).sort()).toEqual(PEOPLE.filter((id) => id !== absent));
      const partnerRoom = r.rooms.find((room) => room.userIds.includes(absent))!;
      const partners = partnerRoom.userIds.filter((id) => id !== absent);
      const absorbed = v2.rounds[r.round - 1].rooms.find((room) => partners.some((p) => room.userIds.includes(p)))!;
      for (const room of r.rooms) {
        if (room.userIds.includes(absent) || absorbed.userIds.some((id) => room.userIds.includes(id))) continue;
        // A room the absence did not touch kept its first-pass row: same people, same id.
        const row = planned(r.round).find((m) => key(membersOf(m)) === key(room.userIds))!;
        expect(row).toBeDefined();
        expect(idNumber(row)).toBeLessThan(firstNumber + firstPassRows);
      }
    }
    // The people whose meetings changed are rung (the event is live); the board shows the absence as the product's.
    expect(world.notifications.length).toBeGreaterThan(0);
    expect(world.absences).toEqual([{ user_id: absent, kind: 'no_show', from_round: 1, to_round: null, created_by: null }]);
    expect(world.audit.filter((r) => r.action === 'schedule.published').at(-1)).toMatchObject({
      actor_id: null, details: { automatic: true, scheduleVersion: 2 },
    });
  });

  it('a late registration who is there at Start is seated by the repair', async () => {
    await published();
    addPerson('ivy', 'IVY', 'in_lobby');
    await materialisePublished(EVENT, { presentUserIds: new Set([...PEOPLE, 'ivy']), hostIds: [HOST, COHOST] });
    for (let round = 1; round <= 5; round++) expect(planned(round).flatMap(membersOf)).toContain('ivy');
    expect(world.versions.at(-1)).toMatchObject({ automatic: true, reason: 'late_joiner' });
  });
});

describe('an event without a published version', () => {
  it('is not on the board: hasPublishedSchedule answers no, with or without a draft', async () => {
    expect(await hasPublishedSchedule(EVENT)).toBe(false);
    await generateBoard(EVENT, OWNER, 0, 'all');
    expect(await hasPublishedSchedule(EVENT)).toBe(false);
  });
});
