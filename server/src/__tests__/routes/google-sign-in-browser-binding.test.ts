// ─── A Google sign-in only finishes in the browser that started it (7 Oct 2026) ──
//
// The OAuth state is signed, so only the server can write one, but nothing tied it to the browser that
// started the sign-in. An attacker could start a sign-in in their own browser, finish Google with THEIR
// account, and send a victim the callback address (their code, their valid state): the victim's browser
// ended up signed into the ATTACKER's account, and anything the victim then typed into it was the
// attacker's to read. The same goes for a photo-link state that was started in someone else's browser.
// (A photo-link START ADDRESS that an attacker minted for their own account and a victim then opens is a
// different attack, and this does not close it: the victim's own browser starts that one, so it is bound.)
//
// Now the start puts a one-time value in a cookie on the API host (and its hash in the signed state), and the
// callback goes on only when the browser's cookie is that value. A missing or invalid state no longer signs
// anyone in either (Ali, 7 Oct 2026: it used to be "a plain sign-in").
//
// Production has TWO API hosts: the client starts on rsn-api-h04m.onrender.com, but Google is told to return to
// API_BASE_URL (api.rsn.network), and a cookie set on the first is never sent to the second, which would have
// refused every sign-in. So the start runs on the canonical host: a start anywhere else is sent on, once, to the
// same start there, and sets nothing. `Browser` (google-browser.ts) keeps a cookie jar per host, with the rules a
// real browser applies, so these tests can see which host holds the cookie and which host Google returns to.
//
// These go through express with the real router, the real state and the real cookie handling, mounted and
// configured the way index.ts does (the router at /api/auth, the first proxy hop trusted, Helmet); only the
// database, Google and the account lookup are stand-ins.

import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-secret-with-enough-length-0123456789', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
    // As in production: the main app is app.rsn.network (so the preview is a different allowed site), and Google is
    // told to return to api.rsn.network.
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.rsn.network',
    googleClientId: 'gid', googleClientSecret: 'gsecret',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));
const mockFindOrCreate = jest.fn();
jest.mock('../../services/identity/identity.service', () => ({
  findOrCreateGoogleUser: (...a: unknown[]) => mockFindOrCreate(...a),
  __esModule: true,
}));
const mockCapture = jest.fn();
jest.mock('../../services/onboarding/avatar.service', () => ({ captureAvatar: (...a: unknown[]) => mockCapture(...a), __esModule: true }));
jest.mock('../../services/onboarding/stage-events.repo', () => ({ record: jest.fn().mockResolvedValue(undefined), __esModule: true }));

import authRoutes from '../../routes/auth';
import config from '../../config';
import logger from '../../config/logger';
import { buildOauthState, mintPhotoLinkToken, GoogleOauthState } from '../../services/identity/google-photo-link';
import { newOauthNonce } from '../../services/identity/oauth-browser-binding';
import type { BindingRefusal } from '../../services/identity/oauth-browser-binding';
import { Browser as BrowserJar, setCookieLines, parseSetCookie } from './google-browser';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';
const MEMBER = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const ATTACKER_MEMBER = 'b0000000-0000-4000-8000-000000000001';
const VICTIM = 'b0000000-0000-4000-8000-000000000002';
const SECRET = 'test-secret-with-enough-length-0123456789';
const PURPOSE = 'google-oauth-state';
const PICTURE = 'https://lh3.googleusercontent.com/a/photo';

// The two hosts the API answers on in production. The client builds its start from CLIENT_API (runtimeEndpoints.ts);
// Google is told to return to API_BASE_URL (CANONICAL), so that is the host that has to hold the cookie.
const CANONICAL = 'api.rsn.network';
const CLIENT_API = 'rsn-api-h04m.onrender.com';

// The cookie that ties a sign-in to the browser, named here in full so a rename cannot go unnoticed. In production it is a
// __Host- cookie: a browser keeps one only when it is Secure, has Path=/ and names no Domain, so no sibling site on
// rsn.network can set it or shadow it. In development the API is plain http, where Secure (and so the prefix) cannot
// apply: the plain name stays, on its own path.
const COOKIE = '__Host-rsn_oauth_nonce';
const COOKIE_PATH = '/';
const DEV_COOKIE = 'rsn_oauth_nonce';
const DEV_COOKIE_PATH = '/api/auth/google';

// As index.ts builds the app: the first proxy hop is trusted, Helmet answers Referrer-Policy: no-referrer on every
// response (so a redirect takes the Referer away from the request it leads to), and the router is at /api/auth.
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use('/api/auth', authRoutes);

const realFetch = global.fetch;
beforeEach(() => {
  mockFindOrCreate.mockReset().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
  mockCapture.mockReset().mockResolvedValue(true);
  // Google is not armed unless a test arms it: a callback that reaches for it is a callback that went on.
  global.fetch = jest.fn();
});
afterAll(() => { global.fetch = realFetch; });

/** Google accepts the code and knows the member (the two calls the callback makes, in order). */
function googleKnowsTheMember(profile: Record<string, unknown> = { email: 'a@b.co', name: 'A B' }) {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ json: async () => ({ access_token: 'g-token' }) })
    .mockResolvedValueOnce({ json: async () => profile }) as unknown as typeof fetch;
}

/** Google refuses the code. */
function googleRefusesTheCode() {
  global.fetch = jest.fn().mockResolvedValueOnce({ json: async () => ({ error: 'invalid_grant' }) }) as unknown as typeof fetch;
}

/** Forget everything called so far (and unarm Google), to check a second callback in the same test as cleanly as the first. */
function forgetCalls() {
  (logger.warn as jest.Mock).mockClear();
  mockFindOrCreate.mockClear();
  mockCapture.mockClear();
  global.fetch = jest.fn();
}

// ── Reading what the server sets ─────────────────────────────────────────────

/** The one Set-Cookie line about the nonce cookie of that name in a response (fails if there is not exactly one). */
function nonceCookie(res: request.Response, name: string = COOKIE) {
  const lines = setCookieLines(res).filter((line) => line.startsWith(`${name}=`));
  expect(lines).toHaveLength(1);
  return parseSetCookie(lines[0]);
}

const stateFrom = (location: string) => new URL(location).searchParams.get('state') ?? '';
const claimsOf = (state: string) => jwt.verify(state, SECRET) as jwt.JwtPayload;
const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const verifyUrl = (base: string, inviteCode?: string) =>
  `${base}/auth/verify?accessToken=at&refreshToken=rt${inviteCode ? `&inviteCode=${inviteCode}` : ''}`;

// ── A browser ────────────────────────────────────────────────────────────────

class Browser extends BrowserJar {
  /** Where Google was told to send this browser back: the redirect_uri of its last start. */
  returnAddress = `https://${CANONICAL}/api/auth/google/callback`;

  constructor() {
    super(app, [CANONICAL, CLIENT_API]);
  }

  /** The member presses a Google button. The client starts on its own API host (CLIENT_API) unless `host` says otherwise. */
  async start(query: Record<string, string> = {}, options: { host?: string; referer?: string } = {}) {
    const search = new URLSearchParams(query).toString();
    const nav = await this.navigate(`https://${options.host ?? CLIENT_API}/api/auth/google${search ? `?${search}` : ''}`, { referer: options.referer });
    const google = nav.leftFor;
    if (!google || google.hostname !== 'accounts.google.com') {
      throw new Error(`the start did not end at Google: ${nav.chain.map((hop) => `${hop.status} ${hop.url}`).join(' -> ')}`);
    }
    this.returnAddress = google.searchParams.get('redirect_uri') as string;
    return { ...nav, google, state: google.searchParams.get('state') ?? '', redirectUri: this.returnAddress };
  }

