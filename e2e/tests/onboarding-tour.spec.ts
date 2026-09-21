import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// "How RSN works" (Shradha's deck, task 2).
//
// The complaint: "Users are never told what RSN is or how it works" and
// "after onboarding, users are left with no guidance on next steps."
//
// It plays once, over their own suggestions, for someone who has just
// finished. Nobody who onboarded before it existed is interrupted, and it
// stays re-openable from Support afterwards.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const ANSWERS = {
  intent: 'get_advice', lookingToMeet: ['advisors_mentors'], canOffer: ['introductions_network'],
  industries: ['software_ai'], industryOther: null, selfKinds: ['founders'],
  jobTitle: null, company: null, about: null,
};

/** Someone who has just come out of the five steps. */
async function justOnboarded(suffix: string): Promise<TestUser> {
  const u = await createTestUser(suffix, 'member', 'not_started');
  made.push(u.id);
  await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [u.id]);
  expect((await apiAs(u, 'POST', '/onboarding/answers/confirm', ANSWERS)).status).toBe(200);
  return u;
}

async function openAs(u: TestUser, path: string, viewport = PHONE): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
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

const tour = (page: Page) => page.getByTestId('how-rsn-works');

test.beforeAll(async () => {
  console.log(`[onboarding-tour] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  if (made.length) await cleanup(pool, { ids: made });
  await cleanupByPrefix(pool, 'e2etest-tour');
  await pool.end().catch(() => {});
});

test('it explains the product once, then never again', async () => {
  test.setTimeout(240_000);
  const me = await justOnboarded('tourfull');
  const page = await openAs(me, '/agents');

  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  // All four cards, in the deck's words, each reachable on a phone.
  for (const [i, title] of ['Suggestions', 'Matches', 'Meetings', 'Circles & events'].entries()) {
    await expect(tour(page).getByRole('heading', { name: title })).toBeVisible();
    if (i < 3) await tapReachable(page, page.getByRole('button', { name: /^Next$/ }), `Next from ${title}`);
  }
  // The last card is the clear next step the deck asks for.
  const cta = page.getByRole('button', { name: /See my suggestions/i });
  await expectReachable(page, cta, '"See my suggestions"');
  await tapReachable(page, cta, '"See my suggestions"');
  await expect(tour(page)).toHaveCount(0);
  console.log('  ✓ walked all four cards and finished');

  // It is done: reloading, or coming back on another device, does not replay it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await expect(tour(page)).toHaveCount(0);

  const second = await openAs(me, '/');
  await second.waitForTimeout(2500);
  await expect(tour(second)).toHaveCount(0);
  console.log('  ✓ not shown again, on this device or another');

  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('completed');
});

test('skipping it counts as seen, and it does not come back', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourskip');
  const page = await openAs(me, '/agents');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  await tapReachable(page, page.getByRole('button', { name: /^Skip$/ }), 'Skip');
  await expect(tour(page)).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await expect(tour(page)).toHaveCount(0);

  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('skipped');
});

test('closing the tab in the middle brings it back', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourhalf');
  const page = await openAs(me, '/agents');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  await tapReachable(page, page.getByRole('button', { name: /^Next$/ }), 'Next');
  await expect(tour(page).getByRole('heading', { name: 'Matches' })).toBeVisible();

  // Left halfway: they were never told the rest, so they are still owed it.
  await page.close();
  const again = await openAs(me, '/');
  await expect(tour(again)).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ still owed after leaving halfway');
});

test('someone who onboarded before it existed is never interrupted', async () => {
  test.setTimeout(120_000);
  // Exactly how every existing member looks: completed, with no tour stamp.
  const old = await createTestUser('tourold');
  made.push(old.id);
  const page = await openAs(old, '/agents');
  await page.waitForTimeout(3000);
  await expect(tour(page)).toHaveCount(0);
  console.log('  ✓ existing members carry on undisturbed');
});

test('it can be opened again from Support, without changing how it was left', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourreplay');
  // They skipped it the first time.
  expect((await apiAs(me, 'POST', '/onboarding/tour', { outcome: 'skipped' })).status).toBe(200);

  const page = await openAs(me, '/support');
  await expect(page.getByRole('heading', { name: /How RSN works/i })).toBeVisible({ timeout: 30_000 });
  await tapReachable(page, page.getByRole('button', { name: /Open the tour/i }), '"Open the tour"');
  await expect(tour(page)).toBeVisible();
  await expect(tour(page).getByRole('heading', { name: 'Suggestions' })).toBeVisible();

  // Escape is a way out of anything that covers the screen.
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);

  // Replaying does not rewrite how they left it the first time.
  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('skipped');
  console.log('  ✓ replayable from Support, and it left the record alone');
});

test('every control can be pressed on a small phone', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('toursmall');
  const page = await openAs(me, '/agents', { width: 360, height: 640 });
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });

  await expectReachable(page, page.getByRole('button', { name: /^Skip$/ }), 'Skip');
  await expectReachable(page, page.getByRole('button', { name: /^Next$/ }), 'Next');
  // The dots are 8px of paint inside a 44px target.
  const dot = page.getByRole('button', { name: /Go to card 3/ });
  const box = await dot.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await tapReachable(page, dot, 'the third dot');
  await expect(tour(page).getByRole('heading', { name: 'Meetings' })).toBeVisible();

  // And nothing is pushed off the side.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  console.log('  ✓ reachable at 360px, no sideways scroll');
});
