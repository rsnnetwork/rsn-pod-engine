import { test, expect } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { apiRequest } from '../helpers/api';
import { cleanup, idsOf, teardown } from '../helpers/live-ui';

// Part 3 Task 12 (11 Nov 2026): the event's owner chooses who may override its group rules, and Buyers and vendors is
// a speed-networking type. Through the API on production (dark: no production screen sends overrideBy yet).
//
// A throwaway owner makes an event with a throwaway co-host and four throwaway members (two founders, two funders). The
// owner saves founders/funders rules with overrideBy 'owner_and_cohosts'; the co-host's board move that puts two
// founders in one meeting, sent with override, succeeds and is in the event's history. The owner switches back to
// 'owner': the co-host's next override is 403 GROUP_OVERRIDE_FORBIDDEN, and the co-host trying to change overrideBy is
// 403. GET /sessions/matching-presets lists "Buyers and vendors". Throwaway accounts only (%rsn-e2e.invalid), deleted by
// id at the end with their pod and event.

const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const RUN = `zp3t12${Date.now().toString(36)}`;
const TITLE = `${RUN} override event`;
let owner: TestUser | undefined;
let cohost: TestUser | undefined;
const founders: TestUser[] = [];
const funders: TestUser[] = [];
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
  const u = await createTestUser(`p3t12${label}`);
  const name = `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, `${u.id}@rsn-e2e.invalid`, name]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

interface Seat { userId: string; override: boolean }
interface Room { roomNumber: number; seats: Seat[] }
interface Board { revision: number; canOverride: boolean; rounds: Array<{ roundNumber: number; rooms: Room[]; basket: Array<{ userId: string }> }> }

const FOUNDERS_FUNDERS = {
  groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
  question: 'Are you a founder or a funder?',
  allowMultiple: false,
  fallback: 'leave_unmatched',
  rounds: [{ fromRound: 1, toRound: 1, mode: 'cross_group', allowedPairs: [] }],
};

const roomOf = (board: Board, userId: string) => board.rounds[0].rooms.find((r) => r.seats.some((s) => s.userId === userId));
const boardOf = async (user: TestUser): Promise<Board> => {
  const res = await call(user, 'GET', `/sessions/${eventId}/schedule`);
  expect(res.status).toBe(200);
  return res.json.data as Board;
};
/** Take the founder out of round 1 (into the basket), then ask to seat them with the other founder, overriding. */
async function seatTwoFoundersTogether(actor: TestUser, reason: string): Promise<{ status: number; json: any }> {
  let board = await boardOf(actor);
  const [a, b] = founders;
  if (roomOf(board, b.id)) {
    const out = await call(actor, 'POST', `/sessions/${eventId}/schedule/ops`, {
      expectedRevision: board.revision, op: { kind: 'unassign', round: 1, userId: b.id },
    });
    expect(out.status).toBe(200);
    board = out.json.data.board as Board;
  }
  const target = roomOf(board, a.id)!;
  expect(target).toBeDefined();
  return call(actor, 'POST', `/sessions/${eventId}/schedule/ops`, {
    expectedRevision: board.revision, op: { kind: 'move', round: 1, userId: b.id, toRoom: target.roomNumber, override: true, reason },
  });
}

test.beforeAll(async () => {
  owner = await throwaway('Owner');
  cohost = await throwaway('Cohost');
  for (let i = 1; i <= 2; i++) founders.push(await throwaway(`Founder${i}`));
  for (let i = 1; i <= 2; i++) funders.push(await throwaway(`Funder${i}`));
  // A private, ACTIVE speed-networking pod the owner directs and the others belong to (see p2-lifecycle-api.spec.ts).
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility, status, pod_type) VALUES ($1, $2, 'private', 'active', 'speed_networking') RETURNING id`,
    [`${RUN} pod`, owner.id]);
  podId = pod.rows[0].id;
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, owner.id]);
  for (const m of [cohost, ...founders, ...funders]) {
    await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [podId, m.id]);
  }
});

test.afterAll(async () => {
  await teardown(() => cleanup(pool, { ids: idsOf(owner, cohost, ...founders, ...funders), podId }));
});

