// ─── Google sign-in returns to the site it started from (7 Oct 2026) ─────────
//
// Ali signed in with Google on the preview and landed on the live app: the callback
// redirected to the fixed CLIENT_URL. The site the member starts on now rides in the
// OAuth state, resolved against the exact allow-list in client-origin.ts, and is
// resolved AGAIN on the callback, because the success redirect carries live tokens in
// its query string: a site that is not ours must never be a destination.
//
// The state is a signed token (google-photo-link.ts), so it cannot be edited or written
// by anyone else; a state that is not ours, in any way, is ignored and the member signs in
// as if there were none. That second resolve stays as belt and braces: it is what holds
// when a signed state names a site that is not ours.
//
// These go through express with the real router and the real allow-list; only the
// database, Google and the account lookup are stand-ins.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

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
import { buildOauthState, mintPhotoLinkToken } from '../../services/identity/google-photo-link';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';
const MEMBER = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const VICTIM = 'b0000000-0000-4000-8000-000000000002';
const SECRET = 'test-secret-with-enough-length-0123456789';
const PURPOSE = 'google-oauth-state';
const PICTURE = 'https://lh3.googleusercontent.com/a/photo';

const app = express();
app.use('/auth', authRoutes);

const realFetch = global.fetch;
beforeEach(() => {
  mockFindOrCreate.mockReset().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
  mockCapture.mockReset().mockResolvedValue(true);
});
afterAll(() => { global.fetch = realFetch; });

// Sites that look like ours and are not, or are ours only in development. None may ever be
// honoured: each one, as the starting site or inside a state, must come back as the main app.
const NOT_OURS = [
  'https://evil.example',
  'https://evil.example/https://preview.rsn.network',
  'https://preview.rsn.network.evil.example', // our name at the front of theirs
  'https://preview.rsn.network@evil.example', // our name as the user name
  'http://preview.rsn.network', // the right host on the wrong scheme
  'https://preview.rsn.network:8443', // the right host on another port
  'https://rsn.network', // the company site, not the app
  'https://api.rsn.network', // the API, whose logs would record a live token
  'https://something-rsnnetwork.vercel.app', // anyone can name a Vercel project like this
  'http://localhost:5173', // development only
  'javascript:alert(1)',
  '//evil.example',
  'evil.example',
  'null',
  '',
];

// ── The start ────────────────────────────────────────────────────────────────

/** The state the start hands to Google: a token signed with our secret, read back the way the callback reads it. */
const claimsOf = (location: string) => jwt.verify(new URL(location).searchParams.get('state') ?? '', SECRET) as jwt.JwtPayload;
/** What the state carries for the sign-in (not the token's own purpose and times). */
const stateOf = (location: string): Record<string, unknown> => {
  const claims = claimsOf(location);
  return Object.fromEntries(['inviteCode', 'origin', 'photoLinkUserId', 'redirect'].filter((key) => key in claims).map((key) => [key, claims[key]]));
};

function start(query: Record<string, string | string[]> = {}, referer?: string) {
  const req = request(app).get('/auth/google').query(query);
  return referer ? req.set('Referer', referer) : req;
}

