import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { io, type Socket } from 'socket.io-client';
import { pool } from '../helpers/auth';
import { SERVER, cleanup, idsOf } from '../helpers/live-ui';

// ADMISSION PER EVENT (Part 2, Task 4, 10 Nov 2026): an invitation-only event, over the API and the live socket.
//
// A throwaway host sets the event to "Invitation only" (restricted), imports a 3-line CSV with one duplicate (2 added),
// and generates 2 codes. A pod member who is not listed is refused at registration (403 EVENT_ADMISSION_REQUIRED): the
// pod's audience is not admitted by membership alone. A listed member registers. The unlisted member redeems a code and
// registers. A second member redeeming the same code is refused (409). The host revokes the listed email, and that
// member's live join (socket session:join) is refused in the invited-guests words while their place stays as it was.
//
// Server only (dark code: no screen reads admission yet). Throwaway accounts (@rsn-e2e.invalid), the spec's own pod
// and event, deleted by id at the end.

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);
const INVITED_GUESTS = 'This event is for invited guests. Enter the email you were invited with, or an admission code.';

interface Person { id: string; email: string; token: string }

async function makePerson(label: string): Promise<Person> {
  const id = uuid();
  const email = `p2t4-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, $4, 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email, `P2T4 ${label}`, label],
  );
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: `P2T4 ${label}`, sessionId: uuid() }, SECRET, { expiresIn: '1h' });
  return { id, email, token };
}

async function api(who: Person, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function connect(who: Person): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: who.token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 15_000);
  });
}

/** The first `error` the socket hears after joining the event, or null if none comes in `ms`. */
function joinAndListen(s: Socket, sessionId: string, ms = 12_000): Promise<{ code?: string; message?: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    s.once('error', (e: { code?: string; message?: string }) => { clearTimeout(timer); resolve(e); });
    s.emit('session:join', { sessionId });
  });
}

let host: Person | undefined;
let listed: Person | undefined;
let unlisted: Person | undefined;
let second: Person | undefined;
let podId = '';
let eventId = '';
const sockets: Socket[] = [];

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  host = await makePerson('host');
  listed = await makePerson('listed');
  unlisted = await makePerson('unlisted');
  second = await makePerson('second');
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'private', 'active', 'speed_networking')`,
    [podId, `P2T4 pod ${RUN}`, host.id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active'), ($1, $3, 'member', 'active')`,
    [podId, host.id, unlisted.id]);
  eventId = uuid();
  await pool.query(
    `INSERT INTO sessions (id, pod_id, title, status, host_user_id, scheduled_at, config)
     VALUES ($1, $2, $3, 'scheduled', $4, NOW() + INTERVAL '2 days', '{}'::jsonb)`,
    [eventId, podId, `P2T4 invitation only ${RUN}`, host.id],
  );
});

test.afterAll(async () => {
  for (const s of sockets) s.disconnect();
  const ids = idsOf(host, listed, unlisted, second);
  // The event's allowed emails and codes go with it (ON DELETE CASCADE) when cleanup deletes the pod's events.
  await cleanup(pool, { ids, podId });
});

