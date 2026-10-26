// ─── "Message all participants" v2 — E2E (26 Oct 2026) ───────────────────────
//
// The 25 Oct configuration, exactly: a plain MEMBER who hosts a finished video meeting and directs its pod
// (Claus), and a super_admin who was the only other person there (Stefan). The v1 rule greyed the button out
// for him, and even enabled it would have reached nobody and sent a feedback survey. v2 lets him write his
// own words to everyone who took part.
//
// This spec talks to the API and reads the database; it drives no browser. It WRITES throwaway data to
// whatever database the target server is connected to, and removes it by id in afterAll.
//
//   E2E_API_URL=https://<deployed-env>/api   (or E2E_SERVER_URL without /api)
//
// Default fallback is http://localhost:3001 so running without the env var hits a local dev server, NOT
// production. Needs a server with migration 113 applied and the worker running (it drains a send every ~10 s).

import { test, expect } from '@playwright/test';
import { pool, createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';

// E2E_API_URL may name the server with or without its /api (the preview and production runners give the bare host, as
// every other spec's SERVER helper expects); either way the calls go to /api (26 Oct 2026: without this, the preview
// runner's bare host made every call here a 404).
const withApi = (base: string) => (/\/api\/?$/.test(base) ? base.replace(/\/$/, '') : `${base.replace(/\/$/, '')}/api`);
const API_BASE = process.env.E2E_API_URL
  ? withApi(process.env.E2E_API_URL)
  : (process.env.E2E_SERVER_URL ? `${process.env.E2E_SERVER_URL}/api` : 'http://localhost:3001/api');

interface ApiResult<T = unknown> {
  status: number;
  body: { success: boolean; data?: T; error?: { code?: string; message?: string }; message?: string };
}

async function call<T = unknown>(user: TestUser, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: ApiResult<T>['body'];
  try {
    parsed = text ? JSON.parse(text) : { success: false };
  } catch {
    parsed = { success: false, message: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

interface Eligibility {
  enabled: boolean;
  visible: boolean;
  reason: string;
  explanation: string;
  audience: { tookPart: number; registeredNoShow: number };
  lastSent?: { at: string; recipients: number };
  nextSendAt?: string;
}
interface Job { id: string; status: string; totalRecipients: number; sentCount: number; failedCount: number }

const EVENT_TITLE = `E2E video meeting ${Date.now().toString(36)}`;

let host: TestUser;       // plain member: host of the event AND director of its pod
let attendee: TestUser;   // super_admin: the only other person who took part on 25 Oct
let ian: TestUser;        // took part, left early
let blocker: TestUser;    // took part, has blocked the host
let closed: TestUser;     // took part, account since closed
let noshow: TestUser;     // registered, never came
let outsider: TestUser;   // no tie to the event

let podId: string;
let sessionId: string;
const BASE = () => `/sessions/${sessionId}/post-event-message`;

const everyone = (): TestUser[] => [host, attendee, ian, blocker, closed, noshow, outsider];

/** Keep DM emails from going to throwaway addresses while the worker sends (notification_prefs, migration 053). */
async function suppressDmEmail(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users
     SET notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
     WHERE id = $1`,
    [userId],
  );
}

/** Poll the status until the latest job is done (the worker runs about every 10 s). */
async function waitForJobDone(user: TestUser, maxMs = 90_000): Promise<Job> {
  const deadline = Date.now() + maxMs;
  let latest: Job | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const res = await call<Job | null>(user, 'GET', `${BASE()}/status`);
    expect(res.status).toBe(200);
    latest = (res.body.data ?? null) as Job | null;
    if (latest && ['completed', 'completed_with_errors', 'failed'].includes(latest.status)) return latest;
  }
  throw new Error(`The send did not finish within ${maxMs / 1000}s (last seen: ${JSON.stringify(latest)})`);
}

/** The DMs `from` wrote to `to`, newest last. Conversations store the pair sorted. */
async function dmsFromTo(from: TestUser, to: TestUser): Promise<string[]> {
  const [a, b] = from.id < to.id ? [from.id, to.id] : [to.id, from.id];
  const rows = await pool.query<{ content: string }>(
    `SELECT dm.content
       FROM direct_messages dm JOIN dm_conversations c ON c.id = dm.conversation_id
      WHERE c.user_a_id = $1 AND c.user_b_id = $2 AND dm.from_user_id = $3
      ORDER BY dm.created_at`,
    [a, b, from.id],
  );
  return rows.rows.map((r) => r.content);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  host = await createTestUser('pem2-host', 'member');
  attendee = await createTestUser('pem2-attendee', 'super_admin');
  ian = await createTestUser('pem2-ian', 'member');
  blocker = await createTestUser('pem2-blocker', 'member');
  closed = await createTestUser('pem2-closed', 'member');
  noshow = await createTestUser('pem2-noshow', 'member');
  outsider = await createTestUser('pem2-outsider', 'member');
  for (const u of everyone()) await suppressDmEmail(u.id);

  // The pod: the host created it, so they direct it (pod creation inserts the creator as director).
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, description, pod_type, orchestration_mode, communication_mode, visibility, status, created_by)
     VALUES ('E2E Message-everyone v2 Pod', 'E2E', 'speed_networking', 'timed_rounds', 'hybrid', 'private', 'active', $1)
     RETURNING id`,
    [host.id],
  );
  podId = pod.rows[0].id;
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);

  // A finished VIDEO MEETING: no matches, no rounds. v1 would call every attendee "could not join".
  const sess = await pool.query<{ id: string }>(
    `INSERT INTO sessions (pod_id, title, description, scheduled_at, started_at, ended_at, status, host_user_id, config)
     VALUES ($1, $2, 'E2E', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour',
             'completed', $3, $4)
     RETURNING id`,
    [podId, EVENT_TITLE, host.id, JSON.stringify({ eventType: 'video_meeting', numberOfRounds: 5, maxParticipants: 50 })],
  );
  sessionId = sess.rows[0].id;

  const joined = (u: TestUser, joinedMinAgo: number, leftMinAgo: number) =>
    pool.query(
      `INSERT INTO session_participants (session_id, user_id, status, joined_at, left_at, rounds_completed)
       VALUES ($1, $2, 'left', NOW() - ($3 || ' minutes')::interval, NOW() - ($4 || ' minutes')::interval, 0)`,
      [sessionId, u.id, String(joinedMinAgo), String(leftMinAgo)],
    );
  await joined(attendee, 110, 60);
  await joined(ian, 100, 80);      // left 20 minutes before the end (it ended 60 minutes ago)
  await joined(blocker, 100, 60);
  await joined(closed, 100, 60);
  await pool.query(
    `INSERT INTO session_participants (session_id, user_id, status, joined_at, left_at, rounds_completed)
     VALUES ($1, $2, 'registered', NULL, NULL, 0)`,
    [sessionId, noshow.id],
  );

  await pool.query(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [blocker.id, host.id]);
  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [closed.id]);
});