describe('GET /auth/google: where the member starts', () => {
  it('?origin= naming the preview puts the preview in the state', async () => {
    const res = await start({ origin: PREVIEW });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(stateOf(res.headers.location).origin).toBe(PREVIEW);
  });

  it.each([
    ['a full page address', `${PREVIEW}/login`],
    ['the bare origin a cross-site navigation sends', `${PREVIEW}/`],
  ])('with no ?origin=, the Referer of the preview (%s) puts the preview in the state', async (_name, referer) => {
    const res = await start({}, referer);
    expect(stateOf(res.headers.location).origin).toBe(PREVIEW);
  });

  it('?origin= wins over the Referer', async () => {
    expect(stateOf((await start({ origin: MAIN }, `${PREVIEW}/login`)).headers.location).origin).toBe(MAIN);
    expect(stateOf((await start({ origin: PREVIEW }, `${MAIN}/login`)).headers.location).origin).toBe(PREVIEW);
  });

  it('an empty ?origin= is no origin, so the Referer is used', async () => {
    expect(stateOf((await start({ origin: '' }, `${PREVIEW}/login`)).headers.location).origin).toBe(PREVIEW);
  });

  it('with neither, the state carries the main app', async () => {
    expect(stateOf((await start()).headers.location).origin).toBe(MAIN);
  });

  it('a site that is ours in another spelling is the exact one', async () => {
    expect(stateOf((await start({ origin: 'HTTPS://Preview.RSN.Network' })).headers.location).origin).toBe(PREVIEW);
    expect(stateOf((await start({ origin: `${PREVIEW}/some/path?x=1#y` })).headers.location).origin).toBe(PREVIEW);
  });

  it.each(NOT_OURS)('?origin=%j is not ours: the state carries the main app', async (origin) => {
    expect(stateOf((await start({ origin })).headers.location).origin).toBe(MAIN);
  });

  it.each(NOT_OURS)('a Referer of %j is not ours: the state carries the main app', async (referer) => {
    expect(stateOf((await start({}, referer)).headers.location).origin).toBe(MAIN);
  });

  it('a hostile ?origin= is not rescued by a good Referer, and a list of origins is never picked from', async () => {
    expect(stateOf((await start({ origin: 'https://evil.example' }, `${PREVIEW}/login`)).headers.location).origin).toBe(MAIN);
    const many = await start({ origin: ['https://evil.example', PREVIEW] });
    expect(stateOf(many.headers.location).origin).toBe(MAIN);
  });

  it('localhost is honoured in development only', async () => {
    const dev = config as unknown as { isDev: boolean };
    try {
      dev.isDev = true;
      expect(stateOf((await start({ origin: 'http://localhost:5173' })).headers.location).origin).toBe('http://localhost:5173');
      expect(stateOf((await start({ origin: 'https://localhost:5173' })).headers.location).origin).toBe(MAIN);
    } finally {
      dev.isDev = false;
    }
    expect(stateOf((await start({ origin: 'http://localhost:5173' })).headers.location).origin).toBe(MAIN);
  });

  it('keeps the invite code and the photo link exactly as before', async () => {
    const invite = await start({ origin: PREVIEW, inviteCode: 'ABC123' });
    expect(stateOf(invite.headers.location)).toEqual({ inviteCode: 'ABC123', origin: PREVIEW });

    const photo = await start({ origin: PREVIEW, photo: mintPhotoLinkToken(MEMBER), redirect: '/profile' });
    expect(stateOf(photo.headers.location)).toEqual({ inviteCode: '', origin: PREVIEW, photoLinkUserId: MEMBER, redirect: '/profile' });

    // A photo link that is not signed names no member, as before.
    const forged = await start({ origin: PREVIEW, photo: 'not-a-token', redirect: '/profile' });
    expect(stateOf(forged.headers.location)).toEqual({ inviteCode: '', origin: PREVIEW });
  });

  it('keeps Google\'s own parameters as before', async () => {
    const url = new URL((await start({ origin: PREVIEW })).headers.location);
    expect(url.searchParams.get('client_id')).toBe('gid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.test/api/auth/google/callback');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('hands Google a signed token of its own purpose, which lives for 30 minutes', async () => {
    const claims = claimsOf((await start({ origin: PREVIEW, inviteCode: 'ABC123' })).headers.location);
    expect(claims.purpose).toBe(PURPOSE);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(30 * 60);
  });
});

// ── The callback ─────────────────────────────────────────────────────────────

/** A state as the server signs it (the real helper). */
const stateWith = buildOauthState;
/** Any claims signed like a state, to put a wrong type in one: the helper above only takes the right types. */
const signedWith = (claims: Record<string, unknown>) => jwt.sign({ purpose: PURPOSE, ...claims }, SECRET, { expiresIn: '30m' });

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

/** `code` null is a return from Google with no code (the member cancelled); `state` undefined is no state at all. */
function callback(state: string | undefined, code: string | null = 'c') {
  const query: Record<string, string> = {};
  if (code) query.code = code;
  if (state !== undefined) query.state = state;
  return request(app).get('/auth/google/callback').query(query);
}

const verifyUrl = (base: string, inviteCode?: string) =>
  `${base}/auth/verify?accessToken=at&refreshToken=rt${inviteCode ? `&inviteCode=${inviteCode}` : ''}`;

describe('GET /auth/google/callback: where the member comes back to', () => {
  it('a state naming the preview sends the member to the preview, tokens and invite code included', async () => {
    googleKnowsTheMember();
    const res = await callback(stateWith({ origin: PREVIEW }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(verifyUrl(PREVIEW));

    googleKnowsTheMember();
    const invited = await callback(stateWith({ origin: PREVIEW, inviteCode: 'ABC123' }));
    expect(invited.headers.location).toBe(verifyUrl(PREVIEW, 'ABC123'));
    expect(mockFindOrCreate).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'a@b.co' }), 'ABC123');
  });

  it('a state naming the main app sends the member to the main app', async () => {
    googleKnowsTheMember();
    expect((await callback(stateWith({ origin: MAIN }))).headers.location).toBe(verifyUrl(MAIN));
  });

  it('a state with no origin behaves exactly as before: the main app', async () => {
    googleKnowsTheMember();
    expect((await callback(stateWith({ inviteCode: 'ABC123' }))).headers.location).toBe(verifyUrl(MAIN, 'ABC123'));
    googleKnowsTheMember();
    expect((await callback(stateWith({}))).headers.location).toBe(verifyUrl(MAIN));
    googleKnowsTheMember();
    expect((await callback('not-base64-json')).headers.location).toBe(verifyUrl(MAIN));
    googleKnowsTheMember();
    expect((await callback(undefined)).headers.location).toBe(verifyUrl(MAIN));
  });

  // The state is signed, so these can only arise from a bug, or a leaked secret. The redirect carries
  // live tokens, so a site that is not ours must still never be a destination, however the state is dressed up.
  it.each(NOT_OURS)('a signed state naming %j, which is not ours, still sends the member and the tokens to the main app', async (origin) => {
    googleKnowsTheMember();
    const res = await callback(stateWith({ origin }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(verifyUrl(MAIN));
    expect(new URL(res.headers.location).origin).toBe(MAIN);
  });

  it.each([[42], [true], [null], [['https://preview.rsn.network']], [{ href: 'https://preview.rsn.network' }]])(
    'a signed state whose origin is %j (not a string) sends the member to the main app',
    async (origin) => {
      googleKnowsTheMember();
      expect((await callback(signedWith({ origin }))).headers.location).toBe(verifyUrl(MAIN));
    },
  );

  it('whatever the state says, the destination is never a site that is not ours', async () => {
    for (const origin of [...NOT_OURS, PREVIEW, MAIN, 'HTTPS://PREVIEW.RSN.NETWORK']) {
      googleKnowsTheMember();
      const where = new URL((await callback(stateWith({ origin, inviteCode: 'X' }))).headers.location).origin;
      expect([MAIN, PREVIEW]).toContain(where);
    }
  });

  it('localhost is honoured in development only', async () => {
    const dev = config as unknown as { isDev: boolean };
    googleKnowsTheMember();
    expect((await callback(stateWith({ origin: 'http://localhost:5173' }))).headers.location).toBe(verifyUrl(MAIN));
    try {
      dev.isDev = true;
      googleKnowsTheMember();
      expect((await callback(stateWith({ origin: 'http://localhost:5173' }))).headers.location).toBe(verifyUrl('http://localhost:5173'));
    } finally {
      dev.isDev = false;
    }
  });

  describe('every way it can fail goes back to the site it started from', () => {
    it.each([
      ['Google refuses the code', () => googleRefusesTheCode(), 'c'],
      ['the member cancels at Google (no code)', () => undefined, null],
      ['Google has no email for the account', () => googleKnowsTheMember({ name: 'A B' }), 'c'],
    ])('%s: the login page on the preview', async (_name, arm, code) => {
      arm();
      const res = await callback(stateWith({ origin: PREVIEW }), code);
      expect(res.headers.location).toBe(`${PREVIEW}/login?error=google_auth_failed`);
    });

    it('an account refused in words: the login page on the preview with the reason', async () => {
      googleKnowsTheMember();
      mockFindOrCreate.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'ACCOUNT_CLOSED' }));
      expect((await callback(stateWith({ origin: PREVIEW }))).headers.location).toBe(`${PREVIEW}/login?error=ACCOUNT_CLOSED`);
    });

    it('an unexpected fault: the login page on the preview, with the generic reason', async () => {
      googleKnowsTheMember();
      mockFindOrCreate.mockRejectedValueOnce(new Error('db down'));
      expect((await callback(stateWith({ origin: PREVIEW }))).headers.location).toBe(`${PREVIEW}/login?error=google_auth_failed`);
    });

    it('a signed state naming a site that is not ours goes to the login page of the main app, never elsewhere', async () => {
      googleRefusesTheCode();
      expect((await callback(stateWith({ origin: 'https://evil.example' }))).headers.location).toBe(`${MAIN}/login?error=google_auth_failed`);
      expect((await callback(stateWith({ origin: 'https://evil.example' }), null)).headers.location).toBe(`${MAIN}/login?error=google_auth_failed`);
      googleKnowsTheMember();
      mockFindOrCreate.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'ACCOUNT_CLOSED' }));
      expect((await callback(stateWith({ origin: 'https://evil.example' }))).headers.location).toBe(`${MAIN}/login?error=ACCOUNT_CLOSED`);
    });

    it('a state with no origin fails to the main app exactly as before', async () => {
      googleRefusesTheCode();
      expect((await callback(stateWith({}))).headers.location).toBe(`${MAIN}/login?error=google_auth_failed`);
      googleKnowsTheMember();
      mockFindOrCreate.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'ACCOUNT_CLOSED' }));
      expect((await callback(stateWith({}))).headers.location).toBe(`${MAIN}/login?error=ACCOUNT_CLOSED`);
    });
  });

  describe('a photo link returns to the page it started from, on the site it started from', () => {
    const photoState = (origin?: string) => stateWith({ photoLinkUserId: MEMBER, redirect: '/profile', ...(origin === undefined ? {} : { origin }) });

    it('done, none, failed and cancelled all come back to the preview', async () => {
      googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
      expect((await callback(photoState(PREVIEW))).headers.location).toBe(`${PREVIEW}/profile?photo=done`);
      // The photo goes to the member the signed state names, and to nobody else.
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith(MEMBER, PICTURE);
      googleKnowsTheMember({ email: 'a@b.co' });
      expect((await callback(photoState(PREVIEW))).headers.location).toBe(`${PREVIEW}/profile?photo=none`);
      googleRefusesTheCode();
      expect((await callback(photoState(PREVIEW))).headers.location).toBe(`${PREVIEW}/profile?photo=failed`);
      expect((await callback(photoState(PREVIEW), null)).headers.location).toBe(`${PREVIEW}/profile?photo=cancelled`);
      // A photo link signs nobody in.
      expect(mockFindOrCreate).not.toHaveBeenCalled();
    });

    it('a signed origin that is not ours comes back to the main app; a state with no origin as before', async () => {
      googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
      expect((await callback(photoState('https://evil.example'))).headers.location).toBe(`${MAIN}/profile?photo=done`);
      googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
      expect((await callback(photoState())).headers.location).toBe(`${MAIN}/profile?photo=done`);
      expect((await callback(photoState('https://evil.example'), null)).headers.location).toBe(`${MAIN}/profile?photo=cancelled`);
    });

    it('the return path stays a same-site path on our site, whatever the state says', async () => {
      googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
      const res = await callback(stateWith({ photoLinkUserId: MEMBER, redirect: 'https://evil.example/x', origin: PREVIEW }));
      expect(res.headers.location).toBe(`${PREVIEW}/onboarding?photo=done`);
    });
  });
});

