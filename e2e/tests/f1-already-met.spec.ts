// e2e/tests/f1-already-met.spec.ts
//
// Stefan, 10 Nov 2026: "I don't see a button to categorise people as folks I have already met (outside the platform)."
// Viewer A, with wants three made-up words; B and C offer those words, so both are on A's For You until A marks one.
//   1. On B's Human Profile, More > "Already met" marks B: the toast says so, the menu item reads "Marked as met · Undo"
//      and the header chip reads "You marked as met". B leaves A's For You, with no refresh.
//   2. B stays on A's Everyone list, labelled "You marked as met", and A can still ask B to meet (no connection, no encounter).
//   3. B's own For You (B's wants A's words too) still lists A: the marker is one-sided and private.
//   4. Undo brings B back to A's For You.
// Throwaway members only, removed by exact id in afterAll. E2E_ENGINE=webkit for Safari's engine; E2E_DEVICE="iPhone 14" for a phone.

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const run = Date.now().toString(36);
const LETTERS = 'bcdfhjklmnpqvwxz';
const madeUpWord = () => Array.from({ length: 6 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
const WORDS = (() => {
  const set = new Set<string>();
  while (set.size < 3) set.add(madeUpWord());
  return [...set];
})().join(' ');

const made: string[] = [];
let browser: Browser | undefined;
let ctxA: BrowserContext | undefined;
let ctxB: BrowserContext | undefined;
let a: TestUser, b: TestUser, c: TestUser;

async function makeUser(label: string, first: string): Promise<TestUser> {
  const u = await createTestUser(`f1-${label}`);
  made.push(u.id);
  await pool.query(
    `UPDATE users SET email = $1, first_name = $2, display_name = $2 WHERE id = $3`,
    [`delivered+f1-${run}-${label}@resend.dev`, `${first} F1${run}`, u.id],
  );
  return u;
}

const signedIn = async (br: Browser, u: TestUser): Promise<BrowserContext> => {
  const ctx = await br.newContext(contextOptions());
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  await primePreview(ctx);
  return ctx;
};
const cardOf = (page: Page, u: TestUser) => page.locator(`[data-person-id="${u.id}"]`);

test.describe.configure({ mode: 'serial' });

test.describe('F1 Already met', () => {
  test.beforeAll(async () => {
    a = await makeUser('a', 'Viewer');
    b = await makeUser('b', 'Marked');
    c = await makeUser('c', 'Stranger');
    // eslint-disable-next-line no-console
    console.log(`[f1] throwaway member ids (if killed, remove exactly these): ${made.join(',')}`);
    await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [WORDS, a.id]);
    for (const u of [b, c]) {
      await pool.query(`UPDATE users SET expertise_text = $1, who_i_want_to_meet = $2 WHERE id = $3`, [WORDS, WORDS, u.id]);
    }
    browser = await launchBrowser();
    ctxA = await signedIn(browser, a);
    ctxB = await signedIn(browser, b);
  });

  test.afterAll(async () => {
    await ctxA?.close().catch(() => undefined);
    await ctxB?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (made.length) {
      await pool.query(`DELETE FROM already_met WHERE user_id = ANY($1::uuid[]) OR target_user_id = ANY($1::uuid[])`, [made]);
      await cleanup(pool, { ids: made });
    }
  });

  test('marking B hides B from A, keeps B on Everyone and in B\'s own view, and Undo brings B back', async () => {
    const page = await ctxA!.newPage();
    await gotoRetry(page, `${APP}/`);
    await expect(cardOf(page, b)).toBeVisible({ timeout: 60_000 });
    await expect(cardOf(page, c)).toBeVisible();

    // 1. Mark from B's profile, through More (phone and desktop alike).
    await gotoRetry(page, `${APP}/people/${b.id}`);
    const more = page.getByRole('button', { name: 'More' });
    await expectReachable(page, more, 'the More button');
    await more.click();
    const item = page.getByRole('button', { name: 'Already met' });
    const box = await item.boundingBox();
    expect(box && box.height >= 44).toBe(true);
    await expectReachable(page, item, 'Already met');
    await item.click();
    await expect(page.getByText('is marked as met')).toBeVisible();
    await expect(page.getByText('You marked as met').first()).toBeVisible();
    await more.click();
    await expect(page.getByRole('button', { name: 'Marked as met · Undo' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Still a stranger as far as the platform goes: the bar still offers a meeting request.
    await expect(page.getByRole('button', { name: 'Meet' })).toBeVisible();

    // Hidden from For You.
    await gotoRetry(page, `${APP}/`);
    await expect(cardOf(page, c)).toBeVisible({ timeout: 60_000 });
    await expect(cardOf(page, b)).toHaveCount(0);

    // 2. Still listed on Everyone, labelled.
    // Everyone is A to Z, 30 a page, so B is found by searching the run's unique name, not by paging.
    await gotoRetry(page, `${APP}/people/everyone`);
    await page.getByLabel('Search everyone').fill(`F1${run}`);
    const row = cardOf(page, b);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByText('You marked as met')).toBeVisible();
    await expect(row.getByRole('button', { name: 'I want to meet' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 3. One-sided and private: B still sees A, and nothing about the mark.
    const pageB = await ctxB!.newPage();
    await gotoRetry(pageB, `${APP}/`);
    await expect(cardOf(pageB, a)).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByText('You marked as met')).toHaveCount(0);
    const rows = await pool.query(`SELECT 1 FROM encounter_history WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [a.id, b.id]);
    expect(rows.rowCount).toBe(0);

    // 4. Undo brings B back.
    await gotoRetry(page, `${APP}/people/${b.id}`);
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Marked as met · Undo' }).click();
    await expect(page.getByText('can be suggested to you again')).toBeVisible();
    await gotoRetry(page, `${APP}/`);
    await expect(cardOf(page, b)).toBeVisible({ timeout: 60_000 });
  });
});