  /** Google sends the browser back to the address it was given, with a code and the state (and whatever else `extra` says). */
  async comesBack(state: string | undefined, extra: Record<string, string> = { code: 'c' }) {
    const address = new URL(this.returnAddress);
    for (const [key, value] of Object.entries({ ...extra, ...(state === undefined ? {} : { state }) })) address.searchParams.set(key, value);
    return (await this.navigate(address.href)).res;
  }
}

/**
 * A state the start would sign for this browser with claims the real start would not choose (a foreign site, an old
 * shape). A real start gives the browser its real cookie, and the state carries that cookie's hash.
 */
async function startedWith(browser: Browser, claims: GoogleOauthState): Promise<string> {
  await browser.start();
  const nonce = browser.valueSentTo(COOKIE, browser.returnAddress) as string;
  return buildOauthState({ ...claims, nonceHash: sha256Hex(nonce) });
}

/** The start, as a request that arrived on `host` (supertest sets the Host header, as a proxy forwards it). */
const startOn = (host: string, query: Record<string, string | string[]> = {}) =>
  request(app).get('/api/auth/google').set('Host', host).query(query);

/** The callback with exactly the Cookie header given (none when undefined), whatever a jar would do. */
function returnWith(state: string | string[] | undefined, cookie?: string, extra: Record<string, string> = { code: 'c' }) {
  const req = request(app).get('/api/auth/google/callback').set('Host', CANONICAL)
    .query({ ...extra, ...(state === undefined ? {} : { state }) });
  return cookie === undefined ? req : req.set('Cookie', cookie);
}

const withNonce = (nonce: string) => `${COOKIE}=${nonce}`;

// ── What every refusal and every outcome must show ───────────────────────────

const REASONS: BindingRefusal[] = ['no state', 'bad state', 'no cookie', 'cookie mismatch'];
/** The fields of every warning the callback wrote about refusing a sign-in that did not start in this browser. */
const refusalWarnings = () =>
  (logger.warn as jest.Mock).mock.calls.map(([fields]) => fields).filter((fields) => REASONS.includes(fields?.reason));

/**
 * The cookie is removed: same name, same path, same flags it was set with (Secure only for the production cookie), Max-Age=0,
 * and nothing in it. In development the name and path are the plain ones, which the caller says.
 */
function expectCleared(res: request.Response, name: string = COOKIE, path: string = COOKIE_PATH) {
  const { value, attributes } = nonceCookie(res, name);
  expect(value).toBe('');
  expect(attributes).toEqual(expect.arrayContaining(['Max-Age=0', `Path=${path}`, 'HttpOnly', 'SameSite=Lax']));
  expect(attributes.includes('Secure')).toBe(name === COOKIE);
}

/** A refused callback: it goes back to the login page, asking to start again, and nothing at all went on. */
function expectRefused(res: request.Response, site: string, reason: BindingRefusal, name: string = COOKIE, path: string = COOKIE_PATH) {
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`${site}/login?error=google_try_again`);
  // No code exchange, no sign-in, no photo change.
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockFindOrCreate).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();
  // And no tokens reach the address either.
  expect(res.headers.location).not.toMatch(/accessToken|refreshToken/);
  expectCleared(res, name, path);
  // One warning from the callback, naming the reason and nothing else.
  expect(refusalWarnings()).toEqual([{ reason }]);
}

// ── The start ────────────────────────────────────────────────────────────────

describe('GET /auth/google: the start ties the sign-in to this browser', () => {
  it('sets __Host-rsn_oauth_nonce on the API\'s own host: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, 30 minutes', async () => {
    const res = await startOn(CANONICAL);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);

    expect(setCookieLines(res)).toHaveLength(1);
    const { name, value, attributes } = nonceCookie(res);
    expect(name).toBe('__Host-rsn_oauth_nonce');
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=1800']));
    // Nothing else: above all no Domain (a browser refuses a __Host- cookie that names one, and the cookie belongs to the
    // API's host alone) and nothing that widens its reach.
    expect(attributes.map((a) => a.split('=')[0]).sort()).toEqual(['Expires', 'HttpOnly', 'Max-Age', 'Path', 'SameSite', 'Secure']);
    // Expires is Express's own companion to Max-Age, and says the same 30 minutes.
    const expires = Date.parse(attributes.find((a) => a.startsWith('Expires='))!.slice('Expires='.length));
    expect(Math.abs(expires - Date.now() - 30 * 60 * 1000)).toBeLessThan(10_000);
  });

  it('is only ever the __Host- name in production: no plain-named twin is set beside it', async () => {
    const lines = setCookieLines(await startOn(CANONICAL));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('__Host-rsn_oauth_nonce=')).toBe(true);
  });

  it('in development, where the API is plain http on localhost: the plain name, on its own path, not Secure (a __Host- cookie cannot be)', async () => {
    const dev = config as unknown as { isDev: boolean };
    try {
      dev.isDev = true;
      const res = await startOn(CANONICAL);
      expect(setCookieLines(res)).toHaveLength(1);
      const { name, attributes } = nonceCookie(res, DEV_COOKIE);
      expect(name).toBe('rsn_oauth_nonce');
      expect(attributes).not.toContain('Secure');
      expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', `Path=${DEV_COOKIE_PATH}`, 'Max-Age=1800']));
      expect(attributes.map((a) => a.split('=')[0]).sort()).toEqual(['Expires', 'HttpOnly', 'Max-Age', 'Path', 'SameSite']);
    } finally {
      dev.isDev = false;
    }
    expect(nonceCookie(await startOn(CANONICAL)).attributes).toContain('Secure');
  });

  it('puts the hash of the cookie\'s value in the signed state, and never the value itself', async () => {
    const res = await startOn(CANONICAL, { origin: PREVIEW, inviteCode: 'ABC123' });
    const { value } = nonceCookie(res);
    const state = stateFrom(res.headers.location);
    expect(claimsOf(state).nonceHash).toBe(sha256Hex(value));
    // The value is in the cookie alone: not in the state, not in the address Google is sent to.
    expect(JSON.stringify(claimsOf(state))).not.toContain(value);
    expect(res.headers.location).not.toContain(value);
    expect(Buffer.from(state.split('.')[1], 'base64url').toString()).not.toContain(value);
  });

  it('is a new value, and a new state hash, for every start', async () => {
    const starts = await Promise.all(Array.from({ length: 12 }, () => startOn(CANONICAL)));
    expect(new Set(starts.map((res) => nonceCookie(res).value)).size).toBe(12);
    expect(new Set(starts.map((res) => claimsOf(stateFrom(res.headers.location)).nonceHash)).size).toBe(12);
  });

  it('lives exactly as long as the state: both 30 minutes', async () => {
    const res = await startOn(CANONICAL);
    const claims = claimsOf(stateFrom(res.headers.location));
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(30 * 60);
    expect(nonceCookie(res).attributes).toContain(`Max-Age=${30 * 60}`);
  });

  it('is set for an invite and for a photo link as for a plain sign-in', async () => {
    const invite = await startOn(CANONICAL, { inviteCode: 'ABC123' });
    const photo = await startOn(CANONICAL, { photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' });
    for (const res of [invite, photo]) {
      expect(claimsOf(stateFrom(res.headers.location)).nonceHash).toBe(sha256Hex(nonceCookie(res).value));
    }
    expect(claimsOf(stateFrom(photo.headers.location)).photoLinkUserId).toBe(MEMBER);
  });

  it('sets nothing when Google sign-in is not configured', async () => {
    const cfg = config as unknown as { googleClientId: string };
    try {
      cfg.googleClientId = '';
      const res = await startOn(CANONICAL);
      expect(res.status).toBe(501);
      expect(setCookieLines(res)).toEqual([]);
    } finally {
      cfg.googleClientId = 'gid';
    }
  });

  // A return by form_post is a cross-site POST, and a Lax cookie is not sent on one: the sign-in would be refused every time.
  it('asks Google for a plain redirect with the code in the query: no response_mode, so the return is a GET a Lax cookie rides on', async () => {
    const google = new URL((await startOn(CANONICAL)).headers.location);
    expect(google.searchParams.has('response_mode')).toBe(false);
    expect(google.searchParams.get('response_type')).toBe('code');
    expect(google.search).not.toMatch(/form_post|response_mode/);
  });
});

