// ─── A Google sign-in only finishes in the browser that started it (7 Oct 2026) ──
//
// The OAuth state is signed, so only the server can write one, but nothing tied it to the browser that
// started the sign-in. An attacker could start a sign-in in their own browser, finish Google with THEIR
// account, and send a victim the callback address (their code, their valid state): the victim's browser
// ended up signed into the ATTACKER's account, and anything the victim then typed into it was the
// attacker's to read. The mirror: an attacker's photo-link state finished by a victim.
//
// Now the start puts a one-time value in a cookie on the API's own host (and its hash in the signed
// state), and the callback goes on only when the browser's cookie is that value. A missing or invalid
// state no longer signs anyone in either (Ali, 7 Oct 2026: it used to be "a plain sign-in").
//
// These go through express with the real router, the real state and the real cookie handling; only the
// database, Google and the account lookup are stand-ins. `Browser` below is a cookie jar for the API
// host, as far as this one cookie goes, so a start and a callback in one browser are one flow, and a
// callback in another browser is not.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-secret-with-enough-length-0123456789', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
    // As in production: the main app is app.rsn.network, so the preview is a different allowed site.
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
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
import { OAUTH_NONCE_COOKIE, newOauthNonce } from '../../services/identity/oauth-browser-binding';
import type { BindingRefusal } from '../../services/identity/oauth-browser-binding';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';
const MEMBER = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const ATTACKER_MEMBER = 'b0000000-0000-4000-8000-000000000001';
const VICTIM = 'b0000000-0000-4000-8000-000000000002';
const SECRET = 'test-secret-with-enough-length-0123456789';
const PURPOSE = 'google-oauth-state';
const PICTURE = 'https://lh3.googleusercontent.com/a/photo';
const COOKIE_PATH = '/api/auth/google';

const app = express();
app.use('/auth', authRoutes);

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

// supertest types every header as a string, but Express sends one Set-Cookie header per cookie, so this one is a list.
const setCookieLines = (res: request.Response): string[] => (res.headers['set-cookie'] ?? []) as unknown as string[];

