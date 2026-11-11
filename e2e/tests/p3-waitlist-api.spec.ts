import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { SERVER, cleanup, teardown } from '../helpers/live-ui';

// AN EVENT'S WAITING LIST (10 Nov 2026 spec, Part 3 Task 3): a full event puts the next person on its waiting list,
// and the first in line is given the next place that frees, with a bell. Over the API only (no production screen asks
// for the line yet; production's register answers a full event exactly as before).
//
// A throwaway host creates an event with room for two and opens it to anyone with its link. Members A and B take the
// places. C's plain registration is refused as today (409 SESSION_FULL); asking for the line (`waitlist: true`) puts C
// first (202), then D second. A fresh address enters by the RSN Call link (its own code hash written onto the entry
// link it asked for, as p2-call-link-api.spec.ts does) and is third. A unregisters: within 10 seconds C holds the place
// and C's bell says so, and D is first. D leaves the line, so the guest is first; the host lists the line and lets the
// guest in now, over capacity. Everything is deleted by id at the end (the guest found by its exact address).

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);

interface Person { id: string; email: string; token: string }

async function makeMember(label: string): Promise<Person> {
  const id = uuid();
  const email = `p3t3-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, $4, 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email, `P3T3 ${label}`, label],
  );
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: `P3T3 ${label}`, sessionId: uuid() }, SECRET, { expiresIn: '1h' });
  return { id, email, token };
}

async function call(method: string, p: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Put the keyed hash of a code the spec chose on the newest entry link of `email` for `eventId`, and answer the code. */
async function knownEntryCode(email: string, eventId: string): Promise<string> {
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE email = $1 AND purpose = 'event_entry' AND target_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [email, eventId],
  );
  expect(row.rows[0], 'the entry link was written').toBeTruthy();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${code}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return code;
}

/** Ask until `ok` holds, at most `ms` (a promotion runs after the unregister's answer). */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    last = await read();
  }
  return last;
}

const people: Person[] = [];
let podId = '';
let eventId = '';
const guestEmail = `${uuid()}@rsn-e2e.invalid`;

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the members and to set a known entry code').toBeTruthy();
  for (const label of ['Host', 'A', 'B', 'C', 'D']) people.push(await makeMember(label));
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'private', 'active', 'speed_networking')`,
    [podId, `P3T3 pod ${RUN}`, people[0].id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, people[0].id]);
});

test.afterAll(async () => {
  const guests = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [guestEmail]);
  await teardown(
    () => pool.query(`DELETE FROM magic_links WHERE email = $1`, [guestEmail]),
    () => cleanup(pool, { ids: [...people.map((p) => p.id), ...guests.rows.map((r) => r.id)], podId }),
  );
});