// ── The host the start runs on ───────────────────────────────────────────────

describe('GET /auth/google: the start runs on the host Google will return to', () => {
  const noLogs = () => [logger.warn, logger.error, logger.info, logger.debug].forEach((fn) => expect(fn).not.toHaveBeenCalled());

  it('a start on the client\'s API host is sent on, once, to the same start on the canonical host, and sets nothing', async () => {
    const res = await startOn(CLIENT_API, { origin: PREVIEW, inviteCode: 'ABC123' });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.location);
    expect(`${to.origin}${to.pathname}`).toBe(`https://${CANONICAL}/api/auth/google`);
    expect(Object.fromEntries(to.searchParams)).toEqual({ origin: PREVIEW, inviteCode: 'ABC123', hop: '1' });
    // No cookie, no state: nothing was minted on a host Google will not return to.
    expect(setCookieLines(res)).toEqual([]);
    expect(res.headers.location).not.toContain('state=');
    // Not a refusal, and nothing worth a log line.
    noLogs();
  });

  it.each([
    ['the invite code', { inviteCode: 'ABC123' }],
    ['the site it started on', { origin: PREVIEW }],
    ['a photo link and its return path', { photo: 'a.photo.token', redirect: '/profile' }],
    ['all of them at once', { origin: PREVIEW, inviteCode: 'ABC123', photo: 'a.photo.token', redirect: '/profile' }],
    ['values that need encoding', { inviteCode: 'a b&c=d', redirect: '/profile?x=1&y=2' }],
  ] as Array<[string, Record<string, string>]>)('keeps %s', async (_what, query) => {
    const to = new URL((await startOn(CLIENT_API, query)).headers.location);
    // With no site named and no Referer, the main app is what it would resolve to.
    expect(Object.fromEntries(to.searchParams)).toEqual({ ...('origin' in query ? {} : { origin: MAIN }), ...query, hop: '1' });
  });

  // The browser does not necessarily send the same Referer on the second request, and Helmet's Referrer-Policy:
  // no-referrer on the redirect takes it away: the site the first request resolved from its Referer rides in ?origin=.
  it.each([
    ['the preview', `${PREVIEW}/login`, PREVIEW],
    ['the preview, as the bare origin a cross-site navigation sends', `${PREVIEW}/`, PREVIEW],
    ['the main app', `${MAIN}/login`, MAIN],
    ['a site that is not ours', 'https://evil.example/login', MAIN],
    ['the API itself', `https://${CLIENT_API}/`, MAIN],
  ])('with no ?origin=, a Referer of %s makes the second start carry the site it resolves to', async (_what, referer, expected) => {
    const res = await startOn(CLIENT_API).set('Referer', referer);
    expect(new URL(res.headers.location).searchParams.getAll('origin')).toEqual([expected]);
  });

  it('with neither a Referer nor an ?origin=, the second start is told the main app (what it would have resolved to anyway)', async () => {
    expect(new URL((await startOn(CLIENT_API)).headers.location).searchParams.getAll('origin')).toEqual([MAIN]);
  });

  it('a named ?origin= is kept exactly as sent, even one that is not ours (it resolves to the main app on the second start, as before)', async () => {
    const res = await startOn(CLIENT_API, { origin: 'https://evil.example' }).set('Referer', `${PREVIEW}/login`);
    expect(new URL(res.headers.location).searchParams.getAll('origin')).toEqual(['https://evil.example']);
  });

  it('an empty, repeated or array-shaped ?origin= counts as none, and becomes the one site it resolves to, with nothing of the old value left', async () => {
    const empty = await startOn(CLIENT_API, { origin: '' }).set('Referer', `${PREVIEW}/login`);
    const repeated = await startOn(CLIENT_API, { origin: ['https://evil.example', PREVIEW] }).set('Referer', `${PREVIEW}/login`);
    const bracketed = await request(app).get('/api/auth/google?origin[]=https%3A%2F%2Fevil.example&origin[x]=y').set('Host', CLIENT_API)
      .set('Referer', `${PREVIEW}/login`);
    for (const res of [empty, repeated, bracketed]) {
      const to = new URL(res.headers.location);
      expect(to.searchParams.getAll('origin')).toEqual([PREVIEW]);
      // So the second start reads one string, not a list.
      expect([...to.searchParams.keys()].filter((key) => key.startsWith('origin'))).toEqual(['origin']);
    }
  });

  it('only ever sends the browser to the configured API origin, whatever the request says', async () => {
    const hostile: Array<Record<string, string>> = [
      { origin: 'https://evil.example' }, { redirect: '//evil.example' }, { redirect: 'https://evil.example/x' },
      { inviteCode: '\r\nSet-Cookie: x=1' }, { 'x@evil.example': '1' }, { redirect: '/\\evil.example' },
    ];
    for (const query of hostile) {
      const to = new URL((await startOn(CLIENT_API, query)).headers.location);
      expect(to.origin).toBe(`https://${CANONICAL}`);
      expect(to.pathname).toBe('/api/auth/google');
      expect(to.username).toBe('');
    }
    // Nor does the spelling of the request's own path, or its host, change where it goes.
    for (const host of ['evil.example', 'api.rsn.network.evil.example', `${CLIENT_API}:8443`, CLIENT_API.toUpperCase()]) {
      const res = await request(app).get('/API/AUTH/GOOGLE/?inviteCode=X').set('Host', host);
      const to = new URL(res.headers.location);
      expect(`${to.origin}${to.pathname}`).toBe(`https://${CANONICAL}/api/auth/google`);
    }
  });

  it('a request that already carries hop is never sent on again: it is a normal start, wherever it arrived', async () => {
    for (const hop of ['1', '0', '', 'yes']) {
      const res = await startOn(CLIENT_API, { hop, origin: PREVIEW });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).hostname).toBe('accounts.google.com');
    }
  });

  it('the address it sends on to carries the flag, so a proxy that makes every request look foreign still ends at Google, not in a loop', async () => {
    const first = await startOn(CLIENT_API, { origin: PREVIEW });
    const again = new URL(first.headers.location);
    // The server still sees the foreign host on the second request (a proxy that rewrites Host).
    const second = await request(app).get(`${again.pathname}${again.search}`).set('Host', CLIENT_API);
    expect(new URL(second.headers.location).hostname).toBe('accounts.google.com');
  });

  it('a start on the canonical host is not sent on: it sets the cookie, and Google is told to return to the host that set it', async () => {
    const res = await startOn(CANONICAL, { origin: PREVIEW });
    expect(new URL(res.headers.location).hostname).toBe('accounts.google.com');
    const redirectUri = new URL(new URL(res.headers.location).searchParams.get('redirect_uri') as string);
    expect(redirectUri.host).toBe(CANONICAL);
    expect(redirectUri.pathname).toBe('/api/auth/google/callback');
    expect(nonceCookie(res).name).toBe(COOKIE);
  });

  it.each(['API.RSN.NETWORK', 'Api.Rsn.Network', `${CANONICAL}:443`, `${CANONICAL}:8080`])('and the host may be spelled %s', async (host) => {
    const res = await startOn(host);
    expect(new URL(res.headers.location).hostname).toBe('accounts.google.com');
    expect(setCookieLines(res)).toHaveLength(1);
  });

  it('the hop is the very first thing the start does, even before the answer for a server with no Google sign-in', async () => {
    const cfg = config as unknown as { googleClientId: string };
    try {
      cfg.googleClientId = '';
      const foreign = await startOn(CLIENT_API);
      expect(foreign.status).toBe(302);
      expect(new URL(foreign.headers.location).host).toBe(CANONICAL);
      expect((await startOn(CANONICAL)).status).toBe(501);
    } finally {
      cfg.googleClientId = 'gid';
    }
  });

  // req.hostname is what Express makes of the request, with `trust proxy` 1 as index.ts sets it: X-Forwarded-Host when a
  // proxy sends one (the first of a list), else the Host header (without its port). Behind Render the Host header is the
  // name the browser asked for; the loop guard above keeps the hop safe if a proxy ever shows something else.
  it('reads the host from X-Forwarded-Host when a proxy sends one (trust proxy 1), else from Host', async () => {
    const forwardedAsForeign = await startOn(CANONICAL).set('X-Forwarded-Host', CLIENT_API);
    expect(`${new URL(forwardedAsForeign.headers.location).origin}`).toBe(`https://${CANONICAL}`);
    expect(new URL(forwardedAsForeign.headers.location).searchParams.get('hop')).toBe('1');

    const forwardedAsCanonical = await startOn(CLIENT_API).set('X-Forwarded-Host', CANONICAL);
    expect(new URL(forwardedAsCanonical.headers.location).hostname).toBe('accounts.google.com');

    const firstOfAList = await startOn(CLIENT_API).set('X-Forwarded-Host', `${CANONICAL}, ${CLIENT_API}`);
    expect(new URL(firstOfAList.headers.location).hostname).toBe('accounts.google.com');
  });
});

