import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';

// Task D2 — always-on re-onboarding route gate. D1 made GET /auth/session
// return onboardingStatus ('not_started'|'in_progress'|'completed'|
// 'needs_review'|'update_required'); ProtectedRoute now redirects to
// /onboarding whenever that status isn't 'completed', except the exempt
// paths (/onboarding itself, /invite/:code, and /session/:id/live). See
// client/src/components/layout/ProtectedRoute.tsx.
//
// createTestUser() seeds onboarding_status as 'completed' by default (see
// e2e/helpers/auth.ts — gate compatibility for every other spec), so every
// scenario here overrides it explicitly via `pool` to the exact status
// under test — the same "real user + direct DB setup" pattern the rest of
// the harness uses (see e2e/helpers/auth.ts, e2e/tests/onboarding-states.spec.ts).
//
// 30 Oct review (T3b): the gate also takes members who finished only the earlier onboarding through the new
// one (onboarding_version 2), and createTestUser() seeds completed members as v2 finishers based in a city. Scenario
// (b) walks the new onboarding against the real server, with no stub (the chatbot onboarding it once drove is gone
// from the preview).

let browser: Browser;
const ctxs: BrowserContext[] = [];
const userIds: string[] = [];

async function setStatus(userId: string, status: string): Promise<void> {
  await pool.query(`UPDATE users SET onboarding_status = $2 WHERE id = $1`, [userId, status]);
}

async function openPage(user: TestUser, viewport = { width: 390, height: 844 }): Promise<Page> {
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
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try {
    await browser?.close();
  } catch {}
  await cleanup(pool, { ids: userIds });
});

test('update_required user landing on / is redirected to /onboarding', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-a');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/`);

  await page.waitForURL(/\/onboarding(\?|$)/, { timeout: 20_000 });
  expect(page.url()).toContain('/onboarding');
  expect(decodeURIComponent(page.url())).toContain('redirect=/');
  console.log('  ✓ update_required + / -> redirected to /onboarding with redirect param.');
});

test('completed user is untouched — no redirect away from /', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-c');
  userIds.push(user.id);
  await setStatus(user.id, 'completed');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/`);

  // Give the SPA a beat to mount and for ProtectedRoute to evaluate the gate;
  // then assert it settled on the real target, not /onboarding.
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(page.url()).not.toContain('/onboarding');
  console.log('  ✓ completed status: no gate redirect, stayed on /.');
});

// 30 Oct review (T3b): the gate now takes members through the NEW onboarding (v2), so this walks it for real, against
// the real server: no stub. The member is update_required; the gate sends them to /onboarding?redirect=/profile; they
// answer the four questions, screen 7 shows where they are based, and "Show me my matches" lands them on /profile
// with no loop back into onboarding.
const tile = (page: Page, label: string) => page.getByRole('checkbox', { name: label, exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('completing the new onboarding exits the gate and lands on the redirect target', async () => {
  test.setTimeout(120_000);
  const user = await createTestUser('reonb-b');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/profile`);
  await page.waitForURL(/\/onboarding\?(.*&)?redirect=/, { timeout: 20_000 });
  expect(decodeURIComponent(page.url())).toContain('redirect=/profile');

  await expect(page.getByRole('heading', { name: "Welcome to REASON. We're glad you're here." })).toBeVisible({ timeout: 30_000 });
  await button(page, "Let's go").click();
  await button(page, 'Continue with email').click();
  for (const [title, answer] of [
    ['Who would you like to meet?', 'I would like to meet investors.'],
    ['What are you hoping to find?', 'I am looking to raise funding.'],
    ['What can you offer others?', 'I can give advice and mentoring.'],
    ['How would you describe yourself?', 'I am a founder or business owner.'],
  ]) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 });
    await tile(page, answer).click();
    await button(page, 'Continue').click();
  }
  await expect(page.getByRole('heading', { name: "Here's how others will see you" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Where are you based?', { exact: true })).toHaveValue('Copenhagen, Denmark');
  await button(page, 'Show me my matches').click();

  // useConfirm re-reads the real GET /auth/session (onboardingVersion 2, a city), so the gate lets go.
  await page.waitForURL(/\/profile$/, { timeout: 30_000 });
  await page.waitForTimeout(2000);
  expect(page.url()).not.toContain('/onboarding');
  const row = (await pool.query(`SELECT onboarding_status, onboarding_version FROM users WHERE id = $1`, [user.id])).rows[0];
  expect(row).toEqual({ onboarding_status: 'completed', onboarding_version: 2 });
  console.log('  ✓ the new onboarding completes and lands on the original redirect target (/profile).');
});

test('a member who finished only the earlier onboarding is sent to the new one', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-v1');
  userIds.push(user.id);
  await pool.query(`UPDATE users SET onboarding_version = NULL WHERE id = $1`, [user.id]);

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/`);
  await page.waitForURL(/\/onboarding\?(.*&)?redirect=/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: "Welcome to REASON. We're glad you're here." })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  console.log('  ✓ completed (earlier onboarding) + / -> the new onboarding, not edit mode.');
});

test('/invite/:code passes through ungated for an update_required user', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-d');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/invite/does-not-exist-e2e`);
  await page.waitForLoadState('networkidle').catch(() => {});

  expect(page.url()).not.toContain('/onboarding');
  expect(page.url()).toContain('/invite/does-not-exist-e2e');
  console.log('  ✓ /invite/:code exempt: no gate redirect even with update_required status.');
});

test('a live-session path passes through ungated for an update_required user', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-e');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/session/does-not-exist-e2e/live`);
  await page.waitForLoadState('networkidle').catch(() => {});

  expect(page.url()).not.toContain('/onboarding');
  console.log('  ✓ /session/:id/live exempt: no gate redirect even with update_required status.');
});