test('the owner lets co-hosts override, then takes it back; only the owner chooses; Buyers and vendors is listed', async () => {
  test.setTimeout(180_000);

  // An event a year out (no job looks at it during the run), one round.
  const created = await apiRequest(owner!, 'POST', '/sessions', {
    podId, title: TITLE, description: 'E2E group override', scheduledAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    config: { eventType: 'speed_networking', numberOfRounds: 1, maxParticipants: 50 },
  });
  eventId = created.data.id as string;

  // The co-host registers before there are groups (no group question), and the owner makes them a co-host.
  expect((await call(cohost!, 'POST', `/sessions/${eventId}/register`)).status).toBe(201);
  expect((await call(owner!, 'POST', `/sessions/${eventId}/cohosts/${cohost!.id}`)).status).toBeLessThan(300);

  // The owner saves founders and funders, and lets co-hosts override.
  const saved = await call(owner!, 'PUT', `/sessions/${eventId}/groups`, { ...FOUNDERS_FUNDERS, overrideBy: 'owner_and_cohosts' });
  expect(saved.status).toBe(200);
  expect(saved.json.data.overrideBy).toBe('owner_and_cohosts');
  const asCohost = await call(cohost!, 'GET', `/sessions/${eventId}/groups`);
  expect(asCohost.json.data.rules.overrideBy).toBe('owner_and_cohosts');
  for (const f of founders) expect((await call(f, 'POST', `/sessions/${eventId}/register`, { groupKeys: ['founder'] })).status).toBe(201);
  for (const f of funders) expect((await call(f, 'POST', `/sessions/${eventId}/register`, { groupKeys: ['funder'] })).status).toBe(201);

  // The board: two meetings of a founder and a funder. The co-host may override.
  const first = await boardOf(owner!);
  const generated = await call(owner!, 'POST', `/sessions/${eventId}/schedule/generate`, { expectedRevision: first.revision, rounds: 'all' });
  expect(generated.status).toBe(200);
  expect((await boardOf(cohost!)).canOverride).toBe(true);

  const reason = `${RUN} same fund`;
  const overridden = await seatTwoFoundersTogether(cohost!, reason);
  expect(overridden.status).toBe(200);
  const room = roomOf(overridden.json.data.board as Board, founders[1].id)!;
  expect(room.seats.map((s) => s.userId)).toEqual(expect.arrayContaining([founders[0].id, founders[1].id]));
  expect(room.seats.find((s) => s.userId === founders[1].id)!.override).toBe(true);

  // It is in the event's history, by the co-host, with their reason.
  const history = await call(owner!, 'GET', `/sessions/${eventId}/audit?limit=50`);
  expect(history.status).toBe(200);
  const entry = (history.json.data.entries as Array<{ action: string; actor: { id: string } | null; reason: string | null }>)
    .find((e) => e.action === 'schedule.edited' && e.reason === reason);
  expect(entry?.actor?.id).toBe(cohost!.id);

  // The owner switches back to the owner only.
  const back = await call(owner!, 'PUT', `/sessions/${eventId}/groups`, { ...FOUNDERS_FUNDERS, overrideBy: 'owner' });
  expect(back.status).toBe(200);
  expect(back.json.data.overrideBy).toBe('owner');
  expect((await boardOf(cohost!)).canOverride).toBe(false);
  expect((await boardOf(owner!)).canOverride).toBe(true);

  // The co-host's next override is refused.
  const refused = await seatTwoFoundersTogether(cohost!, `${RUN} again`);
  expect(refused.status).toBe(403);
  expect(refused.json.error.code).toBe('GROUP_OVERRIDE_FORBIDDEN');

  // Only the owner chooses: the co-host changing overrideBy is refused, and nothing changes.
  const choose = await call(cohost!, 'PUT', `/sessions/${eventId}/groups`, { ...FOUNDERS_FUNDERS, overrideBy: 'owner_and_cohosts' });
  expect(choose.status).toBe(403);
  expect(choose.json.error.message).toBe("Only the event's owner can choose who may override group rules.");
  expect((await call(owner!, 'GET', `/sessions/${eventId}/groups`)).json.data.rules.overrideBy).toBe('owner');

  // Buyers and vendors is one of the speed-networking types.
  const presets = await call(owner!, 'GET', '/sessions/matching-presets');
  expect(presets.status).toBe(200);
  expect(presets.json.data).toEqual(expect.arrayContaining([
    { id: '5e7b1a5e-0000-4000-8000-000000000005', name: 'Buyers and vendors', description: 'Buyers meet vendors first' },
  ]));
});
