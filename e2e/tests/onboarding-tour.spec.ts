import { test, expect, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';
// The made-up people the tour's pictures show. Read from the shared source itself, so swapping a name there
// needs no change here.
import { EXAMPLE_PEOPLE } from '../../shared/src/onboarding/example-people';

// ─────────────────────────────────────────────────────────────────────────────
// "How RSN works" (Shradha's deck, task 2).
//
// The complaint: "Users are never told what RSN is or how it works" and
// "after onboarding, users are left with no guidance on next steps."
//
// It plays once, over their own suggestions, for someone who has just
// finished. Nobody who onboarded before it existed is interrupted, and it
// stays re-openable from Support afterwards.
//
// 26 Oct 2026 (Stefan and Claus tested production on 25 Oct, ONB-04/05): every card opens with its heading
// and its words, then a line saying the examples are made up, then the picture, whose people are the made-up
// English ones in EXAMPLE_PEOPLE, each tagged "Example", with the sheep where a photo would be.
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

const CAPTION = 'Examples only. These are not real members.';
const OLD_PEOPLE = /Amara Okafor|Tomas Lind|Priya Raman|Northwind|Baltic Seed/;

/** Where a thing is on the page, top edge and bottom edge, or a clear failure. */
async function band(label: string, target: Locator): Promise<{ top: number; bottom: number }> {
  const box = await target.boundingBox();
  expect(box, `${label}: not on the page`).not.toBeNull();
  return { top: box!.y, bottom: box!.y + box!.height };
}

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

test('every card puts its heading and words first, says its examples are made up, and labels its people', async () => {
  test.setTimeout(240_000);
  const me = await justOnboarded('tourorder');
  const page = await openAs(me, '/agents');
  const dialog = tour(page);
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  const titles = ['Suggestions', 'Matches', 'Meetings', 'Circles & events'];
  // The first card has two people, one tag on each. The others are lists, tagged once for the whole picture.
  const tagsPerCard = [2, 1, 1, 1];
  for (const [i, title] of titles.entries()) {
    const heading = dialog.getByRole('heading', { name: title });
    await expect(heading).toBeVisible();
    await page.waitForTimeout(700); // the card has slid in and the sheep has settled
    const words = heading.locator('xpath=following-sibling::p[1]');
    const caption = dialog.getByTestId('tour-caption');
    const picture = dialog.getByTestId('tour-picture');

    // The heading, its words, the line about the examples, and then the picture: top to bottom, by where they are.
    const h = await band(`${title} heading`, heading);
    const w = await band(`${title} words`, words);
    const c = await band(`${title} caption`, caption);
    const p = await band(`${title} picture`, picture);
    expect(h.bottom, `${title}: its words come under the heading`).toBeLessThanOrEqual(w.top + 1);
    expect(w.bottom, `${title}: the caption comes under its words`).toBeLessThanOrEqual(c.top + 1);
    expect(c.bottom, `${title}: the picture comes under the caption`).toBeLessThanOrEqual(p.top + 1);
    // Nothing is drawn above the heading but the header bar: the sheep are in the picture, where a photo would be.
    for (const sheep of await dialog.getByTestId('sheep-avatar').all()) {
      expect((await band(`${title} sheep`, sheep)).top, `${title}: a sheep above the heading`).toBeGreaterThan(h.top);
    }

    // The caption says the examples are made up, in words, and a screen reader reads it: it sits outside the hidden picture.
    await expect(caption).toHaveText(CAPTION);
    expect(await caption.evaluate((el) => !el.closest('[aria-hidden="true"]')), `${title}: the caption is inside a hidden frame`).toBe(true);
    expect(await picture.getAttribute('aria-hidden'), `${title}: the picture is hidden from a screen reader`).toBe('true');

    // Each person, or each list, is tagged "Example" in words, not by colour alone.
    await expect(picture.getByText('Example', { exact: true }), `${title}: Example tags`).toHaveCount(tagsPerCard[i]);

    // The people are the shared list's, and nobody from before is in the picture or anywhere else on the card.
    if (i === 0) {
      await expect(picture).toContainText('I want to meet');
      for (const person of EXAMPLE_PEOPLE.slice(0, 2)) {
        await expect(picture).toContainText(person.name);
        await expect(picture).toContainText(person.role);
      }
    }
    if (i === 1) {
      for (const person of EXAMPLE_PEOPLE.slice(0, 3)) await expect(picture).toContainText(person.name);
    }
    expect(await dialog.innerText(), `${title}: a person from before`).not.toMatch(OLD_PEOPLE);

    if (i < titles.length - 1) await tapReachable(page, page.getByRole('button', { name: /^Next$/ }), `Next from ${title}`);
  }
  console.log('  ✓ heading, words, caption, picture on every card; people tagged Example');
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
