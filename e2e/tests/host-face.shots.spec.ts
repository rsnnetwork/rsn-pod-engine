import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// 10 Sep 2026 (Stefan + Claus): the host is a small cartoon face, not a red
// blinking dot. Captures the onboarding chat header at phone and desktop
// widths and checks the face is there and fits.

let browser: Browser;
let user: TestUser;
const ctxs: BrowserContext[] = [];

async function open(viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: user.accessToken, r: user.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  // Settle straight into the chat: not_found, no confirm card (same stub shape
  // as onboarding-states.spec.ts).
  await page.route(`${SERVER}/api/onboarding/status`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { success: true, data: { status: 'not_started', enrichment: { status: 'not_found', error: null, startedAt: null, completedAt: null }, opening: 'not_found' } },
    });
  });
  await gotoRetry(page, `${APP}/onboarding`);
  return page;
}

test.beforeAll(async () => {
  user = await createTestUser('hostface', 'member', 'not_started');
  await pool.query(`UPDATE users SET onboarding_completed = false, linkedin_url = NULL, company = NULL, job_title = NULL, bio = NULL WHERE id = $1`, [user.id]);
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [user.id] });
  await cleanupByPrefix(pool, 'e2etest-hostface');
});

for (const [label, viewport] of [['phone390', { width: 390, height: 844 }], ['desktop1280', { width: 1280, height: 900 }]] as const) {
  test(`the host face shows in the chat header at ${label}`, async () => {
    test.setTimeout(120_000);
    const page = await open(viewport);
    // Skip the LinkedIn ask (isVisible does not wait; waitFor does).
    const skip = page.getByRole('button', { name: /Skip for now/i });
    await skip.waitFor({ state: 'visible', timeout: 20_000 }).then(() => skip.click()).catch(() => {});
    await expect(page.locator('textarea[aria-label="Your answer"]')).toBeVisible({ timeout: 30_000 });
    const face = page.getByTestId('host-face').first();
    await expect(face).toBeVisible();
    // The face springs in from 60%; wait for it to settle before measuring.
    await expect.poll(async () => (await face.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(36);
    const box = await face.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    // A face, not a dot: two eyes (plus a gloss highlight), a nose and lips are drawn.
    expect(await face.locator('svg ellipse').count()).toBeGreaterThanOrEqual(2);
    expect(await face.locator('svg path').count()).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: `shots/onboarding/host-face-${label}.png` }).catch(() => {});
    await face.screenshot({ path: `shots/onboarding/host-face-${label}-closeup.png` }).catch(() => {});
  });
}
