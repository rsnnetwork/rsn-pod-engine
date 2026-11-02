import { test, expect, chromium, webkit, type Browser } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, wait, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// A rate-limited answer never signs a member out (fix wave 3, 2 Nov 2026).
//
// The member's own requests used up their minute (production allows 240 a minute per member), and a page was then
// loaded. Its session check (GET /auth/session) was answered 429 four times over about 17 seconds, after which the app
// treated the member as signed out and sent them to /login, although nothing about their session was wrong. Seen in
// WebKit at the end of n1-t6 on the local preview-shaped stack.
//
// Here one throwaway member (@rsn-e2e.invalid, deleted by id) uses up their own minute straight against the API, then
// opens /messages. For longer than the old 17 seconds the page must stay on /messages, saying it is retrying, never on
// the sign-in page; once the minute is over it must show the member's page without a reload, with the tokens kept.
// Only this member's budget is spent: the limiter counts per member (the token's sub).
// E2E_ENGINE=webkit for Safari's engine.
// ─────────────────────────────────────────────────────────────────────────────

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const RUN = Date.now().toString(36);
const SIGN_IN = /\/(login|welcome)(\?|$)/;
/** Longer than the old give-up point (2 + 5 + 10 seconds of retries, plus the reads). */
const HELD_FOR_MS = 25_000;

let browser: Browser;
let who: TestUser;

/** Reads the session as `who` until the limiter refuses; returns the seconds until its window ends. */
async function spendTheMinute(): Promise<number> {
  for (let i = 0; i < 2000; i++) {
    const res = await fetch(`${SERVER}/api/auth/session`, { headers: { Authorization: `Bearer ${who.accessToken}` } });
    if (res.status === 429) return Number(res.headers.get('ratelimit-reset') ?? res.headers.get('retry-after') ?? 60);
    expect(res.status).toBe(200);
  }
  throw new Error('the limiter never answered 429');
}

test.beforeAll(async () => {
  browser = ENGINE === 'webkit' ? await webkit.launch({ headless: HEADLESS }) : await chromium.launch({ headless: HEADLESS });
  const u = await createTestUser('fw429');
  const email = `e2etest-fw429-${RUN}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  who = { ...u, email };
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  if (who?.id) await cleanup(pool, { ids: [who.id] });
  await pool.end().catch(() => {});
});

test('a member whose minute is used up stays signed in on the page they opened, and the page loads once the minute is over', async () => {
  test.setTimeout(300_000);
  // Spend the minute early in a window, so it stays spent for longer than the old give-up point.
  let resetIn = await spendTheMinute();
  if (resetIn < 45) {
    await wait((resetIn + 1) * 1000);
    resetIn = await spendTheMinute();
  }
  const spentAt = Date.now();

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    if (sessionStorage.getItem('fw429-primed')) return;
    sessionStorage.setItem('fw429-primed', '1');
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: who.accessToken, r: who.refreshToken });
  const page = await ctx.newPage();
  const statuses: number[] = [];
  page.on('response', (res) => { if (res.url().includes('/api/auth/session')) statuses.push(res.status()); });
  await page.goto(`${APP}/messages`, { waitUntil: 'domcontentloaded' });

  // Held: every look over the next 25 seconds finds the member on /messages, told it is retrying.
  const seen = new Set<string>();
  for (const until = Date.now() + HELD_FOR_MS; Date.now() < until;) {
    seen.add(new URL(page.url()).pathname + new URL(page.url()).search);
    await wait(500);
  }
  expect([...seen].filter((p) => SIGN_IN.test(p)), 'sent to sign in while rate-limited').toEqual([]);
  expect(statuses.filter((s) => s === 429).length, 'the session check was rate-limited').toBeGreaterThan(0);
  expect(Date.now() - spentAt, 'the minute was still spent while held').toBeLessThan(resetIn * 1000);
  await expect(page.getByTestId('session-retrying')).toBeVisible();
  await expect(page.getByTestId('session-retrying')).toContainText('retrying');

  // Then the minute ends and the page loads on its own: no reload, still /messages, the tokens kept.
  await expect(page.getByTestId('session-retrying')).toHaveCount(0, { timeout: resetIn * 1000 + 45_000 });
  await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe('/messages');
  expect(statuses[statuses.length - 1]).toBe(200);
  const kept = await page.evaluate(() => localStorage.getItem('rsn_tokens'));
  expect(kept, 'tokens kept').toContain(who.refreshToken);
  await ctx.close();
});
