// ─── A Google sign-in only finishes in the browser that started it (7 Oct 2026) ──
//
// The pieces behind that rule, without express: the one-time value the start puts in the browser,
// the cookie it travels in, how the callback reads the cookie back, and the decision whether the
// browser that came back is the one that left. The routes that use them are pinned in
// routes/google-sign-in-browser-binding.test.ts.

// The default import is the real module object, so a spy on it sees the calls the code under test makes.
import crypto from 'crypto';
import {
  OAUTH_NONCE_COOKIE, OAUTH_NONCE_COOKIE_PATH, OAUTH_STATE_LIFETIME_SECONDS,
  newOauthNonce, oauthNonceCookieOptions, readCookie, browserBindingRefusal,
} from '../../../services/identity/oauth-browser-binding';

const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

describe('the one-time value', () => {
  it('is 32 random bytes as hex, and its hash is the SHA-256 of exactly that text', () => {
    const { nonce, nonceHash } = newOauthNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(nonceHash).toBe(sha256Hex(nonce));
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(nonceHash).not.toBe(nonce);
  });

  it('is new every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newOauthNonce().nonce));
    expect(seen.size).toBe(200);
  });

  it('is drawn from the system\'s random source, not from the clock or a counter', () => {
    const spy = jest.spyOn(crypto, 'randomBytes');
    newOauthNonce();
    expect(spy).toHaveBeenCalledWith(32);
  });
});

describe('the cookie it travels in', () => {
  it('is named rsn_oauth_nonce and is only sent to the Google sign-in routes of the API', () => {
    expect(OAUTH_NONCE_COOKIE).toBe('rsn_oauth_nonce');
    expect(OAUTH_NONCE_COOKIE_PATH).toBe('/api/auth/google');
  });

  it('is HttpOnly, Secure, SameSite=Lax, limited to its path, and lives as long as the state: 30 minutes', () => {
    // res.cookie takes milliseconds and writes Max-Age in seconds.
    expect(oauthNonceCookieOptions(false)).toEqual({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/google', maxAge: 30 * 60 * 1000,
    });
    expect(OAUTH_STATE_LIFETIME_SECONDS).toBe(30 * 60);
  });

  it('is Secure everywhere except development, where the API is plain http on localhost', () => {
    expect(oauthNonceCookieOptions(true).secure).toBe(false);
    expect(oauthNonceCookieOptions(false).secure).toBe(true);
    // Nothing else changes in development.
    expect({ ...oauthNonceCookieOptions(true), secure: true }).toEqual(oauthNonceCookieOptions(false));
  });

  it('names no Domain, so only the API\'s own host ever sees it', () => {
    expect(Object.keys(oauthNonceCookieOptions(false))).not.toContain('domain');
  });
});

describe('readCookie: one cookie out of a Cookie header', () => {
  const NAME = 'rsn_oauth_nonce';

  it.each([
    ['the only cookie', 'rsn_oauth_nonce=abc', 'abc'],
    ['the first of several', 'rsn_oauth_nonce=abc; other=1', 'abc'],
    ['the last of several', 'other=1; rsn_oauth_nonce=abc', 'abc'],
    ['one among several', 'a=1; rsn_oauth_nonce=abc; b=2', 'abc'],
    ['with no space after the separator', 'a=1;rsn_oauth_nonce=abc;b=2', 'abc'],
    ['with spaces around the name and the value', '  rsn_oauth_nonce = abc  ', 'abc'],
    ['in quotes', 'rsn_oauth_nonce="abc"', 'abc'],
    ['holding an equals sign', 'rsn_oauth_nonce=a=b', 'a=b'],
    ['percent-encoded', 'rsn_oauth_nonce=a%20b', 'a b'],
    ['empty', 'rsn_oauth_nonce=', ''],
    ['empty, with more after it', 'rsn_oauth_nonce=; b=2', ''],
    ['sent twice: the first one', 'rsn_oauth_nonce=first; rsn_oauth_nonce=second', 'first'],
    ['after a cookie whose own name is longer', 'rsn_oauth_nonce_x=evil; rsn_oauth_nonce=abc', 'abc'],
    ['after a cookie whose own name ends with it', 'x_rsn_oauth_nonce=evil; rsn_oauth_nonce=abc', 'abc'],
  ])('finds it %s', (_what, header, expected) => {
    expect(readCookie(header, NAME)).toBe(expected);
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['other cookies only', 'a=1; b=2'],
    ['the name with no value or equals sign', 'rsn_oauth_nonce'],
    ['only separators', ';;; ;'],
    ['a name that merely ends with it', 'x_rsn_oauth_nonce=evil'],
    ['a name that merely starts with it', 'rsn_oauth_nonce_x=evil'],
    ['the name in another case', 'RSN_OAUTH_NONCE=evil'],
    ['the name inside another cookie\'s value', 'other=rsn_oauth_nonce=evil'],
    ['the name inside another cookie\'s value after a separator', 'other=a; b=rsn_oauth_nonce=evil'],
  ])('does not find it in %s', (_what, header) => {
    expect(readCookie(header, NAME)).toBeUndefined();
  });

  it('does not throw on a value that is not valid percent-encoding: it reads it as it is, which then matches nothing', () => {
    expect(() => readCookie('rsn_oauth_nonce=%E0%A4%A', NAME)).not.toThrow();
    expect(readCookie('rsn_oauth_nonce=%E0%A4%A', NAME)).toBe('%E0%A4%A');
  });

  it('survives a header as long as a server will accept one', () => {
    const header = `${'a=1; '.repeat(3000)}rsn_oauth_nonce=abc`;
    expect(readCookie(header, NAME)).toBe('abc');
  });

  it('reads the cookie the way Express writes it', () => {
    const { nonce } = newOauthNonce();
    expect(readCookie(`${NAME}=${encodeURIComponent(nonce)}`, NAME)).toBe(nonce);
  });
});