function parseSetCookie(line: string) {
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

/** The one Set-Cookie line about the nonce cookie in a response (fails if there is not exactly one). */
function nonceCookie(res: request.Response) {
  const lines = setCookieLines(res).filter((line) => line.startsWith(`${OAUTH_NONCE_COOKIE}=`));
  expect(lines).toHaveLength(1);
  return parseSetCookie(lines[0]);
}

const stateFrom = (location: string) => new URL(location).searchParams.get('state') ?? '';
const claimsOf = (state: string) => jwt.verify(state, SECRET) as jwt.JwtPayload;
const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const verifyUrl = (base: string, inviteCode?: string) =>
  `${base}/auth/verify?accessToken=at&refreshToken=rt${inviteCode ? `&inviteCode=${inviteCode}` : ''}`;

// ── A browser ────────────────────────────────────────────────────────────────

class Browser {
  /** What this browser holds in its rsn_oauth_nonce cookie for the API host. */
  nonce: string | undefined;

  /** What a browser does with the cookie a response sets (keeps it) or removes (Max-Age=0). */
  private take<T extends request.Response>(res: T): T {
    for (const line of setCookieLines(res)) {
      const { name, value, attributes } = parseSetCookie(line);
      if (name !== OAUTH_NONCE_COOKIE) continue;
      this.nonce = attributes.includes('Max-Age=0') ? undefined : value;
    }
    return res;
  }

  get cookieHeader(): string | undefined {
    return this.nonce === undefined ? undefined : `${OAUTH_NONCE_COOKIE}=${this.nonce}`;
  }

  /** The member presses the Google button (or a photo link): the real start, then the browser keeps what it set. */
  async start(query: Record<string, string> = {}, referer?: string) {
    const req = request(app).get('/auth/google').query(query);
    if (referer) req.set('Referer', referer);
    if (this.cookieHeader) req.set('Cookie', this.cookieHeader);
    const res = this.take(await req);
    return { res, state: stateFrom(res.headers.location) };
  }

  /** Google sends the browser back to the callback, with whatever cookie this browser holds. */
  async comesBack(state: string | undefined, extra: Record<string, string> = { code: 'c' }) {
    const req = request(app).get('/auth/google/callback').query({ ...extra, ...(state === undefined ? {} : { state }) });
    if (this.cookieHeader) req.set('Cookie', this.cookieHeader);
    return this.take(await req);
  }
}

/** A state the start would sign for this browser with claims the real start would not choose (a foreign site, an old shape). */
function startedWith(browser: Browser, claims: GoogleOauthState): string {
  const { nonce, nonceHash } = newOauthNonce();
  browser.nonce = nonce;
  return buildOauthState({ ...claims, nonceHash });
}

/** The callback with exactly the Cookie header given (none when undefined), whatever a jar would do. */
function returnWith(state: string | string[] | undefined, cookie?: string, extra: Record<string, string> = { code: 'c' }) {
  const req = request(app).get('/auth/google/callback').query({ ...extra, ...(state === undefined ? {} : { state }) });
  return cookie === undefined ? req : req.set('Cookie', cookie);
}

const withNonce = (nonce: string) => `${OAUTH_NONCE_COOKIE}=${nonce}`;

// ── What every refusal and every outcome must show ───────────────────────────

const REASONS: BindingRefusal[] = ['no state', 'bad state', 'no cookie', 'cookie mismatch'];
/** The fields of every warning the callback wrote about refusing a sign-in that did not start in this browser. */
const refusalWarnings = () =>
  (logger.warn as jest.Mock).mock.calls.map(([fields]) => fields).filter((fields) => REASONS.includes(fields?.reason));

/** The cookie is removed: same name, same path, Max-Age=0, and nothing in it. */
function expectCleared(res: request.Response) {
  const { value, attributes } = nonceCookie(res);
  expect(value).toBe('');
  expect(attributes).toEqual(expect.arrayContaining(['Max-Age=0', `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax']));
}

/** A refused callback: it goes back to the login page, asking to start again, and nothing at all went on. */
function expectRefused(res: request.Response, site: string, reason: BindingRefusal) {
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`${site}/login?error=google_try_again`);
  // No code exchange, no sign-in, no photo change.
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockFindOrCreate).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();
  // And no tokens reach the address either.
  expect(res.headers.location).not.toMatch(/accessToken|refreshToken/);
  expectCleared(res);
  // One warning from the callback, naming the reason and nothing else.
  expect(refusalWarnings()).toEqual([{ reason }]);
}

// ── The start ────────────────────────────────────────────────────────────────

describe('GET /auth/google: the start ties the sign-in to this browser', () => {
  it('sets rsn_oauth_nonce on the API\'s own host: HttpOnly, Secure, SameSite=Lax, Path=/api/auth/google, 30 minutes', async () => {
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);

    expect(setCookieLines(res)).toHaveLength(1);
    const { name, value, attributes } = nonceCookie(res);
    expect(name).toBe('rsn_oauth_nonce');
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/auth/google', 'Max-Age=1800']));
    // Nothing else: above all no Domain (so the cookie belongs to the API's host alone) and nothing that widens its reach.
    expect(attributes.map((a) => a.split('=')[0]).sort()).toEqual(['Expires', 'HttpOnly', 'Max-Age', 'Path', 'SameSite', 'Secure']);
    // Expires is Express's own companion to Max-Age, and says the same 30 minutes.
    const expires = Date.parse(attributes.find((a) => a.startsWith('Expires='))!.slice('Expires='.length));
    expect(Math.abs(expires - Date.now() - 30 * 60 * 1000)).toBeLessThan(10_000);
  });

  it('is not Secure in development, where the API is plain http on localhost, and is otherwise the same', async () => {
    const dev = config as unknown as { isDev: boolean };
    try {
      dev.isDev = true;
      const { attributes } = nonceCookie(await request(app).get('/auth/google'));
      expect(attributes).not.toContain('Secure');
      expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/api/auth/google', 'Max-Age=1800']));
    } finally {
      dev.isDev = false;
    }
    expect(nonceCookie(await request(app).get('/auth/google')).attributes).toContain('Secure');
  });

  it('puts the hash of the cookie\'s value in the signed state, and never the value itself', async () => {
    const res = await request(app).get('/auth/google').query({ origin: PREVIEW, inviteCode: 'ABC123' });
    const { value } = nonceCookie(res);
    const state = stateFrom(res.headers.location);
    expect(claimsOf(state).nonceHash).toBe(sha256Hex(value));
    // The value is in the cookie alone: not in the state, not in the address Google is sent to.
    expect(JSON.stringify(claimsOf(state))).not.toContain(value);
    expect(res.headers.location).not.toContain(value);
    expect(Buffer.from(state.split('.')[1], 'base64url').toString()).not.toContain(value);
  });

  it('is a new value, and a new state hash, for every start', async () => {
    const starts = await Promise.all(Array.from({ length: 12 }, () => request(app).get('/auth/google')));
    expect(new Set(starts.map((res) => nonceCookie(res).value)).size).toBe(12);
    expect(new Set(starts.map((res) => claimsOf(stateFrom(res.headers.location)).nonceHash)).size).toBe(12);
  });

  it('lives exactly as long as the state: both 30 minutes', async () => {
    const res = await request(app).get('/auth/google');
    const claims = claimsOf(stateFrom(res.headers.location));
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(30 * 60);
    expect(nonceCookie(res).attributes).toContain(`Max-Age=${30 * 60}`);
  });

  it('is set for an invite and for a photo link as for a plain sign-in', async () => {
    const invite = await request(app).get('/auth/google').query({ inviteCode: 'ABC123' });
    const photo = await request(app).get('/auth/google').query({ photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' });
    for (const res of [invite, photo]) {
      expect(claimsOf(stateFrom(res.headers.location)).nonceHash).toBe(sha256Hex(nonceCookie(res).value));
    }
    expect(claimsOf(stateFrom(photo.headers.location)).photoLinkUserId).toBe(MEMBER);
  });

  it('sets nothing when Google sign-in is not configured', async () => {
    const cfg = config as unknown as { googleClientId: string };
    try {
      cfg.googleClientId = '';
      const res = await request(app).get('/auth/google');
      expect(res.status).toBe(501);
      expect(setCookieLines(res)).toEqual([]);
    } finally {
      cfg.googleClientId = 'gid';
    }
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
    expect(browser.nonce).toBeUndefined();
    expect(refusalWarnings()).toEqual([]);
  });

  it('finishes a plain sign-in on the main app', async () => {
    const browser = new Browser();
    const { state } = await browser.start();
    googleKnowsTheMember();
    expect((await browser.comesBack(state)).headers.location).toBe(verifyUrl(MAIN));
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
    expect(slow.nonce).toBeDefined();
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

  type Case = [name: string, reason: BindingRefusal, site: string, arrange: () => { state: string | string[] | undefined; cookie: string | undefined }];

  const aState = (claims: GoogleOauthState = { origin: PREVIEW }) => {
    const browser = new Browser();
    const state = startedWith(browser, claims);
    return { state, nonce: browser.nonce as string, hash: claimsOf(state).nonceHash as string };
  };

  const REFUSED: Case[] = [
    // The cookie is what is missing or wrong. The state verified, so the refusal goes back to the site it names.
    ['there is no cookie at all', 'no cookie', PREVIEW, () => ({ state: aState().state, cookie: undefined })],
    ['the cookie is empty', 'no cookie', PREVIEW, () => ({ state: aState().state, cookie: `${OAUTH_NONCE_COOKIE}=` })],
    ['the browser sends other cookies only', 'no cookie', PREVIEW, () => ({ state: aState().state, cookie: 'theme=dark; sid=abc' })],
    ['the right value sits in a cookie of a similar name', 'no cookie', PREVIEW, () => {
      const s = aState();
      return { state: s.state, cookie: `x_${OAUTH_NONCE_COOKIE}=${s.nonce}; ${OAUTH_NONCE_COOKIE}_2=${s.nonce}` };
    }],
    ['the cookie is some other nonce', 'cookie mismatch', PREVIEW, () => ({ state: aState().state, cookie: withNonce(newOauthNonce().nonce) })],
    ['the cookie is the state\'s own hash (which anyone who reads the state can read)', 'cookie mismatch', PREVIEW, () => {
      const s = aState();
      return { state: s.state, cookie: withNonce(s.hash) };
    }],
    ['the cookie is the right nonce with one character changed', 'cookie mismatch', PREVIEW, () => {
      const s = aState();
      return { state: s.state, cookie: withNonce(`${s.nonce.slice(0, -1)}${s.nonce.endsWith('0') ? '1' : '0'}`) };
    }],
    ['the cookie is the right nonce in capitals', 'cookie mismatch', PREVIEW, () => {
      const s = aState();
      return { state: s.state, cookie: withNonce(s.nonce.toUpperCase()) };
    }],
    ['the cookie is the nonce of a later sign-in started in the same browser', 'cookie mismatch', PREVIEW, () => {
      const browser = new Browser();
      const stale = startedWith(browser, { origin: PREVIEW });
      startedWith(browser, { origin: PREVIEW });
      return { state: stale, cookie: browser.cookieHeader };
    }],

    // The state is what is missing or wrong. A state that did not verify names no site, so it is the main app.
    ['there is no state', 'no state', MAIN, () => ({ state: undefined, cookie: withNonce(forger.nonce) })],
    ['the state is empty', 'no state', MAIN, () => ({ state: '', cookie: withNonce(forger.nonce) })],
    ['the state is sent twice', 'bad state', MAIN, () => ({ state: [aState().state, aState().state], cookie: withNonce(forger.nonce) })],
    ...FORGERIES.map(([name, state]): Case => [`the state is ${name}`, 'bad state', MAIN, () => ({ state, cookie: withNonce(forger.nonce) })]),

    // A state we signed that cannot be answered by any browser: it carries no usable nonce. It verified, so it names its site.
    ['the state was signed before this rule, so it has no nonce (a sign-in in flight at the deploy)', 'bad state', PREVIEW, () => ({
      state: buildOauthState({ origin: PREVIEW, inviteCode: 'ABC123' }), cookie: withNonce(forger.nonce),
    })],
    ['the state\'s nonce is empty', 'bad state', PREVIEW, () => ({
      state: sign({ purpose: PURPOSE, origin: PREVIEW, nonceHash: '' }), cookie: withNonce(forger.nonce),
    })],
    ['the state\'s nonce is not text', 'bad state', PREVIEW, () => ({
      state: sign({ purpose: PURPOSE, origin: PREVIEW, nonceHash: 42 }), cookie: withNonce(forger.nonce),
    })],
    ['the state\'s nonce is not a hash', 'cookie mismatch', PREVIEW, () => ({
      state: sign({ purpose: PURPOSE, origin: PREVIEW, nonceHash: 'not-a-hash' }), cookie: withNonce(forger.nonce),
    })],

    // The site a refusal goes back to is never a site that is not ours, and a refused photo link is not a photo outcome.
    ['the state names a site that is not ours, and the cookie is missing', 'no cookie', MAIN, () => {
      const browser = new Browser();
      return { state: startedWith(browser, { origin: 'https://evil.example' }), cookie: undefined };
    }],
    ['a photo link has no cookie', 'no cookie', PREVIEW, () => ({
      state: aState({ photoLinkUserId: MEMBER, redirect: '/profile', origin: PREVIEW }).state, cookie: undefined,
    })],
    ['a photo link has another sign-in\'s cookie', 'cookie mismatch', PREVIEW, () => ({
      state: aState({ photoLinkUserId: MEMBER, redirect: '/profile', origin: PREVIEW }).state, cookie: withNonce(newOauthNonce().nonce),
    })],
    ['an invite code has no cookie', 'no cookie', PREVIEW, () => ({
      state: aState({ inviteCode: 'ABC123', origin: PREVIEW }).state, cookie: undefined,
    })],
  ];

  it.each(REFUSED)('refuses when %s, as "%s"', async (_name, reason, site, arrange) => {
    const { state, cookie } = arrange();
    // Google would accept the code and know the account: a callback that wrongly went on would sign someone in.
    googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory', picture: PICTURE });
    expectRefused(await returnWith(state, cookie), site, reason);
  });

  it('reads the cookie from the Cookie header and from nowhere else', async () => {
    const s = aState();
    googleKnowsTheMember();
    // The right value in the query string.
    expectRefused(await returnWith(s.state, undefined, { code: 'c', [OAUTH_NONCE_COOKIE]: s.nonce }), PREVIEW, 'no cookie');
    // The right value in some other header.
    forgetCalls();
    googleKnowsTheMember();
    const viaHeader = await request(app).get('/auth/google/callback').query({ code: 'c', state: s.state }).set('X-Cookie', withNonce(s.nonce));
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
      expect(victim.nonce).toBeDefined();
      googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory' });
      const res = await victim.comesBack(state, { code: 'attackers-code' });
      expectRefused(res, PREVIEW, 'cookie mismatch');
      // Their own sign-in is spent with it: they are asked to start again, which is the price of the rule.
      expect(victim.nonce).toBeUndefined();
    });

    it('while the attacker\'s own browser, with the same address, still finishes', async () => {
      const attacker = new Browser();
      const { state } = await attacker.start({ origin: PREVIEW });
      googleKnowsTheMember({ email: 'attacker@example.com', name: 'Mallory' });
      expect((await attacker.comesBack(state, { code: 'attackers-code' })).headers.location).toBe(verifyUrl(PREVIEW));
    });

    it('the mirror: a photo link the attacker started, finished by a victim, attaches nobody\'s photo', async () => {
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

  it('with the same attributes it was set with, so the browser matches it to the cookie it holds, and in development without Secure', async () => {
    const dev = config as unknown as { isDev: boolean };
    expect(nonceCookie(await returnWith(undefined)).attributes).toEqual(
      expect.arrayContaining(['Max-Age=0', 'Path=/api/auth/google', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    try {
      dev.isDev = true;
      const { attributes } = nonceCookie(await returnWith(undefined));
      expect(attributes).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/api/auth/google', 'HttpOnly', 'SameSite=Lax']));
      expect(attributes).not.toContain('Secure');
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
    const victimNonce = victim.nonce as string;
    const nonceHash = claimsOf(state).nonceHash as string;
    const attackersNonce = attacker.nonce as string;

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
