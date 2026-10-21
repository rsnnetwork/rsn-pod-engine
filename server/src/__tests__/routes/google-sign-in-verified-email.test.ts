// ─── Google sign-in needs an email Google has verified (21 Oct 2026) ─────────
//
// Google's userinfo says, in verified_email, whether it has checked that the account really
// owns the address it names. When it has not, the address is only a claim: anyone can make a
// Google account that names someone else's, and signing that account in by its address would
// hand over the owner's account (an admin's, say). The callback now refuses an account whose
// verified_email is exactly false, through the same failure every other Google refusal uses,
// and a field Google leaves out, or says is true, goes on exactly as before.
//
// The photo link ("Use my Google photo") is not a sign-in: it attaches a picture to the member
// who is already signed in and never looks an account up by the address, so it is unchanged.
//
// These go through express with the real router and the real allow-list; only the database,
// Google and the account lookup are stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-secret-with-enough-length-0123456789', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
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
import { buildOauthState, GoogleOauthState } from '../../services/identity/google-photo-link';
import { oauthNonceCookieName, newOauthNonce } from '../../services/identity/oauth-browser-binding';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';
const MEMBER = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const PICTURE = 'https://lh3.googleusercontent.com/a/photo';

const app = express();
app.use('/auth', authRoutes);

const realFetch = global.fetch;
beforeEach(() => {
  mockFindOrCreate.mockReset().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
  mockCapture.mockReset().mockResolvedValue(true);
  (logger.warn as jest.Mock).mockClear();
});
afterAll(() => { global.fetch = realFetch; });

/** The cookie a start would have put in the browser, for each state minted below: a sign-in only finishes in the browser that started it. */
const cookieFor = new Map<string, string>();

function stateWith(claims: GoogleOauthState): string {
  const { nonce, nonceHash } = newOauthNonce();
  const state = buildOauthState({ ...claims, nonceHash });
  cookieFor.set(state, `${oauthNonceCookieName(config.isDev)}=${nonce}`);
  return state;
}

/** Google accepts the code and describes the account (the two calls the callback makes, in order). */
function googleDescribes(profile: Record<string, unknown>) {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ json: async () => ({ access_token: 'g-token' }) })
    .mockResolvedValueOnce({ json: async () => profile }) as unknown as typeof fetch;
}

function callback(state: string) {
  const req = request(app).get('/auth/google/callback').query({ code: 'c', state });
  return req.set('Cookie', cookieFor.get(state)!);
}

const verifyUrl = (base: string, inviteCode?: string) =>
  `${base}/auth/verify?accessToken=at&refreshToken=rt${inviteCode ? `&inviteCode=${inviteCode}` : ''}`;
const loginFailure = (base: string) => `${base}/login?error=google_auth_failed`;

describe('GET /auth/google/callback: an email Google has not verified', () => {
  it.each([[MAIN], [PREVIEW]])('is refused, back to the login page of the site it started on (%s)', async (origin) => {
    googleDescribes({ email: 'admin@company.example', name: 'A Admin', verified_email: false });
    const res = await callback(stateWith({ origin }));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(loginFailure(origin));
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    // The redirect carries no token, and says no more than any other Google failure does.
    expect(res.headers.location).not.toMatch(/accessToken|refreshToken/);
  });

  it('is refused with an invite code too, and the invite is not used', async () => {
    googleDescribes({ email: 'a@b.co', verified_email: false });
    const res = await callback(stateWith({ origin: PREVIEW, inviteCode: 'ABC123' }));

    expect(res.headers.location).toBe(loginFailure(PREVIEW));
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it('is logged as a warning that names the address Google gave', async () => {
    googleDescribes({ email: 'admin@company.example', verified_email: false });
    await callback(stateWith({ origin: MAIN }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ email: 'admin@company.example' }, expect.stringMatching(/not verified/i));
  });
});

describe('GET /auth/google/callback: everything else goes on exactly as before', () => {
  it.each([
    ['verified_email true', { email: 'a@b.co', name: 'A B', verified_email: true }],
    ['no verified_email field at all', { email: 'a@b.co', name: 'A B' }],
  ])('%s signs the member in', async (_name, profile) => {
    googleDescribes(profile);
    const res = await callback(stateWith({ origin: PREVIEW, inviteCode: 'ABC123' }));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(verifyUrl(PREVIEW, 'ABC123'));
    expect(mockFindOrCreate).toHaveBeenCalledTimes(1);
    expect(mockFindOrCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.co' }), 'ABC123');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('the photo link reads no email, so it still attaches the picture whatever Google says about the address', async () => {
    googleDescribes({ email: 'a@b.co', picture: PICTURE, verified_email: false });
    const res = await callback(stateWith({ photoLinkUserId: MEMBER, redirect: '/profile', origin: PREVIEW }));

    expect(res.headers.location).toBe(`${PREVIEW}/profile?photo=done`);
    expect(mockCapture).toHaveBeenCalledWith(MEMBER, PICTURE);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });
});