// ── A state that is not ours ─────────────────────────────────────────────────

// 7 Oct 2026: the state used to be plain base64 JSON and the callback trusted the member id in it, so
// anyone could write one naming ANOTHER member's photo link, finish Google with their own account, and
// replace that member's photo. Every one of these names a victim, an invite code and the preview. None may
// be read: the person still signs in with their own Google account, exactly as with no state, and lands
// on the main app with no invite code and no photo link.
describe('GET /auth/google/callback: a state that is not ours is ignored', () => {
  const CLAIMS = { inviteCode: 'FORGED', photoLinkUserId: VICTIM, redirect: '/profile', origin: PREVIEW };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = (claims: object, secret = SECRET, options: jwt.SignOptions = { expiresIn: '30m' }) => jwt.sign(claims, secret, options);
  const real = buildOauthState({ inviteCode: 'mine' });

  const FORGERIES: Array<[string, string]> = [
    ['the old format: plain base64 JSON', b64(CLAIMS)],
    ['an unsigned token (alg none)', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...CLAIMS, purpose: PURPOSE })}.`],
    ['a token signed with another secret', sign({ ...CLAIMS, purpose: PURPOSE }, 'another-secret-with-enough-length-0123456789')],
    ['an expired token', sign({ ...CLAIMS, purpose: PURPOSE }, SECRET, { expiresIn: '-10s' })],
    ['a token with the wrong purpose (a photo link)', sign({ ...CLAIMS, purpose: 'google-photo' })],
    ['a token with no purpose (as an access token has none)', sign({ ...CLAIMS, sub: VICTIM, role: 'member', sessionId: 's-1' })],
    ['a token whose payload was edited after it was signed', `${real.split('.')[0]}.${b64({ ...(jwt.decode(real) as object), ...CLAIMS })}.${real.split('.')[2]}`],
    ['text that is not a token', 'not-a-token'],
  ];

  it.each(FORGERIES)('%s: the photo of the member it names is not touched, and nothing it says is followed', async (_name, state) => {
    googleKnowsTheMember({ email: 'a@b.co', name: 'A B', picture: PICTURE });
    const res = await callback(state);

    // The person signs in with their own account, on the main app, with no invite code and no photo link.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(verifyUrl(MAIN));
    expect(mockFindOrCreate).toHaveBeenCalledTimes(1);
    expect(mockFindOrCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.co', picture: PICTURE }), undefined);
    // And nobody's photo was set: applyGooglePhoto was never reached.
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each(FORGERIES)('%s: a failed sign-in goes back to the login page of the main app, not to the victim\'s page', async (_name, state) => {
    googleRefusesTheCode();
    const res = await callback(state);
    expect(res.headers.location).toBe(`${MAIN}/login?error=google_auth_failed`);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('the attack as it was: an unsigned state naming another member cannot change that member\'s photo', async () => {
    googleKnowsTheMember({ email: 'attacker@example.com', picture: 'https://lh3.googleusercontent.com/a/attacker' });
    const res = await callback(b64({ photoLinkUserId: VICTIM, redirect: '/profile' }));

    expect(res.headers.location).not.toMatch(/photo=/);
    expect(mockCapture).not.toHaveBeenCalledWith(VICTIM, expect.anything());
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('a state we signed is still honoured: the photo goes to the member it names, on the site it names', async () => {
    googleKnowsTheMember({ email: 'a@b.co', picture: PICTURE });
    const res = await callback(buildOauthState({ photoLinkUserId: MEMBER, redirect: '/profile', origin: PREVIEW }));
    expect(res.headers.location).toBe(`${PREVIEW}/profile?photo=done`);
    expect(mockCapture).toHaveBeenCalledWith(MEMBER, PICTURE);
    expect(mockFindOrCreate).not.toHaveBeenCalled();

    googleKnowsTheMember();
    const invited = await callback(buildOauthState({ inviteCode: 'ABC123', origin: PREVIEW }));
    expect(invited.headers.location).toBe(verifyUrl(PREVIEW, 'ABC123'));
  });

  it('a sign-in started before this change and finished after it lands on the main app without its invite code or photo link', async () => {
    // What the start used to hand to Google: the same fields, unsigned.
    const inFlight = b64({ inviteCode: 'ABC123', origin: PREVIEW });
    googleKnowsTheMember();
    const res = await callback(inFlight);
    expect(res.headers.location).toBe(verifyUrl(MAIN));
    expect(mockFindOrCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.co' }), undefined);
  });
});
