// ─── A Google sign-in only finishes in the browser that started it (7 Oct 2026) ──
//
// The pieces behind that rule, without express: the one-time value the start puts in the browser,
// the cookie it travels in, how the callback reads the cookie back, and the decision whether the
// browser that came back is the one that left. The routes that use them are pinned in
// routes/google-sign-in-browser-binding.test.ts.

// The default import is the real module object, so a spy on it sees the calls the code under test makes.
import crypto from 'crypto';
import {
  OAUTH_STATE_LIFETIME_SECONDS, GOOGLE_START_PATH, OAUTH_NONCE_COOKIE_PRODUCTION, OAUTH_NONCE_COOKIE_DEVELOPMENT,
  newOauthNonce, oauthNonceCookieName, oauthNonceCookieOptions, readCookieValues, browserBindingRefusal, canonicalStartLocation,
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
  it('is named __Host-rsn_oauth_nonce in production and rsn_oauth_nonce in development, in exactly these words', () => {
    expect(OAUTH_NONCE_COOKIE_PRODUCTION).toBe('__Host-rsn_oauth_nonce');
    expect(OAUTH_NONCE_COOKIE_DEVELOPMENT).toBe('rsn_oauth_nonce');
    expect(oauthNonceCookieName(false)).toBe('__Host-rsn_oauth_nonce');
    expect(oauthNonceCookieName(true)).toBe('rsn_oauth_nonce');
  });

  // The __Host- prefix is a promise a browser enforces: it keeps such a cookie only when it is Secure, has Path=/ and names no
  // Domain, set from an https page. So no sibling site on rsn.network can set it from its own address, or shadow it with a
  // cookie of a longer path (which a browser sends first).
  it('in production: Secure, Path=/ and no Domain (what __Host- demands), HttpOnly, SameSite=Lax, 30 minutes', () => {
    // res.cookie takes milliseconds and writes Max-Age in seconds.
    expect(oauthNonceCookieOptions(false)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 30 * 60 * 1000 });
    expect(Object.keys(oauthNonceCookieOptions(false))).not.toContain('domain');
    expect(OAUTH_STATE_LIFETIME_SECONDS).toBe(30 * 60);
  });

  it('in development, where the API is plain http (so Secure, and with it the prefix, cannot apply): the plain name, on its own path, not Secure', () => {
    expect(oauthNonceCookieOptions(true)).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/api/auth/google', maxAge: 30 * 60 * 1000 });
    expect(Object.keys(oauthNonceCookieOptions(true))).not.toContain('domain');
  });

  it('is HttpOnly and SameSite=Lax and lives as long as the state, in either', () => {
    for (const isDev of [true, false]) {
      const { httpOnly, sameSite, maxAge } = oauthNonceCookieOptions(isDev);
      expect([httpOnly, sameSite, maxAge]).toEqual([true, 'lax', OAUTH_STATE_LIFETIME_SECONDS * 1000]);
    }
  });
});

