import { test, expect, chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, wait, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// A rate-limited answer never signs a member out (fix wave 3, 2 Nov 2026), and a refused refresh still does (fix round 1).
//
// The member's own requests used up their minute (production allows 240 a minute per member), and a page was then
// loaded. Its session check (GET /auth/session) was answered 429 four times over about 17 seconds, after which the app
// treated the member as signed out and sent them to /login, although nothing about their session was wrong. Seen in
// WebKit at the end of n1-t6 on the local preview-shaped stack.
//
// Fix round 1 adds the paths the first spec never took, because it opened the page with a fresh access token:
//   - an EXPIRED access token: the read is 401, the 401 interceptor refreshes (keyed by IP, so not limited), and the
//     read sent again with the new token is 429. The first fix took its own refresh for another session taking over
//     and sent the member to sign in;
//   - a refresh the server REFUSES (a refresh token it never issued, as a session revoked elsewhere gives): the member
//     must reach sign-in promptly, not wait on "Connection lost, retrying…" for ever, as the first fix had them do;
//   - the waiting screen's way out: after about 20 seconds it offers Try again and Sign out, each at least 44px tall.
//
// Each test has its own throwaway member (@rsn-e2e.invalid, deleted by id), so one test's spent minute is not another's.
// Only that member's budget is spent: the limiter counts per member (the token's sub). E2E_ENGINE=webkit for Safari's
// engine.
// ─────────────────────────────────────────────────────────────────────────────

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const RUN = Date.now().toString(36);
const SIGN_IN = /\/(login|welcome)(\?|$)/;
/** Longer than the old give-up point (2 + 5 + 10 seconds of retries, plus the reads), and than the 20 s before the buttons. */
const HELD_FOR_MS = 25_000;
/** helpers/auth has loaded the env by now: the key the server signs with, as every test token is signed. */
const JWT_SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET) as string;

let browser: Browser;
const members: string[] = [];

async function newMember(label: string): Promise<TestUser> {
  const u = await createTestUser(`fw429${label}`);
  const email = `e2etest-fw429${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  members.push(u.id);
  return { ...u, email };
}

/** The member's refresh token, recorded as the server records the ones it issues, so the server honours it. */
async function honourRefreshToken(who: TestUser): Promise<void> {
  const hash = crypto.createHash('sha256').update(who.refreshToken).digest('hex');
  await pool.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + interval '1 day')`, [who.id, hash]);
}

/** The member's access token as it is after its quarter of an hour: the same claims, expired two minutes ago. */
function expiredAccessToken(who: TestUser): string {
  const { iat: _iat, exp: _exp, ...claims } = jwt.decode(who.accessToken) as jwt.JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ ...claims, iat: now - 1020, exp: now - 120 }, JWT_SECRET);
}

/** Reads sent at once while the minute is spent: a quarter of production's 240, so five bursts at most. */
const BURST = 60;

/** One read of the session as `who`: its status, and the seconds its window has left when the limiter refused it. */
async function readSession(who: TestUser): Promise<{ status: number; resetIn: number }> {
  const res = await fetch(`${SERVER}/api/auth/session`, { headers: { Authorization: `Bearer ${who.accessToken}` } });
  await res.arrayBuffer();
  return { status: res.status, resetIn: Number(res.headers.get('ratelimit-reset') ?? res.headers.get('retry-after') ?? 60) };
}

/**
 * Reads the session as `who` in bursts of parallel reads until the limiter refuses; returns the seconds until its window
 * ends. In bursts, not one read after another: over production's latency (about 0.2 s a read) 240 reads one at a time
 * took most of the minute, so the window was nearly over (6 to 12 s left, R10z smoke) before the page even opened.
 */
async function spendTheMinute(who: TestUser): Promise<number> {
  for (let burst = 0; burst * BURST < 2000; burst++) {
    const answers = await Promise.all(Array.from({ length: BURST }, () => readSession(who)));
    const refused = answers.filter((a) => a.status === 429);
    expect(answers.filter((a) => a.status !== 200 && a.status !== 429), 'every read is answered 200 or 429').toEqual([]);
    if (refused.length) return Math.min(...refused.map((a) => a.resetIn));
  }
  throw new Error('the limiter never answered 429');
}

