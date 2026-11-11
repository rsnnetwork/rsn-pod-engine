import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { SERVER, cleanup, teardown } from '../helpers/live-ui';

// AN EVENT'S EXTRA MATCHING QUESTIONS (10 Nov 2026 spec, Part 3 Task 5; K5): a soft preference only. Over the API only
// (no production screen asks the questions yet; an event without questions behaves exactly as before).
//
// A throwaway host creates an open two-round event and saves one required one-answer question, "Which sector?"
// (fintech, health; people with the same answer preferred). Four fresh addresses enter by the RSN Call link (each its own
// code hash written onto the entry link it asked for, as p2-call-link-api.spec.ts does): a guest is asked the question
// (missing.questions) and is given no place without it; two answer fintech and two health. A member registering on the
// event page without answers is refused 409 EVENT_ANSWERS_REQUIRED, and with { answers } gets a place (201). The host
// generates the matching board: round 1 never seats a fintech answerer with a health one and the two fintech guests meet.
// The host publishes it; a guest's GET /schedule/mine carries no answers; the host's GET /questions counts fintech 2 and
// health 3, and a guest's carries their own answers only. Everything is deleted by id at the end (the guests by their
// exact addresses).

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);

interface Person { id: string; email: string; token: string }

async function makeMember(label: string): Promise<Person> {
  const id = uuid();
  const email = `p3t5-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, $4, 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email, `P3T5 ${label}`, label],
  );
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: `P3T5 ${label}`, sessionId: uuid() }, SECRET, { expiresIn: '1h' });
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

interface Guest { email: string; sector: 'fintech' | 'health'; id: string; token: string }

const people: Person[] = [];
const guests: Guest[] = (['fintech', 'fintech', 'health', 'health'] as const).map((sector) => ({
  email: `${uuid()}@rsn-e2e.invalid`, sector, id: '', token: '',
}));
let podId = '';

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the members and to set a known entry code').toBeTruthy();
  for (const label of ['Host', 'Member']) people.push(await makeMember(label));
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'private', 'active', 'speed_networking')`,
    [podId, `P3T5 pod ${RUN}`, people[0].id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, people[0].id]);
});

