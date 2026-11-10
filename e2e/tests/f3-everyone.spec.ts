// F3 EVERYONE (Stefan, 10 Nov 2026: "HOW can I connect with ANYONE, you know, just browse through"), headed.
//
// Throwaway members, cleaned up by id. Not run by the implementer: the controller runs it on production after shipping.
//   1. The Everyone tab lists members A to Z with no word typed, and Load more brings the next page without a repeat.
//   2. A listed member is found by searching their name; an unfinished account and a hidden one never appear.
//   3. "I want to meet" sends a request through the Meet sheet and the row then reads "Request sent", no reload.
//   4. At 360px the search box, a row and its buttons fit the window.
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, gotoRetry, idsOf, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const RUN = Date.now() % 100_000;
const TAG = `Qf3x${RUN}`;

let browser: Browser;
let viewer: TestUser;
let listed: TestUser;
let unfinished: TestUser;
let hidden: TestUser;
const contexts: BrowserContext[] = [];

async function viewerContext(viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: viewer.accessToken, r: viewer.refreshToken });
  return ctx;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await launchBrowser();
  viewer = await createTestUser(`f3view${RUN}`);
  listed = await createTestUser(`f3list${RUN}`);
  unfinished = await createTestUser(`f3unfin${RUN}`);
  hidden = await createTestUser(`f3hid${RUN}`);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [`Listed ${TAG}`, listed.id]);
  await pool.query('UPDATE users SET display_name = $1, onboarding_completed = false WHERE id = $2', [`Unfinished ${TAG}`, unfinished.id]);
  await pool.query('UPDATE users SET display_name = $1, profile_visible = false WHERE id = $2', [`Hidden ${TAG}`, hidden.id]);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser?.close().catch(() => {});
  await pool.query('DELETE FROM user_pokes WHERE sender_id = $1 OR recipient_id = $1', [viewer?.id]).catch(() => {});
  await cleanup(pool, { ids: idsOf(viewer, listed, unfinished, hidden) });
});

test('lists members A to Z with no search, and Load more adds people without a repeat', async () => {
  const page = await (await viewerContext({ width: 1280, height: 900 })).newPage();
  await gotoRetry(page, `${APP}/people/everyone`);
  await expect(page.getByRole('link', { name: 'Everyone', exact: true })).toBeVisible();
  const cards = page.locator('[data-person-id]');
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  const names = async () => (await cards.locator('h3').allInnerTexts()).map((n) => n.trim());
  const first = await names();
  const sorted = [...first].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  expect(first.map((n) => n.toLowerCase())).toEqual(sorted.map((n) => n.toLowerCase()));
  const more = page.getByRole('button', { name: 'Load more' });
  if (await more.count()) {
    await more.click();
    await expect(async () => expect((await cards.count())).toBeGreaterThan(first.length)).toPass({ timeout: 15_000 });
  }
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-person-id')));
  expect(new Set(ids).size, 'no member listed twice').toBe(ids.length);
  expect(ids).not.toContain(viewer.id);
});

test('search finds the listed member; an unfinished account and a hidden one never appear', async () => {
  const page = await (await viewerContext({ width: 1280, height: 900 })).newPage();
  await gotoRetry(page, `${APP}/people/everyone`);
  await page.getByLabel('Search everyone').fill(TAG);
  const cards = page.locator('[data-person-id]');
  await expect(cards).toHaveCount(1, { timeout: 15_000 });
  await expect(cards.first()).toContainText(`Listed ${TAG}`);
  await expect(page.getByText(`Unfinished ${TAG}`)).toHaveCount(0);
  await expect(page.getByText(`Hidden ${TAG}`)).toHaveCount(0);
  await page.getByLabel('Search everyone').fill(`nobody-${TAG}-zzz`);
  await expect(page.getByText('No one matches that search')).toBeVisible({ timeout: 15_000 });
});

test('"I want to meet" sends a request and the row reads "Request sent" without a reload', async () => {
  const page = await (await viewerContext({ width: 1280, height: 900 })).newPage();
  await gotoRetry(page, `${APP}/people/everyone`);
  await page.evaluate(() => { (window as unknown as { __notReloaded?: boolean }).__notReloaded = true; });
  await page.getByLabel('Search everyone').fill(TAG);
  const row = page.locator(`[data-person-id="${listed.id}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: 'I want to meet' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(row.getByRole('button', { name: 'Request sent' })).toBeVisible({ timeout: 15_000 });
  const stored = await pool.query('SELECT status FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2', [viewer.id, listed.id]);
  expect(stored.rows.map((r) => r.status)).toEqual(['pending']);
  expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded === true)).toBe(true);
});

test('at 360px the search box, a row and its buttons fit the window and are 44px tall', async () => {
  const page = await (await viewerContext({ width: 360, height: 740 })).newPage();
  await gotoRetry(page, `${APP}/people/everyone`);
  await page.getByLabel('Search everyone').fill(TAG);
  const row = page.locator(`[data-person-id="${listed.id}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expectReachable(page, page.getByLabel('Search everyone'), 'search box');
  await expectReachable(page, row.getByRole('link', { name: /View profile of/ }), 'View profile');
  await expectReachable(page, row.getByRole('button', { name: 'Request sent' }), 'request button');
  const box = await row.getByRole('link', { name: /View profile of/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
