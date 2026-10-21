import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createHash } from 'crypto';
import { createTestUser, TestUser, pool, readSignedToken } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE PHOTO CARD (7 Sep 2026, Ali: "if the person did not log in with Google,
// this prompt can get the Google photo, and the other options are fine too").
//
// A member with no LinkedIn and no Gravatar has no photo. The card offers
// "Use my Google photo" (one tap through Google's consent, then straight back)
// and a way to add one from a file. This drives what can be driven without a
// Google account: the upload lands as the avatar at once, the Google button
// asks the server for a signed link that points at Google's consent screen
// carrying THIS member's id, and the return trip is handled (a "no photo"
// outcome shows the right message). The Google screen itself is not
// automated; Ali confirms that tap on his phone.
//
// 7 Oct 2026: the card moved. It lived on the onboarding chat, which the
// five-question flow replaced on 22 Sep (309885ce), and that flow offers only
// the photo found on the member's LinkedIn ("Is this you?", 23 Sep), which a
// member without a LinkedIn never sees. Both actions are now on the profile
// page, in the card at its top, as "Use my Google photo" and "Change photo",
// so this reaches them there as a member who has finished onboarding.
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

/**
 * What a browser does with a Google start. The API answers on two hosts: the client builds its start from the one in
 * SERVER (the onrender host), and Google is told to return to the other (API_BASE_URL), so the start sends the browser
 * on once before it reaches Google. Node's fetch keeps no cookies and follows no redirects here, so this follows them
 * by hand until Google and remembers which host set which cookie. Nothing in it signs anyone in.
 */
async function startSignIn(address: string, headers: Record<string, string> = {}) {
  const requests: string[] = [];
  const cookies: Array<{ line: string; setBy: URL }> = [];
  let url = new URL(address);
  for (let step = 0; step < 4; step += 1) {
    // Only the first request carries the Referer a page would send: the redirect says no-referrer.
    const res = await fetch(url, { redirect: 'manual', headers: step === 0 ? headers : {} });
    requests.push(url.href);
    for (const line of res.headers.getSetCookie()) cookies.push({ line, setBy: url });
    expect(res.status, `${url.href} answers with a redirect`).toBe(302);
    const next = new URL(res.headers.get('location') || '', url);
    if (next.hostname === 'accounts.google.com') return { google: next, requests, cookies };
    url = next;
  }
  throw new Error(`the start did not reach Google: ${requests.join(' -> ')}`);
}

/**
 * The cookie that ties a sign-in to the browser, as the host that set it said it. Exactly one request of the start
 * sets it, and that request is to the host Google is told to return to: a cookie set anywhere else is never sent to
 * the callback, and every sign-in would be refused. In production (https) it is __Host-rsn_oauth_nonce on Path=/, Secure,
 * which a browser only accepts with no Domain, so no sibling site can set or shadow it; a plain-http API (development)
 * keeps the plain name on its own path.
 */
function nonceCookieOf(start: Awaited<ReturnType<typeof startSignIn>>) {
  const redirectUri = new URL(start.google.searchParams.get('redirect_uri') || '');
  const set = start.cookies.filter(({ line }) => /^(__Host-)?rsn_oauth_nonce=/.test(line));
  expect(set, 'exactly one request of the start sets the browser cookie').toHaveLength(1);
  const [{ line, setBy }] = set;
  expect(setBy.host, 'the cookie is set by the host Google is told to return to').toBe(redirectUri.host);

  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const name = pair.slice(0, pair.indexOf('='));
  const nonce = pair.slice(pair.indexOf('=') + 1);
  const https = setBy.protocol === 'https:';
  expect(name).toBe(https ? '__Host-rsn_oauth_nonce' : 'rsn_oauth_nonce');
  expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Max-Age=1800', https ? 'Path=/' : 'Path=/api/auth/google']));
  expect(attributes.includes('Secure'), 'Secure exactly when the host that set it is served over https').toBe(https);
  expect(attributes.some((attribute) => /^Domain=/i.test(attribute)), 'the cookie belongs to its host alone').toBe(false);
  return { redirectUri, name, nonce };
}

/** The callback, as Google would send the browser to it (the redirect_uri it was told), with a code Google will refuse. */
const returnTo = (redirectUri: URL, state: string) =>
  `${redirectUri.origin}${redirectUri.pathname}?code=not-a-real-code&state=${encodeURIComponent(state)}`;

const clearsTheCookie = (res: Response) => res.headers.getSetCookie().some((line) => /^(__Host-)?rsn_oauth_nonce=;/.test(line) && /Max-Age=0/.test(line));

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
  // Someone who has finished onboarding (the profile page is closed to anyone who has not) and has no photo.
  member = await createTestUser('photocard');
  await pool.query(`UPDATE users SET linkedin_url = NULL, avatar_url = NULL, avatar_blob = NULL WHERE id = $1`, [member.id]);
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
  // The page says which site it is on (?origin=); the server keeps it only when it is one of ours. This link is built on
  // the host Google returns to, so it is one request.
  const photo = await startSignIn(`${link}&origin=${encodeURIComponent(PREVIEW_SITE)}`);
  expect(photo.requests).toHaveLength(1);
  expect(photo.google.hostname).toBe('accounts.google.com');
  // Google is asked for a plain redirect with the code in the query: a form_post return would not carry a Lax cookie.
  expect(photo.google.searchParams.has('response_mode')).toBe(false);
  // The state Google carries back is a token the server signed, read with the key the test tokens use.
  const photoState = photo.google.searchParams.get('state') || '';
  const oauthState = readSignedToken(photoState);
  expect(oauthState).toMatchObject({
    purpose: 'google-oauth-state', photoLinkUserId: member.id, redirect: '/onboarding', origin: PREVIEW_SITE,
  });
  console.log('  ✓ Google link is signed for this member, returns to /onboarding, and keeps the site it started on.');

  // The start ties the sign-in to this browser: a cookie on the host Google returns to, with the hash of its value in the state.
  const bound = nonceCookieOf(photo);
  expect(oauthState.nonceHash).toBe(createHash('sha256').update(bound.nonce).digest('hex'));
  expect(JSON.stringify(oauthState)).not.toContain(bound.nonce);
  // The callback is the address Google was told (its redirect_uri). With that cookie it goes on and asks Google about the
  // code, which Google refuses: the photo link fails on the page it started from. The same address with no cookie, or with
  // another sign-in's, is refused before Google is asked anything, and asked to start again. Either way the cookie is cleared.
  const callbackAddress = returnTo(bound.redirectUri, photoState);
  const sameBrowser = await fetch(callbackAddress, { redirect: 'manual', headers: { Cookie: `${bound.name}=${bound.nonce}` } });
  expect(sameBrowser.status).toBe(302);
  expect(sameBrowser.headers.get('location')).toBe(`${PREVIEW_SITE}/onboarding?photo=failed`);
  expect(clearsTheCookie(sameBrowser)).toBe(true);
  const otherBrowser = await fetch(callbackAddress, { redirect: 'manual' });
  expect(otherBrowser.status).toBe(302);
  expect(otherBrowser.headers.get('location')).toBe(`${PREVIEW_SITE}/login?error=google_try_again`);
  expect(clearsTheCookie(otherBrowser)).toBe(true);
  const wrongCookie = await fetch(callbackAddress, { redirect: 'manual', headers: { Cookie: `${bound.name}=${'0'.repeat(64)}` } });
  expect(wrongCookie.headers.get('location')).toBe(`${PREVIEW_SITE}/login?error=google_try_again`);
  console.log('  ✓ the start sets the browser cookie on the host Google returns to; the callback goes on with it, and is refused without it or with another.');

  // The sign-in the client really starts: from the API origin it knows (SERVER, the onrender host), which sends the browser on
  // to the host Google returns to. The cookie must be set THERE, and Google must be told to return there: set on the first
  // host it would never reach the callback, and every member would be refused.
  const fromClient = await startSignIn(`${SERVER}/api/auth/google?origin=${encodeURIComponent(PREVIEW_SITE)}`);
  const clientCookie = nonceCookieOf(fromClient);
  const clientState = fromClient.google.searchParams.get('state') || '';
  expect(readSignedToken(clientState)).toMatchObject({ purpose: 'google-oauth-state', origin: PREVIEW_SITE });
  expect(fromClient.google.searchParams.has('response_mode')).toBe(false);
  const clientCallback = returnTo(clientCookie.redirectUri, clientState);
  const clientSame = await fetch(clientCallback, { redirect: 'manual', headers: { Cookie: `${clientCookie.name}=${clientCookie.nonce}` } });
  expect(clientSame.headers.get('location'), 'the cookie reaches the callback, which asks Google about the (made-up) code').toBe(`${PREVIEW_SITE}/login?error=google_auth_failed`);
  const clientOther = await fetch(clientCallback, { redirect: 'manual' });
  expect(clientOther.headers.get('location')).toBe(`${PREVIEW_SITE}/login?error=google_try_again`);
  // An older sign-in page that names no site and relies on the Referer still comes back to the site it started on.
  const byReferer = await startSignIn(`${SERVER}/api/auth/google`, { Referer: `${PREVIEW_SITE}/login` });
  expect(readSignedToken(byReferer.google.searchParams.get('state') || '').origin).toBe(PREVIEW_SITE);
  console.log(`  ✓ a start from the client's API host is sent on once and ends on the host Google returns to (${fromClient.requests.map((r) => new URL(r).host).join(' -> ')}).`);

  // A forged or foreign token is ignored: the flow becomes a plain sign-in, not a photo link.
  const forged = await startSignIn(`${SERVER}/api/auth/google?photo=not-a-token&redirect=/onboarding&origin=${encodeURIComponent(PREVIEW_SITE)}`);
  const forgedState = readSignedToken(forged.google.searchParams.get('state') || '');
  expect(forgedState.purpose).toBe('google-oauth-state');
  expect(forgedState.photoLinkUserId).toBeUndefined();
  expect(forgedState.origin).toBe(PREVIEW_SITE);
  // A site that is not ours is never kept, whatever the page says: the state names a real site of ours instead.
  const foreign = await startSignIn(`${SERVER}/api/auth/google?origin=${encodeURIComponent('https://evil.example')}`);
  const foreignState = readSignedToken(foreign.google.searchParams.get('state') || '');
  expect(foreignState.origin).not.toBe('https://evil.example');
  expect(String(foreignState.origin)).toMatch(/^https?:\/\//);
  // And a state nobody signed changes nothing on the way back. This one is the old format (base64 JSON naming this
  // member's photo link). It carries no nonce for a cookie to answer, and fetch sends no cookie anyway, so the callback
  // is refused before Google is asked anything and no photo outcome is reached: the login page, asking to start again.
  // (Before the state was signed this went to /onboarding?photo=failed; before the browser cookie, to a plain
  // sign-in that failed at Google as /login?error=google_auth_failed.)
  const unsigned = Buffer.from(JSON.stringify({ photoLinkUserId: member.id, redirect: '/onboarding' })).toString('base64url');
  const back = await fetch(returnTo(bound.redirectUri, unsigned), { redirect: 'manual' });
  expect(back.status).toBe(302);
  const backTo = back.headers.get('location') || '';
  expect(backTo).toMatch(/\/login\?error=google_try_again$/);
  expect(backTo).not.toMatch(/photo=/);
  console.log('  ✓ a foreign site is never kept, and a state nobody signed changes nothing.');

  // The card, with no photo yet: the profile page's top card, opened as a member who has finished onboarding.
  const page = await openAs(member, '/profile');
  const google = page.getByTestId('use-google-photo');
  const change = page.getByRole('button', { name: 'Change photo' });
  await expect(google).toBeVisible({ timeout: 30_000 });
  await expect(change).toBeVisible();
  // No photo yet: the card shows the member's initials, not a picture, and none is stored.
  await expect(page.locator('img[src^="data:"]')).toHaveCount(0);
  const before = await pool.query(`SELECT avatar_url FROM users WHERE id = $1`, [member.id]);
  expect(before.rows[0].avatar_url).toBeNull();
  for (const [name, button] of [['Use my Google photo', google], ['Change photo', change]] as const) {
    const box = await button.boundingBox();
    expect(box!.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
  }

  // Change photo, from a file: it is the avatar at once, in the card and in the account.
  await page.locator('input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  // The success toast is brief; the durable outcomes below are what matter. (The small avatar in the
  // page header is hidden on a phone, so look for the picture that is on screen.)
  await expect(page.locator('img[src^="data:image/png"]:visible').first()).toBeVisible({ timeout: 20_000 });
  const row = await pool.query(`SELECT avatar_url FROM users WHERE id = $1`, [member.id]);
  expect(String(row.rows[0].avatar_url)).toMatch(/^data:image\/png;base64,/);
  console.log('  ✓ uploaded photo is the avatar immediately.');

  // Coming back from Google with no photo says so, and the URL is cleaned.
  await gotoRetry(page, `${APP}/profile?photo=none`);
  await expect(page.getByText(/That Google account has no photo/)).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/photo=/);
  console.log('  ✓ the return trip from Google is handled.');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 390px').toBeLessThanOrEqual(0);

  // Google's "cancelled" outcome is handled too, and the link the profile's own tap asks for comes back to the profile.
  await gotoRetry(page, `${APP}/profile?photo=cancelled`);
  await expect(google).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/No problem, nothing changed/)).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/photo=/);
  const profileState = await apiAs(member, 'POST', '/auth/google/photo-state', { redirect: '/profile' });
  expect(profileState.json.data.url).toMatch(/redirect=%2Fprofile$/);
  console.log('  ✓ the profile page has the Google photo tap and handles the return trip.');
});
