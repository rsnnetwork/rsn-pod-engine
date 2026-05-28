// ─── Post-Event Broadcast Messaging — E2E test (Task 12) ──────────────────────
//
// IMPORTANT: This test WRITES throwaway data to whatever database the target
// server is connected to. It must be pointed at an environment where the
// feature is deployed (Task 10 / server routes + worker) via:
//
//   E2E_API_URL=https://<deployed-env>/api   (or E2E_SERVER_URL without /api)
//
// Default fallback is http://localhost:3001 so running without the env var
// hits a local dev server, NOT production. All seeded rows are cleaned up by
// ID in afterAll — nothing is left in the DB after a successful (or failed)
// run.
//
// DO NOT run this test against the deployed production environment until the
// feat/post-event-broadcast-messaging server changes are live there.

import { test, expect } from '@playwright/test';
import { pool, createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';

// ─── Base URL ─────────────────────────────────────────────────────────────────
//
// api.ts reads E2E_API_URL and defaults to the production Render URL.
// For this test we override: if neither env var is set, default to localhost
// so the test does NOT accidentally hit prod when the feature is undeployed.
const API_BASE =
  process.env.E2E_API_URL ||
  (process.env.E2E_SERVER_URL ? `${process.env.E2E_SERVER_URL}/api` : 'http://localhost:3001/api');

// ─── Typed API helper (local to this spec) ────────────────────────────────────

interface ApiResult<T = unknown> {
  status: number;
  body: { success: boolean; data?: T; error?: string; message?: string };
}

async function call<T = unknown>(
  user: TestUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.accessToken}`,
    },
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

// ─── Bucket-specific substrings (from templates.ts) ──────────────────────────
//
// Assert on stable phrases that are unlikely to change. These map 1-to-1 with
// the case blocks in buildMessage().

const BUCKET_SUBSTRING: Record<string, string> = {
  stayed:         'right through to the end',
  left_early:     'head off partway through',
  could_not_join: 'weren\'t able to get into the conversations',
  no_show:        'didn\'t get the chance to take part',
};

// ─── State shared across tests in this file ───────────────────────────────────

let admin:    TestUser;   // sender / super_admin
let stayed:   TestUser;   // member — completed event
let early:    TestUser;   // member — left early
let cantjoin: TestUser;   // member — joined but 0 rounds
let noshow:   TestUser;   // member — never joined

let podId:     string;
let sessionId: string;

const recipientUsers = (): TestUser[] => [stayed, early, cantjoin, noshow];

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Suppress DM emails for a user by patching notification_prefs on the users
 * row (JSONB column added by migration 053). This prevents the post-event
 * worker from attempting real email sends to throwaway addresses.
 */
async function suppressDmEmail(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users
     SET notification_prefs = jsonb_set(
           COALESCE(notification_prefs, '{}'::jsonb),
           '{dm_email}',
           'false'
         )
     WHERE id = $1`,
    [userId],
  );
}

// ─── beforeAll — seed the full scenario ──────────────────────────────────────

