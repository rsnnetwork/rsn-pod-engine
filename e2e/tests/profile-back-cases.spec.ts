import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, idsOf, teardown, APP } from '../helpers/live-ui';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 26 Oct 2026 (CON-01, and the review of the first fix): where a profile's Back goes, in every way a member reaches a
// profile. Back steps back to the page they were on when an earlier page of the app is behind it, and goes to the
// dashboard when the profile is the first page the app showed in the tab (a new tab, an emailed link, an address
// pasted into a tab). It never does nothing, and never leaves the site.
//
// The pod page, the event page, People and the recap used to link with a plain <a href>, which loads the page afresh:
// to the browser that is a first page, with the tab's history behind it, so Back went to the dashboard from a pod page.
// Each of those now links in place, which this proves by a marker on `window` that survives the click and the Back.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let viewer: TestUser, peer: TestUser, admin: TestUser;
let podId = '', eventId = '', doneId = '';
const ctxs: BrowserContext[] = [];
const run = Date.now().toString().slice(-7);

async function authedContext(u: TestUser): Promise<BrowserContext> {
  const ctx = await browser.newContext(contextOptions({ width: 1100, height: 900 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  return ctx;
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await authedContext(u);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

/** A marker on the page itself: it is gone if the document is loaded again, and kept if the app moved in place. */
const mark = (page: Page) => page.evaluate(() => { (window as unknown as { __inPlace: number }).__inPlace = 1; });
const marked = (page: Page) => page.evaluate(() => (window as unknown as { __inPlace?: number }).__inPlace === 1);

const profileOf = (id: string) => `${APP}/profile/${id}`;
const backButton = (page: Page) => page.getByRole('button', { name: /^Back$/ });

/** Opens the link the way a live event does: target="_blank" with noopener, so the new tab starts at the profile. */
async function openInNewTab(page: Page, href: string): Promise<Page> {
  await page.evaluate((to) => {
    const a = document.createElement('a');
    a.href = to; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.id = 'e2e-newtab'; a.textContent = 'profile in a new tab';
    a.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999;background:#fff;padding:8px';
    document.body.appendChild(a);
  }, href);
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.locator('#e2e-newtab').click()]);
  await tab.waitForLoadState('domcontentloaded');
  await expect(tab.getByTestId('profile-card')).toBeVisible({ timeout: 40_000 });
  return tab;
}

test.beforeAll(async () => {
  viewer = await createTestUser('backview');
  peer = await createTestUser('backpeer');
  admin = await createTestUser('backadmin', 'admin');
  await pool.query(`UPDATE users SET display_name = 'Dana Peer' WHERE id = $1`, [peer.id]);

  podId = (await createPod(viewer, `E2E Back pod ${run}`)).id;
  await addPodMember(viewer, podId, peer.id);
  // An event the peer is going to, for the event page; a finished one, for the recap.
  eventId = (await createSession(viewer, podId, `E2E Back event ${run}`, new Date(Date.now() + 86_400_000))).id;
  await registerForSession(peer, eventId);
  doneId = (await createSession(viewer, podId, `E2E Back recap ${run}`, new Date(Date.now() + 86_400_000))).id;
  await pool.query(`UPDATE sessions SET status = 'completed', started_at = now() - interval '1 hour', ended_at = now() WHERE id = $1`, [doneId]);
  // People: a past meeting between the two.
  const [a, b] = [viewer.id, peer.id].sort();
  await pool.query(`INSERT INTO encounter_history (user_a_id, user_b_id, times_met, last_session_id) VALUES ($1, $2, 1, $3)`, [a, b, doneId]);

  console.log(`[profile-back-cases] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  // An account whose creation failed is undefined here and has nothing to delete; each step runs even if another fails.
  await teardown(
    () => cleanup(pool, { ids: [], podId }),
    () => cleanup(pool, { ids: idsOf(viewer, peer, admin) }),
    () => cleanupByPrefix(pool, 'e2etest-back'),
    () => pool.end().catch(() => {}),
  );
});

for (const from of [
  { name: 'the pod page', path: () => `/pods/${podId}` },
  { name: 'the event page', path: () => `/sessions/${eventId}` },
  { name: 'People', path: () => '/encounters' },
]) {
  test(`from ${from.name}: the profile opens in place, and Back returns to ${from.name}`, async () => {
    test.setTimeout(120_000);
    const page = await openAs(viewer, from.path());
    const link = page.locator(`a[href="/profile/${peer.id}"]`).first();
    await expect(link).toBeVisible({ timeout: 40_000 });
    await mark(page);
    await link.click();
    await expect(page).toHaveURL(profileOf(peer.id));
    await expect(page.getByTestId('profile-card')).toBeVisible({ timeout: 40_000 });
    expect(await marked(page), 'the page was loaded again: the link is a plain anchor').toBe(true);
    await backButton(page).click();
    await expect(page).toHaveURL(`${APP}${from.path()}`);
    expect(await marked(page), 'Back loaded the page again').toBe(true);
    console.log(`  ✓ from ${from.name}: Back goes to ${page.url().replace(APP, '')}`);
  });
}

test('from a recap: the profile opens in place, and Back returns to the recap', async () => {
  test.setTimeout(120_000);
  const ctx = await authedContext(viewer);
  const conn = { userId: peer.id, displayName: 'Dana Peer', qualityScore: 4, meetAgain: true, theirMeetAgain: true, mutualMeetAgain: true, roundNumber: 1, isManual: false };
  await ctx.route('**/ratings/sessions/*/people-met', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { connections: [conn], mutualConnections: [conn], totalRounds: 1, roundsAttended: 1, uniquePeopleMet: 1, totalMeetings: 1, mutualMatches: 1 } }),
  }));
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}/sessions/${doneId}/recap`);
  const link = page.locator(`a[href="/profile/${peer.id}"]`).first();
  await expect(link).toBeVisible({ timeout: 40_000 });
  await mark(page);
  await link.click();
  await expect(page).toHaveURL(profileOf(peer.id));
  expect(await marked(page), 'the page was loaded again: the link is a plain anchor').toBe(true);
  await backButton(page).click();
  await expect(page).toHaveURL(`${APP}/sessions/${doneId}/recap`);
  console.log(`  ✓ from a recap: Back goes to ${page.url().replace(APP, '')}`);
});

test('after a reload inside the app, Back still goes to the page before', async () => {
  test.setTimeout(120_000);
  const page = await openAs(viewer, `/pods/${podId}`);
  const link = page.locator(`a[href="/profile/${peer.id}"]`).first();
  await expect(link).toBeVisible({ timeout: 40_000 });
  await link.click();
  await expect(page).toHaveURL(profileOf(peer.id));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('profile-card')).toBeVisible({ timeout: 40_000 });
  await backButton(page).click();
  await expect(page).toHaveURL(`${APP}/pods/${podId}`);
  console.log(`  ✓ after a reload: Back goes to ${page.url().replace(APP, '')}`);
});

test('a new tab (a link from a live event): Back goes to the dashboard', async () => {
  test.setTimeout(120_000);
  const page = await openAs(viewer, `/pods/${podId}`);
  await expect(page.locator(`a[href="/profile/${peer.id}"]`).first()).toBeVisible({ timeout: 40_000 });
  const tab = await openInNewTab(page, `/profile/${peer.id}`);
  await backButton(tab).click();
  await expect(tab).toHaveURL(`${APP}/`);
  await expect(page).toHaveURL(`${APP}/pods/${podId}`);
  console.log(`  ✓ a new tab: Back goes to ${tab.url().replace(APP, '') || '/'}`);
});

test('an address pasted into a tab that already showed another site: Back stays on this site, at the dashboard', async () => {
  test.setTimeout(120_000);
  const ctx = await authedContext(viewer);
  await ctx.route('http://other.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>another site</p>' }));
  const page = await ctx.newPage();
  await page.goto('http://other.test/');
  await page.goto(profileOf(peer.id), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('profile-card')).toBeVisible({ timeout: 40_000 });
  expect(await page.evaluate(() => window.history.length), 'the tab has history behind it').toBeGreaterThan(1);
  await backButton(page).click();
  await expect(page).toHaveURL(`${APP}/`);
  console.log(`  ✓ a pasted address: Back goes to ${page.url().replace(APP, '') || '/'} (not the other site)`);
});

