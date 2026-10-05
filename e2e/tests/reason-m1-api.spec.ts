// e2e/tests/reason-m1-api.spec.ts
//
// REASON milestone 1, part A: the people endpoints, proven on production right after the
// release that carries them. Two throwaway members (a and b) talk to the real API; there is no
// browser in this spec.
//
//   Save / Pass      PUT + DELETE /api/people/:userId/response, and what they do to the For You
//                    feed (GET /api/matches/platform): Save marks the card, Pass hides it, undo
//                    brings it back
//   Pass is private  b passing on a changes nothing for a: a's feed, a's brief and the rows
//   The brief        GET /api/people/:userId/brief: b's public card only, no private key on
//                    `person`, b's own want and email nowhere in it (the opener and the match
//                    reason included)
//   The request      POST /api/matches/platform/:userId/interest with a note and a format, read
//                    by the recipient. The message is the note, a blank line and REASON's reason
//                    built from the SENDER's own want; it never quotes the recipient's want
//   The outcome      POST /api/people/:userId/outcome, then the brief and the recent connections.
//                    The outcome is private to the member who recorded it
//   Blocked          a blocked member is not found
//
// A second test, on its own two members, covers one more privacy rule: a reason never names words
// from another member's private interests (see the comment above it).
//
// Every check is on an outcome: the HTTP status and what the next read returns (or the row in
// the database), never "the page looked right".
//
// Needs the release first: migration 101, the people routes and the new For You fields must be
// live, or the calls below are 404s and the feed has no `saved`. Run it one spec per process (the
// database pool is shared):
//   cd e2e
//   npx playwright test tests/reason-m1-api.spec.ts
// E2E_JWT_SECRET must be production's signing key, or every call below is a 401.

import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, SERVER } from '../helpers/live-ui';

// One id per run keeps every address, word and note unique and traceable.
const RUN = Date.now().toString(36);
// Three made-up words only a and b share, and no job-category word (a word like "specialists" is
// a category the matcher gives every analyst, which would put real members ahead of the test
// people).
const WORDS = [`zq${RUN}`, `wx${RUN}`, `vk${RUN}`];
const THE_WORDS = WORDS.join(' ');
// What b privately wants to meet. It is on b's row and must never reach a.
const SECRET_WANT = `secret-want-${RUN}`;
const OFFER = 'Intros to retail buyers';

// The keys of a member that never leave the server about ANOTHER member. This is a copy of
// PRIVATE_MEMBER_KEYS in server/src/services/user/public-card.ts, whose own test
// (server/src/__tests__/services/user/public-card.test.ts) pins the exact list: a key added or
// removed there has to be added or removed here.
const PRIVATE_MEMBER_KEYS: ReadonlySet<string> = new Set([
  // contact
  'email', 'phone', 'timezone',
  // why they are here / what they want
  'whoIWantToMeet', 'whyIWantToMeet', 'myIntent', 'goals', 'reasonsToConnect',
  'interests', 'whatICareAbout', 'matchingNotes', 'careerStage', 'currentState',
  'meetingPreferences',
  // account / prefs / lifecycle
  'invitedByUserId', 'notifyEmail', 'notifyEventReminders', 'notifyMatches',
  'profileVisible', 'inviteOptOutPublicEvents', 'onboardingStatus', 'lastOnboardedAt',
]);

// Every throwaway account, pushed the moment it exists, removed by exact id in afterAll. The rows
// that hang off a member (person_responses, meeting_outcomes, user_blocks) go with the member
// (ON DELETE CASCADE).
const made: string[] = [];

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface Envelope<T> { success?: boolean; data?: T; error?: { code?: string; message?: string } }

async function api<T = unknown>(u: TestUser, method: string, apiPath: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The envelope is read loosely on purpose: each assertion names the one field it checks, an
  // error reply has no data, and a 500 may not be JSON. Typing every endpoint here would only
  // copy the server's own types.
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

// A call that must come back with this status; if it does not, the message shows what the server said.
function expectStatus(r: { status: number; body: unknown }, want: number, what: string): void {
  expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(want);
}

interface FeedCard { userId: string; saved: boolean; reason: string }
interface FeedJson { matches: FeedCard[] }
interface ReceivedPoke { id: string; senderId: string; message: string | null; preferredFormat: string | null }
interface RecentConnection { userId: string }
interface BriefJson {
  person: Record<string, unknown>;
  match: { reason: string; strength: string } | null;
  theyCanBring: string | null;
  youAreLookingFor: string | null;
  opener: string;
  relationship: {
    state: string;
    saved: boolean;
    passed: boolean;
    outcomes: Array<{ worthContinuing: string; outcomes: string[] }>;
  };
}

// ── Accounts ─────────────────────────────────────────────────────────────────

// Resend refuses @example.com, and the request email would then log an error on Render.
// delivered+label@resend.dev is accepted and never reaches a real inbox. The id goes into made[]
// before the address changes, so a failure in between cannot leave the account behind.
async function makeUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`m1api-${label}`);
  made.push(u.id);
  const email = `delivered+m1api-${RUN}-${label}@resend.dev`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  return { ...u, email };
}

