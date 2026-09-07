import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE PHOTO ON THE ONBOARDING CARD (7 Sep 2026, Ali: "if the person did not
// log in with Google, this prompt can get the Google photo, and the other
// options are fine too").
//
// A member with no LinkedIn and no Gravatar reaches the card with no photo.
// The card offers "Use my Google photo" (one tap through Google's consent,
// then straight back) and "Add a photo". This drives what can be driven
// without a Google account: the upload lands as the avatar at once, the
// Google button asks the server for a signed link that points at Google's
// consent screen carrying THIS member's id, and the return trip is handled
// (a "no photo" outcome shows the right message). The Google screen itself
// is not automated; Ali confirms that tap on his phone.

let browser: Browser;
let member: TestUser;
const ctxs: BrowserContext[] = [];

// A 2x2 PNG, enough for an upload.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBFAAyxQX/RiL7dwAAAABJRU5ErkJggg==', 'base64');

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => {
  member = await createTestUser('photocard', 'member', 'not_started');
  await pool.query(`UPDATE users SET onboarding_completed = false, linkedin_url = NULL, avatar_url = NULL, avatar_blob = NULL, company = 'Fjord Analytics' WHERE id = $1`, [member.id]);
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [member?.id].filter(Boolean) });
  await cleanupByPrefix(pool, 'e2etest-photocard');
});

test('the card offers a Google photo and an upload; the upload lands at once; the Google link carries this member', async () => {
  test.setTimeout(240_000);

  // The signed Google link: made for this member, pointing at Google's consent screen, coming back to onboarding.
  const state = await apiAs(member, 'POST', '/auth/google/photo-state', { redirect: '/onboarding' });
  expect(state.status, JSON.stringify(state.json)).toBe(200);
  const link: string = state.json.data.url;
  expect(link).toMatch(/\/api\/auth\/google\?photo=.+&redirect=%2Fonboarding$/);
  const hop = await fetch(link, { redirect: 'manual' });
  expect(hop.status).toBe(302);
  const location = new URL(hop.headers.get('location') || '');
  expect(location.hostname).toBe('accounts.google.com');
  const oauthState = JSON.parse(Buffer.from(location.searchParams.get('state') || '', 'base64url').toString());
  expect(oauthState).toMatchObject({ photoLinkUserId: member.id, redirect: '/onboarding' });
  console.log('  ✓ Google link is signed for this member and returns to /onboarding.');
  // A forged or foreign token is ignored: the flow becomes a plain sign-in, not a photo link.
  const forged = await fetch(`${SERVER}/api/auth/google?photo=not-a-token&redirect=/onboarding`, { redirect: 'manual' });
  const forgedState = JSON.parse(Buffer.from(new URL(forged.headers.get('location') || '').searchParams.get('state') || '', 'base64url').toString());
  expect(forgedState.photoLinkUserId).toBeUndefined();

  // The card, with no photo yet.
  const page = await openAs(member, '/onboarding');
  await expect(page.locator('input[aria-label="Your LinkedIn URL"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Skip for now/i }).click();
  await expect(page.getByRole('button', { name: /Yes, continue/i })).toBeVisible({ timeout: 60_000 });
  const card = page.getByTestId('card-photo');
  await expect(card).toBeVisible();
  await expect(card.getByText('No photo yet')).toBeVisible();
  await expect(card.getByTestId('use-google-photo')).toBeVisible();
  for (const name of ['Use my Google photo', 'Add a photo']) {
    const box = await card.getByText(name).boundingBox();
    expect(box!.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(40);
  }

  // Add a photo from a file: it is the avatar at once, on the card and in the account.
  await card.locator('input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Photo added.')).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 20_000 });
  await expect(card.getByText('Looks good')).toBeVisible();
  const row = await pool.query(`SELECT avatar_url FROM users WHERE id = $1`, [member.id]);
  expect(String(row.rows[0].avatar_url)).toMatch(/^data:image\/png;base64,/);
  console.log('  ✓ uploaded photo is the avatar immediately.');

  // Coming back from Google with no photo says so, and the URL is cleaned.
  await gotoRetry(page, `${APP}/onboarding?photo=none`);
  await expect(page.getByText(/That Google account has no photo/)).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/photo=/);
  console.log('  ✓ the return trip from Google is handled.');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 390px').toBeLessThanOrEqual(0);
});
