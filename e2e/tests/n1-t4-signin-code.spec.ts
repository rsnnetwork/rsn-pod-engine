import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pool } from '../helpers/auth';
import { APP, cleanup } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 1 Nov 2026 — 30 Oct review, 8.1 / 8.4 / 5d (task T4).
//   - Stefan could not sign in: he expected a password. The sign-in page now says "No password needed", and the
//     sign-in email carries a 6-digit code that the waiting screen takes (POST /auth/magic-link/code).
//   - A wrong code five times kills the code AND the link.
//   - A signed-out visit to a meeting link signs in and lands back on that meeting, by code (this tab) and by the
//     link opened somewhere else (another browser context standing in for a phone).
//   - The top-left logo is the official sheep with nothing cut off, at seven widths; the manifest is served.
//
// Reading the code: the local API (NODE_ENV=development) hands the link and the code back in its answer, as it
// always has for the link (devLink). Production never does, and never emails a reserved test address; there the
// spec writes the hash of a code it chose onto the link it just asked for, with the server's own keyed hash (the
// e2e secret is the server's), and checks the server takes that code. Production allows 10 code tries per address
// per 15 minutes: one engine's run uses 7.
// ─────────────────────────────────────────────────────────────────────────────

const RUN = Date.now().toString(36);
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const SHOTS = 'test-results/n1-t4';
const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];
const NO_PASSWORD = "No password needed — we'll email you a link and a code.";

const made: string[] = [];
const madeEmails: string[] = [];
let browser: Browser;

async function member(label: string): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `e2etest-t4-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed, onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, 'Tee', 'Four', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Copenhagen, Denmark')`,
    [id, email, `Tee Four ${label}`],
  );
  made.push(id);
  madeEmails.push(email);
  return { id, email };
}

interface Emailed { code: string; link: string | null }