// ── The privacy of a brief ───────────────────────────────────────────────────

// The brief is about b and read by a. b's private values are known, so they are looked for in the
// whole reply and not only in `person`.
function expectBriefIsPrivate(reply: unknown, brief: BriefJson, b: TestUser, label: string): void {
  // 1. The person is b's public card: none of the private keys is on it.
  const leaked = Object.keys(brief.person).filter((key) => PRIVATE_MEMBER_KEYS.has(key));
  expect(leaked, `${label}: the person carries private keys (${leaked.join(', ')})`).toEqual([]);
  expect(brief.person, `${label}: the person is b's public card`).toMatchObject({ id: b.id, whatICanHelpWith: OFFER });

  // 2. What is built from the two members' answers never quotes b's own want. The match has to be
  // there, or the reason check below would pass on nothing.
  expect(brief.opener, `${label}: the opener quotes b's own want`).not.toContain(SECRET_WANT);
  expect(brief.match, `${label}: the brief says why REASON put a and b together`).not.toBeNull();
  const reason = brief.match?.reason ?? '';
  for (const word of WORDS) {
    expect(reason, `${label}: the match reason is in a's own words (${word})`).toContain(word);
  }
  expect(reason, `${label}: the match reason quotes b's own want`).not.toContain(SECRET_WANT);

  // Nowhere else in the reply either: not b's want, not b's email.
  const wire = JSON.stringify(reply);
  expect(wire, `${label}: b's own want is somewhere in the reply`).not.toContain(SECRET_WANT);
  expect(wire, `${label}: b's email is somewhere in the reply`).not.toContain(b.email);
}

// ── Hooks ────────────────────────────────────────────────────────────────────

test.beforeAll(() => {
  console.log(`[reason-m1-api] api=${SERVER}`);
});

test.afterAll(async () => {
  if (made.length) await cleanup(pool, { ids: made });
});

// ═════════════════════════════════════════════════════════════════════════════

