// e2e/tests/reason-m1-part-a-live.spec.ts
//
// REASON milestone 1, part A, proven on production right after the deploy.
//
//   A2  Save / Pass            PUT + DELETE /api/people/:userId/response
//   A3  "What happened?"       POST /api/people/:userId/outcome
//   A4  note + format          POST /api/matches/platform/:userId/interest, with the
//                              recipient's poke bell OFF, line breaks folded, both
//                              members' screens told through entity:changed
//   A4  one-tap request        unchanged wording, the note limit, a decline stays final
//   A4  request cards          /messages at 360, 390, 768, 1024 and 1280 wide
//
// Every check is on an outcome: the HTTP status AND the row in the database (or the
// socket event that really arrived), never "the page looked right" alone.
//
// Needs the deploy first: migration 101 and the new endpoints must be live. The
// beforeAll says so plainly if the database does not have migration 101 yet.
// Run it one engine at a time, and one spec per process (the pool is shared):
//   cd e2e
//   npx playwright test tests/reason-m1-part-a-live.spec.ts
//   E2E_ENGINE=webkit npx playwright test tests/reason-m1-part-a-live.spec.ts
//   E2E_ENGINE=webkit E2E_DEVICE='iPhone 14' npx playwright test tests/reason-m1-part-a-live.spec.ts
// E2E_JWT_SECRET must be production's signing key, or every call below is a 401.

import { test, expect, Browser, BrowserContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, connectSocket, wait, APP, SERVER } from '../helpers/live-ui';
import type { Socket } from '../helpers/live-ui';
import { launchBrowser, engineLabel, contextOptions } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// One id per run keeps every test address and every note unique and traceable.
const RUN = Date.now().toString(36);
const SHOTS = path.resolve(__dirname, '../../workspace/scratch/2026-10-03-reason-part-a-shots');

let browser: Browser | undefined;
const ctxs: BrowserContext[] = [];
const sockets: Socket[] = [];
// Every throwaway account, pushed the moment it exists, removed by exact id in afterAll.
const made: string[] = [];

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface Envelope<T> { success?: boolean; data?: T; error?: { code?: string; message?: string } }

