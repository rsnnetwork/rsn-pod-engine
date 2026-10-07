import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createHash } from 'crypto';
import { createTestUser, TestUser, pool, readSignedToken } from '../helpers/auth';
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
//
// What Google carries through its consent screen (the OAuth "state") is a token
// the server signs (7 Oct 2026; it used to be base64 JSON anyone could write, and
// the callback trusted the member id in it). The spec reads it with the key the
// test tokens use, so it also proves the state is signed.
//
// A Google sign-in also only finishes in the browser that started it (7 Oct 2026):
// the start puts a one-time value in a cookie on the API's host and its hash in the
// state, and the callback goes on only when the browser sends that cookie back. The
// spec reads the cookie off the start by hand (Node's fetch keeps none), and checks
// what the callback does with it, without it, and with a state nobody signed.

let browser: Browser;
let member: TestUser;
const ctxs: BrowserContext[] = [];

// A site of ours that is always allowed (client-origin.ts), whichever site the main app is.
const PREVIEW_SITE = 'https://preview.rsn.network';

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
  // The page says which site it is on (?origin=); the server keeps it only when it is one of ours.
  const hop = await fetch(`${link}&origin=${encodeURIComponent(PREVIEW_SITE)}`, { redirect: 'manual' });
  expect(hop.status).toBe(302);
  const location = new URL(hop.headers.get('location') || '');
  expect(location.hostname).toBe('accounts.google.com');
  // The state Google carries back is a token the server signed, read with the key the test tokens use.
  const oauthState = readSignedToken(location.searchParams.get('state') || '');
  expect(oauthState).toMatchObject({
    purpose: 'google-oauth-state', photoLinkUserId: member.id, redirect: '/onboarding', origin: PREVIEW_SITE,
  });
  console.log('  ✓ Google link is signed for this member, returns to /onboarding, and keeps the site it started on.');

  // The start ties the sign-in to this browser: a cookie on the API's host, with the hash of its value in the state.
  const nonceLine = hop.headers.getSetCookie().find((line) => line.startsWith('rsn_oauth_nonce=')) || '';
  expect(nonceLine, 'the start sets the cookie that ties the sign-in to the browser').not.toBe('');
  const [nonceCookie, ...nonceAttributes] = nonceLine.split(';').map((part) => part.trim());
  const nonce = nonceCookie.slice('rsn_oauth_nonce='.length);
  expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(nonceAttributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/api/auth/google', 'Max-Age=1800']));
  expect(nonceAttributes.includes('Secure'), 'Secure whenever the API is served over https').toBe(SERVER.startsWith('https://'));
  expect(nonceAttributes.some((attribute) => /^Domain=/i.test(attribute)), 'the cookie belongs to the API host alone').toBe(false);
  expect(oauthState.nonceHash).toBe(createHash('sha256').update(nonce).digest('hex'));
  expect(JSON.stringify(oauthState)).not.toContain(nonce);
  // With that cookie the callback goes on and asks Google about the code, which Google refuses: the photo link fails on
  // the page it started from. The same address with no cookie (a browser that did not start it) is refused before
  // Google is asked anything, and asked to start again. Either way the cookie is cleared.
  const returnAddress = `${SERVER}/api/auth/google/callback?code=not-a-real-code&state=${encodeURIComponent(location.searchParams.get('state') || '')}`;
  const sameBrowser = await fetch(returnAddress, { redirect: 'manual', headers: { Cookie: `rsn_oauth_nonce=${nonce}` } });
  expect(sameBrowser.status).toBe(302);
  expect(sameBrowser.headers.get('location')).toBe(`${PREVIEW_SITE}/onboarding?photo=failed`);
  expect(sameBrowser.headers.getSetCookie().some((line) => line.startsWith('rsn_oauth_nonce=;') && /Max-Age=0/.test(line))).toBe(true);
  const otherBrowser = await fetch(returnAddress, { redirect: 'manual' });
  expect(otherBrowser.status).toBe(302);
  expect(otherBrowser.headers.get('location')).toBe(`${PREVIEW_SITE}/login?error=google_try_again`);
  expect(otherBrowser.headers.getSetCookie().some((line) => line.startsWith('rsn_oauth_nonce=;') && /Max-Age=0/.test(line))).toBe(true);
  console.log('  ✓ the start sets the browser cookie; the callback goes on with it, and is refused without it.');

  // A forged or foreign token is ignored: the flow becomes a plain sign-in, not a photo link.
  const forged = await fetch(`${SERVER}/api/auth/google?photo=not-a-token&redirect=/onboarding&origin=${encodeURIComponent(PREVIEW_SITE)}`, { redirect: 'manual' });
  const forgedState = readSignedToken(new URL(forged.headers.get('location') || '').searchParams.get('state') || '');
  expect(forgedState.purpose).toBe('google-oauth-state');
  expect(forgedState.photoLinkUserId).toBeUndefined();
  expect(forgedState.origin).toBe(PREVIEW_SITE);
  // A site that is not ours is never kept, whatever the page says: the state names a real site of ours instead.
  const foreign = await fetch(`${SERVER}/api/auth/google?origin=${encodeURIComponent('https://evil.example')}`, { redirect: 'manual' });
  const foreignState = readSignedToken(new URL(foreign.headers.get('location') || '').searchParams.get('state') || '');
  expect(foreignState.origin).not.toBe('https://evil.example');
  expect(String(foreignState.origin)).toMatch(/^https?:\/\//);
  // And a state nobody signed changes nothing on the way back. This one is the old format (base64 JSON naming this
  // member's photo link). It carries no nonce for a cookie to answer, and fetch sends no cookie anyway, so the callback
  // is refused before Google is asked anything and no photo outcome is reached: the login page, asking to start again.
  // (Before the state was signed this went to /onboarding?photo=failed; before the browser cookie, to a plain
  // sign-in that failed at Google as /login?error=google_auth_failed.)
  const unsigned = Buffer.from(JSON.stringify({ photoLinkUserId: member.id, redirect: '/onboarding' })).toString('base64url');
  const back = await fetch(`${SERVER}/api/auth/google/callback?code=not-a-real-code&state=${unsigned}`, { redirect: 'manual' });
  expect(back.status).toBe(302);
  const backTo = back.headers.get('location') || '';
  expect(backTo).toMatch(/\/login\?error=google_try_again$/);
  expect(backTo).not.toMatch(/photo=/);
  console.log('  ✓ a foreign site is never kept, and a state nobody signed changes nothing.');

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
  // The success toast lasts 2.5s; the durable outcomes below are what matter.
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

  // The same tap lives on the profile page for members who finished onboarding long ago.
  await pool.query(`UPDATE users SET onboarding_status = 'completed', onboarding_completed = true WHERE id = $1`, [member.id]);
  await gotoRetry(page, `${APP}/profile?photo=cancelled`);
  await expect(page.getByTestId('use-google-photo')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/No problem, nothing changed/)).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/photo=/);
  const profileState = await apiAs(member, 'POST', '/auth/google/photo-state', { redirect: '/profile' });
  expect(profileState.json.data.url).toMatch(/redirect=%2Fprofile$/);
  console.log('  ✓ the profile page has the Google photo tap and handles the return trip.');
});