// ── The whole sign-in, in a browser, on the two hosts ────────────────────────

describe('a sign-in from the client, through both API hosts', () => {
  it('starts on the client\'s API host, is sent on to the canonical host, gets its cookie THERE, and finishes where Google returns it', async () => {
    const browser = new Browser();
    const start = await browser.start({ origin: PREVIEW, inviteCode: 'ABC123' });

    // What the browser did: the client's API host sent it on (no cookie), then the canonical host sent it to Google.
    expect(start.chain.map((hop) => [new URL(hop.url).host, hop.status])).toEqual([[CLIENT_API, 302], [CANONICAL, 302]]);
    expect(browser.holding(COOKIE).map((c) => c.host)).toEqual([CANONICAL]);
    // Google returns it to the host that holds the cookie.
    expect(new URL(start.redirectUri).host).toBe(CANONICAL);

    googleKnowsTheMember();
    const res = await browser.comesBack(start.state);
    expect(res.headers.location).toBe(verifyUrl(PREVIEW, 'ABC123'));
    expect(mockFindOrCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.co' }), 'ABC123');
    expect(browser.holding(COOKIE)).toEqual([]);
  });

  it('an older sign-in page that names no site and relies on the Referer still comes back to the site it started on', async () => {
    const browser = new Browser();
    const start = await browser.start({}, { referer: `${PREVIEW}/login` });
    // Helmet's no-referrer on the redirect took the Referer away from the second request; the site rode in ?origin= instead.
    expect(start.chain.map((hop) => hop.referer)).toEqual([`${PREVIEW}/login`, undefined]);
    expect(claimsOf(start.state).origin).toBe(PREVIEW);

    googleKnowsTheMember();
    expect((await browser.comesBack(start.state)).headers.location).toBe(verifyUrl(PREVIEW));
  });

  it('a start that Google would return to another host than the one that holds the cookie is refused: a cookie set by one host is never sent to another', async () => {
    // The first version of this rule set its cookie on the client's API host, and Google returned to the other one.
    const browser = new Browser();
    const start = await browser.start({ origin: PREVIEW }, { host: CANONICAL });
    expect(browser.holding(COOKIE).map((c) => c.host)).toEqual([CANONICAL]);

    const other = new URL(start.redirectUri);
    other.host = CLIENT_API;
    other.search = new URLSearchParams({ code: 'c', state: start.state }).toString();
    googleKnowsTheMember();
    expect(browser.cookieHeaderFor(other)).toBeUndefined();
    expectRefused((await browser.navigate(other.href)).res, PREVIEW, 'no cookie');
  });

  it('a photo link, whose address the server builds on the canonical host, is one request and works as it did', async () => {
    const browser = new Browser();
    const start = await browser.start({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' }, { host: CANONICAL });
    expect(start.chain.map((hop) => new URL(hop.url).host)).toEqual([CANONICAL]);
    googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
    expect((await browser.comesBack(start.state)).headers.location).toBe(`${PREVIEW}/profile?photo=done`);
    expect(mockCapture).toHaveBeenCalledWith(MEMBER, PICTURE);
  });

  describe('in development, where API_BASE_URL is localhost', () => {
    it('a start on localhost is not sent on, and the cookie comes back on the same host', async () => {
      const cfg = config as unknown as { isDev: boolean; apiBaseUrl: string };
      try {
        cfg.isDev = true;
        cfg.apiBaseUrl = 'http://localhost:3001';
        const browser = new BrowserJar(app, ['localhost:3001']);
        const nav = await browser.navigate(`http://localhost:3001/api/auth/google?origin=${encodeURIComponent(PREVIEW)}`);
        expect(nav.chain).toHaveLength(1);
        expect(nav.leftFor?.hostname).toBe('accounts.google.com');
        const redirectUri = new URL(nav.leftFor!.searchParams.get('redirect_uri') as string);
        expect(redirectUri.host).toBe('localhost:3001');
        // Plain http: the plain name, on its own path (a __Host- cookie could not be kept here at all).
        expect(browser.holding(DEV_COOKIE).map((c) => [c.host, c.path])).toEqual([['localhost', DEV_COOKIE_PATH]]);
        expect(browser.holding(COOKIE)).toEqual([]);

        redirectUri.search = new URLSearchParams({ code: 'c', state: nav.leftFor!.searchParams.get('state') as string }).toString();
        googleKnowsTheMember();
        expect((await browser.navigate(redirectUri.href)).res.headers.location).toBe(verifyUrl(PREVIEW));
        // Cleared the way it was set: the browser let go of it.
        expect(browser.holding(DEV_COOKIE)).toEqual([]);
      } finally {
        cfg.isDev = false;
        cfg.apiBaseUrl = 'https://api.rsn.network';
      }
    });

    it('a cookie sent twice is refused here too, and the plain name is the only one read', async () => {
      const cfg = config as unknown as { isDev: boolean; apiBaseUrl: string };
      try {
        cfg.isDev = true;
        cfg.apiBaseUrl = 'http://localhost:3001';
        const browser = new BrowserJar(app, ['localhost:3001']);
        const nav = await browser.navigate(`http://localhost:3001/api/auth/google?origin=${encodeURIComponent(PREVIEW)}`);
        const state = nav.leftFor!.searchParams.get('state') as string;
        const nonce = browser.valueSentTo(DEV_COOKIE, 'http://localhost:3001/api/auth/google/callback') as string;
        const callbackWith = (cookie: string) => request(app).get('/api/auth/google/callback').set('Host', 'localhost:3001')
          .query({ code: 'c', state }).set('Cookie', cookie);

        googleKnowsTheMember();
        expectRefused(await callbackWith(`${DEV_COOKIE}=${nonce}; ${DEV_COOKIE}=${nonce}`), PREVIEW, 'cookie mismatch', DEV_COOKIE, DEV_COOKIE_PATH);
        forgetCalls();
        googleKnowsTheMember();
        // A __Host- cookie is nothing to the development server.
        expectRefused(await callbackWith(`${COOKIE}=${nonce}`), PREVIEW, 'no cookie', DEV_COOKIE, DEV_COOKIE_PATH);
      } finally {
        cfg.isDev = false;
        cfg.apiBaseUrl = 'https://api.rsn.network';
      }
    });
  });
});

// ── The callback, in the browser that started it ─────────────────────────────

describe('GET /auth/google/callback: in the browser that started the sign-in', () => {
  it('finishes the sign-in on the site it started on, with the invite code, and clears the cookie', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW, inviteCode: 'ABC123' });
    googleKnowsTheMember();
    const res = await browser.comesBack(state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(verifyUrl(PREVIEW, 'ABC123'));
    expect(mockFindOrCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.co' }), 'ABC123');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expectCleared(res);
    // The browser really let go of it: the removal matched the cookie it holds.
    expect(browser.holding(COOKIE)).toEqual([]);
    expect(refusalWarnings()).toEqual([]);
  });

  it('finishes a plain sign-in on the main app', async () => {
    const browser = new Browser();
    const { state } = await browser.start();
    googleKnowsTheMember();
    expect((await browser.comesBack(state)).headers.location).toBe(verifyUrl(MAIN));
  });

  it('is not put off by other cookies in the header: a plain-named one, a look-alike, whatever else the browser holds', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW });
    const nonce = browser.valueSentTo(COOKIE, browser.returnAddress) as string;
    googleKnowsTheMember();
    const res = await returnWith(state, `theme=dark; rsn_oauth_nonce=tossed; x_${COOKIE}=1; ${COOKIE}=${nonce}; sid=abc`);
    expect(res.headers.location).toBe(verifyUrl(PREVIEW));
  });

  it('links the photo to the member the state names, and goes back to the page it started from', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' });
    googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
    const res = await browser.comesBack(state);
    expect(res.headers.location).toBe(`${PREVIEW}/profile?photo=done`);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(MEMBER, PICTURE);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expectCleared(res);
  });

  it('a callback 29 minutes after the start goes on; 31 minutes after, the state is spent and it does not', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW });

    clock.mockReturnValue(now + 29 * 60 * 1000);
    googleKnowsTheMember();
    expect((await browser.comesBack(state)).headers.location).toBe(verifyUrl(PREVIEW));

    // A fresh flow, and this time the person leaves Google's screen open for 31 minutes. Even if the browser
    // still holds its cookie (the clock here is the server's), an expired state is a bad state.
    clock.mockReturnValue(now);
    const slow = new Browser();
    const second = await slow.start({ origin: PREVIEW });
    clock.mockReturnValue(now + 31 * 60 * 1000);
    forgetCalls();
    expect(slow.holding(COOKIE)).toHaveLength(1);
    expectRefused(await slow.comesBack(second.state), MAIN, 'bad state');
  });
});