/** Spends the minute early in a window, so it stays spent for longer than the hold. Returns when it was spent and for how long. */
async function spendTheMinuteEarly(who: TestUser): Promise<{ spentAt: number; resetIn: number }> {
  const started = Date.now();
  let resetIn = await spendTheMinute(who);
  if (resetIn < 45) {
    // The window had opened earlier: wait for the next one, and spend it as it opens.
    await wait((resetIn + 1) * 1000);
    resetIn = await spendTheMinute(who);
  }
  console.log(`[n1-fw-429] the minute was spent ${((Date.now() - started) / 1000).toFixed(1)} s after starting, ${resetIn} s of its window left`);
  return { spentAt: Date.now(), resetIn };
}

interface Opened { ctx: BrowserContext; page: Page; sessionStatuses: number[]; refreshStatuses: number[] }

/** A phone-sized tab opened on /messages with these tokens already in storage, its auth answers recorded. */
async function openMessages(tokens: { access: string; refresh: string }): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    if (sessionStorage.getItem('fw429-primed')) return;
    sessionStorage.setItem('fw429-primed', '1');
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: tokens.access, r: tokens.refresh });
  const page = await ctx.newPage();
  const sessionStatuses: number[] = [];
  const refreshStatuses: number[] = [];
  page.on('response', (res) => {
    if (res.request().method() === 'OPTIONS') return;
    if (res.url().includes('/api/auth/session')) sessionStatuses.push(res.status());
    if (res.url().includes('/api/auth/refresh')) refreshStatuses.push(res.status());
  });
  await page.goto(`${APP}/messages`, { waitUntil: 'domcontentloaded' });
  return { ctx, page, sessionStatuses, refreshStatuses };
}

/** Every look over `ms` finds the page off the sign-in page. Returns the paths seen. */
async function heldOffSignIn(page: Page, ms: number): Promise<string[]> {
  const seen = new Set<string>();
  for (const until = Date.now() + ms; Date.now() < until;) {
    seen.add(new URL(page.url()).pathname + new URL(page.url()).search);
    await wait(500);
  }
  return [...seen];
}

