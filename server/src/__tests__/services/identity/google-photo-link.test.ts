// ─── "Use my Google photo" (7 Sep 2026) ──────────────────────────────────────

const mockQuery = jest.fn();
const mockCapture = jest.fn();
jest.mock('../../../db', () => ({ __esModule: true, query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock('../../../config', () => ({ __esModule: true, default: { jwtSecret: 'test-secret-with-enough-length-0123456789' } }));
jest.mock('../../../config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../services/onboarding/avatar.service', () => ({ __esModule: true, captureAvatar: (...a: unknown[]) => mockCapture(...a) }));
jest.mock('../../../services/onboarding/stage-events.repo', () => ({ __esModule: true, record: jest.fn().mockResolvedValue(undefined) }));

import jwt from 'jsonwebtoken';
import logger from '../../../config/logger';
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
  const SECRET = 'test-secret-with-enough-length-0123456789';
  const PURPOSE = 'google-oauth-state';
  const VICTIM = 'b0000000-0000-4000-8000-000000000002';
  const PREVIEW = 'https://preview.rsn.network';

  /** Any claims, signed like a state, so a test can put a wrong type, secret, purpose or expiry in. */
  const sign = (claims: Record<string, unknown>, secret = SECRET, options: jwt.SignOptions = { expiresIn: '30m' }) =>
    jwt.sign(claims, secret, options);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it('carries the photo link and the return path, and survives garbage', () => {
    const s = buildOauthState({ photoLinkUserId: 'u-1', redirect: '/onboarding' });
    expect(parseOauthState(s)).toEqual({ inviteCode: undefined, photoLinkUserId: 'u-1', redirect: '/onboarding' });
    expect(parseOauthState('not-base64-json')).toEqual({});
    expect(parseOauthState(undefined)).toEqual({});
  });

  // 7 Oct 2026: the site the sign-in started on rides in the state, with the invite code and the photo link.
  it('round-trips every field it carries', () => {
    const all = { inviteCode: 'ABC123', photoLinkUserId: 'u-1', redirect: '/profile', origin: PREVIEW };
    expect(parseOauthState(buildOauthState(all))).toEqual(all);
    expect(parseOauthState(buildOauthState({ inviteCode: 'ABC' })).origin).toBeUndefined();
  });

  // 7 Oct 2026: the state used to be plain base64 JSON, so anyone could write one naming another member's
  // photo link, finish Google with their own account, and replace that member's photo. It is signed now.
  it('is a signed token with its own purpose and a 30-minute life', () => {
    const state = buildOauthState({ inviteCode: 'ABC123' });
    const claims = jwt.verify(state, SECRET) as jwt.JwtPayload;
    expect(claims.purpose).toBe(PURPOSE);
    expect(claims.inviteCode).toBe('ABC123');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(30 * 60);
    expect(state.split('.')).toHaveLength(3);
  });

  // Every one of these names a victim's photo link, an invite code and the preview. None may be read, and
  // each is logged under the one class of reason that says why (the third column), never by its content.
  const CLAIMS = { inviteCode: 'FORGED', photoLinkUserId: VICTIM, redirect: '/profile', origin: PREVIEW };
  const real = buildOauthState({ inviteCode: 'mine' });
  const FORGERIES: Array<[string, string, string]> = [
    ['the old format: plain base64 JSON', b64(CLAIMS), 'malformed'],
    ['an unsigned token (alg none)', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...CLAIMS, purpose: PURPOSE })}.`, 'bad signature'],
    ['a token signed with another secret', sign({ ...CLAIMS, purpose: PURPOSE }, 'another-secret-with-enough-length-0123456789'), 'bad signature'],
    ['a token signed with another algorithm', sign({ ...CLAIMS, purpose: PURPOSE }, SECRET, { algorithm: 'HS512', expiresIn: '30m' }), 'bad signature'],
    ['an expired token', sign({ ...CLAIMS, purpose: PURPOSE }, SECRET, { expiresIn: '-10s' }), 'expired'],
    ['a token with the wrong purpose (a photo link)', sign({ ...CLAIMS, purpose: 'google-photo' }), 'wrong purpose'],
    ['a token with no purpose (as an access token has none)', sign({ ...CLAIMS, sub: VICTIM, role: 'member', sessionId: 's-1' }), 'wrong purpose'],
    ['a token whose payload was edited after it was signed', `${real.split('.')[0]}.${b64({ ...(jwt.decode(real) as object), ...CLAIMS })}.${real.split('.')[2]}`, 'bad signature'],
    ['a token with its signature cut off', real.slice(0, real.lastIndexOf('.')), 'malformed'],
    ['a token with its last characters cut off', real.slice(0, -4), 'bad signature'],
    ['text that is not a token', 'not-a-token', 'malformed'],
  ];

  it.each(FORGERIES)('ignores %s: nothing is read from it', (_name, state) => {
    expect(parseOauthState(state)).toEqual({});
  });

  it('ignores a state that is missing, or not a string at all', () => {
    expect(parseOauthState(undefined)).toEqual({});
    expect(parseOauthState('')).toEqual({});
    expect(parseOauthState(['a', 'b'] as unknown as string)).toEqual({});
    expect(parseOauthState({ photoLinkUserId: VICTIM } as unknown as string)).toEqual({});
  });

  // 7 Oct 2026: a refused state used to be silent, so a forgery probe, or a regression that made every
  // real state fail, would show nowhere. Each refusal is now one warning naming the class of reason.
  describe('a refused state is logged, by why and never by what it held', () => {
    const warn = () => logger.warn as jest.Mock;

    it.each(FORGERIES.map(([name, state, reason]) => ({ name, state, reason })))('logs $name once, as "$reason"', ({ state, reason }) => {
      parseOauthState(state);

      expect(warn()).toHaveBeenCalledTimes(1);
      const [fields, message] = warn().mock.calls[0];
      expect(fields).toEqual({ reason });
      expect(typeof message).toBe('string');
      // Nothing of the token, or of what it claimed, reaches the log: not the token, not a piece of it,
      // not the member it named, the invite code or the site.
      const logged = JSON.stringify(warn().mock.calls);
      for (const piece of [state, ...state.split('.'), VICTIM, 'FORGED', PREVIEW]) {
        if (piece.length > 8) expect(logged).not.toContain(piece);
      }
    });

    it('logs a state that is not a string as malformed, without printing it', () => {
      parseOauthState(['not', 'a', 'string'] as unknown as string);
      expect(warn()).toHaveBeenCalledTimes(1);
      // The fields are the reason and nothing else, so the value itself cannot be in the log.
      expect(warn().mock.calls[0][0]).toEqual({ reason: 'malformed' });
    });

    it('logs nothing for a state we signed, and nothing when there is no state at all', () => {
      parseOauthState(buildOauthState({ inviteCode: 'ABC123', origin: PREVIEW }));
      parseOauthState(undefined);
      parseOauthState('');
      expect(warn()).not.toHaveBeenCalled();
    });
  });

  describe('lives for 30 minutes', () => {
    afterEach(() => { jest.useRealTimers(); });

    it('is read at 29 minutes and ignored from 31', () => {
      jest.useFakeTimers({ now: new Date('2026-10-07T10:00:00Z') });
      const state = buildOauthState({ inviteCode: 'ABC123' });
      jest.setSystemTime(new Date('2026-10-07T10:29:00Z'));
      expect(parseOauthState(state)).toMatchObject({ inviteCode: 'ABC123' });
      jest.setSystemTime(new Date('2026-10-07T10:31:00Z'));
      expect(parseOauthState(state)).toEqual({});
    });
  });

  it('a photo link, an access token and a state are not interchangeable', () => {
    expect(parseOauthState(mintPhotoLinkToken('u-1'))).toEqual({});
    expect(readPhotoLinkToken(buildOauthState({ photoLinkUserId: 'u-1' }))).toBeNull();
    expect(parseOauthState(sign({ sub: 'u-1', email: 'a@b.co', role: 'member', sessionId: 's-1' }))).toEqual({});
    expect(parseOauthState(sign({ sub: 'u-1', sessionId: 's-1', type: 'refresh' }))).toEqual({});
  });

  // A signature proves the server wrote the state, not that every field has the type the code expects.
  it('reads a field of the wrong type as missing, even in a state we signed', () => {
    const odd = sign({ purpose: PURPOSE, inviteCode: 5, photoLinkUserId: ['u-1'], redirect: { path: '/x' }, origin: true });
    expect(parseOauthState(odd)).toEqual({});
    for (const origin of [42, true, null, ['https://preview.rsn.network'], { href: 'https://preview.rsn.network' }]) {
      expect(parseOauthState(sign({ purpose: PURPOSE, origin })).origin).toBeUndefined();
    }
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