// ── The callback, in a browser that did not ──────────────────────────────────

describe('GET /auth/google/callback: in a browser that did not start the sign-in', () => {
  const forger = newOauthNonce();
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = (claims: object, secret = SECRET, options: jwt.SignOptions = { expiresIn: '30m' }) => jwt.sign(claims, secret, options);

  /**
   * Every way a state can be not ours. Each one names a victim's photo link, an invite code and the preview, and
   * carries the hash of the cookie the table sends with it, so the signature alone is what gives it away.
   */
  const FORGERIES: Array<[string, string]> = (() => {
    const claims = { inviteCode: 'FORGED', photoLinkUserId: VICTIM, redirect: '/profile', origin: PREVIEW, nonceHash: forger.nonceHash };
    const real = buildOauthState({ origin: PREVIEW, nonceHash: forger.nonceHash });
    const [header, , signature] = real.split('.');
    return [
      ['the old format: plain base64 JSON', b64(claims)],
      ['an unsigned token (alg none)', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, purpose: PURPOSE })}.`],
      ['a token signed with another secret', sign({ ...claims, purpose: PURPOSE }, 'another-secret-with-enough-length-0123456789')],
      ['a token signed with another algorithm', sign({ ...claims, purpose: PURPOSE }, SECRET, { algorithm: 'HS512', expiresIn: '30m' })],
      ['an expired token', sign({ ...claims, purpose: PURPOSE }, SECRET, { expiresIn: '-10s' })],
      ['a token with the wrong purpose (a photo link)', sign({ ...claims, purpose: 'google-photo' })],
      ['a token with no purpose (as an access token has none)', sign({ ...claims, sub: VICTIM, role: 'member', sessionId: 's-1' })],
      ['a token whose payload was edited after it was signed', `${header}.${b64({ ...(jwt.decode(real) as object), ...claims })}.${signature}`],
      ['a token with its signature cut off', real.slice(0, real.lastIndexOf('.'))],
      ['a token with its last characters cut off', real.slice(0, -4)],
      ['text that is not a token', 'not-a-token'],
    ];
  })();

  type Arranged = { state: string | string[] | undefined; cookie: string | undefined };
  type Case = [name: string, reason: BindingRefusal, site: string, arrange: () => Promise<Arranged>];

  /** A sign-in the browser really started (so it really holds the cookie), with the state's claims chosen here. */
  const aState = async (claims: GoogleOauthState = { origin: PREVIEW }) => {
    const browser = new Browser();
    const state = await startedWith(browser, claims);
    const nonce = browser.valueSentTo(COOKIE, browser.returnAddress) as string;
    return { state, nonce, hash: claimsOf(state).nonceHash as string };
  };

  const REFUSED: Case[] = [
    // The cookie is what is missing or wrong. The state verified, so the refusal goes back to the site it names.
    ['there is no cookie at all', 'no cookie', PREVIEW, async () => ({ state: (await aState()).state, cookie: undefined })],
    ['the cookie is empty', 'no cookie', PREVIEW, async () => ({ state: (await aState()).state, cookie: `${COOKIE}=` })],
    ['the browser sends other cookies only', 'no cookie', PREVIEW, async () => ({ state: (await aState()).state, cookie: 'theme=dark; sid=abc' })],
    ['the right value sits in a cookie of a similar name', 'no cookie', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `x_${COOKIE}=${s.nonce}; ${COOKIE}_2=${s.nonce}` };
    }],
    ['the right value sits in the plain-named cookie, and the __Host- one is missing (the one a sibling site could set)', 'no cookie', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `rsn_oauth_nonce=${s.nonce}` };
    }],
    // A browser sends one cookie of a name per host and path, so two of the name mean somebody else's was set beside ours.
    // Which one a server reads first is not something to rely on: more than one is refused, the right value included.
    ['the cookie is sent twice, both with the right value', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `${COOKIE}=${s.nonce}; ${COOKIE}=${s.nonce}` };
    }],
    ['the cookie is sent twice, the right value first', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `${COOKIE}=${s.nonce}; ${COOKIE}=${newOauthNonce().nonce}` };
    }],
    ['the cookie is sent twice, the right value second', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `${COOKIE}=${newOauthNonce().nonce}; ${COOKIE}=${s.nonce}` };
    }],
    ['the cookie is sent twice, an empty one and the right one', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `${COOKIE}=; ${COOKIE}=${s.nonce}` };
    }],
    ['the cookie is sent three times, with another cookie between', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: `${COOKIE}=${s.nonce}; a=1; ${COOKIE}=${s.nonce}; ${COOKIE}=${s.nonce}` };
    }],
    ['the cookie is some other nonce', 'cookie mismatch', PREVIEW, async () => ({ state: (await aState()).state, cookie: withNonce(newOauthNonce().nonce) })],
    ['the cookie is the state\'s own hash (which anyone who reads the state can read)', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: withNonce(s.hash) };
    }],
    ['the cookie is the right nonce with one character changed', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: withNonce(`${s.nonce.slice(0, -1)}${s.nonce.endsWith('0') ? '1' : '0'}`) };
    }],
    ['the cookie is the right nonce in capitals', 'cookie mismatch', PREVIEW, async () => {
      const s = await aState();
      return { state: s.state, cookie: withNonce(s.nonce.toUpperCase()) };
    }],
    ['the cookie is the nonce of a later sign-in started in the same browser', 'cookie mismatch', PREVIEW, async () => {
      const browser = new Browser();
      const stale = await startedWith(browser, { origin: PREVIEW });
      await startedWith(browser, { origin: PREVIEW });
      return { state: stale, cookie: browser.cookieHeaderFor(browser.returnAddress) };
    }],

    // The state is what is missing or wrong. A state that did not verify names no site, so it is the main app.
    ['there is no state', 'no state', MAIN, async () => ({ state: undefined, cookie: withNonce(forger.nonce) })],
    ['the state is empty', 'no state', MAIN, async () => ({ state: '', cookie: withNonce(forger.nonce) })],
    ['the state is sent twice', 'bad state', MAIN, async () => ({ state: [(await aState()).state, (await aState()).state], cookie: withNonce(forger.nonce) })],
    ...FORGERIES.map(([name, state]): Case => [`the state is ${name}`, 'bad state', MAIN, async () => ({ state, cookie: withNonce(forger.nonce) })]),

    // A state we signed that cannot be answered by any browser: it carries no usable nonce. It verified, so it names its site.
    ['the state was signed before this rule, so it has no nonce (a sign-in in flight at the deploy)', 'bad state', PREVIEW, async () => ({
      state: buildOauthState({ origin: PREVIEW, inviteCode: 'ABC123' }), cookie: withNonce(forger.nonce),
    })],
    ['the state\'s nonce is empty', 'bad state', PREVIEW, async () => ({
      state: sign({ purpose: PURPOSE, origin: PREVIEW, nonceHash: '' }), cookie: withNonce(forger.nonce),
    })],
    ['the state\'s nonce is not text', 'bad state', PREVIEW, async () => ({
      state: sign({ purpose: PURPOSE, origin: PREVIEW, nonceHash: 42 }), cookie: withNonce(forger.nonce),
    })],
    ['the state\'s nonce is not a hash', 'cookie mismatch', PREVIEW, async () => ({
      state: sign({ purpose: PURPOSE, origin: PREVIEW, nonceHash: 'not-a-hash' }), cookie: withNonce(forger.nonce),
    })],

    // The site a refusal goes back to is never a site that is not ours, and a refused photo link is not a photo outcome.
    ['the state names a site that is not ours, and the cookie is missing', 'no cookie', MAIN, async () => {
      const browser = new Browser();
      return { state: await startedWith(browser, { origin: 'https://evil.example' }), cookie: undefined };
    }],
    ['a photo link has no cookie', 'no cookie', PREVIEW, async () => ({
      state: (await aState({ photoLinkUserId: MEMBER, redirect: '/profile', origin: PREVIEW })).state, cookie: undefined,
    })],
    ['a photo link has another sign-in\'s cookie', 'cookie mismatch', PREVIEW, async () => ({
      state: (await aState({ photoLinkUserId: MEMBER, redirect: '/profile', origin: PREVIEW })).state, cookie: withNonce(newOauthNonce().nonce),
    })],
    ['an invite code has no cookie', 'no cookie', PREVIEW, async () => ({
      state: (await aState({ inviteCode: 'ABC123', origin: PREVIEW })).state, cookie: undefined,
    })],
  ];

  it.each(REFUSED)('refuses when %s, as "%s"', async (_name, reason, site, arrange) => {
    const { state, cookie } = await arrange();
    // Google would accept the code and know the account: a callback that wrongly went on would sign someone in.
    googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory', picture: PICTURE });
    expectRefused(await returnWith(state, cookie), site, reason);
  });

  it('reads the cookie from the Cookie header and from nowhere else', async () => {
    const s = await aState();
    googleKnowsTheMember();
    // The right value in the query string.
    expectRefused(await returnWith(s.state, undefined, { code: 'c', [COOKIE]: s.nonce }), PREVIEW, 'no cookie');
    // The right value in some other header.
    forgetCalls();
    googleKnowsTheMember();
    const viaHeader = await request(app).get('/api/auth/google/callback').set('Host', CANONICAL)
      .query({ code: 'c', state: s.state }).set('X-Cookie', withNonce(s.nonce));
    expectRefused(viaHeader, PREVIEW, 'no cookie');
  });

  // The attack this closes. The attacker starts in their own browser, finishes Google with their own account, and
  // keeps the callback address (their code and their valid state). They send it to a victim.
  describe('login CSRF: someone else\'s sign-in, finished in the victim\'s browser', () => {
    it('signs the victim into nothing, whether or not the victim has a sign-in of their own going', async () => {
      const attacker = new Browser();
      const { state } = await attacker.start({ origin: PREVIEW, inviteCode: 'ABC123' });

      // A victim with no sign-in of their own going: no cookie.
      const bystander = new Browser();
      googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory' });
      expectRefused(await bystander.comesBack(state, { code: 'attackers-code' }), PREVIEW, 'no cookie');

      // A victim who was in the middle of signing in themselves: their cookie is another nonce.
      forgetCalls();
      const victim = new Browser();
      await victim.start({ origin: PREVIEW });
      expect(victim.holding(COOKIE)).toHaveLength(1);
      googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory' });
      const res = await victim.comesBack(state, { code: 'attackers-code' });
      expectRefused(res, PREVIEW, 'cookie mismatch');
      // Their own sign-in is spent with it: they are asked to start again, which is the price of the rule.
      expect(victim.holding(COOKIE)).toEqual([]);
    });

    it('while the attacker\'s own browser, with the same address, still finishes', async () => {
      const attacker = new Browser();
      const { state } = await attacker.start({ origin: PREVIEW });
      googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory' });
      expect((await attacker.comesBack(state, { code: 'attackers-code' })).headers.location).toBe(verifyUrl(PREVIEW));
    });

    // What this covers is the STATE: one that was started in someone else's browser. It does not cover a photo-link START
    // ADDRESS that an attacker minted for their own account (the photo token is a bearer token in that address) and a victim
    // then opens: the victim's own browser starts that flow, so it is bound, and the victim's Google picture would land on
    // the attacker's account. Closing that needs the photo link tied to the signed-in member (a follow-up in the report).
    it('a photo-link state started in the attacker\'s browser, finished in a victim\'s, attaches nobody\'s photo', async () => {
      const attacker = new Browser();
      const { state } = await attacker.start({ origin: PREVIEW, photo: mintPhotoLinkToken(ATTACKER_MEMBER), redirect: '/profile' });
      expect(claimsOf(state).photoLinkUserId).toBe(ATTACKER_MEMBER);

      const victim = new Browser();
      googleKnowsTheMember({ email: 'victim@example.com', picture: PICTURE });
      const res = await victim.comesBack(state, { code: 'victims-code' });
      // Not the page the photo link would have gone back to, and no photo outcome: the login page, asking to start again.
      expectRefused(res, PREVIEW, 'no cookie');
      expect(res.headers.location).not.toMatch(/photo=/);
    });

    it('the attack as it was before the state was signed: an unsigned state naming another member changes no photo', async () => {
      const victim = new Browser();
      await victim.start({ origin: PREVIEW });
      googleKnowsTheMember({ email: 'attacker@example.com', picture: PICTURE });
      const res = await victim.comesBack(b64({ photoLinkUserId: VICTIM, redirect: '/profile' }));
      expect(res.headers.location).toBe(`${MAIN}/login?error=google_try_again`);
      expect(res.headers.location).not.toMatch(/photo=/);
      expect(mockCapture).not.toHaveBeenCalled();
    });
  });
});

// ── A sibling site cannot set or shadow the cookie ───────────────────────────

// Any host under rsn.network can set a cookie for the whole domain: `name=value; Domain=rsn.network; Path=/api/auth/google/callback`
// is stored, and is sent to api.rsn.network BEFORE a cookie of a shorter path, so a server that read the first cookie of a
// plain name would read the sibling's. A sibling could then start its own sign-in, toss that nonce into a victim's browser,
// and send the victim its callback address (its code, its valid state): login CSRF again, once everything is on one host.
// The __Host- name closes it: a browser refuses such a cookie with a Domain or a Path other than /, and a plain-named
// cookie is not the one the server reads.
describe('a sibling site on rsn.network cannot set or shadow the cookie', () => {
  const SIBLING = 'https://evil.rsn.network/';
  const TOSSED_PLAIN = (nonce: string) => `rsn_oauth_nonce=${nonce}; Domain=rsn.network; Path=/api/auth/google/callback; Secure`;

  it('a plain-named cookie tossed from a sibling is sent first, and counts for nothing: the member signs in as themselves', async () => {
    const browser = new Browser();
    browser.hear(SIBLING, TOSSED_PLAIN('tossed'));
    const start = await browser.start({ origin: PREVIEW });
    // It is held, and it goes to the callback ahead of the real cookie (longer path first)...
    expect(browser.cookieHeaderFor(start.redirectUri)?.startsWith('rsn_oauth_nonce=tossed; ')).toBe(true);
    // ...and the sign-in finishes anyway, because only the __Host- name is read.
    googleKnowsTheMember();
    expect((await browser.comesBack(start.state)).headers.location).toBe(verifyUrl(PREVIEW));
  });

  it('the attack: the nonce of the attacker\'s own sign-in, tossed into the victim\'s browser in every way a sibling can, signs the victim into nothing', async () => {
    const attacker = new Browser();
    const { state } = await attacker.start({ origin: PREVIEW });
    const attackersNonce = attacker.valueSentTo(COOKIE, attacker.returnAddress) as string;

    const victim = new Browser();
    victim.hear(SIBLING, TOSSED_PLAIN(attackersNonce));
    // Every way to set the __Host- cookie from another address, which a browser refuses or keeps for the sibling alone:
    victim.hear(SIBLING, `${COOKIE}=${attackersNonce}; Domain=rsn.network; Path=/; Secure`); // a Domain
    victim.hear(SIBLING, `${COOKIE}=${attackersNonce}; Domain=rsn.network; Path=/api/auth/google/callback; Secure`); // a longer path
    victim.hear(SIBLING, `${COOKIE}=${attackersNonce}; Domain=rsn.network; Secure`); // a Domain, and no Path
    victim.hear(SIBLING, `${COOKIE}=${attackersNonce}; Path=/`); // not Secure
    victim.hear(SIBLING, `${COOKIE}=${attackersNonce}; Path=/; Secure`); // the one a browser keeps: for the sibling's host alone
    expect(victim.holding(COOKIE)).toEqual([{ host: 'evil.rsn.network', hostOnly: true, path: '/', value: attackersNonce }]);
    expect(victim.cookieHeaderFor(attacker.returnAddress)).toBe(`rsn_oauth_nonce=${attackersNonce}`);

    googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory' });
    expectRefused(await victim.comesBack(state, { code: 'attackers-code' }), PREVIEW, 'no cookie');
  });

  it('the cookie the API really sets is one a browser keeps under those rules: for the API\'s host alone, on Path=/', async () => {
    const browser = new Browser();
    await browser.start({ origin: PREVIEW });
    expect(browser.holding(COOKIE)).toEqual([{ host: CANONICAL, hostOnly: true, path: '/', value: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });
});

// ── The cookie is cleared on every outcome ───────────────────────────────────

describe('GET /auth/google/callback: the cookie is cleared on every outcome', () => {
  async function inBrowser(claims: Record<string, string>, arm: () => void, extra?: Record<string, string>) {
    const browser = new Browser();
    const { state } = await browser.start(claims);
    arm();
    return browser.comesBack(state, extra);
  }

  it.each([
    ['the sign-in finishes', () => inBrowser({ origin: PREVIEW }, () => googleKnowsTheMember())],
    ['the photo is linked', () => inBrowser({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' }, () => googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE }))],
    ['Google has no photo for the account', () => inBrowser({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' }, () => googleKnowsTheMember({ email: 'a@b.co' }))],
    ['Google refuses the code', () => inBrowser({ origin: PREVIEW }, () => googleRefusesTheCode())],
    ['Google has no email for the account', () => inBrowser({ origin: PREVIEW }, () => googleKnowsTheMember({ name: 'A B' }))],
    ['the account is refused in words', () => inBrowser({ origin: PREVIEW }, () => {
      googleKnowsTheMember();
      mockFindOrCreate.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'ACCOUNT_CLOSED' }));
    })],
    ['something unexpected goes wrong', () => inBrowser({ origin: PREVIEW }, () => {
      googleKnowsTheMember();
      mockFindOrCreate.mockRejectedValueOnce(new Error('db down'));
    })],
    ['the person cancels at Google', () => inBrowser({ origin: PREVIEW }, () => undefined, { error: 'access_denied' })],
    ['a photo link is cancelled at Google', () => inBrowser({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' }, () => undefined, { error: 'access_denied' })],
    ['the callback is refused', () => returnWith(buildOauthState({ origin: PREVIEW }))],
    ['the callback has no state at all', () => returnWith(undefined)],
  ] as Array<[string, () => Promise<request.Response>]>)('%s', async (_name, run) => {
    expectCleared(await run());
  });

  it('with the name, path and flags it was set with, so the browser matches it to the cookie it holds; in development the plain ones, without Secure', async () => {
    const dev = config as unknown as { isDev: boolean };
    const production = await returnWith(undefined);
    expect(nonceCookie(production).attributes).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']));
    expect(setCookieLines(production)).toHaveLength(1);
    try {
      dev.isDev = true;
      const development = await returnWith(undefined);
      const { attributes } = nonceCookie(development, DEV_COOKIE);
      expect(attributes).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/api/auth/google', 'HttpOnly', 'SameSite=Lax']));
      expect(attributes).not.toContain('Secure');
      expect(setCookieLines(development)).toHaveLength(1);
    } finally {
      dev.isDev = false;
    }
  });

  it('a callback address is good once per browser: loading it again finds the cookie gone', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW });
    googleKnowsTheMember();
    expect((await browser.comesBack(state)).headers.location).toBe(verifyUrl(PREVIEW));

    forgetCalls();
    googleKnowsTheMember();
    expectRefused(await browser.comesBack(state), PREVIEW, 'no cookie');
  });

  describe('two sign-ins started in one browser: the last start wins', () => {
    it('the last one finishes when it comes back first; the other tab is asked to start again', async () => {
      const browser = new Browser();
      const first = await browser.start({ origin: PREVIEW });
      const second = await browser.start({ origin: PREVIEW });

      googleKnowsTheMember();
      expect((await browser.comesBack(second.state)).headers.location).toBe(verifyUrl(PREVIEW));

      // The first tab's cookie was replaced by the second start, and then spent: it is asked to start again.
      forgetCalls();
      googleKnowsTheMember();
      expectRefused(await browser.comesBack(first.state), PREVIEW, 'no cookie');
    });

    // The rule is "clear on every outcome", refusals included, so the stale tab returning first spends the
    // cookie the newer tab needs. Both tabs are asked to start again, which is acceptable for two tabs at once.
    it('the first one is refused when it comes back first, and that refusal spends the cookie too, so the second is asked to start again as well', async () => {
      const browser = new Browser();
      const first = await browser.start({ origin: PREVIEW });
      const second = await browser.start({ origin: PREVIEW });

      googleKnowsTheMember();
      expectRefused(await browser.comesBack(first.state), PREVIEW, 'cookie mismatch');

      forgetCalls();
      googleKnowsTheMember();
      expectRefused(await browser.comesBack(second.state), PREVIEW, 'no cookie');
    });
  });
});

// ── Google's own refusal ─────────────────────────────────────────────────────

// Google sends the browser back with error=access_denied and no code when the person cancels. That is not a
// sign-in, a photo link or an invite code going on, so it keeps the handling it had: the generic failure on the
// login page, or "cancelled" on the page a photo link started from. It is not turned into a refusal.
describe('GET /auth/google/callback: the person cancelled at Google (error=access_denied)', () => {
  it('a sign-in: the login page of the site it started on, with the generic failure', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW });
    const res = await browser.comesBack(state, { error: 'access_denied' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${PREVIEW}/login?error=google_auth_failed`);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(refusalWarnings()).toEqual([]);
  });

  it('a photo link: back to the page it started from, as cancelled, and nothing changed', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' });
    const res = await browser.comesBack(state, { error: 'access_denied' });
    expect(res.headers.location).toBe(`${PREVIEW}/profile?photo=cancelled`);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(refusalWarnings()).toEqual([]);
  });

  it('is handled the same when the browser holds no cookie: a cancel goes on to nothing, so there is nothing to refuse', async () => {
    const other = new Browser();
    const { state } = await other.start({ origin: PREVIEW });
    const res = await returnWith(state, undefined, { error: 'access_denied' });
    expect(res.headers.location).toBe(`${PREVIEW}/login?error=google_auth_failed`);
    expect(refusalWarnings()).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
    expectCleared(res);
  });

  it('a callback with neither a code nor an error is handled the same way', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW });
    expect((await browser.comesBack(state, {})).headers.location).toBe(`${PREVIEW}/login?error=google_auth_failed`);
  });
});