test('a new tab where the member goes on to Message and comes back: Back still goes to the dashboard, not nowhere', async () => {
  test.setTimeout(120_000);
  // An admin may message anyone, so the profile has its Message button.
  const page = await openAs(admin, `/pods/${podId}`);
  await expect(page.locator('a[href="/messages"]').first()).toBeAttached({ timeout: 40_000 });
  const tab = await openInNewTab(page, `/profile/${peer.id}`);
  await tab.getByTestId('profile-card').getByRole('button', { name: /^Message$/ }).click();
  await expect(tab).toHaveURL(/\/messages\//, { timeout: 30_000 });
  await tab.goBack();
  await expect(tab).toHaveURL(profileOf(peer.id));
  await expect(backButton(tab)).toBeVisible();
  await backButton(tab).click();
  await expect(tab).toHaveURL(`${APP}/`);
  console.log(`  ✓ a new tab, Message, browser Back, page Back: goes to ${tab.url().replace(APP, '') || '/'}`);
});

test('after the Google photo return strips ?photo= from the address, a profile\'s Back still goes to the page before, not the dashboard', async () => {
  test.setTimeout(120_000);
  // The return from Google lands on /profile?photo=..., and the page takes the ?photo= out of the address. It used to do
  // that by writing an empty state over the entry, which dropped the router's count of the app's pages: every page the
  // member then opened was counted from nothing (NaN), and a profile's Back went to the dashboard.
  const page = await openAs(viewer, '/profile?photo=cancelled');
  await expect(page.getByText('No problem, nothing changed.')).toBeVisible({ timeout: 40_000 });
  await expect(page).toHaveURL(`${APP}/profile`);
  await mark(page);

  // Then the member goes on inside the app: the pods list, a pod, a name.
  await page.locator('a[href="/pods"]:visible').first().click();
  await page.getByText(`E2E Back pod ${run}`).first().click();
  await expect(page).toHaveURL(`${APP}/pods/${podId}`);
  const link = page.locator(`a[href="/profile/${peer.id}"]`).first();
  await expect(link).toBeVisible({ timeout: 40_000 });
  await link.click();
  await expect(page).toHaveURL(profileOf(peer.id));
  await expect(page.getByTestId('profile-card')).toBeVisible({ timeout: 40_000 });

  await backButton(page).click();
  await expect(page).toHaveURL(`${APP}/pods/${podId}`);
  expect(await marked(page), 'Back loaded the page again').toBe(true);
  console.log(`  ✓ after the photo return: Back goes to ${page.url().replace(APP, '')}`);
});
