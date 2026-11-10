// e2e/tests/f5-for-you-exclusions.spec.ts
//
// Spec 10 Nov 2026, item 5: For You stops introducing people the member already talks to. One viewer (A) whose
// wants three made-up words; every other throwaway member offers those words, so each would be on A's For You if
// nothing excluded them:
//   B  has a direct-message conversation with A            -> not on For You
//   B2 has a conversation A deleted on their side (the other side's flag too, in the reverse order) -> not on For You
//   E  accepted a request from A (accepted, either way)   -> not on For You
//   D  has a request from A still waiting                  -> still on For You, with the request sent
//   F  asked A, and the request is still waiting          -> still on For You (the other direction)
//   C  no contact at all                                   -> on For You
// Seeded through the database (the rows a real conversation and request leave), read through the real page.
// Throwaway members only (made-up words, no real member can match them), removed by exact id in afterAll.
// E2E_ENGINE=webkit for Safari's engine; E2E_DEVICE="iPhone 14" for a phone.

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
let ctx: BrowserContext | undefined;
let a: TestUser, b: TestUser, b2: TestUser, c: TestUser, d: TestUser, e: TestUser, f: TestUser;

async function makeUser(label: string, first: string): Promise<TestUser> {
  const u = await createTestUser(`f5-${label}`);
  made.push(u.id);
  await pool.query(
    `UPDATE users SET email = $1, first_name = $2, display_name = $2 WHERE id = $3`,
    [`delivered+f5-${run}-${label}@resend.dev`, `${first} F5${run}`, u.id],
  );
  return u;
}

const pair = (x: TestUser, y: TestUser): [string, string] => (x.id < y.id ? [x.id, y.id] : [y.id, x.id]);
const cardOf = (page: Page, u: TestUser) => page.locator(`[data-person-id="${u.id}"]`);

test.describe('F5 For You exclusions', () => {
  test.beforeAll(async () => {
    a = await makeUser('a', 'Viewer');
    b = await makeUser('b', 'Talked');
    b2 = await makeUser('b2', 'Deleted');
    c = await makeUser('c', 'Stranger');
    d = await makeUser('d', 'Asked');
    e = await makeUser('e', 'Accepted');
    f = await makeUser('f', 'Asking');
    // eslint-disable-next-line no-console
    console.log(`[f5] throwaway member ids (if killed, remove exactly these): ${made.join(',')}`);

    await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [WORDS, a.id]);
    for (const u of [b, b2, c, d, e, f]) {
      await pool.query(
        `UPDATE users SET expertise_text = $1, who_i_want_to_meet = 'nothing in particular' WHERE id = $2`,
        [WORDS, u.id],
      );
    }
    const [x1, y1] = pair(a, b);
    await pool.query(`INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW())`, [x1, y1]);
    const [x2, y2] = pair(a, b2);
    await pool.query(
      `INSERT INTO dm_conversations (user_a_id, user_b_id, user_a_deleted_at, user_b_deleted_at) VALUES ($1, $2, NOW(), NOW())`,
      [x2, y2],
    );
    // E asked A and A accepted, the encounter row that accepting writes included: the reverse direction of D's.
    await pool.query(
      `INSERT INTO user_pokes (sender_id, recipient_id, status, responded_at) VALUES ($1, $2, 'accepted', NOW())`,
      [e.id, a.id],
    );
    const [x3, y3] = pair(a, e);
    await pool.query(
      `INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at) VALUES (gen_random_uuid(), $1, $2, 1, NOW())`,
      [x3, y3],
    );
    await pool.query(`INSERT INTO user_pokes (sender_id, recipient_id, status) VALUES ($1, $2, 'pending')`, [a.id, d.id]);
    await pool.query(`INSERT INTO user_pokes (sender_id, recipient_id, status) VALUES ($1, $2, 'pending')`, [f.id, a.id]);

    browser = await launchBrowser();
    ctx = await browser.newContext(contextOptions());
    await ctx.addInitScript((t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a);
      localStorage.setItem('rsn_refresh', t.r);
      localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
    }, { a: a.accessToken, r: a.refreshToken });
    await primePreview(ctx);
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (made.length) await cleanup(pool, { ids: made });
  });

  test('people A already talks to are not on For You; a stranger and a waiting request still are', async () => {
    const page = await ctx!.newPage();
    await gotoRetry(page, `${APP}/`);
    await expect(cardOf(page, c)).toBeVisible({ timeout: 60_000 });
    await expect(cardOf(page, d)).toBeVisible();
    await expect(cardOf(page, f)).toBeVisible();
    await expect(cardOf(page, b)).toHaveCount(0);
    await expect(cardOf(page, b2)).toHaveCount(0);
    await expect(cardOf(page, e)).toHaveCount(0);
    await cardOf(page, c).scrollIntoViewIfNeeded();
    await expectReachable(page, cardOf(page, c), 'the stranger card');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