/** The waiting screen's two buttons: shown, at least 44px tall, and wholly on screen. */
async function expectTheWayOut(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  for (const id of ['session-try-again', 'session-sign-out']) {
    const button = page.getByTestId(id);
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.height, `${id} is at least 44px tall`).toBeGreaterThanOrEqual(44);
    expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${id} is on screen`).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true);
}

test.beforeAll(async () => {
  browser = ENGINE === 'webkit' ? await webkit.launch({ headless: HEADLESS }) : await chromium.launch({ headless: HEADLESS });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  if (members.length) await cleanup(pool, { ids: members });
  await pool.end().catch(() => {});
});

test('a member whose minute is used up stays signed in on the page they opened, and the page loads once the minute is over', async () => {
  test.setTimeout(300_000);
  const who = await newMember('a');
  const { spentAt, resetIn } = await spendTheMinuteEarly(who);
  const { ctx, page, sessionStatuses } = await openMessages({ access: who.accessToken, refresh: who.refreshToken });

  // Held: every look over the next 25 seconds finds the member on /messages, told it is retrying. The way out is offered
  // after about 20 seconds, not at once.
  await expect(page.getByTestId('session-retrying')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('session-try-again')).toHaveCount(0);
  const seen = await heldOffSignIn(page, HELD_FOR_MS);
  expect(seen.filter((p) => SIGN_IN.test(p)), 'sent to sign in while rate-limited').toEqual([]);
  expect(sessionStatuses.filter((s) => s === 429).length, 'the session check was rate-limited').toBeGreaterThan(0);
  expect(Date.now() - spentAt, 'the minute was still spent while held').toBeLessThan(resetIn * 1000);
  await expect(page.getByTestId('session-retrying')).toContainText('retrying');
  await expectTheWayOut(page);

  // Try again asks at once; still rate-limited, the member stays on the waiting screen.
  const asked = sessionStatuses.length;
  await page.getByTestId('session-try-again').click();
  await expect.poll(() => sessionStatuses.length, { timeout: 10_000 }).toBeGreaterThan(asked);
  await expect(page.getByTestId('session-retrying')).toBeVisible();
  expect(SIGN_IN.test(new URL(page.url()).pathname)).toBe(false);

  // Then the minute ends and the page loads on its own: no reload, still /messages, the tokens kept.
  await expect(page.getByTestId('session-retrying')).toHaveCount(0, { timeout: resetIn * 1000 + 45_000 });
  await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe('/messages');
  expect(sessionStatuses[sessionStatuses.length - 1]).toBe(200);
  const kept = await page.evaluate(() => localStorage.getItem('rsn_tokens'));
  expect(kept, 'tokens kept').toContain(who.refreshToken);
  await ctx.close();
});

test('an expired access token whose refreshed read is rate-limited keeps the member waiting, then the page loads', async () => {
  test.setTimeout(300_000);
  const who = await newMember('b');
  await honourRefreshToken(who);
  const { spentAt, resetIn } = await spendTheMinuteEarly(who);
  const { ctx, page, sessionStatuses, refreshStatuses } = await openMessages({ access: expiredAccessToken(who), refresh: who.refreshToken });

  // 401 (the expired token, keyed by IP), the interceptor's refresh lands, and the read sent again is 429 (keyed by member).
  await expect.poll(() => sessionStatuses.slice(0, 2), { timeout: 15_000 }).toEqual([401, 429]);
  expect(refreshStatuses[0], 'the refresh landed').toBe(200);
  const seen = await heldOffSignIn(page, HELD_FOR_MS);
  expect(seen.filter((p) => SIGN_IN.test(p)), 'sent to sign in after its own refresh').toEqual([]);
  expect(Date.now() - spentAt, 'the minute was still spent while held').toBeLessThan(resetIn * 1000);
  await expect(page.getByTestId('session-retrying')).toBeVisible();

  await expect(page.getByTestId('session-retrying')).toHaveCount(0, { timeout: resetIn * 1000 + 45_000 });
  await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe('/messages');
  expect(sessionStatuses[sessionStatuses.length - 1]).toBe(200);
  expect(refreshStatuses, 'refreshed once').toEqual([200]);
  const kept = JSON.parse((await page.evaluate(() => localStorage.getItem('rsn_tokens'))) ?? 'null') as { refresh: string } | null;
  expect(kept?.refresh, 'the refreshed pair is kept').toBeTruthy();
  expect(kept?.refresh, 'the pair was rotated').not.toBe(who.refreshToken);
  await ctx.close();
});

test('an expired access token whose refresh the server refuses reaches sign-in promptly, the tokens gone', async () => {
  test.setTimeout(120_000);
  const who = await newMember('c');
  // A refresh token the server never recorded: refused with 401, as one revoked by a sign-out elsewhere is.
  const { ctx, page, sessionStatuses, refreshStatuses } = await openMessages({ access: expiredAccessToken(who), refresh: who.refreshToken });
  const opened = Date.now();
  await expect(page).toHaveURL(SIGN_IN, { timeout: 15_000 });
  expect(Date.now() - opened, 'promptly').toBeLessThan(15_000);
  expect(sessionStatuses[0]).toBe(401);
  expect(refreshStatuses[0]).toBe(401);
  expect(await page.evaluate(() => localStorage.getItem('rsn_tokens')), 'tokens gone').toBeNull();
  // Nothing more is asked once signed out.
  const asked = refreshStatuses.length + sessionStatuses.length;
  await wait(8_000);
  expect(refreshStatuses.length + sessionStatuses.length, 'nothing more sent').toBe(asked);
  expect(SIGN_IN.test(new URL(page.url()).pathname + new URL(page.url()).search)).toBe(true);
  await ctx.close();
});

test('Sign out on the waiting screen signs the member out and reaches sign-in', async () => {
  test.setTimeout(300_000);
  const who = await newMember('d');
  await spendTheMinuteEarly(who);
  const { ctx, page } = await openMessages({ access: who.accessToken, refresh: who.refreshToken });
  await expect(page.getByTestId('session-retrying')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('session-sign-out')).toBeVisible({ timeout: 30_000 });
  await expectTheWayOut(page);
  await page.getByTestId('session-sign-out').click();
  await expect(page).toHaveURL(SIGN_IN, { timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem('rsn_tokens')), 'tokens gone').toBeNull();
  await ctx.close();
});
