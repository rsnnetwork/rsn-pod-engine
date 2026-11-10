import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { SERVER, cleanup, idsOf, teardown } from '../helpers/live-ui';

// THE RSN CALL LINK (Part 2 foundation, Task 6, 11 Nov 2026): open an event's link, verify an email with a 6-digit code,
// give only a name, enter. Over the API only (dark server code: no screen reads it yet).
//
// A throwaway host creates an open event through the API and reads its call link (a new event has one from creation).
// A fresh address (<uuid>@rsn-e2e.invalid, a reserved address: production stores the code but sends no email) asks for
// a code; the spec writes the keyed hash of a code it chose onto the entry link it just asked for, the way
// n1-t4-signin-code.spec.ts does for sign-in. It verifies (a new event guest), enters with a name (a place, admitted as
// open), is refused a member-only part of RSN (GET /api/people/everyone: 403 GUEST_MEMBERSHIP_REQUIRED) and reads its
// event (GET /api/sessions/:id: 200). An invitation-only event answers an unlisted address at /email exactly as it answers
// a member's (no answer tells whether an address has an account), and refuses it only after its code is proved, with no
// account made and nothing spent. Everything is deleted by id at the end (the guest found by its exact address, never a pattern).

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);

interface Person { id: string; email: string; token: string }

async function makeHost(): Promise<Person> {
  const id = uuid();
  const email = `p2t6-host-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, 'P2T6 Host', 'Host', 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email],
  );
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: 'P2T6 Host', sessionId: uuid() }, SECRET, { expiresIn: '1h' });
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

let host: Person | undefined;
let podId = '';
let openEventId = '';
let restrictedEventId = '';
const guestEmail = `${uuid()}@rsn-e2e.invalid`;
const refusedEmail = `${uuid()}@rsn-e2e.invalid`;

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the host and to set a known entry code').toBeTruthy();
  host = await makeHost();
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'private', 'active', 'speed_networking')`,
    [podId, `P2T6 pod ${RUN}`, host.id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);
});