test('Save, Pass, brief, note + format, outcome and recent connections work on production', async () => {
  test.setTimeout(180_000);
  const a = await makeUser('a');
  const b = await makeUser('b');
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [THE_WORDS, a.id]);
  await pool.query(
    `UPDATE users SET expertise_text = $1, what_i_can_help_with = $2, who_i_want_to_meet = $3 WHERE id = $4`,
    [THE_WORDS, OFFER, SECRET_WANT, b.id],
  );
  const feed = async () => dataOf(await api<FeedJson>(a, 'GET', '/matches/platform'), 'a\'s For You feed').matches;
  const briefOf = async (viewer: TestUser, person: TestUser) =>
    dataOf(await api<BriefJson>(viewer, 'GET', `/people/${person.id}/brief`), 'brief').relationship;

  // ── Save, Pass and undo, as they show in the feed ──────────────────────────
  // b is suggested; Save marks the card; Pass hides it; undo brings it back.
  expect((await feed()).map((m) => m.userId), 'b is suggested to a').toContain(b.id);
  expectStatus(await api(a, 'PUT', `/people/${b.id}/response`, { response: 'saved' }), 200, 'a saves b');
  expect((await feed()).find((m) => m.userId === b.id)?.saved, 'Save marks the card').toBe(true);
  expectStatus(await api(a, 'PUT', `/people/${b.id}/response`, { response: 'passed' }), 200, 'a passes on b');
  expect((await feed()).map((m) => m.userId), 'Pass hides the card').not.toContain(b.id);
  expectStatus(await api(a, 'DELETE', `/people/${b.id}/response`), 200, 'a undoes');
  const backAgain = (await feed()).find((m) => m.userId === b.id);
  expect(backAgain, 'undo brings the card back').toBeDefined();
  expect(backAgain?.saved, 'and it is not marked saved').toBe(false);
  console.log('  ✓ Save marks the card, Pass hides it, undo brings it back unmarked.');

  // ── Pass is private to the member who made it ──────────────────────────────
  // b passes on a. Nothing changes for a: the feed, the Save flag, a's own brief of b.
  const feedBefore = await feed();
  expectStatus(await api(b, 'PUT', `/people/${a.id}/response`, { response: 'passed' }), 200, 'b passes on a');
  const feedAfter = await feed();
  expect(feedAfter.map((m) => m.userId), 'b\'s Pass leaves a\'s feed as it was').toEqual(feedBefore.map((m) => m.userId));
  expect(feedAfter.find((m) => m.userId === b.id)?.saved, 'b\'s Pass does not touch a\'s Save on b').toBe(false);
  const rows = (await pool.query<{ user_id: string; target_user_id: string; response: string }>(
    `SELECT user_id, target_user_id, response FROM person_responses WHERE user_id = ANY($1) AND target_user_id = ANY($1)`,
    [[a.id, b.id]],
  )).rows;
  expect(rows, 'the only row is b\'s own Pass on a, and a has none on b').toEqual([{ user_id: b.id, target_user_id: a.id, response: 'passed' }]);
  const bOnA = await briefOf(b, a);
  expect([bOnA.passed, bOnA.saved], 'b\'s brief of a shows b\'s own Pass').toEqual([true, false]);
  const aOnB = await briefOf(a, b);
  expect([aOnB.passed, aOnB.saved], 'a\'s brief of b shows nothing of b\'s Pass').toEqual([false, false]);
  console.log('  ✓ b passed on a: a\'s feed and Save flag are unchanged, the one row is b\'s, only b\'s brief shows the Pass.');

  // ── The brief: public card only, b's own want never included ───────────────
  const brief = await api<BriefJson>(a, 'GET', `/people/${b.id}/brief`);
  expectStatus(brief, 200, 'a opens the brief of b');
  const data = dataOf(brief, 'brief');
  expect(data.theyCanBring).toBe(OFFER);
  expect(data.youAreLookingFor).toBe(THE_WORDS);
  expect(data.relationship.state).toBe('none');
  expectBriefIsPrivate(brief.body, data, b, 'brief');
  console.log('  ✓ brief: b\'s public card, a\'s own words, no private key, b\'s want and email nowhere in it.');

  // ── A request with a note and a format: b sees the note first and the format ─
  const note = `Hello ${RUN}`;
  const req = await api(a, 'POST', `/matches/platform/${b.id}/interest`, { note, format: 'coffee' });
  expectStatus(req, 201, 'a asks b to meet, with a note and a format');
  const received = dataOf(await api<ReceivedPoke[]>(b, 'GET', '/pokes/received'), 'b\'s received requests');
  const mine = received.find((p) => p.senderId === a.id);
  if (!mine) throw new Error(`b does not list a's request: ${JSON.stringify(received)}`);
  // The note, a blank line, then REASON's reason. a's own want fits b, so the reason is there, and
  // it is made of a's words. b's own want is never in the message.
  expect(mine.message?.startsWith(`${note}\n\nWhy REASON suggested this: `), `the message is the note, a blank line and the reason: ${JSON.stringify(mine.message)}`).toBe(true);
  for (const word of WORDS) expect(mine.message, `the reason is made of a's own words (${word})`).toContain(word);
  expect(mine.message, 'the message never quotes b\'s own want').not.toContain(SECRET_WANT);
  expect(mine.preferredFormat).toBe('coffee');
  console.log('  ✓ request: b lists the note first, then a\'s reason, and the format coffee; b\'s own want is not in it.');

  // ── Accept, then a records an outcome, and it shows in recent connections ───
  expectStatus(await api(b, 'POST', `/pokes/${mine.id}/accept`), 200, 'b accepts');
  expectStatus(await api(a, 'POST', `/people/${b.id}/outcome`, { worthContinuing: 'yes', outcomes: ['introduction'] }), 201, 'a records an outcome');
  const after = await api<BriefJson>(a, 'GET', `/people/${b.id}/brief`);
  expectStatus(after, 200, 'a opens the brief of b once connected');
  const afterData = dataOf(after, 'brief once connected');
  expect(afterData.relationship.state).toBe('connected');
  expect(afterData.relationship.outcomes[0]).toMatchObject({ worthContinuing: 'yes', outcomes: ['introduction'] });
  expectBriefIsPrivate(after.body, afterData, b, 'brief once connected');
  const recent = dataOf(await api<RecentConnection[]>(a, 'GET', '/people/connections/recent'), 'recent connections');
  expect(recent.map((r) => r.userId), 'b is among a\'s recent connections').toContain(b.id);
  // The outcome is a's own: b's brief of a lists none.
  expect((await briefOf(b, a)).outcomes, 'a\'s outcome is private to a').toEqual([]);
  console.log('  ✓ accepted: connected, the outcome on a\'s brief only, b in a\'s recent connections.');

  // ── Blocked people are not found ───────────────────────────────────────────
  await pool.query(`INSERT INTO user_blocks (id, blocker_id, blocked_id) VALUES (gen_random_uuid(), $1, $2)`, [b.id, a.id]);
  expectStatus(await api(a, 'GET', `/people/${b.id}/brief`), 404, 'a opens the brief of a member who blocked them');
  console.log('  ✓ blocked: the brief is 404.');
});

