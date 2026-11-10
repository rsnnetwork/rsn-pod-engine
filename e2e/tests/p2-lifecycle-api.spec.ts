import { test, expect } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { apiRequest } from '../helpers/api';
import { cleanup, idsOf, teardown } from '../helpers/live-ui';

// Part 2 Task 2 (10 Nov 2026), spec 11: an event's lifecycle, through the API on production (dark: no screen yet).
//
// A throwaway host makes a draft through the API. A throwaway member of the same pod does not see it: their Events
// list leaves it out, and its page answers 404 exactly as an id that names no event. Published, it is listed and the
// member registers. Cancelled with a reason, the member's notifications say "<title> was cancelled". Archived, it
// leaves the member's default list and comes back with ?archived=1. A throwaway super admin's delete-permanently with
// a wrong name is 400 in words; with the right name the event is gone and the audit trail keeps its snapshot.
// Throwaway accounts only (%rsn-e2e.invalid), deleted by id at the end with their pod and event.

const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const RUN = `zp2t2${Date.now().toString(36)}`;
const TITLE = `${RUN} lifecycle event`;
let host: TestUser | undefined, member: TestUser | undefined, superAdmin: TestUser | undefined;
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

async function throwaway(label: string, role: 'member' | 'super_admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`p2t2${label}`, role);
  const name = `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, `${u.id}@rsn-e2e.invalid`, name]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

const listedTo = async (user: TestUser, query = ''): Promise<string[]> => {
  const res = await call(user, 'GET', `/sessions?pageSize=100${query}`);
  expect(res.status).toBe(200);
  return (res.json.data as Array<{ id: string }>).map((e) => e.id);
};

test.beforeAll(async () => {
  host = await throwaway('Host');
  member = await throwaway('Member');
  superAdmin = await throwaway('Super', 'super_admin');
  // A private, ACTIVE speed-networking pod the host directs and the member belongs to (an active member). Production
  // schedules events only in an active pod (POD_NOT_ACTIVE otherwise; a pod row's default status is not active), and
  // only its directors and hosts may create one. As an active member of a private pod, the member sees its published
  // events in their Events list (the NULL-visibility rule) and registers without an invite.
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility, status, pod_type) VALUES ($1, $2, 'private', 'active', 'speed_networking') RETURNING id`,
    [`${RUN} pod`, host.id]);
  podId = pod.rows[0].id;
  await pool.query(
    `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active'), ($1, $3, 'member', 'active')`,
    [podId, host.id, member.id]);
});

test.afterAll(async () => {
  await teardown(() => cleanup(pool, { ids: idsOf(host, member, superAdmin), podId }));
});

test('a draft is the host\'s alone until published; cancel tells the member; archive puts it away; delete needs its name', async () => {
  test.setTimeout(120_000);

  // A draft, made through the API. A year out, so it heads the Events list (newest first, 100 a page) whatever else
  // production lists to the member, and no job (overdue, in-person ender) ever looks at it during the run.
  const created = await apiRequest(host!, 'POST', '/sessions', {
    podId, title: TITLE, description: 'E2E lifecycle', scheduledAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    publication: 'draft',
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50 },
  });
  eventId = created.data.id as string;
  expect(created.data.publication).toBe('draft');

  // The member: not in their Events list, and its page is the same 404 as an id that names nothing.
  expect(await listedTo(member!)).not.toContain(eventId);
  const hidden = await call(member!, 'GET', `/sessions/${eventId}`);
  const unknown = await call(member!, 'GET', '/sessions/5e550000-0000-4000-8000-00000000dead');
  expect(hidden.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(hidden.json).toEqual(unknown.json);
  expect((await call(member!, 'POST', `/sessions/${eventId}/register`)).status).toBe(404);

  // The host sees it, as a draft they may publish.
  const own = await call(host!, 'GET', `/sessions/${eventId}`);
  expect(own.status).toBe(200);
  expect(own.json.data).toMatchObject({ lifecycle: 'draft', publication: 'draft' });
  expect(own.json.data.allowedActions).toEqual(expect.arrayContaining(['publish', 'cancel']));
  expect(await listedTo(host!)).toContain(eventId);

  // Published: listed to the member, who registers.
  expect((await call(host!, 'POST', `/sessions/${eventId}/publish`)).status).toBe(200);
  expect(await listedTo(member!)).toContain(eventId);
  expect((await call(member!, 'POST', `/sessions/${eventId}/register`)).status).toBe(201);
  // Someone holds a place now, so it can no longer go back to a draft.
  const unpublish = await call(host!, 'POST', `/sessions/${eventId}/unpublish`);
  expect(unpublish.status).toBe(409);
  expect(unpublish.json.error.message).toBe('People have already registered. Cancel the event instead.');

  // Cancelled with a reason: the member's notifications say so, once.
  const cancelled = await call(host!, 'POST', `/sessions/${eventId}/cancel`, { reason: 'The venue closed.' });
  expect(cancelled.status).toBe(200);
  expect(cancelled.json.data.notified).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => {
    const bell = await call(member!, 'GET', '/notifications');
    return (bell.json?.data?.notifications ?? [])
      .filter((n: { title: string; type: string }) => n.type === 'event_cancelled' && n.title === `${TITLE} was cancelled`).length;
  }, { timeout: 15_000 }).toBe(1);
  const again = await call(host!, 'POST', `/sessions/${eventId}/cancel`, { reason: 'Twice' });
  expect(again.status).toBe(409);
  expect(again.json.error.message).toBe('This event is already cancelled.');
  const db = await pool.query<{ status: string; cancel_reason: string | null; cancelled_by: string | null }>(
    `SELECT status, cancel_reason, cancelled_by FROM sessions WHERE id = $1`, [eventId]);
  expect(db.rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'The venue closed.', cancelled_by: host!.id });

  // Archived: gone from the member's default list, back with ?archived=1.
  expect((await call(host!, 'POST', `/sessions/${eventId}/archive`)).status).toBe(200);
  expect(await listedTo(member!)).not.toContain(eventId);
  expect(await listedTo(member!, '&archived=1')).toContain(eventId);

  // Delete for good: a wrong name is 400 in words, and the event stays.
  const wrong = await call(superAdmin!, 'POST', `/sessions/${eventId}/delete-permanently`, { confirmTitle: 'Not the name' });
  expect(wrong.status).toBe(400);
  expect(wrong.json.error.message).toBe("Type the event's name to delete it.");
  expect((await pool.query(`SELECT 1 FROM sessions WHERE id = $1`, [eventId])).rowCount).toBe(1);

  // The right name (any case) deletes it, and the audit trail keeps what it was.
  expect((await call(superAdmin!, 'POST', `/sessions/${eventId}/delete-permanently`, { confirmTitle: `  ${TITLE.toUpperCase()} ` })).status).toBe(200);
  expect((await pool.query(`SELECT 1 FROM sessions WHERE id = $1`, [eventId])).rowCount).toBe(0);
  const trail = await pool.query<{ action: string; details: { before: { title: string } } }>(
    `SELECT action, details FROM audit_log WHERE entity_type = 'session' AND entity_id = $1 AND action LIKE 'event.%' ORDER BY created_at`,
    [eventId]);
  expect(trail.rows.map((r) => r.action)).toEqual(['event.published', 'event.cancelled', 'event.archived', 'event.deleted']);
  expect(trail.rows[3].details.before.title).toBe(TITLE);
  // The trail outlives the event. Its rows name this run's throwaway accounts, and go with them in the cleanup.
});