test.afterAll(async () => {
  const guests = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 OR email = $2`, [guestEmail, refusedEmail]);
  await teardown(
    () => pool.query(`DELETE FROM magic_links WHERE email = ANY($1::text[])`, [[guestEmail, refusedEmail]]),
    () => cleanup(pool, { ids: [...idsOf(host), ...guests.rows.map((r) => r.id)], podId }),
  );
});

test('a fresh address enters an open event by its link as a guest, and an invitation-only event refuses it', async () => {
  test.setTimeout(180_000);
  const h = host!;

  // The host creates an event through the API: it has a call link from the start.
  const scheduledAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const created = await call('POST', '/sessions', { token: h.token, body: { podId, title: `P2T6 open ${RUN}`, scheduledAt } });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  openEventId = created.json.data.id;
  const link = await call('GET', `/sessions/${openEventId}/call-link`, { token: h.token });
  expect(link.status, JSON.stringify(link.json)).toBe(200);
  const { code, path, url } = link.json.data;
  expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/);
  expect(path).toBe(`/call/${code}`);
  expect(url).toMatch(new RegExp(`/call/${code}$`));
  const stored = await pool.query(`SELECT call_code FROM sessions WHERE id = $1`, [openEventId]);
  expect(stored.rows[0].call_code).toBe(code);
  // The host opens it to anyone with the link.
  const opened = await call('PUT', `/sessions/${openEventId}/admission`, { token: h.token, body: { mode: 'open' } });
  expect(opened.status, JSON.stringify(opened.json)).toBe(200);

  // Anyone holding the link sees the event, and nothing about who is in it.
  const landing = await call('GET', `/call-links/${code.toUpperCase()}`);
  expect(landing.status).toBe(200);
  expect(landing.json.data).toMatchObject({
    code, title: `P2T6 open ${RUN}`, lifecycle: 'registration_open', admission: 'open',
    host: { displayName: 'P2T6 Host' }, viewer: { signedIn: false, step: 'identify' },
  });
  expect(JSON.stringify(landing.json)).not.toContain(h.email);
  expect(JSON.stringify(landing.json)).not.toContain(podId);
  // A code that leads nowhere is one plain 404.
  const nowhere = await call('GET', '/call-links/zzzzzzzzzz');
  expect(nowhere).toEqual({ status: 404, json: { success: false, error: { code: 'SESSION_NOT_FOUND', message: "We couldn't find that event." } } });

  // A fresh address asks for a code, and the spec puts a known one on the entry link.
  const asked = await call('POST', `/call-links/${code}/email`, { body: { email: guestEmail } });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(asked.json.data.sent).toBe(true);
  const entryCode = await knownEntryCode(guestEmail, openEventId);
  const wrongTry = await call('POST', `/call-links/${code}/verify`, { body: { email: guestEmail, code: String((Number(entryCode) + 1) % 1_000_000).padStart(6, '0') } });
  expect(wrongTry.status).toBe(400);
  expect(wrongTry.json.error.code).toBe('AUTH_SIGN_IN_CODE_WRONG');
  const verified = await call('POST', `/call-links/${code}/verify`, { body: { email: guestEmail, code: entryCode } });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  expect(verified.json.data).toMatchObject({ accountKind: 'event_guest', created: true });
  const guestToken: string = verified.json.data.accessToken;
  const guest = await pool.query(
    `SELECT id, account_kind, onboarding_completed, profile_visible, guest_first_session_id, display_name FROM users WHERE email = $1`,
    [guestEmail],
  );
  expect(guest.rows[0]).toMatchObject({
    account_kind: 'event_guest', onboarding_completed: false, profile_visible: false, guest_first_session_id: openEventId, display_name: 'Guest',
  });

  // Only a name is missing; entering with one takes the place.
  const before = await call('GET', `/call-links/${code}/entry`, { token: guestToken });
  expect(before.status).toBe(200);
  expect(before.json.data).toMatchObject({ step: 'details', missing: { displayName: true, group: false, admissionCode: false } });
  const entered = await call('POST', `/call-links/${code}/enter`, { token: guestToken, body: { displayName: `Gus ${RUN}` } });
  expect(entered.status, JSON.stringify(entered.json)).toBe(200);
  expect(entered.json.data).toMatchObject({ step: 'wait_for_start', sessionId: openEventId });
  const place = await pool.query(`SELECT status, admitted_via FROM session_participants WHERE session_id = $1 AND user_id = $2`,
    [openEventId, guest.rows[0].id]);
  expect(place.rows[0]).toEqual({ status: 'registered', admitted_via: 'open' });
  const named = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [guest.rows[0].id]);
  expect(named.rows[0].display_name).toBe(`Gus ${RUN}`);
  // Entering again changes nothing.
  const again = await call('POST', `/call-links/${code}/enter`, { token: guestToken, body: { displayName: 'Someone else' } });
  expect(again.json.data).toEqual(entered.json.data);

  // The guest is kept out of member-only RSN, and reads its own event.
  const everyone = await call('GET', '/people/everyone', { token: guestToken });
  expect(everyone.status).toBe(403);
  expect(everyone.json.error.code).toBe('GUEST_MEMBERSHIP_REQUIRED');
  const event = await call('GET', `/sessions/${openEventId}`, { token: guestToken });
  expect(event.status, JSON.stringify(event.json)).toBe(200);
  const mine = await call('GET', '/call-links/me/events', { token: guestToken });
  expect(mine.status).toBe(200);
  expect(mine.json.data).toEqual([expect.objectContaining({ code, step: 'wait_for_start' })]);

  // An invitation-only event: /email answers an unlisted address exactly as it answers the host's own address (no
  // answer tells whether an address has an account); the refusal comes only after the code is proved, and makes no
  // account and spends nothing.
  const restricted = await call('POST', '/sessions', { token: h.token, body: { podId, title: `P2T6 invitation only ${RUN}`, scheduledAt } });
  expect(restricted.status).toBe(201);
  restrictedEventId = restricted.json.data.id;
  expect((await call('PUT', `/sessions/${restrictedEventId}/admission`, { token: h.token, body: { mode: 'restricted' } })).status).toBe(200);
  const restrictedCode = (await call('GET', `/sessions/${restrictedEventId}/call-link`, { token: h.token })).json.data.code;
  const unlisted = await call('POST', `/call-links/${restrictedCode}/email`, { body: { email: refusedEmail } });
  const member = await call('POST', `/call-links/${restrictedCode}/email`, { body: { email: h.email } });
  expect(unlisted).toEqual({ status: 200, json: { success: true, data: { sent: true } } });
  expect(member).toEqual(unlisted);
  const refusedCode = await knownEntryCode(refusedEmail, restrictedEventId);
  const refused = await call('POST', `/call-links/${restrictedCode}/verify`, { body: { email: refusedEmail, code: refusedCode } });
  expect(refused.status).toBe(403);
  expect(refused.json.error).toMatchObject({ code: 'EVENT_ADMISSION_REQUIRED', details: { admissionCode: true } });
  expect(refused.json.error.message).toMatch(/^This event is invitation only\./);
  const noAccount = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE email = $1`, [refusedEmail]);
  expect(noAccount.rows[0].n).toBe(0);
  const unspent = await pool.query(`SELECT used_at FROM magic_links WHERE email = $1 AND purpose = 'event_entry' AND target_id = $2`,
    [refusedEmail, restrictedEventId]);
  expect(unspent.rows[0].used_at).toBeNull();
});