test('a full event queues the next people, promotes the first in line when a place frees, and the host lets one in now', async () => {
  test.setTimeout(180_000);
  const [host, a, b, c, d] = people;

  // An event with room for two (the host holds no place), open to anyone with its link.
  const scheduledAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const title = `P3T3 waiting list ${RUN}`;
  const created = await call('POST', '/sessions', { token: host.token, body: { podId, title, scheduledAt, config: { maxParticipants: 2 } } });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  eventId = created.json.data.id;
  expect((await call('PUT', `/sessions/${eventId}/admission`, { token: host.token, body: { mode: 'open' } })).status).toBe(200);
  const code: string = (await call('GET', `/sessions/${eventId}/call-link`, { token: host.token })).json.data.code;

  // A and B take the two places.
  for (const m of [a, b]) {
    const r = await call('POST', `/sessions/${eventId}/register`, { token: m.token });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }

  // C: a plain registration is refused as today; asking for the line puts C first, and asking again keeps the place.
  const plain = await call('POST', `/sessions/${eventId}/register`, { token: c.token });
  expect(plain).toEqual({ status: 409, json: { success: false, error: { code: 'SESSION_FULL', message: 'This event has reached its maximum participant count' } } });
  const queuedC = await call('POST', `/sessions/${eventId}/register`, { token: c.token, body: { waitlist: true } });
  expect(queuedC).toEqual({ status: 202, json: { success: true, data: { waitlisted: true, position: 1 } } });
  expect((await call('POST', `/sessions/${eventId}/register`, { token: c.token, body: { waitlist: true } })).json.data.position).toBe(1);
  const queuedD = await call('POST', `/sessions/${eventId}/register`, { token: d.token, body: { waitlist: true } });
  expect(queuedD).toEqual({ status: 202, json: { success: true, data: { waitlisted: true, position: 2 } } });
  const asC = await call('GET', `/sessions/${eventId}`, { token: c.token });
  expect(asC.json.data.access.waitlist).toEqual({ full: true, position: 1 });

  // A fresh address enters by the call link: third in line.
  expect((await call('POST', `/call-links/${code}/email`, { body: { email: guestEmail } })).status).toBe(200);
  const entryCode = await knownEntryCode(guestEmail, eventId);
  const verified = await call('POST', `/call-links/${code}/verify`, { body: { email: guestEmail, code: entryCode } });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  const guestToken: string = verified.json.data.accessToken;
  const guestId = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [guestEmail])).rows[0].id;
  const entered = await call('POST', `/call-links/${code}/enter`, { token: guestToken, body: { displayName: `Gus ${RUN}` } });
  expect(entered.status, JSON.stringify(entered.json)).toBe(200);
  expect(entered.json.data).toMatchObject({ step: 'waitlisted', sessionId: eventId, waitlistPosition: 3 });

  // A unregisters: C is given the place within 10 seconds and is told by the bell; D is now first.
  expect((await call('DELETE', `/sessions/${eventId}/register`, { token: a.token })).status).toBe(200);
  const cPlace = await eventually(
    () => pool.query<{ status: string }>(`SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`, [eventId, c.id]),
    (r) => r.rows[0]?.status === 'registered',
  );
  expect(cPlace.rows[0]?.status).toBe('registered');
  const cNow = await call('GET', `/sessions/${eventId}`, { token: c.token });
  expect(cNow.json.data.access.waitlist.position).toBeNull();
  const bells = await eventually(
    () => call('GET', '/notifications', { token: c.token }),
    (r) => JSON.stringify(r.json).includes(`A place opened in ${title}: it's yours`),
  );
  expect(JSON.stringify(bells.json)).toContain(`A place opened in ${title}: it's yours`);
  expect((await call('GET', `/sessions/${eventId}`, { token: d.token })).json.data.access.waitlist).toEqual({ full: true, position: 1 });

  // D leaves the line: the guest is first.
  const left = await call('DELETE', `/sessions/${eventId}/waitlist/mine`, { token: d.token });
  expect(left).toEqual({ status: 200, json: { success: true, data: { left: true } } });
  const guestEntry = await call('GET', `/call-links/${code}/entry`, { token: guestToken });
  expect(guestEntry.json.data).toMatchObject({ step: 'waitlisted', waitlistPosition: 1 });

  // The host reads the line (the guest, first, no email) and lets the guest in now, over capacity.
  const line = await call('GET', `/sessions/${eventId}/waitlist`, { token: host.token });
  expect(line.status, JSON.stringify(line.json)).toBe(200);
  expect(line.json.data).toEqual([expect.objectContaining({ userId: guestId, position: 1, joinedVia: 'call_link', accountKind: 'event_guest' })]);
  expect(JSON.stringify(line.json)).not.toContain('@');
  expect((await call('GET', `/sessions/${eventId}/waitlist`, { token: b.token })).status).toBe(403);
  const admitted = await call('POST', `/sessions/${eventId}/waitlist/${guestId}/admit`, { token: host.token });
  expect(admitted.status, JSON.stringify(admitted.json)).toBe(200);
  const guestNow = await call('GET', `/call-links/${code}/entry`, { token: guestToken });
  expect(guestNow.json.data).toMatchObject({ step: 'wait_for_start', waitlistPosition: null });
  const held = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM session_participants WHERE session_id = $1 AND status <> 'removed' AND user_id <> $2`, [eventId, host.id]);
  expect(held.rows[0].n).toBe(3);
  const counts = await call('GET', `/sessions/${eventId}/participant-counts`, { token: host.token });
  expect(counts.json.data.waitlisted).toBe(0);
});