describe('readCookieValues: every cookie of one name out of a Cookie header', () => {
  const NAME = 'rsn_oauth_nonce';

  it.each([
    ['the only cookie', 'rsn_oauth_nonce=abc', ['abc']],
    ['the first of several', 'rsn_oauth_nonce=abc; other=1', ['abc']],
    ['the last of several', 'other=1; rsn_oauth_nonce=abc', ['abc']],
    ['one among several', 'a=1; rsn_oauth_nonce=abc; b=2', ['abc']],
    ['with no space after the separator', 'a=1;rsn_oauth_nonce=abc;b=2', ['abc']],
    ['with spaces around the name and the value', '  rsn_oauth_nonce = abc  ', ['abc']],
    ['in quotes', 'rsn_oauth_nonce="abc"', ['abc']],
    ['holding an equals sign', 'rsn_oauth_nonce=a=b', ['a=b']],
    ['percent-encoded', 'rsn_oauth_nonce=a%20b', ['a b']],
    ['empty', 'rsn_oauth_nonce=', ['']],
    ['empty, with more after it', 'rsn_oauth_nonce=; b=2', ['']],
    ['after a cookie whose own name is longer', 'rsn_oauth_nonce_x=evil; rsn_oauth_nonce=abc', ['abc']],
    ['after a cookie whose own name ends with it', 'x_rsn_oauth_nonce=evil; rsn_oauth_nonce=abc', ['abc']],
  ])('finds it %s', (_what, header, expected) => {
    expect(readCookieValues(header, NAME)).toEqual(expected);
  });

  // A browser sends one cookie of a name per host and path, so two of one name means somebody else's was set beside it.
  // Every one is returned, in the order sent, so that the decision can refuse the lot.
  it.each([
    ['twice: both, in the order sent', 'rsn_oauth_nonce=first; rsn_oauth_nonce=second', ['first', 'second']],
    ['twice with the same value', 'rsn_oauth_nonce=a; rsn_oauth_nonce=a', ['a', 'a']],
    ['three times, with others between', 'rsn_oauth_nonce=a; x=1; rsn_oauth_nonce=b; y=2; rsn_oauth_nonce=c', ['a', 'b', 'c']],
    ['an empty one and a full one', 'rsn_oauth_nonce=; rsn_oauth_nonce=abc', ['', 'abc']],
    ['one in quotes and one not', 'rsn_oauth_nonce="a"; rsn_oauth_nonce=b', ['a', 'b']],
  ])('finds it %s', (_what, header, expected) => {
    expect(readCookieValues(header, NAME)).toEqual(expected);
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
    ['the production name, when asked for the plain one', '__Host-rsn_oauth_nonce=evil'],
  ])('finds no cookie in %s', (_what, header) => {
    expect(readCookieValues(header, NAME)).toEqual([]);
  });

  it('the plain name and the __Host- name are two cookies: reading one never returns the other', () => {
    const header = 'rsn_oauth_nonce=plain; __Host-rsn_oauth_nonce=prefixed';
    expect(readCookieValues(header, 'rsn_oauth_nonce')).toEqual(['plain']);
    expect(readCookieValues(header, '__Host-rsn_oauth_nonce')).toEqual(['prefixed']);
  });

  it('does not throw on a value that is not valid percent-encoding: it reads it as it is, which then matches nothing', () => {
    expect(() => readCookieValues('rsn_oauth_nonce=%E0%A4%A', NAME)).not.toThrow();
    expect(readCookieValues('rsn_oauth_nonce=%E0%A4%A', NAME)).toEqual(['%E0%A4%A']);
  });

  it('survives a header as long as a server will accept one', () => {
    const header = `${'a=1; '.repeat(3000)}rsn_oauth_nonce=abc`;
    expect(readCookieValues(header, NAME)).toEqual(['abc']);
  });

  it('reads the cookie the way Express writes it', () => {
    const { nonce } = newOauthNonce();
    expect(readCookieValues(`${NAME}=${encodeURIComponent(nonce)}`, NAME)).toEqual([nonce]);
  });
});

