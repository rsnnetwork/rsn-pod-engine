import { test, expect } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { apiRequest } from '../helpers/api';
import { cleanup, idsOf, teardown } from '../helpers/live-ui';

// Part 2 Task 9 (10 Nov 2026), spec 06/07: publishing the matching board as numbered versions, through the API on
// production (dark: no screen yet).
//
// A throwaway host makes an event for six throwaway members and generates its board. One pair is locked; generating
// again leaves that pair where it was. Version 1 is published (before the event: no bell). Two people are swapped in
// round 2 and version 2 is published: a swapped member's notifications say "Your meetings for {title} changed", a
// member whose meetings did not change has no such bell. GET /schedule/mine answers version 2, and the organisers'
// versions list has both. Throwaway accounts only (%rsn-e2e.invalid), deleted by id at the end with their pod and event.

const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const RUN = `zp2t9${Date.now().toString(36)}`;
const TITLE = `${RUN} board event`;
let host: TestUser | undefined;
const members: TestUser[] = [];
let podId: string | undefined;
let eventId: string | undefined;

/** A call whose answer the test reads whatever its status (apiRequest throws on anything but 2xx). */
async function call(user: TestUser, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function throwaway(label: string): Promise<TestUser> {
  const u = await createTestUser(`p2t9${label}`);
  const name = `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, `${u.id}@rsn-e2e.invalid`, name]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

interface Seat { userId: string }
interface Room { roomNumber: number; locked: boolean; seats: Seat[] }
interface Board { revision: number; publishedVersion: number | null; draftDiffersFromPublished: boolean; rounds: Array<{ roundNumber: number; rooms: Room[] }> }

const people = (room: Room) => room.seats.map((s) => s.userId).sort();
const scheduleChangedBells = async (user: TestUser): Promise<number> => {
  const bell = await call(user, 'GET', '/notifications');
  expect(bell.status).toBe(200);
  return (bell.json?.data?.notifications ?? [])
    .filter((n: { title: string; type: string }) => n.type === 'event_schedule_changed' && n.title === `Your meetings for ${TITLE} changed`).length;
};

test.beforeAll(async () => {
  host = await throwaway('Host');
  for (let i = 1; i <= 6; i++) members.push(await throwaway(`Member${i}`));
  // A private, ACTIVE speed-networking pod the host directs and the members belong to (see p2-lifecycle-api.spec.ts).
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility, status, pod_type) VALUES ($1, $2, 'private', 'active', 'speed_networking') RETURNING id`,
    [`${RUN} pod`, host.id]);
  podId = pod.rows[0].id;
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);
  for (const m of members) {
    await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [podId, m.id]);
  }
});

test.afterAll(async () => {
  await teardown(() => cleanup(pool, { ids: idsOf(host, ...members), podId }));
});