// ═════════════════════════════════════════════════════════════════════════════

// A reviewer found this on 5 Oct 2026, and afa7705f fixed it. A want is matched on its synonyms
// too: "manufacturers" reaches "production" and "industrial". A consultant whose public card says
// nothing about manufacturing, but whose PRIVATE interests are "industrial design" and "production
// of short films", counted as a strong fit, and the reason named "production, industrial": it
// spelled the private interests out to whoever looked. The score may count private interests; the
// words a reason names may not come from them.
const V_WANT = 'manufacturers';
const T_OFFER = 'Pricing and positioning workshops for new software launches';
const T_INTERESTS = ['industrial design', 'production of short films'];
const T_CARES = 'Sailing and long-distance cycling';
// The two words the want reaches through its synonyms. Neither is on T's public card.
const PRIVATE_WORDS = /industrial|production/i;

test('a reason never names words from another member\'s private interests', async () => {
  test.setTimeout(180_000);
  const v = await makeUser('v');
  const t = await makeUser('t');
  // V wants manufacturers. T is a strategy consultant: nothing on T's public card is about
  // manufacturing. What the synonyms reach is in T's private interests alone.
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [V_WANT, v.id]);
  await pool.query(
    `UPDATE users
        SET job_title = $2, industry = $3, expertise_text = $4, what_i_can_help_with = $5,
            interests = $6, what_i_care_about = $7
      WHERE id = $1`,
    [t.id, 'Strategy consultant', 'Consulting', 'Go-to-market strategy', T_OFFER, T_INTERESTS, T_CARES],
  );
  // The fixture is in place, so that "no word of them in the reply" means something.
  const stored = (await pool.query<{ interests: string[] }>(`SELECT interests FROM users WHERE id = $1`, [t.id])).rows[0];
  expect(stored.interests, 'T\'s private interests are on T\'s row').toEqual(T_INTERESTS);

  // The brief judges the fit on the public card only: no match, and nowhere a word of the interests.
  const brief = await api<BriefJson>(v, 'GET', `/people/${t.id}/brief`);
  expectStatus(brief, 200, 'V opens the brief of T');
  const data = dataOf(brief, 'brief of T');
  expect(data.youAreLookingFor, 'V\'s own want is in place').toBe(V_WANT);
  expect(data.theyCanBring, 'the brief shows T\'s public offer').toBe(T_OFFER);
  expect(data.match, 'the public card alone gives no match for a want of manufacturers').toBeNull();
  expect(JSON.stringify(brief.body), 'the brief names a word from T\'s private interests').not.toMatch(PRIVATE_WORDS);
  console.log('  ✓ brief: 200, no match, and neither "industrial" nor "production" anywhere in the reply.');

  // The feed may count the interests (it chooses whom to suggest), but its reason may not name them.
  // T can be missing from V's feed: it shows at most ten cards, real members who really make things
  // rank above a weak fit, and its generic-term filter can drop one. Then there is nothing to read.
  const cards = dataOf(await api<FeedJson>(v, 'GET', '/matches/platform'), 'V\'s For You feed').matches;
  const card = cards.find((m) => m.userId === t.id);
  if (card) {
    expect(card.reason, 'T\'s card in the feed names a word from T\'s private interests').not.toMatch(PRIVATE_WORDS);
    console.log(`  ✓ feed: T is suggested, and its reason reads "${card.reason}".`);
  } else {
    const note = `T is not among the ${cards.length} cards in V's feed (its limit, or its generic-term filter on a weak fit), so no reason was read on the feed side.`;
    test.info().annotations.push({ type: 'note', description: note });
    console.log(`  (feed) ${note}`);
  }
});