describe('browserBindingRefusal: did the browser that came back start the sign-in?', () => {
  const { nonce, nonceHash } = newOauthNonce();
  const other = newOauthNonce();
  const decide = (over: Partial<Parameters<typeof browserBindingRefusal>[0]> = {}) =>
    browserBindingRefusal({ rawState: 'state', nonceHash, cookieNonces: [nonce], ...over });

  it('lets it through only when there is a state, the state carries a nonce, and exactly one cookie is that nonce', () => {
    expect(browserBindingRefusal({ rawState: 'signed.state.token', nonceHash, cookieNonces: [nonce] })).toBeNull();
  });

  it('no state: "no state"', () => {
    expect(decide({ rawState: undefined })).toBe('no state');
    expect(decide({ rawState: '' })).toBe('no state');
  });

  it('a state that carries no nonce (not ours, or from before this rule): "bad state"', () => {
    expect(decide({ nonceHash: undefined })).toBe('bad state');
    expect(decide({ nonceHash: '' })).toBe('bad state');
  });

  it('no cookie, or an empty one: "no cookie"', () => {
    expect(decide({ cookieNonces: [] })).toBe('no cookie');
    expect(decide({ cookieNonces: [''] })).toBe('no cookie');
  });

  it('a cookie that is not the nonce of this state: "cookie mismatch"', () => {
    expect(decide({ cookieNonces: [other.nonce] })).toBe('cookie mismatch');
    expect(decide({ cookieNonces: [nonce.toUpperCase()] })).toBe('cookie mismatch');
    expect(decide({ cookieNonces: [`${nonce} `] })).toBe('cookie mismatch');
    expect(decide({ cookieNonces: [nonce.slice(1)] })).toBe('cookie mismatch');
    expect(decide({ cookieNonces: ['x'.repeat(100_000)] })).toBe('cookie mismatch');
  });

  // Two cookies of the name can only mean that somebody else set one beside ours. Which of them a server reads first is
  // not something to rely on, so more than one is refused outright, whatever they hold, the right value included.
  it('more than one cookie of the name, whatever they hold: "cookie mismatch"', () => {
    for (const cookieNonces of [
      [nonce, nonce], [nonce, other.nonce], [other.nonce, nonce], ['', nonce], [nonce, ''], ['', ''], [nonce, nonce, nonce],
    ]) {
      expect(decide({ cookieNonces })).toBe('cookie mismatch');
    }
  });

  it('the state\'s own hash is not a cookie: the hash, copied from the state, is refused', () => {
    // Someone who reads the state can read the hash. It must not be enough.
    expect(decide({ cookieNonces: [nonceHash] })).toBe('cookie mismatch');
  });

  it('a hash that is not a hash (wrong length, not hex) matches nothing, and never throws', () => {
    for (const bad of ['zz', 'abc', 'a'.repeat(63), 'a'.repeat(65), '0x' + 'a'.repeat(62), ' '.repeat(64)]) {
      expect(() => decide({ nonceHash: bad })).not.toThrow();
      expect(decide({ nonceHash: bad })).toBe('cookie mismatch');
    }
  });

  it('checks the reasons in order: no state, then bad state, then no cookie, then two cookies or a mismatch', () => {
    expect(decide({ rawState: undefined, nonceHash: undefined, cookieNonces: [] })).toBe('no state');
    expect(decide({ rawState: undefined, cookieNonces: [nonce, nonce] })).toBe('no state');
    expect(decide({ nonceHash: undefined, cookieNonces: [] })).toBe('bad state');
    expect(decide({ nonceHash: undefined, cookieNonces: [nonce, nonce] })).toBe('bad state');
    expect(decide({ cookieNonces: [] })).toBe('no cookie');
  });

  it('compares in constant time: the digests go through crypto.timingSafeEqual, 32 bytes each', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    decide();
    decide({ cookieNonces: [other.nonce] });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it('does not reach the comparison when there is nothing to compare, or more than one thing', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    decide({ rawState: undefined });
    decide({ nonceHash: undefined });
    decide({ cookieNonces: [] });
    decide({ cookieNonces: [nonce, nonce] });
    expect(spy).not.toHaveBeenCalled();
  });
});

