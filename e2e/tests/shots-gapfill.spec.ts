import { test, expect, chromium, Browser, BrowserContext } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// Opt-in (SHOTS=1): a brand-new member whose name and LinkedIn URL are Ali's
// opens onboarding on production. The client fires the real enrichment; with
// the gap fill live, the confirm card must show a Role pulled from the public
// page rather than "Not set". Nothing is clicked. Writes e2e/shots/gapfill-*.png.

test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture');

let browser: Browser;
let member: TestUser;
const ctxs: BrowserContext[] = [];

test.beforeAll(async () => {
  member = await createTestUser('gapfill', 'member', 'not_started');
  await pool.query(
    `UPDATE users SET onboarding_completed = false, display_name = 'Ali Hamza Tariq', first_name = 'Ali', last_name = 'Hamza Tariq',
       company = NULL, job_title = NULL, bio = NULL, industry = NULL, location = NULL,
       linkedin_url = 'https://www.linkedin.com/in/alihamzaraja/' WHERE id = $1`,
    [member.id]);
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [member?.id].filter(Boolean) });
  await cleanupByPrefix(pool, 'e2etest-gapfill');
});

test('the confirm card shows a Role for a member whose LinkedIn has one', async () => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: member.accessToken, r: member.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/onboarding`);

  // The client runs the real enrichment (scrapingdog, then the web gap fill),
  // then settles on the confirm card. Give it up to two minutes.
  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/gapfill-confirm-card-390.png', fullPage: true });

  const roleRow = page.getByText('Role', { exact: true }).locator('..');
  const roleText = (await roleRow.textContent()) || '';
  console.log(`  ROLE ROW: ${roleText.replace(/\s+/g, ' ').trim()}`);
  expect(roleText, 'a role was pulled from the public page').not.toMatch(/Not set/i);

  const st = await pool.query(
    `SELECT enrichment_status::text s, inferred_profile->'enriched'->'profile'->>'currentRole' role,
            inferred_profile->'enriched'->'profile'->>'headline' headline, inferred_profile->'enriched'->>'confidence' conf
       FROM user_intent_profiles WHERE user_id = $1`, [member.id]);
  console.log(`  STORED: ${JSON.stringify(st.rows[0])}`);
  expect(st.rows[0]?.role, 'currentRole stored').toBeTruthy();
});