test.beforeAll(async () => {
  // 1. Create users
  admin    = await createTestUser('pem-admin',    'super_admin');
  stayed   = await createTestUser('pem-stayed',   'member');
  early    = await createTestUser('pem-early',    'member');
  cantjoin = await createTestUser('pem-cantjoin', 'member');
  noshow   = await createTestUser('pem-noshow',   'member');

  // 2. Suppress DM emails for all recipients so the worker never calls the
  //    email service with our throwaway addresses.
  for (const u of recipientUsers()) {
    await suppressDmEmail(u.id);
  }

  // 3. Create a pod hosted by admin
  const podRes = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, description, pod_type, orchestration_mode, communication_mode,
                       visibility, status, created_by)
     VALUES ('E2E Post-Event Test Pod', 'E2E', 'speed_networking', 'timed_rounds', 'hybrid',
             'private', 'active', $1)
     RETURNING id`,
    [admin.id],
  );
  podId = podRes.rows[0].id;

  // 4. Add recipients as pod members (role=member, status=active)
  for (const u of recipientUsers()) {
    await pool.query(
      `INSERT INTO pod_members (pod_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')
       ON CONFLICT (pod_id, user_id) DO NOTHING`,
      [podId, u.id],
    );
  }

  // 5. Insert a completed session
  //    ended_at = NOW(), scheduled_at = NOW() - 1h
  const sessRes = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (pod_id, title, description, scheduled_at, started_at, ended_at,
        status, host_user_id, config)
     VALUES
       ($1, 'E2E Post-Event Test', 'E2E', NOW() - INTERVAL '1 hour',
        NOW() - INTERVAL '1 hour', NOW(),
        'completed', $2, $3)
     RETURNING id`,
    [
      podId,
      admin.id,
      JSON.stringify({
        eventType: 'speed_networking',
        numberOfRounds: 5,
        maxParticipants: 50,
        timerVisibility: 'always_visible',
        ratingWindowSeconds: 30,
        lobbyDurationSeconds: 300,
        noShowTimeoutSeconds: 60,
        roundDurationSeconds: 60,
        transitionDurationSeconds: 30,
        closingLobbyDurationSeconds: 300,
      }),
    ],
  );
  sessionId = sessRes.rows[0].id;

  // 6. Insert session_participants with field values that produce each bucket.
  //
  //    Classify logic (classify.ts):
  //      no_show      → joinedAt = NULL
  //      could_not_join → joinedAt != NULL, roundsCompleted < 1
  //      left_early   → roundsCompleted >= 1, leftAt <= endedAt - 121s
  //      stayed       → roundsCompleted >= 1, leftAt = endedAt (within 120s grace)
  //
  //    Columns (from migration 001): session_id, user_id, status, joined_at, left_at,
  //    rounds_completed (NOT NULL DEFAULT 0), is_no_show (DEFAULT false)

  // stayed: joined 40min before end, left at end (within 120s grace), 5 rounds
  await pool.query(
    `INSERT INTO session_participants
       (session_id, user_id, status, joined_at, left_at, rounds_completed, is_no_show)
     VALUES ($1, $2, 'left', NOW() - INTERVAL '40 minutes', NOW(), 5, false)
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, stayed.id],
  );

  // left_early: joined 40min before end, left 20min before end (gap ~20min >> 120s), 3 rounds
  await pool.query(
    `INSERT INTO session_participants
       (session_id, user_id, status, joined_at, left_at, rounds_completed, is_no_show)
     VALUES ($1, $2, 'left', NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '20 minutes', 3, false)
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, early.id],
  );

  // could_not_join: joined 30min before end, left 25min before end, 0 rounds
  await pool.query(
    `INSERT INTO session_participants
       (session_id, user_id, status, joined_at, left_at, rounds_completed, is_no_show)
     VALUES ($1, $2, 'left', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '25 minutes', 0, true)
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, cantjoin.id],
  );

  // no_show: joined_at = NULL (never joined)
  await pool.query(
    `INSERT INTO session_participants
       (session_id, user_id, status, joined_at, left_at, rounds_completed, is_no_show)
     VALUES ($1, $2, 'no_show', NULL, NULL, 0, true)
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, noshow.id],
  );
});

// ─── afterAll — complete teardown by ID ───────────────────────────────────────

