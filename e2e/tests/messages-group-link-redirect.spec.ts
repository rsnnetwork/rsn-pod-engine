import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 26 Oct 2026: a group-chat bell links to /messages/g/<groupId>. The group screen is on the preview; production's
// own client has none, and had no route for that address, so the bell opened its not-found page. Until the preview
// goes live the address redirects to /messages, replacing the history entry.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let me: TestUser;
const ctxs: BrowserContext[] = [];
// Not any real group: the address is what is under test, and nothing looks the group up.
const GROUP = '3f1d2a9e-5b7c-4c1a-8d2e-9a6b0c4d7e11';

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1100, height: 900 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => {
  me = await createTestUser('grouplink');
  console.log(`[messages-group-link-redirect] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  await cleanup(pool, { ids: [me.id] });
  await cleanupByPrefix(pool, 'e2etest-grouplink');
  await pool.end().catch(() => {});
});

test('the address of a group chat lands on Messages, not on a page that is not found, and Back does not return to it', async () => {
  test.setTimeout(120_000);
  const page = await openAs(me, '/messages');
  await expect(page.locator('a[href="/messages"]').first()).toBeAttached({ timeout: 40_000 });
  await page.waitForTimeout(2500);

  await page.goto(`${APP}/messages/g/${GROUP}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${APP}/messages`, { timeout: 30_000 });
  await expect(page.getByText(/Page not found|404/i)).toHaveCount(0);

  // The redirect replaced the entry, so stepping back is not stepping into the address that redirected.
  await page.goBack();
  expect(page.url()).not.toContain('/messages/g/');
});

test('a group-chat bell opens Messages', async () => {
  test.setTimeout(120_000);
  // The bell navigates to the link the server gave its entry. One row for this one throwaway member; the cleanup
  // above removes it with the member.
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, 'group_message', $2, $3, $4)`,
    [me.id, 'Priya wrote in Founders night', 'Looking forward to Thursday', `/messages/g/${GROUP}`],
  );
  const page = await openAs(me, '/');
  const bell = page.locator('button:has(svg.lucide-bell)').first();
  await expect(bell).toBeVisible({ timeout: 40_000 });
  await bell.click();
  const entry = page.getByText('Priya wrote in Founders night');
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.click();
  await expect(page).toHaveURL(`${APP}/messages`, { timeout: 20_000 });
  await expect(page.getByText(/Page not found|404/i)).toHaveCount(0);
});
