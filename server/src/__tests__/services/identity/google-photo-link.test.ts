// ─── "Use my Google photo" (7 Sep 2026) ──────────────────────────────────────

const mockQuery = jest.fn();
const mockCapture = jest.fn();
jest.mock('../../../db', () => ({ __esModule: true, query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock('../../../config', () => ({ __esModule: true, default: { jwtSecret: 'test-secret-with-enough-length-0123456789' } }));
jest.mock('../../../config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../services/onboarding/avatar.service', () => ({ __esModule: true, captureAvatar: (...a: unknown[]) => mockCapture(...a) }));
jest.mock('../../../services/onboarding/stage-events.repo', () => ({ __esModule: true, record: jest.fn().mockResolvedValue(undefined) }));

import jwt from 'jsonwebtoken';
import {
  mintPhotoLinkToken, readPhotoLinkToken, safeRedirectPath, buildOauthState, parseOauthState, applyGooglePhoto,
} from '../../../services/identity/google-photo-link';

beforeEach(() => { mockQuery.mockReset(); mockCapture.mockReset(); mockQuery.mockResolvedValue({ rows: [], rowCount: 1 }); });

describe('photo-link token', () => {
  it('round-trips the member id and is bound to its purpose', () => {
    const t = mintPhotoLinkToken('u-1');
    expect(readPhotoLinkToken(t)).toBe('u-1');
    // A normal access token is not a photo-link token, even with the same secret.
    const access = jwt.sign({ sub: 'u-1', role: 'member' }, 'test-secret-with-enough-length-0123456789');
    expect(readPhotoLinkToken(access)).toBeNull();
    expect(readPhotoLinkToken('garbage')).toBeNull();
    expect(readPhotoLinkToken(undefined)).toBeNull();
  });
});

describe('oauth state', () => {
  it('carries the photo link and the return path, and survives garbage', () => {
    const s = buildOauthState({ photoLinkUserId: 'u-1', redirect: '/onboarding' });
    expect(parseOauthState(s)).toEqual({ inviteCode: undefined, photoLinkUserId: 'u-1', redirect: '/onboarding' });
    expect(parseOauthState('not-base64-json')).toEqual({});
    expect(parseOauthState(undefined)).toEqual({});
  });

  // 7 Oct 2026: the site the sign-in started on rides in the state. The state is plain base64 JSON that
  // whoever holds the link can rewrite, so the parser only says what type it is; the callback checks it.
  it('carries the site the sign-in started on, and reads anything that is not a string as no site', () => {
    const s = buildOauthState({ inviteCode: 'ABC', origin: 'https://preview.rsn.network' });
    expect(parseOauthState(s)).toEqual({ inviteCode: 'ABC', origin: 'https://preview.rsn.network' });
    const named = (origin: unknown) => Buffer.from(JSON.stringify({ origin })).toString('base64url');
    for (const odd of [42, true, null, ['https://preview.rsn.network'], { href: 'https://preview.rsn.network' }]) {
      expect(parseOauthState(named(odd)).origin).toBeUndefined();
    }
    expect(parseOauthState(buildOauthState({ inviteCode: 'ABC' })).origin).toBeUndefined();
  });

  it('only a same-site path may be a return target', () => {
    expect(safeRedirectPath('/onboarding')).toBe('/onboarding');
    expect(safeRedirectPath('/profile')).toBe('/profile');
    expect(safeRedirectPath('https://evil.example/x')).toBe('/onboarding');
    expect(safeRedirectPath('//evil.example')).toBe('/onboarding');
    expect(safeRedirectPath(undefined)).toBe('/onboarding');
  });
});

describe('applyGooglePhoto', () => {
  it('stores a durable copy when the download works', async () => {
    mockCapture.mockResolvedValue(true);
    expect(await applyGooglePhoto('u-1', 'https://lh3.googleusercontent.com/a/photo')).toBe('done');
    expect(mockCapture).toHaveBeenCalledWith('u-1', 'https://lh3.googleusercontent.com/a/photo');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('falls back to the picture url when the download fails, so the photo still shows', async () => {
    mockCapture.mockResolvedValue(false);
    expect(await applyGooglePhoto('u-1', 'https://lh3.googleusercontent.com/a/photo')).toBe('done');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE users SET avatar_url = \$1/);
    expect(params).toEqual(['https://lh3.googleusercontent.com/a/photo', 'u-1']);
  });

  it('reports none when the Google account has no picture', async () => {
    expect(await applyGooglePhoto('u-1', undefined)).toBe('none');
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
