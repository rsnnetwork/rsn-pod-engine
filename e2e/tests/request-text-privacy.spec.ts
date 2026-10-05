// e2e/tests/request-text-privacy.spec.ts
//
// A meeting request never quotes the recipient's own private want. Proven on
// production right after the fix is deployed (5 Oct 2026).
//
// The gap: POST /api/matches/platform/:userId/interest ("I want to meet") used to
// fall back, when the sender had stated no want that fitted the recipient, to
// text written from the RECIPIENT's own want ("What you're looking for matches
// their profile: <their words>"). The sender reads the stored message in several
// places: the 201 response, the first message of the conversation once the
// recipient accepts, and the "accepted your request" bell. So pressing the button
// told a member what another member privately wants to meet.
//
// The fixture is built so that the OLD code would have fired. Each recipient's own
// want is three made-up words only this run uses; the sender has NO want of any
// kind but lists exactly those three words as expertise, so the recipient's want
// fits the sender. A control reads the recipient's own Matches card to prove that
// fit is real before anything is asserted about the request.
//
// Every check is on an outcome: the HTTP status AND the stored row (or what the
// sender is actually sent), never "the page looked right".
//
// There is no screen to look at: the fix changes the stored text only, and every
// client shows that text unchanged. Run it one spec per process (the pool is shared):
//   cd e2e
//   npx playwright test tests/request-text-privacy.spec.ts
// E2E_JWT_SECRET must be production's signing key, or every call below is a 401.

import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, SERVER } from '../helpers/live-ui';

// One id per run keeps every address, word and note unique and traceable.
const RUN = Date.now().toString(36);
// Three made-up words nobody else has. The recipients WANT them; the sender's
// expertise lists them, so a recipient's want fits the sender and the old
// fallback would have quoted them.
const WORDS = [`zq${RUN}`, `wx${RUN}`, `vk${RUN}`];
const THE_WANT = WORDS.join(' ');
// The three openings the old fallback wrote its sentence with.
const OLD_OPENINGS = ["You're looking to meet", "What you're looking for", 'Their profile matches'];

// Every throwaway account, pushed the moment it exists, removed by exact id in afterAll.
const made: string[] = [];

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface Envelope<T> { success?: boolean; data?: T; error?: { code?: string; message?: string } }

async function api<T = unknown>(u: TestUser, method: string, apiPath: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
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

interface PokeJson { id: string; senderId: string; recipientId: string; status: string; message: string | null }
interface AcceptedJson { poke: PokeJson; conversationId: string }
interface MatchesJson { matches: Array<{ userId: string; reason: string; score: number }> }

// ── Accounts ─────────────────────────────────────────────────────────────────

// Resend refuses @example.com, and the request email would then log a 500 on
// Render. delivered+label@resend.dev is accepted and never reaches a real inbox.
async function makeUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`rtp-${label}`);
  made.push(u.id);
  const email = `delivered+rtp-${RUN}-${label}@resend.dev`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  return { ...u, email };
}

// ── The check ────────────────────────────────────────────────────────────────

// Fails with the text itself and what was found in it, so a leak is readable in the log.
function expectNoWant(text: string | null | undefined, where: string): void {
  const haystack = (text ?? '').toLowerCase();
  const found = [...WORDS, ...OLD_OPENINGS].filter((p) => haystack.includes(p.toLowerCase()));
  expect(found, `${where} quotes the recipient's own want (${found.join(', ')}): "${text}"`).toEqual([]);
}

// ── Hooks ────────────────────────────────────────────────────────────────────

test.afterAll(async () => {
  if (made.length) await cleanup(pool, { ids: made });
});

// ═════════════════════════════════════════════════════════════════════════════

