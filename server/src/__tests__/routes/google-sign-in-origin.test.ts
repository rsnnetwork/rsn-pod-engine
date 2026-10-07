// ─── Google sign-in returns to the site it started from (7 Oct 2026) ─────────
//
// Ali signed in with Google on the preview and landed on the live app: the callback
// redirected to the fixed CLIENT_URL. The site the member starts on now rides in the
// OAuth state, resolved against the exact allow-list in client-origin.ts, and is
// resolved AGAIN on the callback. The state is plain base64 JSON that whoever holds the
// link can rewrite, and the success redirect carries live tokens in its query string,
// so a tampered origin must send the member to the main app and never to another site.
//
// These go through express with the real router and the real allow-list; only the
// database, Google and the account lookup are stand-ins.

import express from 'express';
import request from 'supertest';

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
import { mintPhotoLinkToken } from '../../services/identity/google-photo-link';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';
const MEMBER = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

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

const stateOf = (location: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(new URL(location).searchParams.get('state') ?? '', 'base64url').toString());

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
});

// ── The callback ─────────────────────────────────────────────────────────────

const stateWith = (state: object) => Buffer.from(JSON.stringify(state)).toString('base64url');

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

  // The state is attacker-visible. The redirect carries live tokens, so a site that is not ours
  // must never be a destination, whatever the state says and however it is dressed up.
  it.each(NOT_OURS)('a tampered state naming %j sends the member, and the tokens, to the main app', async (origin) => {
    googleKnowsTheMember();
    const res = await callback(stateWith({ origin }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(verifyUrl(MAIN));
    expect(new URL(res.headers.location).origin).toBe(MAIN);
  });

  it.each([[42], [true], [null], [['https://preview.rsn.network']], [{ href: 'https://preview.rsn.network' }]])(
    'a tampered state whose origin is %j (not a string) sends the member to the main app',
    async (origin) => {
      googleKnowsTheMember();
      expect((await callback(stateWith({ origin }))).headers.location).toBe(verifyUrl(MAIN));
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

    it('a tampered origin goes to the login page of the main app, never elsewhere', async () => {
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
    const photoState = (origin?: unknown) => stateWith({ photoLinkUserId: MEMBER, redirect: '/profile', ...(origin === undefined ? {} : { origin }) });

    it('done, none, failed and cancelled all come back to the preview', async () => {
      googleKnowsTheMember({ email: 'a@b.co', picture: 'https://lh3.googleusercontent.com/a/photo' });
      expect((await callback(photoState(PREVIEW))).headers.location).toBe(`${PREVIEW}/profile?photo=done`);
      googleKnowsTheMember({ email: 'a@b.co' });
      expect((await callback(photoState(PREVIEW))).headers.location).toBe(`${PREVIEW}/profile?photo=none`);
      googleRefusesTheCode();
      expect((await callback(photoState(PREVIEW))).headers.location).toBe(`${PREVIEW}/profile?photo=failed`);
      expect((await callback(photoState(PREVIEW), null)).headers.location).toBe(`${PREVIEW}/profile?photo=cancelled`);
      // A photo link signs nobody in.
      expect(mockFindOrCreate).not.toHaveBeenCalled();
    });

    it('a tampered origin comes back to the main app; a state with no origin as before', async () => {
      googleKnowsTheMember({ email: 'a@b.co', picture: 'https://lh3.googleusercontent.com/a/photo' });
      expect((await callback(photoState('https://evil.example'))).headers.location).toBe(`${MAIN}/profile?photo=done`);
      googleKnowsTheMember({ email: 'a@b.co', picture: 'https://lh3.googleusercontent.com/a/photo' });
      expect((await callback(photoState())).headers.location).toBe(`${MAIN}/profile?photo=done`);
      expect((await callback(photoState('https://evil.example'), null)).headers.location).toBe(`${MAIN}/profile?photo=cancelled`);
    });

    it('the return path stays a same-site path on our site, whatever the state says', async () => {
      googleKnowsTheMember({ email: 'a@b.co', picture: 'https://lh3.googleusercontent.com/a/photo' });
      const res = await callback(stateWith({ photoLinkUserId: MEMBER, redirect: 'https://evil.example/x', origin: PREVIEW }));
      expect(res.headers.location).toBe(`${PREVIEW}/onboarding?photo=done`);
    });
  });
});