describe('browserBindingRefusal: did the browser that came back start the sign-in?', () => {
  const { nonce, nonceHash } = newOauthNonce();
  const other = newOauthNonce();

  it('lets it through only when there is a state, the state carries a nonce, and the cookie is that nonce', () => {
    expect(browserBindingRefusal({ rawState: 'signed.state.token', nonceHash, cookieNonce: nonce })).toBeNull();
  });

  it('no state: "no state"', () => {
    expect(browserBindingRefusal({ rawState: undefined, nonceHash, cookieNonce: nonce })).toBe('no state');
    expect(browserBindingRefusal({ rawState: '', nonceHash, cookieNonce: nonce })).toBe('no state');
  });

  it('a state that carries no nonce (not ours, or from before this rule): "bad state"', () => {
    expect(browserBindingRefusal({ rawState: 'state', nonceHash: undefined, cookieNonce: nonce })).toBe('bad state');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash: '', cookieNonce: nonce })).toBe('bad state');
  });

  it('no cookie, or an empty one: "no cookie"', () => {
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: undefined })).toBe('no cookie');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: '' })).toBe('no cookie');
  });

  it('a cookie that is not the nonce of this state: "cookie mismatch"', () => {
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: other.nonce })).toBe('cookie mismatch');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: nonce.toUpperCase() })).toBe('cookie mismatch');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: `${nonce} ` })).toBe('cookie mismatch');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: nonce.slice(1) })).toBe('cookie mismatch');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: 'x'.repeat(100_000) })).toBe('cookie mismatch');
  });

  it('the state\'s own hash is not a cookie: the hash, copied from the state, is refused', () => {
    // Someone who reads the state can read the hash. It must not be enough.
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: nonceHash })).toBe('cookie mismatch');
  });

  it('a hash that is not a hash (wrong length, not hex) matches nothing, and never throws', () => {
    for (const bad of ['zz', 'abc', 'a'.repeat(63), 'a'.repeat(65), '0x' + 'a'.repeat(62), ' '.repeat(64)]) {
      expect(() => browserBindingRefusal({ rawState: 'state', nonceHash: bad, cookieNonce: nonce })).not.toThrow();
      expect(browserBindingRefusal({ rawState: 'state', nonceHash: bad, cookieNonce: nonce })).toBe('cookie mismatch');
    }
  });

  it('checks the reasons in order: no state, then bad state, then no cookie, then a mismatch', () => {
    expect(browserBindingRefusal({ rawState: undefined, nonceHash: undefined, cookieNonce: undefined })).toBe('no state');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash: undefined, cookieNonce: undefined })).toBe('bad state');
    expect(browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: undefined })).toBe('no cookie');
  });

  it('compares in constant time: the digests go through crypto.timingSafeEqual, 32 bytes each', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: nonce });
    browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: other.nonce });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it('does not reach the comparison when there is nothing to compare', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    browserBindingRefusal({ rawState: undefined, nonceHash, cookieNonce: nonce });
    browserBindingRefusal({ rawState: 'state', nonceHash: undefined, cookieNonce: nonce });
    browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonce: undefined });
    expect(spy).not.toHaveBeenCalled();
  });
});