// u = null sends no Authorization header at all.
async function api<T = unknown>(u: TestUser | null, method: string, apiPath: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (u) headers.Authorization = `Bearer ${u.accessToken}`;
  const res = await fetch(`${SERVER}/api${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The envelope is read loosely on purpose: an error reply has no data, a 500 may not be JSON.
  const parsed = (await res.json().catch(() => null)) as Envelope<T> | null;
  return { status: res.status, body: parsed };
}

// The reply's data, or an error that shows what the server actually said.
function dataOf<T>(r: { status: number; body: Envelope<T> | null }, what: string): T {
  if (r.body?.data === undefined) {
    throw new Error(`${what}: no data in the reply (HTTP ${r.status}) ${JSON.stringify(r.body)}`);
  }
  return r.body.data;
}

interface PokeJson {
  id: string; senderId: string; recipientId: string; status: string;
  message: string | null; preferredFormat: string | null;
}
interface ReceivedPoke extends PokeJson { senderDisplayName: string | null }
interface AcceptedJson { poke: PokeJson; conversationId: string }
interface OutcomeJson { id: string; worthContinuing: string; outcomes: string[]; createdAt: string }

// ── Accounts ─────────────────────────────────────────────────────────────────

// Resend refuses @example.com, and the request email would then log a 500 on
// Render. delivered+label@resend.dev is accepted and never reaches a real inbox.
async function makeUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`m1a-${label}`);
  made.push(u.id);
  const email = `delivered+m1a-${RUN}-${label}@resend.dev`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  return { ...u, email };
}

// ── Sockets ──────────────────────────────────────────────────────────────────

interface EntityLog {
  /** How many entity:changed events carried this tag so far. */
  countOf(tag: string): number;
  /** Every distinct tag heard so far. */
  all(): string[];
}

// Connect as the member and keep every entity:changed the server sends them.
async function listen(u: TestUser): Promise<EntityLog> {
  const sock = await connectSocket(u);
  sockets.push(sock);
  const events: string[][] = [];
  sock.on('entity:changed', (payload: { entities?: string[] }) => {
    events.push(Array.isArray(payload?.entities) ? payload.entities : []);
  });
  return {
    countOf: (tag) => events.filter((e) => e.includes(tag)).length,
    all: () => Array.from(new Set(events.flat())),
  };
}

// Wait until MORE than `moreThan` events carried the tag; say what was heard if not.
async function waitForTag(log: EntityLog, tag: string, moreThan: number, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (log.countOf(tag) > moreThan) return;
    await wait(100);
  }
  throw new Error(`${label}: no entity:changed carrying ${tag} within ${ms / 1000}s. Heard: ${log.all().join(', ') || 'nothing'}`);
}

// ── Hooks ────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  console.log(`[reason-m1-part-a-live] engine=${engineLabel()} app=${APP} api=${SERVER}`);
  // Read-only: is migration 101 on the database this run talks to?
  const ready = (await pool.query<{ people: string | null; outcomes: string | null; format: number }>(
    `SELECT to_regclass('public.person_responses')::text AS people,
            to_regclass('public.meeting_outcomes')::text AS outcomes,
            (SELECT COUNT(*)::int FROM information_schema.columns
              WHERE table_name = 'user_pokes' AND column_name = 'preferred_format') AS format`,
  )).rows[0];
  if (!ready.people || !ready.outcomes || ready.format < 1) {
    throw new Error('Migration 101 is not on this database yet (person_responses, meeting_outcomes, user_pokes.preferred_format). Deploy the server first.');
  }
});

test.afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

test.afterAll(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (made.length) await cleanup(pool, { ids: made });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. A2: Save / Pass
// ═════════════════════════════════════════════════════════════════════════════

test('A2 Save and Pass: one row per pair, the latest choice wins, undo clears it, bad calls change nothing', async () => {
  test.setTimeout(180_000);
  const actor = await makeUser('saver');
  const person = await makeUser('saved');
  const actorLog = await listen(actor);
  const personLog = await listen(person);
  const url = `/people/${person.id}/response`;
  const mine = `user:${actor.id}`;

  const rows = async () => (await pool.query<{ response: string }>(
    `SELECT response FROM person_responses WHERE user_id = $1 AND target_user_id = $2`,
    [actor.id, person.id],
  )).rows;

  // Save: the row exists and the member's own screens are told.
  let heard = actorLog.countOf(mine);
  const saved = await api<{ response: string }>(actor, 'PUT', url, { response: 'saved' });
  expect(saved.status, `PUT saved: ${JSON.stringify(saved.body)}`).toBe(200);
  expect(saved.body?.data?.response).toBe('saved');
  expect(await rows(), 'one row, saved').toEqual([{ response: 'saved' }]);
  await waitForTag(actorLog, mine, heard, 'after Save');

  // Pass replaces it: still ONE row for the pair, now passed.
  heard = actorLog.countOf(mine);
  const passed = await api<{ response: string }>(actor, 'PUT', url, { response: 'passed' });
  expect(passed.status, `PUT passed: ${JSON.stringify(passed.body)}`).toBe(200);
  expect(passed.body?.data?.response).toBe('passed');
  expect(await rows(), 'still one row, now passed').toEqual([{ response: 'passed' }]);
  await waitForTag(actorLog, mine, heard, 'after Pass');

  // Undo clears it.
  heard = actorLog.countOf(mine);
  const undone = await api(actor, 'DELETE', url);
  expect(undone.status, `DELETE: ${JSON.stringify(undone.body)}`).toBe(200);
  expect(await rows(), 'undo leaves no row').toEqual([]);
  await waitForTag(actorLog, mine, heard, 'after undo');
  console.log('  ✓ Save, Pass (still one row) and undo, each followed by user:<member> on their own socket.');

  // Calls that must be refused, and must leave the table empty.
  expect((await api(actor, 'PUT', url, { response: 'like' })).status, 'an answer other than saved or passed').toBe(400);
  expect((await api(actor, 'PUT', url, {})).status, 'no answer at all').toBe(400);
  expect((await api(actor, 'PUT', '/people/not-a-member-id/response', { response: 'saved' })).status, 'an id that is not a member id').toBe(400);
  expect((await api(actor, 'DELETE', '/people/not-a-member-id/response')).status, 'undo with an id that is not a member id').toBe(400);
  expect((await api(actor, 'PUT', `/people/${actor.id}/response`, { response: 'saved' })).status, 'saving yourself').toBe(400);
  expect((await api(actor, 'PUT', `/people/${randomUUID()}/response`, { response: 'saved' })).status, 'a member who does not exist').toBe(404);
  expect((await api(null, 'PUT', url, { response: 'saved' })).status, 'no token').toBe(401);
  const stray = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM person_responses WHERE user_id = $1`, [actor.id])).rows[0].n;
  expect(stray, 'none of the refused calls wrote a row').toBe(0);
  console.log('  ✓ 400 (answer, no answer, bad id x2, yourself), 404 (unknown member), 401 (no token); no row written.');

  // Private: the person who was saved and passed was told nothing.
  await wait(1500); // a negative check: give a stray event time to (wrongly) arrive
  expect(personLog.all(), 'the person who was saved or passed hears nothing').toEqual([]);
  console.log('  ✓ the other member received no event.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A3: "What happened?" after two people met
// ═════════════════════════════════════════════════════════════════════════════

test('A3 outcomes: refused until the two are connected, then stored under the member who answered', async () => {
  test.setTimeout(180_000);
  const one = await makeUser('first-answerer');
  const two = await makeUser('second-answerer');
  // The server orders every pair by id. Answering from BOTH sides covers both orders:
  // the lower id and the higher id each have to be stored under their own name.
  const [low, high] = one.id < two.id ? [one, two] : [two, one];
  const pair = [low.id, high.id];
  const toHigh = `/people/${high.id}/outcome`;
  const toLow = `/people/${low.id}/outcome`;

  const outcomeRows = async () => (await pool.query<{
    user_id: string; target_user_id: string; worth_continuing: string; outcome_keys: string[];
  }>(
    `SELECT user_id, target_user_id, worth_continuing, outcome_keys
       FROM meeting_outcomes
      WHERE user_id = ANY($1) OR target_user_id = ANY($1)
      ORDER BY user_id, created_at, id`,
    [pair],
  )).rows;

  // Strangers: refused from either side, nothing stored.
  const answer = { worthContinuing: 'yes', outcomes: ['introduction'] };
  expect((await api(low, 'POST', toHigh, answer)).status, 'not connected yet (lower id answers)').toBe(409);
  expect((await api(high, 'POST', toLow, answer)).status, 'not connected yet (higher id answers)').toBe(409);
  expect(await outcomeRows(), 'a refused answer is not stored').toEqual([]);
  console.log('  ✓ 409 from both sides before the two are connected; no row.');

  // Connect them the real way: a meeting request, accepted.
  const sent = await api<PokeJson>(low, 'POST', '/pokes', { recipientId: high.id, message: 'Coffee on Thursday?' });
  expect(sent.status, `request: ${JSON.stringify(sent.body)}`).toBe(201);
  const accepted = await api<AcceptedJson>(high, 'POST', `/pokes/${dataOf(sent, 'request').id}/accept`);
  expect(accepted.status, `accept: ${JSON.stringify(accepted.body)}`).toBe(200);
  const link = (await pool.query<{ enc: number; dm: number }>(
    `SELECT (SELECT COUNT(*)::int FROM encounter_history
              WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)) AS enc,
            (SELECT COUNT(*)::int FROM dm_conversations
              WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)) AS dm`,
    [low.id, high.id],
  )).rows[0];
  expect(link, 'accepting connects the pair (an encounter and a conversation)').toEqual({ enc: 1, dm: 1 });

  // Connected: each side answers, and the answer carries the person who gave it.
  const fromLow = await api<OutcomeJson>(low, 'POST', toHigh, { worthContinuing: 'yes', outcomes: ['introduction', 'introduction', 'advice'] });
  expect(fromLow.status, `lower id answers: ${JSON.stringify(fromLow.body)}`).toBe(201);
  const lowData = dataOf(fromLow, 'lower id answer');
  expect(lowData.worthContinuing).toBe('yes');
  expect(lowData.outcomes, 'duplicates are removed in the reply').toEqual(['introduction', 'advice']);
  expect(lowData.id, 'the reply carries the new row id').toMatch(/^[0-9a-f-]{36}$/);
  expect(new Date(lowData.createdAt).toISOString(), 'createdAt is an ISO date').toBe(lowData.createdAt);

  const fromHigh = await api<OutcomeJson>(high, 'POST', toLow, { worthContinuing: 'maybe', outcomes: ['follow_up', 'follow_up'] });
  expect(fromHigh.status, `higher id answers: ${JSON.stringify(fromHigh.body)}`).toBe(201);
  expect(dataOf(fromHigh, 'higher id answer').outcomes, 'duplicates are removed in the reply').toEqual(['follow_up']);

  expect(await outcomeRows(), 'each row is stored under the member who answered').toEqual([
    { user_id: low.id, target_user_id: high.id, worth_continuing: 'yes', outcome_keys: ['introduction', 'advice'] },
    { user_id: high.id, target_user_id: low.id, worth_continuing: 'maybe', outcome_keys: ['follow_up'] },
  ]);
  console.log('  ✓ 201 from both sides, duplicates removed, each row under its own author.');

  // It is a history: a second answer from the same member is a second row.
  const again = await api<OutcomeJson>(low, 'POST', toHigh, { worthContinuing: 'no', outcomes: [] });
  expect(again.status, `a second answer: ${JSON.stringify(again.body)}`).toBe(201);
  const history = await outcomeRows();
  expect(history.filter((r) => r.user_id === low.id), 'the lower id now has two answers').toHaveLength(2);
  expect(history.filter((r) => r.user_id === high.id), 'the higher id still has one').toHaveLength(1);

  // Bad calls, even now that the pair is connected: nothing new is stored.
  const before = history.length;
  expect((await api(low, 'POST', toHigh, { worthContinuing: 'definitely', outcomes: ['marriage'] })).status, 'both values outside the lists').toBe(400);
  expect((await api(low, 'POST', toHigh, { worthContinuing: 'definitely', outcomes: [] })).status, 'worth continuing outside the list').toBe(400);
  expect((await api(low, 'POST', toHigh, { worthContinuing: 'yes', outcomes: ['marriage'] })).status, 'an outcome outside the list').toBe(400);
  expect((await api(low, 'POST', `/people/${low.id}/outcome`, { worthContinuing: 'yes', outcomes: [] })).status, 'answering about yourself').toBe(400);
  expect((await api(low, 'POST', '/people/not-a-member-id/outcome', { worthContinuing: 'yes', outcomes: [] })).status, 'an id that is not a member id').toBe(400);
  expect((await api(null, 'POST', toHigh, answer)).status, 'no token').toBe(401);
  expect(await outcomeRows(), 'the refused answers wrote nothing').toHaveLength(before);
  console.log('  ✓ a second answer adds a row; 400 for bad values and yourself, 401 without a token; nothing extra stored.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. A4: a note and a format, with the recipient's poke bell OFF
// ═════════════════════════════════════════════════════════════════════════════

test('A4 note and format with the bell off: stored, line breaks folded, both screens told, no bell row, accept works', async () => {
  test.setTimeout(240_000);
  const sender = await makeUser('asker');
  const recipient = await makeUser('asked');
  const control = await makeUser('asked-bell-on');

  // The recipient turns the poke bell off. COALESCE covers a member with no stored prefs.
  await pool.query(
    `UPDATE users
        SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || '{"poke_bell": false}'::jsonb
      WHERE id = $1`,
    [recipient.id],
  );
  const prefs = (await pool.query<{ poke_bell: string | null }>(
    `SELECT notification_prefs->>'poke_bell' AS poke_bell FROM users WHERE id = $1`, [recipient.id])).rows[0];
  expect(prefs.poke_bell, 'the recipient has the poke bell off').toBe('false');

  // Both members listen BEFORE the request goes out.
  const senderLog = await listen(sender);
  const recipientLog = await listen(recipient);

  const note = `Hello ${RUN}\n\n\n\n\nsecond paragraph`;
  const sent = await api<PokeJson>(sender, 'POST', `/matches/platform/${recipient.id}/interest`, { note, format: 'coffee' });
  expect(sent.status, `interest: ${JSON.stringify(sent.body)}`).toBe(201);
  const poke = dataOf(sent, 'interest');
  expect(poke.preferredFormat, 'the reply carries the format').toBe('coffee');

  // What the recipient is shown.
  const received = dataOf(await api<ReceivedPoke[]>(recipient, 'GET', '/pokes/received'), 'received list');
  const item = received.find((p) => p.id === poke.id);
  expect(item, 'the recipient lists the request').toBeDefined();
  expect(item?.message, 'it leads with the note').toMatch(new RegExp(`^Hello ${RUN}`));
  expect(item?.message, 'five line breaks were folded to one blank line').toMatch(new RegExp(`^Hello ${RUN}\\n\\nsecond paragraph`));
  expect(item?.message, 'no run of three line breaks survives').not.toMatch(/\n{3,}/);
  expect(item?.preferredFormat, 'the list carries the format').toBe('coffee');

  // What is stored.
  const row = (await pool.query<{ preferred_format: string | null; status: string; message: string | null }>(
    `SELECT preferred_format, status, message FROM user_pokes WHERE id = $1`, [poke.id])).rows[0];
  expect(row.preferred_format, 'the format is stored').toBe('coffee');
  expect(row.status).toBe('pending');
  expect(row.message, 'the stored message is folded too').not.toMatch(/\n{3,}/);
  console.log('  ✓ 201; the recipient lists the folded note with preferredFormat coffee; the row agrees.');

  // Both screens are told, whatever the bell setting; only the bell's own tag is withheld.
  await waitForTag(senderLog, `user:${sender.id}`, 0, 'sender');
  await waitForTag(senderLog, `user:${sender.id}:invites`, 0, 'sender');
  await waitForTag(recipientLog, `user:${recipient.id}`, 0, 'recipient');
  await waitForTag(recipientLog, `user:${recipient.id}:invites`, 0, 'recipient');
  await wait(2000); // a negative check: give the withheld tag time to (wrongly) arrive
  expect(recipientLog.countOf(`user:${recipient.id}:notifications`),
    `bell off: the recipient's bell tag is withheld (heard: ${recipientLog.all().join(', ')})`).toBe(0);
  const bellRows = await pool.query(
    `SELECT id FROM notifications WHERE user_id = $1 AND (type = 'poke' OR link = $2)`,
    [recipient.id, `/messages?poke=${poke.id}`]);
  expect(bellRows.rows, 'bell off: no bell notification row for this request').toEqual([]);
  console.log('  ✓ sender and recipient both heard user:<id> and user:<id>:invites; no bell tag, no bell row.');

  // Control for the negative check above: the same request to a member whose bell is ON
  // does create the bell row and does send the bell tag. Without it, "never saw" could
  // pass just because the tag is never sent at all.
  const controlLog = await listen(control);
  const controlSent = await api<PokeJson>(sender, 'POST', `/matches/platform/${control.id}/interest`, { note: `Hello again ${RUN}` });
  expect(controlSent.status, `control interest: ${JSON.stringify(controlSent.body)}`).toBe(201);
  const controlPoke = dataOf(controlSent, 'control interest');
  await waitForTag(controlLog, `user:${control.id}:notifications`, 0, 'bell on');
  const controlBell = await pool.query<{ link: string }>(
    `SELECT link FROM notifications WHERE user_id = $1 AND type = 'poke'`, [control.id]);
  expect(controlBell.rows.map((r) => r.link), 'bell on: the bell row exists').toEqual([`/messages?poke=${controlPoke.id}`]);
  console.log('  ✓ control: with the bell on, the bell row and the bell tag are there.');

  // The recipient accepts: the row flips and the reply still carries the format.
  const accepted = await api<AcceptedJson>(recipient, 'POST', `/pokes/${poke.id}/accept`);
  expect(accepted.status, `accept: ${JSON.stringify(accepted.body)}`).toBe(200);
  const acceptedData = dataOf(accepted, 'accept');
  expect(acceptedData.poke.preferredFormat, 'accept reads the format column').toBe('coffee');
  expect(acceptedData.conversationId, 'accepting opens a conversation').toMatch(/^[0-9a-f-]{36}$/);
  const after = (await pool.query<{ status: string }>(`SELECT status FROM user_pokes WHERE id = $1`, [poke.id])).rows[0];
  expect(after.status).toBe('accepted');
  console.log('  ✓ accepted: 200, format still coffee, row accepted.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. A4: the one-tap request is unchanged; limits; a decline stays final
// ═════════════════════════════════════════════════════════════════════════════

test('A4 one-tap request is unchanged, the note limit holds, and a declined request stays final', async () => {
  test.setTimeout(240_000);
  const asker = await makeUser('tapper');
  const asked = await makeUser('tapped');
  const edgeAsked = await makeUser('edge-asked');
  const url = `/matches/platform/${asked.id}/interest`;
  const pokeCount = async () => (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`,
    [asker.id, asked.id])).rows[0].n;

  // Refused before anything is written.
  expect((await api(asker, 'POST', '/matches/platform/not-a-member-id/interest')).status, 'an id that is not a member id').toBe(400);
  expect((await api(asker, 'POST', url, { format: 'dinner' })).status, 'an unknown format').toBe(400);
  expect((await api(asker, 'POST', url, { note: 'x'.repeat(301) })).status, 'a 301 character note').toBe(400);
  expect(await pokeCount(), 'the refused calls wrote no request').toBe(0);

  // No body at all: today's one-tap request.
  const sent = await api<PokeJson>(asker, 'POST', url);
  expect(sent.status, `one-tap interest: ${JSON.stringify(sent.body)}`).toBe(201);
  const poke = dataOf(sent, 'one-tap interest');
  expect(poke.preferredFormat, 'no format asked for').toBeNull();
  const received = dataOf(await api<ReceivedPoke[]>(asked, 'GET', '/pokes/received'), 'received list');
  const item = received.find((p) => p.id === poke.id);
  expect(item, 'the recipient lists the request').toBeDefined();
  expect(item?.message, 'the old one-tap wording').toMatch(/We think you two should meet\.$/);
  expect(item?.preferredFormat, 'no format on the list item').toBeNull();
  const stored = (await pool.query<{ preferred_format: string | null; status: string }>(
    `SELECT preferred_format, status FROM user_pokes WHERE id = $1`, [poke.id])).rows[0];
  expect(stored.preferred_format, 'no format stored').toBeNull();
  expect(stored.status).toBe('pending');
  console.log('  ✓ no body: 201, "...We think you two should meet.", preferredFormat null; 400 for bad id, format, 301 characters.');

  // Declined: 200, the row says declined, and the sender cannot ask again.
  const declined = await api<PokeJson>(asked, 'POST', `/pokes/${poke.id}/decline`);
  expect(declined.status, `decline: ${JSON.stringify(declined.body)}`).toBe(200);
  expect(dataOf(declined, 'decline').preferredFormat).toBeNull();
  const afterDecline = (await pool.query<{ status: string }>(`SELECT status FROM user_pokes WHERE id = $1`, [poke.id])).rows[0];
  expect(afterDecline.status).toBe('declined');
  expect((await api(asker, 'POST', url)).status, 'asking again after a decline').toBe(403);
  expect(await pokeCount(), 'the refused re-ask wrote nothing').toBe(1);
  console.log('  ✓ declined: 200, row declined, a re-ask is 403 and writes nothing.');

  // The limit is inclusive: exactly 300 characters goes through, with a format, and a
  // decline of that request hands the format back.
  const edgeNote = `${'Coffee and conversation. '.repeat(12).slice(0, 299)}!`;
  expect(edgeNote, 'the test note is exactly 300 characters').toHaveLength(300);
  const edgeSent = await api<PokeJson>(asker, 'POST', `/matches/platform/${edgeAsked.id}/interest`, { note: edgeNote, format: 'message_first' });
  expect(edgeSent.status, `300 character note: ${JSON.stringify(edgeSent.body)}`).toBe(201);
  const edgePoke = dataOf(edgeSent, '300 character note');
  const edgeRow = (await pool.query<{ message: string | null; preferred_format: string | null }>(
    `SELECT message, preferred_format FROM user_pokes WHERE id = $1`, [edgePoke.id])).rows[0];
  expect(edgeRow.message?.startsWith(edgeNote), 'the whole 300 character note is stored').toBe(true);
  expect(edgeRow.preferred_format).toBe('message_first');
  const edgeDeclined = await api<PokeJson>(edgeAsked, 'POST', `/pokes/${edgePoke.id}/decline`);
  expect(edgeDeclined.status, `decline of the 300 character request: ${JSON.stringify(edgeDeclined.body)}`).toBe(200);
  expect(dataOf(edgeDeclined, 'decline').preferredFormat, 'decline reads the format column').toBe('message_first');
  console.log('  ✓ a 300 character note with a format goes through; its decline returns the format.');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. A4 client: the request cards at every screen size (headed)
// ═════════════════════════════════════════════════════════════════════════════

// Twelve short lines, one line break between each: well under 300 characters, so
// the server's fold (three or more line breaks only) leaves every one of them.
const NOTE_LINES = [
  'Line one: hello', 'Line two: coffee', 'Line three: notebook', 'Line four: station',
  'Line five: morning', 'Line six: sunshine', 'Line seven: Tuesday', 'Line eight: umbrella',
  'Line nine: bicycle', 'Line ten: harbour', 'Line eleven: lantern', 'Line twelve: goodbye',
];
const NOTE = NOTE_LINES.join('\n');
const FIRST_LINE = NOTE_LINES[0];
const LAST_LINE = NOTE_LINES[NOTE_LINES.length - 1];
const PREFERS = 'Prefers in person coffee';

const DEVICE = process.env.E2E_DEVICE;
const MATRIX = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
// With E2E_DEVICE set, the device's own viewport is the only size.
function viewports(): Array<{ width: number; height: number }> {
  if (!DEVICE) return MATRIX;
  return [contextOptions().viewport ?? { width: 390, height: 844 }];
}

// The browser's own notice that a resize observer needed another frame. It is not an
// application error, and the Messages page does use a resize observer.
const BENIGN_PAGE_ERROR = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i;

interface ClampReading { clamp: string; lineHeight: number; shown: number; natural: number }

// Runs inside the page, so it must not use anything from this file. Measures how tall
// the paragraph is on screen (`shown`) and how tall the same text would be with no
// clamp (`natural`, from a hidden copy), plus the paragraph's line height and its
// computed -webkit-line-clamp.
function measureClamp(el: HTMLElement): ClampReading {
  const cs = window.getComputedStyle(el);
  const clamp = cs.getPropertyValue('-webkit-line-clamp') || cs.getPropertyValue('line-clamp');
  const parsed = parseFloat(cs.lineHeight);
  const lineHeight = isFinite(parsed) ? parsed : parseFloat(cs.fontSize) * 1.2;
  const box = el.getBoundingClientRect();
  const probe = el.cloneNode(true) as HTMLElement;
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;display:block;overflow:visible;height:auto;max-height:none;width:' + box.width + 'px';
  probe.style.setProperty('-webkit-line-clamp', 'none');
  (el.parentElement as HTMLElement).appendChild(probe);
  const natural = probe.getBoundingClientRect().height;
  probe.remove();
  return { clamp, lineHeight, shown: box.height, natural };
}

// Runs inside the page. 'ok' when the LAST line of the paragraph is inside the window
// and is what a person would hit at that spot (not clipped by a parent, not covered).
function lastLineOnScreen(el: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return 'the paragraph has no text rectangles';
  let last = rects[0];
  for (const r of rects) if (r.bottom > last.bottom) last = r;
  if (last.top < 0 || last.bottom > window.innerHeight || last.left < 0 || last.right > window.innerWidth) {
    return 'the last line is outside the window: top=' + Math.round(last.top) + ' bottom=' + Math.round(last.bottom) + ' of ' + window.innerHeight;
  }
  const hit = document.elementFromPoint(last.left + last.width / 2, last.top + last.height / 2);
  if (!hit || !(hit === el || el.contains(hit))) {
    return 'the last line is clipped or covered by ' + (hit ? hit.tagName.toLowerCase() : 'nothing');
  }
  return 'ok';
}

const firstLineOf = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0];

test('A4 request cards on every screen size: note, format line, six-line clamp, no sideways scroll, buttons reachable', async () => {
  test.setTimeout(420_000);
  const asker = await makeUser('card-asker');
  const reader = await makeUser('card-reader');

  // The recipient has exactly one pending request: twelve lines and a format.
  expect(NOTE.length, 'the fixture note stays under the 300 character limit').toBeLessThanOrEqual(300);
  const sent = await api<PokeJson>(asker, 'POST', `/matches/platform/${reader.id}/interest`, { note: NOTE, format: 'coffee' });
  expect(sent.status, `interest: ${JSON.stringify(sent.body)}`).toBe(201);
  const pokeId = dataOf(sent, 'interest').id;
  const stored = (await pool.query<{ status: string; preferred_format: string | null; message: string | null }>(
    `SELECT status, preferred_format, message FROM user_pokes WHERE id = $1`, [pokeId])).rows[0];
  expect(stored.status).toBe('pending');
  expect(stored.preferred_format, 'the format is stored').toBe('coffee');
  expect(stored.message?.startsWith(NOTE), 'single line breaks are kept by the fold').toBe(true);
  const pending = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM user_pokes WHERE recipient_id = $1 AND status = 'pending'`, [reader.id])).rows[0].n;
  expect(pending, 'one pending request').toBe(1);

  fs.mkdirSync(SHOTS, { recursive: true });
  const label = engineLabel().replace(/[^a-z0-9]+/gi, '-');
  const problems: string[] = [];
  const pageErrors: string[] = [];
  const info = test.info();
  const note = (type: string, description: string) => info.annotations.push({ type, description });
  browser = await launchBrowser();

  for (const vp of viewports()) {
    const size = `${vp.width}x${vp.height}`;
    const ctx = await browser.newContext(DEVICE ? contextOptions() : { viewport: vp });
    ctxs.push(ctx);
    await ctx.addInitScript((t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a);
      localStorage.setItem('rsn_refresh', t.r);
      localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
    }, { a: reader.accessToken, r: reader.refreshToken });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => {
      if (!BENIGN_PAGE_ERROR.test(e.message)) pageErrors.push(`${size} ${page.url()}: ${e.message}`);
    });

    try {
      // ── The list: /messages ────────────────────────────────────────────────
      await gotoRetry(page, `${APP}/messages`);
      const card = page.locator(`[data-testid="meeting-request"][data-poke-id="${pokeId}"]`);
      await expect(card, `${size}: the request is on the page`).toBeVisible({ timeout: 30_000 });
      await expect(card, `${size}: the request shows its note`).toContainText(FIRST_LINE, { timeout: 30_000 });
      // Sizes mean nothing until the stylesheet and fonts have applied.
      await page.waitForLoadState('load');
      await page.evaluate(async () => { await document.fonts.ready; });

      const msg = card.locator('p', { hasText: FIRST_LINE });
      await expect(msg, `${size}: the note paragraph`).toHaveCount(1);
      await expectReachable(page, msg, `${size} the note`);
      await expectReachable(page, card.getByText(PREFERS), `${size} the "${PREFERS}" line`);

      // Clamped to six lines, and the note really is twelve lines tall without the clamp.
      const row = await msg.evaluate(measureClamp);
      note(`row-${size}`, `line height ${row.lineHeight}px, shown ${Math.round(row.shown)}px, unclamped ${Math.round(row.natural)}px, clamp ${row.clamp}`);
      expect(row.clamp, `${size}: computed -webkit-line-clamp`).toBe('6');
      expect(row.natural, `${size}: the twelve line breaks make twelve lines (whitespace-pre-line)`).toBeGreaterThanOrEqual(12 * row.lineHeight - 2);
      expect(row.shown, `${size}: the row shows at most six lines (${Math.round(row.shown)}px of ${Math.round(row.natural)}px)`).toBeLessThanOrEqual(6 * row.lineHeight + 2);
      expect(row.shown, `${size}: the row shows six lines, not fewer`).toBeGreaterThanOrEqual(6 * row.lineHeight - 2);

      // No sideways scroll.
      const sw = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(sw.scroll, `${size}: sideways scroll (scrollWidth ${sw.scroll} over innerWidth ${sw.inner})`).toBeLessThanOrEqual(sw.inner);

      // Accept and Decline can be pressed where they are, without scrolling.
      const accept = await expectReachable(page, card.getByRole('button', { name: /^Accept$/ }), `${size} Accept`);
      const decline = await expectReachable(page, card.getByRole('button', { name: /^Decline$/ }), `${size} Decline`);
      note(`tap-${size}`, `Accept ${Math.round(accept.width)}x${Math.round(accept.height)}px, Decline ${Math.round(decline.width)}x${Math.round(decline.height)}px`);

      await page.screenshot({ path: path.join(SHOTS, `${label}-${vp.width}.png`), fullPage: true });
      console.log(`  ✓ ${size} list: note + "${PREFERS}" on screen, row ${Math.round(row.shown)}px of ${Math.round(row.natural)}px (clamp ${row.clamp}), no sideways scroll, Accept ${Math.round(accept.height)}px / Decline ${Math.round(decline.height)}px tall and reachable.`);

      // ── The focused card: /messages?poke=<id>, shown from 1024 wide ─────────
      if (vp.width >= 1024) {
        await gotoRetry(page, `${APP}/messages?poke=${pokeId}`);
        const focused = page.getByTestId('focused-meeting-request');
        await expect(focused, `${size}: the focused card is on the page`).toBeVisible({ timeout: 30_000 });
        await expect(focused.getByText(LAST_LINE), `${size}: the focused card shows the twelfth line`).toBeVisible({ timeout: 30_000 });
        await page.waitForLoadState('load');
        await page.evaluate(async () => { await document.fonts.ready; });

        const full = focused.locator('p', { hasText: FIRST_LINE });
        await expect(full, `${size}: the focused note paragraph`).toHaveCount(1);
        const open = await full.evaluate(measureClamp);
        note(`focused-${size}`, `line height ${open.lineHeight}px, shown ${Math.round(open.shown)}px, unclamped ${Math.round(open.natural)}px, clamp ${open.clamp}`);
        expect(open.clamp, `${size}: the focused card is not clamped`).toBe('none');
        expect(open.shown, `${size}: all twelve lines are laid out`).toBeGreaterThanOrEqual(12 * open.lineHeight - 2);
        expect(Math.abs(open.natural - open.shown), `${size}: nothing is cut from the focused note`).toBeLessThanOrEqual(2);
        expect(await full.evaluate(lastLineOnScreen), `${size}: the twelfth line is on screen, not clipped or covered`).toBe('ok');
        await expectReachable(page, focused.getByText(PREFERS), `${size} focused "${PREFERS}" line`);

        // Informational only: with a long note the card can outgrow a short window.
        const focusedAccept = await expectReachable(page, focused.getByRole('button', { name: /^Accept$/ }), `${size} focused Accept`)
          .then((b) => `reachable, ${Math.round(b.width)}x${Math.round(b.height)}px`, (e) => `NOT reachable: ${firstLineOf(e)}`);
        const focusedDecline = await expectReachable(page, focused.getByRole('button', { name: /^Decline$/ }), `${size} focused Decline`)
          .then((b) => `reachable, ${Math.round(b.width)}x${Math.round(b.height)}px`, (e) => `NOT reachable: ${firstLineOf(e)}`);
        note(`focused-buttons-${size}`, `Accept ${focusedAccept}; Decline ${focusedDecline}`);

        await page.screenshot({ path: path.join(SHOTS, `${label}-${vp.width}-focused.png`), fullPage: true });
        console.log(`  ✓ ${size} focused card: all twelve lines (${Math.round(open.shown)}px), the twelfth on screen, "${PREFERS}" shown. Buttons: Accept ${focusedAccept}; Decline ${focusedDecline}.`);
      }
    } catch (e) {
      problems.push(`${size}: ${firstLineOf(e)}`);
      console.log(`  ✗ ${size}: ${firstLineOf(e)}`);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${vp.width}-FAILED.png`), fullPage: true }).catch(() => undefined);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }

  expect(pageErrors, 'no script errors on any page').toEqual([]);
  expect(problems, `sizes with a problem:\n${problems.join('\n')}`).toEqual([]);
});