test.afterAll(async () => {
  // Wrapped in try/finally so a mid-suite failure still cleans up.
  const allIds = [admin, stayed, early, cantjoin, noshow]
    .filter(Boolean)
    .map((u) => u.id);
  const recipientIds = recipientUsers().map((u) => u.id);

  try {
    if (sessionId) {
      // Delete post-event message rows first (cascade from session delete also
      // covers them, but being explicit avoids FK ordering surprises).
      await pool.query(
        `DELETE FROM post_event_message_recipients
         WHERE job_id IN (
           SELECT id FROM post_event_message_jobs WHERE session_id = $1
         )`,
        [sessionId],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM post_event_message_jobs WHERE session_id = $1`,
        [sessionId],
      ).catch(() => {});
    }

    if (recipientIds.length > 0) {
      // Delete direct_messages sent between admin and each recipient
      // (conversation normalizes pair by sort order, so we check both orderings
      // via the dm_conversations join).
      await pool.query(
        `DELETE FROM direct_messages
         WHERE conversation_id IN (
           SELECT id FROM dm_conversations
           WHERE (user_a_id = $1 AND user_b_id = ANY($2))
              OR (user_b_id = $1 AND user_a_id = ANY($2))
         )`,
        [admin.id, recipientIds],
      ).catch(() => {});

      await pool.query(
        `DELETE FROM dm_conversations
         WHERE (user_a_id = $1 AND user_b_id = ANY($2))
            OR (user_b_id = $1 AND user_a_id = ANY($2))`,
        [admin.id, recipientIds],
      ).catch(() => {});

      // Delete notifications for recipients
      await pool.query(
        `DELETE FROM notifications WHERE user_id = ANY($1)`,
        [recipientIds],
      ).catch(() => {});
    }

    // session_participants + session cascade-delete via sessions FK
    if (sessionId) {
      await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]).catch(() => {});
    }

    // Pod (pod_members cascade from pod FK)
    if (podId) {
      await pool.query(`DELETE FROM pods WHERE id = $1`, [podId]).catch(() => {});
    }
  } finally {
    // cleanupTestData() finds all e2etest-* users and deletes them + cascade.
    // This covers notifications, audit_log, refresh_tokens, etc.
    try {
      const result = await cleanupTestData();
      console.log('Post-event message spec cleanup:', result);
    } catch (err) {
      console.error('cleanupTestData failed:', err);
    }
    await closePool();
  }
});

// ─── Test 1: Eligibility ──────────────────────────────────────────────────────

test('eligibility: member recipient gets enabled=false; admin gets enabled=true reason=admin', async () => {
  // A plain member cannot broadcast
  const memberRes = await call(stayed, 'GET', `/sessions/${sessionId}/post-event-message/eligibility`);
  expect(memberRes.status).toBe(200);
  const memberData = (memberRes.body.data ?? {}) as Record<string, unknown>;
  expect(memberData.enabled).toBe(false);

  // A super_admin can broadcast
  const adminRes = await call(admin, 'GET', `/sessions/${sessionId}/post-event-message/eligibility`);
  expect(adminRes.status).toBe(200);
  const adminData = (adminRes.body.data ?? {}) as Record<string, unknown>;
  expect(adminData.enabled).toBe(true);
  expect(adminData.reason).toBe('admin');
});

// ─── Test 2: Preview ─────────────────────────────────────────────────────────

test('preview: 4 total recipients, one per bucket', async () => {
  const res = await call(admin, 'GET', `/sessions/${sessionId}/post-event-message/preview`);
  expect(res.status).toBe(200);

  const data = (res.body.data ?? {}) as {
    totalRecipients?: number;
    buckets?: Array<{ bucket: string; count: number }>;
  };

  expect(data.totalRecipients).toBe(4);

  // Confirm each bucket appears exactly once
  const bucketMap = new Map<string, number>(
    (data.buckets ?? []).map((b) => [b.bucket, b.count] as [string, number]),
  );
  expect(bucketMap.get('stayed')).toBe(1);
  expect(bucketMap.get('left_early')).toBe(1);
  expect(bucketMap.get('could_not_join')).toBe(1);
  expect(bucketMap.get('no_show')).toBe(1);
});

// ─── Test 3: Send + worker completion ────────────────────────────────────────

test('POST creates job (201); worker completes with sentCount=4, failedCount=0', async () => {
  test.setTimeout(120_000); // worker runs every ~10s; allow up to 90s polling + margin

  // Create the job
  const sendRes = await call<{
    id?: string;
    status?: string;
    totalRecipients?: number;
  }>(admin, 'POST', `/sessions/${sessionId}/post-event-message`);
  expect(sendRes.status).toBe(201);

  const job = sendRes.body.data;
  expect(job?.status).toMatch(/^(pending|processing)$/);

  // Poll GET /status until terminal state (max 90s, poll every 5s)
  const POLL_INTERVAL_MS = 5_000;
  const MAX_WAIT_MS = 90_000;
  const deadline = Date.now() + MAX_WAIT_MS;

  let finalJob: {
    status?: string;
    sentCount?: number;
    failedCount?: number;
    totalRecipients?: number;
  } | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await call<typeof finalJob>(
      admin,
      'GET',
      `/sessions/${sessionId}/post-event-message/status`,
    );
    expect(statusRes.status).toBe(200);

    const latest = statusRes.body.data as typeof finalJob;
    if (
      latest?.status === 'completed' ||
      latest?.status === 'completed_with_errors' ||
      latest?.status === 'failed'
    ) {
      finalJob = latest;
      break;
    }
  }

  expect(finalJob, 'Worker did not complete within 90s').not.toBeNull();
  expect(finalJob!.status, `Expected completed, got ${finalJob!.status}`).toBe('completed');
  expect(finalJob!.sentCount).toBe(4);
  expect(finalJob!.failedCount).toBe(0);
});

// ─── Test 4: DMs landed in direct_messages ────────────────────────────────────

test('each recipient has exactly one DM from admin with bucket-appropriate content', async () => {
  const bucketByUser: Record<string, string> = {
    [stayed.id]:   'stayed',
    [early.id]:    'left_early',
    [cantjoin.id]: 'could_not_join',
    [noshow.id]:   'no_show',
  };

  for (const recipient of recipientUsers()) {
    // Conversation pair is normalized: user_a_id < user_b_id
    const [orderedA, orderedB] =
      admin.id < recipient.id
        ? [admin.id, recipient.id]
        : [recipient.id, admin.id];

    const msgRows = await pool.query<{ id: string; from_user_id: string; content: string }>(
      `SELECT dm.id, dm.from_user_id, dm.content
       FROM direct_messages dm
       JOIN dm_conversations dc ON dc.id = dm.conversation_id
       WHERE dc.user_a_id = $1 AND dc.user_b_id = $2
         AND dm.from_user_id = $3`,
      [orderedA, orderedB, admin.id],
    );

    expect(
      msgRows.rows.length,
      `Expected exactly 1 DM for recipient ${recipient.email}`,
    ).toBe(1);

    const content = msgRows.rows[0].content;
    const expectedSubstring = BUCKET_SUBSTRING[bucketByUser[recipient.id]];
    expect(
      content,
      `DM for ${bucketByUser[recipient.id]} should contain "${expectedSubstring}"`,
    ).toContain(expectedSubstring);
  }
});

// ─── Test 5: Notifications created ───────────────────────────────────────────

test('each recipient has a notifications row of type direct_message', async () => {
  for (const recipient of recipientUsers()) {
    const notifRows = await pool.query<{ id: string; type: string }>(
      `SELECT id, type FROM notifications
       WHERE user_id = $1 AND type = 'direct_message'`,
      [recipient.id],
    );
    expect(
      notifRows.rows.length,
      `Expected at least 1 direct_message notification for ${recipient.email}`,
    ).toBeGreaterThanOrEqual(1);
  }
});

// ─── Test 6: Idempotency — second POST does not duplicate messages ────────────

test('second POST: either 409 (active job guard) or 0 new messages sent; recipients still have exactly 1 DM each', async () => {
  test.setTimeout(120_000);

  const secondRes = await call<{
    id?: string;
    status?: string;
    sentCount?: number;
    failedCount?: number;
  }>(admin, 'POST', `/sessions/${sessionId}/post-event-message`);

  if (secondRes.status === 409) {
    // The unique partial index on (session_id WHERE status IN pending/processing)
    // fired — an active job exists. This is the expected fast-path.
    console.log('  Idempotency: server returned 409 (active job guard fired) — correct');
  } else {
    // A new job was created (first job has reached terminal state, so the
    // index allowed a new pending row). The service should have found all
    // recipients already 'sent' and created a job with totalRecipients=0
    // (or very quickly reach completed with sentCount=0).
    expect(secondRes.status).toBe(201);

    const POLL_INTERVAL_MS = 5_000;
    const MAX_WAIT_MS = 90_000;
    const deadline = Date.now() + MAX_WAIT_MS;
    let finalJob: typeof secondRes.body.data = secondRes.body.data;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const statusRes = await call<typeof finalJob>(
        admin,
        'GET',
        `/sessions/${sessionId}/post-event-message/status`,
      );
      const latest = statusRes.body.data as typeof finalJob;
      if (
        latest?.status === 'completed' ||
        latest?.status === 'completed_with_errors' ||
        latest?.status === 'failed'
      ) {
        finalJob = latest;
        break;
      }
    }

    console.log(
      `  Idempotency: second job finished with status=${finalJob?.status} sentCount=${finalJob?.sentCount}`,
    );
    // The second job must not have sent additional messages to already-sent recipients
    expect(finalJob?.sentCount ?? 0).toBe(0);
  }

  // Regardless of the path above, assert no duplication in direct_messages
  for (const recipient of recipientUsers()) {
    const [orderedA, orderedB] =
      admin.id < recipient.id
        ? [admin.id, recipient.id]
        : [recipient.id, admin.id];

    const msgRows = await pool.query<{ id: string }>(
      `SELECT dm.id
       FROM direct_messages dm
       JOIN dm_conversations dc ON dc.id = dm.conversation_id
       WHERE dc.user_a_id = $1 AND dc.user_b_id = $2
         AND dm.from_user_id = $3`,
      [orderedA, orderedB, admin.id],
    );

    expect(
      msgRows.rows.length,
      `Recipient ${recipient.email} should still have exactly 1 DM after idempotency run`,
    ).toBe(1);
  }
});
