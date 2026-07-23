import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';

// Task E3 — admin per-user inspector UI, driven through the REAL client:
//   1. An admin opens /admin/users/:id for a seeded member and sees the
//      onboarding transcript, the enrichment state, a DM thread + its
//      messages, and a report row (all four tabs' data present).
//   2. A non-admin hitting the same URL gets the "Admin Only" shield —
//      never the data.
//   3. Clicking "Refresh enrichment" (after the confirm dialog) fires
//      POST /onboarding/admin/refresh-enrichment with the TARGET user's id
//      — proven by intercepting the request in the browser rather than
//      letting it reach the real backend (which would kick off a real,
//      billable LinkedIn lookup against prod).
//
// Seed data goes in directly via the DB (same "real user + direct DB setup"
// pattern as e2e/tests/reonboarding-gate.spec.ts / onboarding-states.spec.ts)
// so this test never depends on a live LLM/enrichment round trip.

let browser: Browser;
const ctxs: BrowserContext[] = [];
const userIds: string[] = [];
let convId: string | null = null;

let admin: TestUser;
let nonAdmin: TestUser;
let target: TestUser;
let partner: TestUser;

const SEEDED_LINKEDIN_URL = 'https://www.linkedin.com/in/e3-target-seed';
const SEEDED_ENRICHMENT_SOURCE = 'e2e-seed-provider';
const SEEDED_USER_MESSAGE = 'I want to meet other founders building AI infrastructure.';
const SEEDED_DM_MESSAGE = 'Hello from the target member — great meeting you.';
const SEEDED_REPORT_REASON = 'harassment';

async function openPage(user: TestUser, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(
    (t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a);
      localStorage.setItem('rsn_refresh', t.r);
    },
    { a: user.accessToken, r: user.refreshToken },
  );
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  browser = await chromium.launch({ headless: true });

  admin = await createTestUser('e3admin', 'admin');
  nonAdmin = await createTestUser('e3member');
  target = await createTestUser('e3target');
  partner = await createTestUser('e3partner');
  userIds.push(admin.id, nonAdmin.id, target.id, partner.id);

  // ── Onboarding tab: transcript + enrichment + intent ──
  await pool.query(
    `UPDATE users SET linkedin_url = $2, onboarding_status = 'completed', last_onboarded_at = NOW() WHERE id = $1`,
    [target.id, SEEDED_LINKEDIN_URL],
  );
  await pool.query(
    `INSERT INTO user_intent_profiles (
       user_id, matching_intent, matching_tags, avoid_preferences, profile_strength,
       onboarding_conversation, enrichment_status, enrichment_source,
       enrichment_started_at, enrichment_completed_at
     ) VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz, $10::timestamptz)
     ON CONFLICT (user_id) DO UPDATE SET
       matching_intent = EXCLUDED.matching_intent,
       matching_tags = EXCLUDED.matching_tags,
       avoid_preferences = EXCLUDED.avoid_preferences,
       profile_strength = EXCLUDED.profile_strength,
       onboarding_conversation = EXCLUDED.onboarding_conversation,
       enrichment_status = EXCLUDED.enrichment_status,
       enrichment_source = EXCLUDED.enrichment_source,
       enrichment_started_at = EXCLUDED.enrichment_started_at,
       enrichment_completed_at = EXCLUDED.enrichment_completed_at`,
    [
      target.id,
      JSON.stringify({ desiredPeople: ['founders'], reasonForMeeting: 'Explore infra partnerships' }),
      ['founders', 'ai-infra'],
      ['recruiters'],
      'strong',
      JSON.stringify([
        { role: 'assistant', content: 'What brings you to Reason?' },
        { role: 'user', content: SEEDED_USER_MESSAGE },
      ]),
      'found',
      SEEDED_ENRICHMENT_SOURCE,
      new Date(Date.now() - 5000).toISOString(),
      new Date().toISOString(),
    ],
  );
  await pool.query(
    `INSERT INTO onboarding_stage_events (user_id, stage, detail, duration_ms) VALUES ($1, 'confirmed', '{}'::jsonb, $2)`,
    [target.id, 850],
  );

  // ── Conversations tab: a DM thread with messages ──
  const [userAId, userBId] = [target.id, partner.id].sort();
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW()) RETURNING id`,
    [userAId, userBId],
  );
  convId = conv.rows[0].id;
  await pool.query(
    `INSERT INTO direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [convId, target.id, SEEDED_DM_MESSAGE, partner.id, 'Likewise — let\'s find a time to talk.'],
  );

  // ── Reports & Interactions tab: a report row ──
  await pool.query(
    `INSERT INTO user_reports (reporter_id, reported_id, reason, status) VALUES ($1, $2, $3, 'open')`,
    [partner.id, target.id, SEEDED_REPORT_REASON],
  );
});