test('invitation only: the list and the codes decide who registers and who enters the live room', async () => {
  test.setTimeout(180_000);
  const h = host!; const l = listed!; const u = unlisted!; const s2 = second!;

  // The host makes the event invitation-only; the event, which followed its private pod, becomes private (D3).
  const mode = await api(h, 'PUT', `/sessions/${eventId}/admission`, { mode: 'restricted' });
  expect(mode.status, JSON.stringify(mode.json)).toBe(200);
  expect(mode.json.data).toMatchObject({ mode: 'restricted', effective: 'restricted' });
  const row = await pool.query(`SELECT admission_mode, visibility FROM sessions WHERE id = $1`, [eventId]);
  expect(row.rows[0]).toEqual({ admission_mode: 'restricted', visibility: 'private' });
  // Someone who does not run it cannot change it.
  expect((await api(u, 'PUT', `/sessions/${eventId}/admission`, { mode: 'open' })).status).toBe(403);

  // A 3-line CSV with one duplicate: 2 added.
  const other = `p2t4-other-${RUN}@rsn-e2e.invalid`;
  const csv = `name,email,ticket\r\nListed,${l.email},VIP\r\nListed again,${l.email.toUpperCase()},VIP\r\nOther,${other},GA\r\n`;
  const imported = await api(h, 'POST', `/sessions/${eventId}/admission/emails`, { csv, source: 'csv' });
  expect(imported.status, JSON.stringify(imported.json)).toBe(200);
  expect(imported.json.data).toEqual({ added: 2, alreadyListed: 0, restored: 0, invalid: [] });

  // Two codes, shown once; only keyed hashes and last fours are stored.
  const made = await api(h, 'POST', `/sessions/${eventId}/admission/codes`, { count: 2, label: 'P2T4' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const codes: Array<{ id: string; code: string }> = made.json.data.codes;
  expect(codes).toHaveLength(2);
  for (const c of codes) expect(c.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const stored = await pool.query(`SELECT code_hash, code_last4 FROM event_admission_codes WHERE session_id = $1`, [eventId]);
  expect(stored.rows).toHaveLength(2);
  for (const c of codes) {
    expect(JSON.stringify(stored.rows)).not.toContain(c.code.split('-').join(''));
    expect(stored.rows.map((r) => r.code_last4)).toContain(c.code.slice(-4));
  }

  // The unlisted pod member is refused: membership alone does not admit to an invitation-only event.
  const refused = await api(u, 'POST', `/sessions/${eventId}/register`);
  expect(refused.status).toBe(403);
  expect(refused.json.error).toMatchObject({ code: 'EVENT_ADMISSION_REQUIRED', message: INVITED_GUESTS });
  const access = await api(u, 'GET', `/sessions/${eventId}`);
  expect(access.json?.data?.access?.admission).toBe('restricted');

  // The listed member registers.
  const reg = await api(l, 'POST', `/sessions/${eventId}/register`);
  expect(reg.status, JSON.stringify(reg.json)).toBeLessThan(300);
  const listedRow = await pool.query(`SELECT status, admitted_via FROM session_participants WHERE session_id = $1 AND user_id = $2`, [eventId, l.id]);
  expect(listedRow.rows[0]).toEqual({ status: 'registered', admitted_via: 'allow_list' });

  // The unlisted member redeems a code (case and dashes ignored) and registers.
  const redeem = await api(u, 'POST', `/sessions/${eventId}/admission/redeem`, { code: codes[0].code.toLowerCase().split('-').join(' ') });
  expect(redeem.status, JSON.stringify(redeem.json)).toBe(200);
  const again = await api(u, 'POST', `/sessions/${eventId}/admission/redeem`, { code: codes[0].code });
  expect(again.status, 'the same person redeeming again (another device) is told it worked').toBe(200);
  const reg2 = await api(u, 'POST', `/sessions/${eventId}/register`);
  expect(reg2.status, JSON.stringify(reg2.json)).toBeLessThan(300);
  const codeRow = await pool.query(`SELECT admitted_via FROM session_participants WHERE session_id = $1 AND user_id = $2`, [eventId, u.id]);
  expect(codeRow.rows[0].admitted_via).toBe('code');

  // A second member redeeming the same code is refused.
  const used = await api(s2, 'POST', `/sessions/${eventId}/admission/redeem`, { code: codes[0].code });
  expect(used.status).toBe(409);
  expect(used.json.error).toMatchObject({ code: 'ADMISSION_CODE_USED', message: 'This admission code has already been used.' });
  const wrong = await api(s2, 'POST', `/sessions/${eventId}/admission/redeem`, { code: 'AAAA-BBBB-CCCC' });
  expect(wrong.status).toBe(400);
  expect(wrong.json.error.code).toBe('ADMISSION_CODE_INVALID');

  // The organisers' lists: the listed address shows as registered, the codes as used and unused, never the code.
  const list = await api(h, 'GET', `/sessions/${eventId}/admission/emails`);
  expect(list.status).toBe(200);
  const entry = list.json.data.entries.find((e: { email: string }) => e.email === l.email.toLowerCase());
  expect(entry).toMatchObject({ status: 'registered' });
  const codeList = await api(h, 'GET', `/sessions/${eventId}/admission/codes`);
  expect(codeList.json.data.map((c: { status: string }) => c.status).sort()).toEqual(['unused', 'used']);
  expect(JSON.stringify(codeList.json)).not.toContain(codes[1].code.split('-').join(''));

  // Before the revoke, the listed member's live join is not refused for admission.
  const before = await connect(l);
  sockets.push(before);
  expect((await joinAndListen(before, eventId, 8_000))?.code).not.toBe('EVENT_ADMISSION_REQUIRED');
  before.disconnect();

  // The host revokes the listed email: the live join is refused in the invited-guests words; the place stays.
  const revoke = await api(h, 'DELETE', `/sessions/${eventId}/admission/emails/${entry.id}`);
  expect(revoke.status).toBe(200);
  const after = await connect(l);
  sockets.push(after);
  const refusal = await joinAndListen(after, eventId);
  expect(refusal).toEqual({ code: 'EVENT_ADMISSION_REQUIRED', message: INVITED_GUESTS });
  const kept = await pool.query(`SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`, [eventId, l.id]);
  // The place is kept, never removed: the row is there, and reads 'registered', or 'disconnected' because this member
  // joined live above and that socket was closed.
  expect(kept.rows, 'their participant row is kept').toHaveLength(1);
  expect(['registered', 'disconnected']).toContain(kept.rows[0].status);

  // Every change was audited.
  const audit = await pool.query(
    `SELECT action FROM audit_log WHERE entity_type = 'session' AND entity_id = $1 AND action LIKE 'admission.%' ORDER BY created_at`,
    [eventId],
  );
  expect(audit.rows.map((r) => r.action)).toEqual([
    'admission.mode_changed', 'admission.emails_added', 'admission.codes_generated', 'admission.code_redeemed', 'admission.email_revoked',
  ]);
});