test.afterAll(async () => {
  const ids = everyone().filter(Boolean).map((u) => u.id);
  try {
    if (sessionId) {
      await pool.query(
        `DELETE FROM post_event_message_recipients WHERE job_id IN (SELECT id FROM post_event_message_jobs WHERE session_id = $1)`,
        [sessionId],
      ).catch(() => {});
      await pool.query(`DELETE FROM post_event_message_jobs WHERE session_id = $1`, [sessionId]).catch(() => {});
    }
    if (ids.length > 0) {
      await pool.query(
        `DELETE FROM direct_messages WHERE conversation_id IN (
           SELECT id FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1))`,
        [ids],
      ).catch(() => {});
      await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]).catch(() => {});
      await pool.query(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [ids]).catch(() => {});
    }
    if (sessionId) await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]).catch(() => {});
    if (podId) await pool.query(`DELETE FROM pods WHERE id = $1`, [podId]).catch(() => {});
  } finally {
    try {
      const result = await cleanupTestData();
      console.log('Post-event message v2 spec cleanup:', result);
    } catch (err) {
      console.error('cleanupTestData failed:', err);
    }
    await closePool();
  }
});

// ─── 1. The 25 Oct bug, and the fix ───────────────────────────────────────────

test('the member-role host who directs the pod: v1 still says "coming soon", v2 says they can send', async () => {
  const v1 = await call<{ enabled: boolean; reason: string }>(host, 'GET', `${BASE()}/eligibility`);
  expect(v1.status).toBe(200);
  expect(v1.body.data).toMatchObject({ enabled: false, reason: 'director_coming_soon' });

  const v2 = await call<Eligibility>(host, 'GET', `${BASE()}/eligibility?v=2`);
  expect(v2.status).toBe(200);
  expect(v2.body.data).toMatchObject({ enabled: true, visible: true, reason: 'ok', explanation: '' });
  // The attendee (a super_admin: admins are recipients) is the only person the host can reach: the blocker
  // blocked the host, the closed account is gone, and the person who never came is not asked for.
  expect(v2.body.data!.audience).toEqual({ tookPart: 2, registeredNoShow: 1 });
});