test('lock, regenerate, publish v1, swap, publish v2: the swapped are rung, the others are not, mine reads v2', async () => {
  test.setTimeout(180_000);

  // An event a year out (no job looks at it during the run), three rounds, six people.
  const created = await apiRequest(host!, 'POST', '/sessions', {
    podId, title: TITLE, description: 'E2E board publish', scheduledAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50 },
  });
  eventId = created.data.id as string;
  for (const m of members) expect((await call(m, 'POST', `/sessions/${eventId}/register`)).status).toBe(201);

  // Generate every round.
  let board = (await call(host!, 'GET', `/sessions/${eventId}/schedule`)).json.data as Board;
  const generated = await call(host!, 'POST', `/sessions/${eventId}/schedule/generate`, { expectedRevision: board.revision, rounds: 'all' });
  expect(generated.status).toBe(200);
  board = generated.json.data.board as Board;
  expect(board.rounds).toHaveLength(3);
  for (const round of board.rounds) expect(round.rooms.flatMap(people)).toHaveLength(6);

  // Lock round 1's first meeting; generating again leaves it where it was.
  const pair = board.rounds[0].rooms[0];
  const locked = await call(host!, 'POST', `/sessions/${eventId}/schedule/ops`, {
    expectedRevision: board.revision, op: { kind: 'lock_room', round: 1, room: pair.roomNumber },
  });
  expect(locked.status).toBe(200);
  const again = await call(host!, 'POST', `/sessions/${eventId}/schedule/generate`, { expectedRevision: locked.json.data.board.revision, rounds: 'all' });
  expect(again.status).toBe(200);
  board = again.json.data.board as Board;
  const kept = board.rounds[0].rooms.find((r) => r.roomNumber === pair.roomNumber)!;
  expect(kept.locked).toBe(true);
  expect(people(kept)).toEqual(people(pair));

  // A participant reads nothing before the first version; the organisers' preview lists no conflicts.
  expect((await call(members[0], 'GET', `/sessions/${eventId}/schedule/mine`)).json).toEqual({ success: true, data: null });
  const preview = await call(host!, 'GET', `/sessions/${eventId}/schedule/publish-preview`);
  expect(preview.status).toBe(200);
  expect(preview.json.data).toMatchObject({ blocking: [], nextVersion: 1 });

  // Version 1, before the event: nobody is rung.
  const v1 = await call(host!, 'POST', `/sessions/${eventId}/schedule/publish`, { expectedRevision: board.revision, note: 'First plan' });
  expect(v1.status).toBe(200);
  expect(v1.json.data.version).toBe(1);
  for (const m of members) expect(await scheduleChangedBells(m)).toBe(0);

  // Swap two people between two rooms of round 2, then publish version 2.
  board = (await call(host!, 'GET', `/sessions/${eventId}/schedule`)).json.data as Board;
  expect(board).toMatchObject({ publishedVersion: 1, draftDiffersFromPublished: false });
  const [roomA, roomB] = board.rounds[1].rooms;
  const x = roomA.seats[0].userId;
  const y = roomB.seats[0].userId;
  const swapped = await call(host!, 'POST', `/sessions/${eventId}/schedule/ops`, {
    expectedRevision: board.revision, op: { kind: 'swap', round: 2, userId: x, withUserId: y },
  });
  expect(swapped.status).toBe(200);
  expect(swapped.json.data.board.draftDiffersFromPublished).toBe(true);
  const v2 = await call(host!, 'POST', `/sessions/${eventId}/schedule/publish`, { expectedRevision: swapped.json.data.board.revision });
  expect(v2.status).toBe(200);
  expect(v2.json.data.version).toBe(2);
  const impacted = v2.json.data.impactedUserIds as string[];
  expect(impacted).toEqual(expect.arrayContaining([x, y]));
  expect(impacted.length).toBeLessThanOrEqual(4);

  // A swapped member is rung once; a member whose meetings did not change is not.
  const swappedMember = members.find((m) => m.id === x)!;
  const untouched = members.find((m) => !impacted.includes(m.id))!;
  expect(untouched).toBeDefined();
  await expect.poll(() => scheduleChangedBells(swappedMember), { timeout: 15_000 }).toBe(1);
  expect(await scheduleChangedBells(untouched)).toBe(0);

  // Their own schedule is version 2: in round 2 they now meet the people of the other room.
  const mine = await call(swappedMember, 'GET', `/sessions/${eventId}/schedule/mine`);
  expect(mine.status).toBe(200);
  expect(mine.json.data.version).toBe(2);
  expect(mine.json.data.rounds).toHaveLength(3);
  const round2 = mine.json.data.rounds[1];
  expect(round2.room).toBe(roomB.roomNumber);
  const expectedPartners = roomB.seats.filter((s) => s.userId !== y).map((s) => members.find((m) => m.id === s.userId)!.displayName).sort();
  expect(round2.partners.map((p: { displayName: string }) => p.displayName).sort()).toEqual(expectedPartners);

  // The organisers' versions list, latest first; a member may not read it.
  const versions = await call(host!, 'GET', `/sessions/${eventId}/schedule/versions`);
  expect(versions.status).toBe(200);
  expect(versions.json.data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  expect(versions.json.data[1]).toMatchObject({ automatic: false, note: 'First plan', publishedBy: { userId: host!.id } });
  expect((await call(members[0], 'GET', `/sessions/${eventId}/schedule/versions`)).status).toBe(403);

  // The audit trail names each version.
  const trail = await pool.query<{ details: { scheduleVersion: number } }>(
    `SELECT details FROM audit_log WHERE entity_type = 'session' AND entity_id = $1 AND action = 'schedule.published' ORDER BY created_at`,
    [eventId]);
  expect(trail.rows.map((r) => r.details.scheduleVersion)).toEqual([1, 2]);
});