test('a meeting request says only what the sender shared, never the recipient\'s own want', async () => {
  test.setTimeout(180_000);
  const sender = await makeUser('sender');
  const recipient = await makeUser('recipient');
  const noteRecipient = await makeUser('note-recipient');

  // Both recipients WANT the three words. The sender has no want and lists them as expertise.
  for (const r of [recipient, noteRecipient]) {
    await pool.query(`UPDATE users SET who_i_want_to_meet = $2 WHERE id = $1`, [r.id, THE_WANT]);
  }
  await pool.query(`UPDATE users SET expertise_text = $2 WHERE id = $1`, [sender.id, THE_WANT]);

  // The scenario the old code mishandled needs a sender with no want of any kind.
  const s = (await pool.query<{ who: string | null; intent: string | null; why: string | null; goals: string[] | null }>(
    `SELECT who_i_want_to_meet AS who, my_intent AS intent, why_i_want_to_meet AS why, goals
       FROM users WHERE id = $1`, [sender.id])).rows[0];
  expect([s.who, s.intent, s.why].map((v) => v ?? ''), 'the sender stated no want of any kind').toEqual(['', '', '']);
  expect(s.goals ?? [], 'the sender has no goals either').toEqual([]);

  // Control: each recipient's own want really does fit the sender. This is exactly
  // what the old fallback read. It is the recipient's own card, so it may name the
  // words; what must never happen is the sender being sent them.
  for (const r of [recipient, noteRecipient]) {
    const mine = dataOf(await api<MatchesJson>(r, 'GET', '/matches/platform'), 'the recipient\'s matches');
    const fit = mine.matches.find((m) => m.userId === sender.id);
    expect(fit, `control: ${r.displayName}'s own want fits the sender, so the old fallback would have fired`).toBeDefined();
    for (const w of WORDS) {
      expect(fit?.reason, `control: ${r.displayName}'s own match card names ${w}`).toContain(w);
    }
    if (r === recipient) console.log(`  control: the recipient's own card says "${fit?.reason}"`);
  }
  console.log('  ✓ the sender has no want; each recipient\'s own want fits the sender (the old fallback would have fired).');

  // ── 1. One tap, no note: the neutral sentence, everywhere the sender can read it ──
  const neutral = `${sender.displayName} thinks you fit what they're looking for. We think you two should meet.`;
  const sent = await api<PokeJson>(sender, 'POST', `/matches/platform/${recipient.id}/interest`);
  expect(sent.status, `interest: ${JSON.stringify(sent.body)}`).toBe(201);
  const poke = dataOf(sent, 'interest');
  expectNoWant(JSON.stringify(sent.body), 'the 201 response');
  expect(poke.message, 'the 201 response carries the neutral sentence').toBe(neutral);

  const received = dataOf(await api<Array<PokeJson & { senderDisplayName: string | null }>>(recipient, 'GET', '/pokes/received'), 'received list');
  const item = received.find((p) => p.id === poke.id);
  expect(item, 'the recipient lists the request').toBeDefined();
  expect(item?.message, 'the recipient is shown the same safe message').toBe(neutral);
  const stored = (await pool.query<{ message: string | null }>(`SELECT message FROM user_pokes WHERE id = $1`, [poke.id])).rows[0];
  expect(stored.message, 'the stored message is the neutral sentence').toBe(neutral);
  console.log(`  ✓ 201; the response, the recipient's list and the row all say: "${neutral}"`);

  // ── 2. The recipient accepts: the first message and the sender's bell ──────
  const accepted = await api<AcceptedJson>(recipient, 'POST', `/pokes/${poke.id}/accept`);
  expect(accepted.status, `accept: ${JSON.stringify(accepted.body)}`).toBe(200);
  const { conversationId } = dataOf(accepted, 'accept');
  expect(conversationId, 'accepting opens a conversation').toMatch(/^[0-9a-f-]{36}$/);

  const first = (await pool.query<{ content: string | null; from_user_id: string }>(
    `SELECT content, from_user_id FROM direct_messages
      WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`, [conversationId])).rows[0];
  expect(first, 'accepting seeds the conversation with a first message').toBeDefined();
  expect(first.from_user_id, 'the first message is written as the sender').toBe(sender.id);
  expect(first.content, 'the first message is the neutral sentence').toBe(neutral);
  expectNoWant(first.content, 'the first message');

  // What the sender actually receives for that conversation.
  const thread = await api(sender, 'GET', `/dm/conversations/${conversationId}/messages`);
  expect(thread.status, `the sender reads the thread: ${JSON.stringify(thread.body)}`).toBe(200);
  expectNoWant(JSON.stringify(thread.body), 'the sender\'s view of the conversation');

  // The "accepted your request" bell carries the first 120 characters of that message.
  const bell = (await pool.query<{ body: string | null }>(
    `SELECT body FROM notifications WHERE user_id = $1 AND type = 'poke_accepted'`, [sender.id])).rows;
  expect(bell, 'the sender got one accepted bell').toHaveLength(1);
  expect(bell[0].body, 'the bell body is the neutral sentence').toBe(neutral);
  console.log('  ✓ accepted: 200; the first message (from the sender), the sender\'s view of the thread and the accepted bell carry no recipient want.');

  // ── 3. With a note: exactly the note, with no "Why REASON suggested this" line ──
  const note = `Hello ${RUN}`;
  const noted = await api<PokeJson>(sender, 'POST', `/matches/platform/${noteRecipient.id}/interest`, { note });
  expect(noted.status, `interest with a note: ${JSON.stringify(noted.body)}`).toBe(201);
  const notedPoke = dataOf(noted, 'interest with a note');
  expectNoWant(JSON.stringify(noted.body), 'the 201 response with a note');
  expect(notedPoke.message, 'the 201 response carries exactly the note').toBe(note);

  const notedRow = (await pool.query<{ message: string | null }>(`SELECT message FROM user_pokes WHERE id = $1`, [notedPoke.id])).rows[0];
  expect(notedRow.message, 'the stored message is exactly the note').toBe(note);
  const notedList = dataOf(await api<PokeJson[]>(noteRecipient, 'GET', '/pokes/received'), 'received list of the note recipient');
  expect(notedList.find((p) => p.id === notedPoke.id)?.message, 'the recipient is shown exactly the note').toBe(note);
  console.log(`  ✓ with a note: 201; the response, the row and the recipient's list are exactly "${note}".`);
});