test('a super_admin with no tie to the event can send too; a plain attendee and an outsider cannot see it', async () => {
  const admin = await call<Eligibility>(attendee, 'GET', `${BASE()}/eligibility?v=2`);
  expect(admin.body.data).toMatchObject({ enabled: true, reason: 'ok' });

  for (const who of [ian, outsider]) {
    const res = await call<Eligibility>(who, 'GET', `${BASE()}/eligibility?v=2`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: false, visible: false, reason: 'not_organiser' });
    expect(res.body.data!.audience).toEqual({ tookPart: 0, registeredNoShow: 0 }); // nothing about who came
  }
});

test('the progress of a send is for the people running the event: a plain attendee is refused', async () => {
  expect((await call(ian, 'GET', `${BASE()}/status`)).status).toBe(403);
  expect((await call(outsider, 'GET', `${BASE()}/status`)).status).toBe(403);
  const hostStatus = await call(host, 'GET', `${BASE()}/status`);
  expect(hostStatus.status).toBe(200);
  expect(hostStatus.body.data ?? null).toBeNull();
});

test('a message that is blank, too long or missing is refused with a readable sentence, and creates nothing', async () => {
  const blank = await call(host, 'POST', BASE(), { body: '   ' });
  expect(blank.status).toBe(400);
  expect(blank.body.error?.message).toBe('Write a message first.');

  const long = await call(host, 'POST', BASE(), { body: 'x'.repeat(2001) });
  expect(long.status).toBe(400);
  expect(long.body.error?.message).toBe('Messages can be up to 2000 characters.');

  // Asking for version 2 without a body must never turn into the old template send.
  const missing = await call(host, 'POST', `${BASE()}?v=2`, {});
  expect(missing.status).toBe(400);

  const stranger = await call(ian, 'POST', BASE(), { body: 'Hello everyone' });
  expect(stranger.status).toBe(403);

  const jobs = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM post_event_message_jobs WHERE session_id = $1`, [sessionId]);
  expect(jobs.rows[0].n).toBe(0);
});

// ─── 2. The send ──────────────────────────────────────────────────────────────

const WORDS = 'Thank you all for coming.\n\nThe recording is on its way, and I would love to hear what you thought. Just reply here.';

test('the host sends their own words: the attendee gets the DM and the bell, the blocker and the closed account get nothing', async () => {
  test.setTimeout(150_000);

  const send = await call<Job>(host, 'POST', BASE(), { body: `  ${WORDS}  ` });
  expect(send.status).toBe(201);
  expect(send.body.data!.status).toMatch(/^(pending|processing)$/);
  expect(send.body.data!.totalRecipients).toBe(2); // the attendee and Ian

  // Pressed again at once, or by an admin at the same moment: told plainly, nothing duplicated.
  const again = await call(host, 'POST', BASE(), { body: WORDS });
  const rival = await call(attendee, 'POST', BASE(), { body: 'Me too' });
  for (const refused of [again, rival]) {
    // The worker may have finished already on a fast server; then there is nothing to refuse.
    if (refused.status === 409) expect(refused.body.error?.message).toMatch(/being sent/);
  }
  const sending = await call<Eligibility>(host, 'GET', `${BASE()}/eligibility?v=2`);
  if (sending.body.data!.reason === 'sending') {
    expect(sending.body.data!.explanation).toMatch(/^Sending… \d+ of 2\.$/);
  }

  const done = await waitForJobDone(host);
  expect(done.status).toBe('completed');
  expect(done.sentCount).toBeGreaterThanOrEqual(2);
  expect(done.failedCount).toBe(0);

  // The words, exactly as written (the space around them is the only thing taken off), from the host.
  expect(await dmsFromTo(host, attendee)).toContain(WORDS);
  expect(await dmsFromTo(host, ian)).toContain(WORDS);
  for (const dm of [...(await dmsFromTo(host, attendee)), ...(await dmsFromTo(host, ian))]) {
    expect(dm).not.toMatch(/weren't able to get into the conversations/);
  }

  // The bell: type direct_message, titled with who wrote and where from.
  const hostRow = await pool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [host.id]);
  const bell = await pool.query<{ title: string; link: string | null }>(
    `SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'direct_message'`,
    [attendee.id],
  );
  expect(bell.rows.map((r) => r.title)).toContain(`${hostRow.rows[0].display_name} messaged everyone from ‘${EVENT_TITLE}’`);
  expect(bell.rows.some((r) => /^\/messages\//.test(r.link ?? ''))).toBe(true);

  // Nobody else was written to: the person who blocked the host, the closed account, the one who never came.
  for (const nobody of [blocker, closed, noshow, outsider]) {
    expect(await dmsFromTo(host, nobody), `${nobody.email} must not be messaged`).toEqual([]);
  }

  // The rows say why: the blocked pair and the closed account were skipped, not failed.
  const rows = await pool.query<{ user_id: string; status: string; error: string | null; bucket: string }>(
    `SELECT r.user_id, r.status, r.error, r.bucket
       FROM post_event_message_recipients r JOIN post_event_message_jobs j ON j.id = r.job_id
      WHERE j.session_id = $1 AND j.created_by = $2`,
    [sessionId, host.id],
  );
  const rowOf = (u: TestUser) => rows.rows.find((r) => r.user_id === u.id);
  expect(rowOf(attendee)?.status).toBe('sent');
  expect(rowOf(ian)?.status).toBe('sent');
  expect(rowOf(ian)?.bucket).toBe('left_early');
  expect(rowOf(blocker)).toMatchObject({ status: 'skipped', error: 'blocked' });
  expect(rowOf(closed)).toMatchObject({ status: 'skipped', error: 'inactive' });
  expect(rowOf(noshow)).toBeUndefined();
  expect(rows.rows.some((r) => r.bucket === 'could_not_join')).toBe(false); // a video meeting has no rounds
});

test('a reply goes to the organiser alone', async () => {
  const reply = await call(ian, 'POST', '/dm/messages', { toUserId: host.id, content: 'Great session, thank you!' });
  expect([200, 201]).toContain(reply.status);

  expect(await dmsFromTo(ian, host)).toContain('Great session, thank you!');
  // Nothing from Ian reached anyone else who was messaged.
  expect(await dmsFromTo(ian, attendee)).toEqual([]);
  const toOthers = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM direct_messages dm JOIN dm_conversations c ON c.id = dm.conversation_id
      WHERE dm.from_user_id = $1 AND NOT (c.user_a_id = $2 OR c.user_b_id = $2)`,
    [ian.id, host.id],
  );
  expect(toOthers.rows[0].n).toBe(0);
});