test.afterAll(async () => {
  try {
    await browser?.close();
  } catch {}
  if (convId) {
    await pool.query(`DELETE FROM direct_messages WHERE conversation_id = $1`, [convId]).catch(() => {});
    await pool.query(`DELETE FROM dm_conversations WHERE id = $1`, [convId]).catch(() => {});
  }
  await cleanup(pool, { ids: userIds });
});

test('admin sees the transcript, enrichment state, a DM thread + messages, and a report row', async () => {
  test.setTimeout(60_000);
  const page = await openPage(admin);
  await gotoRetry(page, `${APP}/admin/users/${target.id}`);

  // Onboarding tab (default) — transcript text + enrichment state.
  await expect(page.getByText(SEEDED_USER_MESSAGE)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(SEEDED_ENRICHMENT_SOURCE)).toBeVisible();
  await expect(page.getByText('found', { exact: true }).first()).toBeVisible();

  // Conversations tab — thread list, then the messages of the selected thread.
  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(page.getByText('Access is audit logged.')).toBeVisible();
  await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 15_000 });
  await page.getByText(partner.displayName).click();
  await expect(page.getByText(SEEDED_DM_MESSAGE)).toBeVisible({ timeout: 15_000 });

  // Reports & Interactions tab — the seeded report row.
  await page.getByRole('button', { name: 'Reports & Interactions' }).click();
  await expect(page.getByText(SEEDED_REPORT_REASON)).toBeVisible({ timeout: 15_000 });

  console.log('  ✓ admin inspector: transcript, enrichment, DM thread + messages, and report row all visible.');
});

test('a non-admin hitting the inspector URL gets the Admin Only shield, never the data', async () => {
  test.setTimeout(60_000);
  const page = await openPage(nonAdmin);
  await gotoRetry(page, `${APP}/admin/users/${target.id}`);

  await expect(page.getByText('Admin Only')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(SEEDED_USER_MESSAGE)).not.toBeVisible();
  await expect(page.getByText(SEEDED_ENRICHMENT_SOURCE)).not.toBeVisible();

  console.log('  ✓ non-admin: shield shown, no inspector data leaked.');
});

test('Refresh enrichment fires the admin endpoint with the target user id (via request interception)', async () => {
  test.setTimeout(60_000);
  const page = await openPage(admin);
  await gotoRetry(page, `${APP}/admin/users/${target.id}`);
  await expect(page.getByRole('button', { name: /Refresh enrichment/i })).toBeVisible({ timeout: 20_000 });

  // Intercept + fulfill locally — never let this reach the real backend, which
  // would fire a genuine (billable) LinkedIn lookup against prod.
  let capturedBody: unknown = null;
  const requestSeen = new Promise<void>((resolve) => {
    page.route(`${SERVER}/api/onboarding/admin/refresh-enrichment`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { cleared: true, status: 'searching' } }),
      });
      resolve();
    });
  });

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Refresh enrichment/i }).click();
  await requestSeen;

  expect(capturedBody).toEqual({ userId: target.id });

  console.log('  ✓ Refresh enrichment: POST /onboarding/admin/refresh-enrichment fired with { userId: target.id }.');
});
