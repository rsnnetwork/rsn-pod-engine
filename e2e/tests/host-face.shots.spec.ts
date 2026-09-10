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

async function open(viewport: { width: number; height: number }, opening: 'not_found' | 'found' = 'not_found'): Promise<Page> {
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
      json: { success: true, data: { status: 'not_started', enrichment: { status: opening, error: null, startedAt: null, completedAt: null }, opening } },
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

// 10 Sep 2026 (Ali's screenshot): on a short desktop window the confirm card
// was taller than the screen and vertically centred, so the face at the top
// and the footnote at the bottom were both clipped and unreachable. The
// screen now starts at the top and scrolls.
test('the confirm card starts at the top with the face fully visible on a short window, and scrolls', async () => {
  test.setTimeout(120_000);
  await pool.query(`UPDATE users SET linkedin_url = 'https://www.linkedin.com/in/hostface-e2e', company = 'Axorvian', job_title = 'MLOps Engineer', bio = 'A long enough About to make the card tall. '.repeat(6) WHERE id = $1`, [user.id]);
  const page = await open({ width: 1280, height: 700 }, 'found');
  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 30_000 });
  const face = page.getByTestId('host-face').first();
  await expect.poll(async () => (await face.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(90);
  const box = await face.boundingBox();
  expect(box!.y, 'the face is not clipped above the viewport').toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: 'shots/onboarding/confirm-card-short-window.png' }).catch(() => {});
  // The card is taller than 700px: the buttons are reachable by scrolling.
  const cont = page.getByRole('button', { name: /Yes, continue/i });
  await cont.scrollIntoViewIfNeeded();
  await expect(cont).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