// ─── 3. The limit ─────────────────────────────────────────────────────────────

test('three sends in a day are the limit: the fourth is refused with the time the next may go', async () => {
  test.setTimeout(240_000);

  for (const text of ['A second note: the slides are attached.', 'And a third: see you at the next one.']) {
    const send = await call<Job>(host, 'POST', BASE(), { body: text });
    expect(send.status).toBe(201);
    expect((await waitForJobDone(host)).status).toBe('completed');
  }

  const elig = await call<Eligibility>(host, 'GET', `${BASE()}/eligibility?v=2`);
  expect(elig.body.data).toMatchObject({ enabled: false, visible: true, reason: 'limit' });
  expect(elig.body.data!.explanation).toMatch(/^You can send another message at \d\d:\d\d\.$/);
  expect(elig.body.data!.nextSendAt).toBeTruthy();
  expect(elig.body.data!.lastSent?.recipients).toBeGreaterThanOrEqual(2);

  const fourth = await call(host, 'POST', BASE(), { body: 'One too many' });
  expect(fourth.status).toBe(409);
  expect(fourth.body.error?.message).toMatch(/^You can send another message at \d\d:\d\d\.$/);

  // The limit is the sender's own: the admin has sent nothing, so they still can.
  const admin = await call<Eligibility>(attendee, 'GET', `${BASE()}/eligibility?v=2`);
  expect(admin.body.data).toMatchObject({ enabled: true, reason: 'ok' });
});