// ── What is written down ─────────────────────────────────────────────────────

describe('GET /auth/google/callback: a refusal is logged as a reason, and never as anything that could be used', () => {
  it('writes one warning per refusal, { reason } and nothing else, and none for a callback that goes on', async () => {
    const browser = new Browser();
    const { state } = await browser.start({ origin: PREVIEW });
    googleKnowsTheMember();
    await browser.comesBack(state);
    expect(refusalWarnings()).toEqual([]);

    await returnWith(state);
    expect(refusalWarnings()).toEqual([{ reason: 'no cookie' }]);
    await returnWith(state, withNonce(newOauthNonce().nonce));
    await returnWith(undefined, withNonce(newOauthNonce().nonce));
    await returnWith('not-a-state', withNonce(newOauthNonce().nonce));
    expect(refusalWarnings()).toEqual([{ reason: 'no cookie' }, { reason: 'cookie mismatch' }, { reason: 'no state' }, { reason: 'bad state' }]);
    for (const [fields, message] of (logger.warn as jest.Mock).mock.calls) {
      expect(Object.keys(fields)).toEqual(['reason']);
      expect(typeof message).toBe('string');
    }
  });

  it('never prints the nonce, the cookie, the hash, the state or anything it held', async () => {
    const attacker = new Browser();
    const { state } = await attacker.start({ origin: PREVIEW, inviteCode: 'SECRETINVITE', photo: mintPhotoLinkToken(VICTIM), redirect: '/private-page' });
    const victim = new Browser();
    await victim.start({ origin: PREVIEW });
    const victimNonce = victim.valueSentTo(COOKIE, victim.returnAddress) as string;
    const nonceHash = claimsOf(state).nonceHash as string;
    const attackersNonce = attacker.valueSentTo(COOKIE, attacker.returnAddress) as string;

    await returnWith(state, withNonce(victimNonce));
    await returnWith(state);
    await returnWith(`${state}x`, withNonce(victimNonce));

    const everything = JSON.stringify(
      [logger.warn, logger.error, logger.info, logger.debug].map((fn) => (fn as jest.Mock).mock.calls),
    );
    for (const secret of [
      victimNonce, attackersNonce, nonceHash, state, ...state.split('.'),
      'SECRETINVITE', VICTIM, '/private-page', PREVIEW,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(refusalWarnings()).toHaveLength(3);
  });
});