// Production has two API hosts. The client builds its start from the first (rsn-api-h04m.onrender.com, runtimeEndpoints.ts)
// and Google is told to return to `${API_BASE_URL}/api/auth/google/callback`, the second (api.rsn.network). A cookie set on
// the first is never sent to the second, so the start has to run on the host Google will return to.
describe('canonicalStartLocation: the start runs on the host Google will return to', () => {
  const ONRENDER = 'rsn-api-h04m.onrender.com';
  const API = 'https://api.rsn.network';
  type Input = Parameters<typeof canonicalStartLocation>[0];
  const ask = (over: Partial<Input> = {}) =>
    canonicalStartLocation({ hostname: ONRENDER, originalUrl: '/api/auth/google', apiBaseUrl: API, carryOrigin: undefined, ...over });
  const paramsOf = (location: string | null) => Object.fromEntries(new URL(location as string).searchParams);

  it('knows where the start lives on the API', () => {
    expect(GOOGLE_START_PATH).toBe('/api/auth/google');
  });

  it('is no hop on the canonical host, however its name is spelled', () => {
    for (const hostname of ['api.rsn.network', 'API.RSN.NETWORK', 'Api.Rsn.Network']) {
      expect(ask({ hostname })).toBeNull();
    }
  });

  it('sends a start on any other host to the same start on the canonical host, and only to it', () => {
    expect(ask()).toBe('https://api.rsn.network/api/auth/google?hop=1');
    for (const hostname of [ONRENDER, 'localhost', '127.0.0.1', 'evil.example', 'api.rsn.network.evil.example', 'xapi.rsn.network', 'rsn.network']) {
      const to = new URL(ask({ hostname }) as string);
      expect(to.origin).toBe(API);
      expect(to.pathname).toBe('/api/auth/google');
    }
  });

  it('keeps the query as it came (site, invite code, photo link, return path) and adds hop=1', () => {
    const original = '/api/auth/google?origin=https%3A%2F%2Fpreview.rsn.network&inviteCode=ABC123&photo=a.b.c&redirect=%2Fprofile%3Fx%3D1';
    expect(paramsOf(ask({ originalUrl: original }))).toEqual({
      origin: 'https://preview.rsn.network', inviteCode: 'ABC123', photo: 'a.b.c', redirect: '/profile?x=1', hop: '1',
    });
  });

  it('carries the site it resolved when the request named none, replacing an empty or repeated one', () => {
    const preview = 'https://preview.rsn.network';
    expect(paramsOf(ask({ carryOrigin: preview }))).toEqual({ origin: preview, hop: '1' });
    expect(paramsOf(ask({ originalUrl: '/api/auth/google?inviteCode=X', carryOrigin: preview }))).toEqual({ inviteCode: 'X', origin: preview, hop: '1' });
    expect(paramsOf(ask({ originalUrl: '/api/auth/google?origin=', carryOrigin: preview }))).toEqual({ origin: preview, hop: '1' });
    const repeated = new URL(ask({ originalUrl: '/api/auth/google?origin=a&origin=b', carryOrigin: preview }) as string);
    expect(repeated.searchParams.getAll('origin')).toEqual([preview]);
    // An origin that arrived as a list or an object leaves nothing of itself behind: the second request must read one string.
    const listed = new URL(ask({ originalUrl: '/api/auth/google?origin[]=a&origin[0]=b&origin[x]=c&other=1', carryOrigin: preview }) as string);
    expect(Object.fromEntries(listed.searchParams)).toEqual({ origin: preview, other: '1', hop: '1' });
  });

  it('leaves a named site exactly as it was, even one that is not ours', () => {
    const named = '/api/auth/google?origin=https%3A%2F%2Fevil.example';
    expect(paramsOf(ask({ originalUrl: named, carryOrigin: undefined }))).toEqual({ origin: 'https://evil.example', hop: '1' });
  });

  it('is no hop for a request that already carries hop, whatever its value: one hop at most', () => {
    for (const hop of ['1', '0', '', 'true', 'x']) {
      expect(ask({ originalUrl: `/api/auth/google?origin=a&hop=${hop}` })).toBeNull();
    }
    expect(ask({ originalUrl: '/api/auth/google?hop' })).toBeNull();
  });

  it('is a hop for a request that names no host at all', () => {
    expect(ask({ hostname: undefined })).toBe('https://api.rsn.network/api/auth/google?hop=1');
    expect(ask({ hostname: '' })).toBe('https://api.rsn.network/api/auth/google?hop=1');
  });

  it('compares host names, never ports or schemes: localhost:3001 is localhost', () => {
    expect(ask({ hostname: 'localhost', apiBaseUrl: 'http://localhost:3001' })).toBeNull();
    expect(ask({ hostname: '127.0.0.1', apiBaseUrl: 'http://localhost:3001' })).toBe('http://localhost:3001/api/auth/google?hop=1');
    expect(ask({ hostname: '[::1]', apiBaseUrl: 'http://[::1]:3001' })).toBeNull();
  });

  it('takes only the origin of the setting: a path or a trailing slash in it changes nothing', () => {
    for (const apiBaseUrl of ['https://api.rsn.network/', 'https://api.rsn.network/api', 'https://api.rsn.network//x?y=1']) {
      expect(ask({ apiBaseUrl })).toBe('https://api.rsn.network/api/auth/google?hop=1');
    }
  });

  it('never leaves the configured origin, whatever the request says', () => {
    for (const originalUrl of [
      '//evil.example/x?y=1', '/\\evil.example', '/api/auth/google@evil.example', 'https://evil.example/api/auth/google?x=1',
      '/api/auth/google/../../x', '/api/auth/google?redirect=//evil.example', '/api/auth/google?%0d%0aSet-Cookie:%20x=1', '',
    ]) {
      const to = new URL(ask({ originalUrl }) as string);
      expect(to.origin).toBe(API);
      expect(to.pathname).toBe('/api/auth/google');
      expect(to.username).toBe('');
    }
  });

  it('does not throw on a setting that is not a URL: no hop, so a misconfiguration cannot take sign-in down with it', () => {
    for (const apiBaseUrl of ['', 'not a url', 'api.rsn.network']) {
      expect(() => ask({ apiBaseUrl })).not.toThrow();
      expect(ask({ apiBaseUrl })).toBeNull();
    }
  });
});