/** Ask for the sign-in email on the page, and read what it carries (see the header for production). */
async function askForEmail(page: Page, email: string): Promise<Emailed> {
  await expect(page.getByText(NO_PASSWORD)).toBeVisible();
  await page.getByPlaceholder('you@example.com').fill(email);
  const answer = page.waitForResponse((r) => r.url().includes('/auth/magic-link') && r.request().method() === 'POST' && !r.url().includes('/code'));
  await page.getByRole('button', { name: 'Email me a link and a code' }).click();
  const res = await answer;
  expect(res.status(), 'the sign-in email was sent').toBe(200);
  const body = await res.json();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  if (body?.data?.devCode) return { code: body.data.devCode, link: body.data.devLink };
  if (!SECRET) throw new Error('no devCode in the answer and no E2E_JWT_SECRET to set a known code');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE email = $1 AND purpose = 'login' ORDER BY created_at DESC LIMIT 1`, [email]);
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${code}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return { code, link: null };
}

const codeField = (page: Page) => page.getByLabel('6-digit code from the email');
const wrongOf = (code: string, step = 1) => String((Number(code) + step) % 1_000_000).padStart(6, '0');

async function newContext(width = 1280, height = 900): Promise<BrowserContext> {
  return browser.newContext(process.env.E2E_DEVICE ? contextOptions() : { viewport: { width, height } });
}

test.describe(`sign-in by code, the target page kept, the logo (${engineLabel()})`, () => {
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    browser = await launchBrowser();
  });

  test.afterAll(async () => {
    // Exactly the addresses this run made, never a pattern.
    await pool.query(`DELETE FROM magic_links WHERE email = ANY($1)`, [madeEmails]);
    await cleanup(pool, { ids: made });
    await browser?.close();
  });

  test('a signed-out meeting link → the code from the email → back on that meeting', async () => {
    const { email } = await member('code');
    const meeting = `/meet/${crypto.randomUUID()}?scheduled=1&kind=video`;
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}${meeting}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login\?redirect=%2Fmeet%2F/);

    const { code } = await askForEmail(page, email);
    const field = codeField(page);
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    const box = await field.boundingBox();
    expect(box!.height, 'the code field is a 44px target').toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: /Send a new email/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/code-waiting-${engineLabel().replace(/\W+/g, '-')}.png`, fullPage: true });

    // The whole code at once, as a paste lands (with the space people copy from the email): it is sent by itself.
    await field.fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await expect(page).toHaveURL(`${APP}${meeting}`, { timeout: 30_000 });
    const tokens = await page.evaluate(() => localStorage.getItem('rsn_tokens'));
    expect(tokens, 'signed in').toBeTruthy();
    await page.screenshot({ path: `${SHOTS}/code-landed-on-meeting-${engineLabel().replace(/\W+/g, '-')}.png` });
    await ctx.close();
  });

  test('a wrong code five times locks the code and the link', async () => {
    const { email } = await member('lock');
    const ctx = await newContext(390, 844);
    const page = await ctx.newPage();
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    const { code, link } = await askForEmail(page, email);
    const field = codeField(page);
    // Five different wrong codes, each sent by itself as its sixth digit goes in (the same six are never re-sent
    // by themselves; the button sends them again).
    for (const left of [4, 3, 2, 1]) {
      await field.fill(wrongOf(code, 5 - left));
      await expect(page.getByRole('alert')).toHaveText(`That code is not right. You can try ${left} more ${left === 1 ? 'time' : 'times'}.`);
    }
    await field.fill(wrongOf(code, 5));
    const locked = 'That code was entered wrongly too many times, so it and the link no longer work. Send a new email to get a fresh code.';
    await expect(page.getByRole('alert')).toHaveText(locked);
    await page.screenshot({ path: `${SHOTS}/code-locked-${engineLabel().replace(/\W+/g, '-')}.png`, fullPage: true });

    // The right code no longer works either.
    await field.fill(code);
    await expect(page.getByRole('alert')).toHaveText(locked);
    expect(await page.evaluate(() => localStorage.getItem('rsn_tokens')), 'nobody signed in').toBeNull();

    const row = await pool.query(
      `SELECT code_attempts, used_at IS NOT NULL AS used, expires_at <= NOW() AS dead FROM magic_links WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [email]);
    expect(row.rows[0]).toEqual({ code_attempts: 5, used: true, dead: true });

    // And the link from the same email is dead too.
    if (link) {
      const other = await newContext();
      const tab = await other.newPage();
      await tab.goto(link, { waitUntil: 'domcontentloaded' });
      await expect(tab.getByText('This sign-in link has expired. Get a fresh link below.')).toBeVisible({ timeout: 30_000 });
      await other.close();
    }
    await ctx.close();
  });

  test('the link opened somewhere else lands on the page the signed-out visit was going to', async () => {
    const { email } = await member('link');
    const target = `/sessions/${crypto.randomUUID()}`;
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}${target}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsessions%2F/);
    const { link } = await askForEmail(page, email);
    test.skip(!link, 'production never hands the link back; the link carrying the page is pinned in server/src/__tests__/routes/sign-in-code.test.ts');
    expect(new URL(link!).searchParams.get('redirect')).toBe(target);
    // A second context is a second device: nothing in this tab's storage reaches it.
    const phone = await newContext(390, 844);
    const tab = await phone.newPage();
    await tab.goto(link!, { waitUntil: 'domcontentloaded' });
    await expect(tab).toHaveURL(`${APP}${target}`, { timeout: 30_000 });
    await phone.close();
    await ctx.close();
  });

  test('the top-left logo is the whole official sheep at seven widths, and the manifest is served', async () => {
    const { email } = await member('logo');
    const manifest = await fetch(`${APP}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    const json = await manifest.json();
    expect(json.name).toBe('REASON');
    for (const icon of json.icons as { src: string }[]) expect((await fetch(`${APP}${icon.src}`)).status, icon.src).toBe(200);

    // Signed in through the code, like a member, at each width.
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    const { code } = await askForEmail(page, email);
    await codeField(page).fill(code);
    await expect(page).toHaveURL(`${APP}/`, { timeout: 30_000 });

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
      const logo = page.locator('img[src="/reason-mark-small.png"]:visible').first();
      await expect(logo).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(480);
      const fit = await logo.evaluate((img: HTMLImageElement) => {
        const r = img.getBoundingClientRect();
        const link = img.closest('a')!.getBoundingClientRect();
        return { inside: r.left >= link.left - 0.5 && r.right <= link.right + 0.5 && r.top >= link.top - 0.5 && r.bottom <= link.bottom + 0.5, top: r.top, left: r.left, w: r.width, h: r.height };
      });
      expect(fit.inside, `${width}px: the mark sits whole inside its link`).toBe(true);
      expect(fit.top).toBeGreaterThanOrEqual(0);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px: no sideways scroll`).toBe(true);
      await page.screenshot({ path: `${SHOTS}/logo-${width}-${engineLabel().replace(/\W+/g, '-')}.png`, clip: { x: 0, y: 0, width: Math.min(width, 420), height: 120 } });
    }
    await ctx.close();
  });
});