test.afterAll(async () => {
  const emails = guests.map((g) => g.email);
  const found = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = ANY($1::text[])`, [emails]);
  await teardown(
    () => pool.query(`DELETE FROM magic_links WHERE email = ANY($1::text[])`, [emails]),
    () => cleanup(pool, { ids: [...people.map((p) => p.id), ...found.rows.map((r) => r.id)], podId }),
  );
});

test('a required matching question is asked at entry and registration, and round 1 pairs people who answered alike', async () => {
  test.setTimeout(240_000);
  const [host, member] = people;

  // An open two-round event, a year out (no job looks at it during the run).
  const created = await call('POST', '/sessions', {
    token: host.token,
    body: {
      podId, title: `P3T5 questions ${RUN}`, scheduledAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      config: { eventType: 'speed_networking', numberOfRounds: 2, maxParticipants: 50 },
    },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const eventId: string = created.json.data.id;
  expect((await call('PUT', `/sessions/${eventId}/admission`, { token: host.token, body: { mode: 'open' } })).status).toBe(200);
  const code: string = (await call('GET', `/sessions/${eventId}/call-link`, { token: host.token })).json.data.code;

  // The host saves one required question; a member who does not run the event cannot.
  const question = {
    key: 'sector', prompt: 'Which sector?', kind: 'single', prefer: 'same', required: true,
    options: [{ key: 'fintech', label: 'Fintech' }, { key: 'health', label: 'Health' }],
  };
  const saved = await call('PUT', `/sessions/${eventId}/questions`, { token: host.token, body: { questions: [question] } });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect(saved.json.data.questions).toEqual([question]);
  expect((await call('PUT', `/sessions/${eventId}/questions`, { token: member.token, body: { questions: [] } })).status).toBe(403);

  // The landing, signed out, lists the question (and never anyone's answers).
  const landing = await call('GET', `/call-links/${code}`);
  expect(landing.json.data.asks.questions).toEqual([question]);

  // Four guests enter by the link: asked the question, no place without it, a place with it.
  for (const [i, g] of guests.entries()) {
    expect((await call('POST', `/call-links/${code}/email`, { body: { email: g.email } })).status).toBe(200);
    const entryCode = await knownEntryCode(g.email, eventId);
    const verified = await call('POST', `/call-links/${code}/verify`, { body: { email: g.email, code: entryCode } });
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    g.token = verified.json.data.accessToken;
    g.id = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [g.email])).rows[0].id;
    const asked = await call('GET', `/call-links/${code}/entry`, { token: g.token });
    expect(asked.json.data).toMatchObject({ step: 'details', missing: { displayName: true, questions: true } });
    const named = await call('POST', `/call-links/${code}/enter`, { token: g.token, body: { displayName: `Guest ${i} ${RUN}` } });
    expect(named.json.data).toMatchObject({ step: 'details', missing: { displayName: false, questions: true } });
    const entered = await call('POST', `/call-links/${code}/enter`, { token: g.token, body: { answers: { sector: [g.sector] } } });
    expect(entered.status, JSON.stringify(entered.json)).toBe(200);
    expect(entered.json.data).toMatchObject({ step: 'wait_for_start', sessionId: eventId });
  }

  // A member on the event page: refused without answers, a place with them.
  const refused = await call('POST', `/sessions/${eventId}/register`, { token: member.token });
  expect(refused).toEqual({
    status: 409, json: { success: false, error: { code: 'EVENT_ANSWERS_REQUIRED', message: "Answer this event's questions first." } },
  });
  const registered = await call('POST', `/sessions/${eventId}/register`, { token: member.token, body: { answers: { sector: ['health'] } } });
  expect(registered.status, JSON.stringify(registered.json)).toBe(201);

  // The host generates the board: round 1 never mixes the sectors, and the two fintech guests meet.
  const board = (await call('GET', `/sessions/${eventId}/schedule`, { token: host.token })).json.data;
  const generated = await call('POST', `/sessions/${eventId}/schedule/generate`, {
    token: host.token, body: { expectedRevision: board.revision, rounds: 'all' },
  });
  expect(generated.status, JSON.stringify(generated.json)).toBe(200);
  const sectorOf = new Map<string, string>([...guests.map((g) => [g.id, g.sector] as [string, string]), [member.id, 'health']]);
  const round1 = generated.json.data.board.rounds[0];
  const rooms: string[][] = round1.rooms.map((r: { seats: Array<{ userId: string }> }) => r.seats.map((s) => s.userId));
  expect(rooms.flat().sort()).toEqual([...sectorOf.keys()].sort());
  for (const room of rooms) expect(new Set(room.map((id) => sectorOf.get(id))).size).toBe(1);
  const fintech = guests.filter((g) => g.sector === 'fintech').map((g) => g.id).sort();
  expect(rooms.some((room) => [...room].sort().join() === fintech.join())).toBe(true);

  // Published: a guest's own schedule carries no answers.
  const published = await call('POST', `/sessions/${eventId}/schedule/publish`, {
    token: host.token, body: { expectedRevision: generated.json.data.board.revision },
  });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  const mine = await call('GET', `/sessions/${eventId}/schedule/mine`, { token: guests[0].token });
  expect(mine.status).toBe(200);
  expect(mine.json.data).not.toBeNull();
  expect(JSON.stringify(mine.json)).not.toMatch(/fintech|health|answers|sector/);

  // The host's read counts the answers; a guest reads their own only.
  const hostView = await call('GET', `/sessions/${eventId}/questions`, { token: host.token });
  expect(hostView.status).toBe(200);
  expect(hostView.json.data.counts).toEqual({ sector: { fintech: 2, health: 3 } });
  expect(hostView.json.data.answers).toHaveLength(5);
  const guestView = await call('GET', `/sessions/${eventId}/questions`, { token: guests[0].token });
  expect(guestView.status).toBe(200);
  expect(guestView.json.data).toEqual({ questions: [question], mine: { sector: ['fintech'] }, missingRequired: [] });
});
