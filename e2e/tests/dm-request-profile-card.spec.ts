import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// W5 (7 Sep 2026, Ali must-have): a meeting request shows WHO is asking as a
// profile card, and the recipient can reach the sender's profile by clicking the
// name — from the request AND from the bell (which links /messages?poke=<id>,
// now focused). So the recipient can check who they are before accepting.
//
// 26 Oct 2026 (CON-01, Stefan and Claus on production, 25 Oct): that profile used to open in a NEW tab, where Back
// did nothing. It opens in the same tab now, and Back returns to the request; a profile that does land in a tab
// with nothing behind it (a live event's link) has a Back that goes to the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let sender: TestUser, recipient: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

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
  sender = await createTestUser('reqcardSender');
  recipient = await createTestUser('reqcardRecip');
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`,
    ['Dana Sender', 'Senior React Developer', 'Acme Robotics', sender.id]);
  console.log(`[dm-request-profile-card] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [sender.id, recipient.id] });
  await cleanupByPrefix(pool, 'e2etest-reqcard');
  await pool.end().catch(() => {});
});

test('a meeting request shows the sender as a profile card, name links to their profile, and the bell link focuses it', async () => {
  test.setTimeout(120_000);

  const sent = await apiAs(sender, 'POST', '/pokes', { recipientId: recipient.id, message: 'Would love to compare notes on robotics.' });
  expect(sent.status, 'poke created').toBe(201);
  const pokeId = sent.json?.data?.id;
  expect(pokeId).toBeTruthy();

  // Land the way the bell does: /messages?poke=<id>.
  const page = await openAs(recipient, `/messages?poke=${pokeId}`);
  const card = page.locator(`[data-testid="meeting-request"][data-poke-id="${pokeId}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The card is a profile card: it shows the sender's role and company.
  await expect(card).toContainText('Dana Sender');
  await expect(card).toContainText('Senior React Developer');
  await expect(card).toContainText('Acme Robotics');

  // The name links to the sender's profile (ProfileLink → /profile/:id).
  const profileLink = card.locator(`a[href="/profile/${sender.id}"]`);
  await expect(profileLink.first()).toBeVisible();
  // Name text is inside a profile link, not plain text.
  await expect(card.getByText('Dana Sender')).toHaveAttribute('href', `/profile/${sender.id}`);

  // Clicking it opens the sender's public profile in THIS tab (25 Oct 2026, CON-01). It used to open a new tab, where
  // Back did nothing because a new tab has no history; in this tab, Back returns to the request.
  expect(await card.getByText('Dana Sender').getAttribute('target'), 'a same-tab link has no target').toBeNull();
  const tabsBefore = page.context().pages().length;
  await card.getByText('Dana Sender').click();
  await expect(page).toHaveURL(new RegExp(`/profile/${sender.id}$`));
  await expect(page.getByTestId('profile-card')).toContainText('Dana Sender');
  expect(page.context().pages().length, 'no second tab was opened').toBe(tabsBefore);

  // The page's own Back button, then the browser's, both return to the request with its card on screen.
  await page.getByRole('button', { name: /^Back$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/messages\\?poke=${pokeId}`));
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByText('Dana Sender').click();
  await expect(page).toHaveURL(new RegExp(`/profile/${sender.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/messages\\?poke=${pokeId}`));
  await expect(card).toBeVisible({ timeout: 20_000 });

  // 7 Sep 2026 (Ali): the MAIN pane (not just the left band) shows the
  // requester's profile card with Accept/Decline, on desktop widths.
  if (page.viewportSize() && page.viewportSize()!.width >= 1024) {
    const panel = page.locator('[data-testid="focused-meeting-request"]');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText('Dana Sender');
    await expect(panel).toContainText('Senior React Developer');
    await expect(panel.getByRole('button', { name: /^Accept$/i })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Decline$/i })).toBeVisible();
    await expect(panel.locator(`a[href="/profile/${sender.id}"]`).first()).toBeVisible();

    // "View full profile" in the focused card stays in this tab too, and Back returns to the card.
    const viewFull = panel.getByRole('link', { name: 'View full profile' });
    expect(await viewFull.getAttribute('target')).toBeNull();
    await viewFull.click();
    await expect(page).toHaveURL(new RegExp(`/profile/${sender.id}$`));
    expect(page.context().pages().length, 'no second tab was opened').toBe(tabsBefore);
    await page.getByRole('button', { name: /^Back$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/messages\\?poke=${pokeId}`));
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText('Dana Sender');
  }
});

test('a profile opened in a NEW tab, the way a live event opens one, has a Back that goes to the dashboard instead of doing nothing', async () => {
  test.setTimeout(120_000);

  // Any signed-in page will do as the place to open the link from.
  const page = await openAs(recipient, '/messages');
  await expect(page.locator('a[href="/messages"]').first()).toBeAttached({ timeout: 30_000 });

  // The markup ProfileLink draws inside a live event: target="_blank" and rel="noopener noreferrer".
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.id = 'e2e-newtab'; a.textContent = 'open profile in a new tab';
    a.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999;background:#fff;padding:8px';
    document.body.appendChild(a);
  }, `/profile/${sender.id}`);
  const [profileTab] = await Promise.all([
    page.context().waitForEvent('page'),
    page.locator('#e2e-newtab').click(),
  ]);
  await profileTab.waitForLoadState('domcontentloaded');
  await expect(profileTab.getByTestId('profile-card')).toBeVisible({ timeout: 30_000 });
  // Nothing behind it, which is why its Back used to do nothing.
  expect(await profileTab.evaluate(() => window.history.length), 'a new tab has no history behind it').toBe(1);
  await profileTab.getByRole('button', { name: /^Back$/ }).click();
  await expect(profileTab).toHaveURL(`${APP}/`);
  await profileTab.close();
  // The tab it was opened from never moved.
  await expect(page).toHaveURL(/\/messages/);
});
