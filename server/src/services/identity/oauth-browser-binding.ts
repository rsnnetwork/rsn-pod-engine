// ─── A Google sign-in only finishes in the browser that started it ───────────
//
// 7 Oct 2026. The OAuth state (google-photo-link.ts) is signed, so only the server can write one. But
// a signature proves the server wrote the state, not that the browser arriving at the callback is the
// one that left. So an attacker could start a sign-in in their own browser, finish Google with THEIR
// account, and send a victim the callback address (their code, their valid state): the victim's browser
// would end up signed into the ATTACKER's account, and whatever the victim then typed into it (private
// answers, the things RSN exists to hold) would be the attacker's to read. The mirror is a photo-link
// state started by someone else and finished by a victim.
//
// The fix is a one-time secret that lives in the browser and nowhere else. The start puts a random
// nonce in a cookie on the API's own host and the nonce's SHA-256 in the signed state; the callback goes
// on only when the browser's cookie hashes to what the state carries. The state holds the hash and not
// the nonce, because the state travels in URLs (Google's, the callback's, logs, history), and a state
// that leaks must not reveal what the cookie has to hold.
//
// Everything here is pure (strings in, strings out): the route does the reading and writing of cookies,
// because services never touch req/res.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const OAUTH_NONCE_COOKIE = 'rsn_oauth_nonce';
/** Only the Google sign-in routes of the API (the start and the callback) are sent the cookie. */
export const OAUTH_NONCE_COOKIE_PATH = '/api/auth/google';
/**
 * How long a state lives, and so how long the cookie that binds it to a browser lives: the same
 * 30 minutes, said once. A state outliving its cookie could only be refused; a cookie outliving its state
 * would only be clutter.
 */
export const OAUTH_STATE_LIFETIME_SECONDS = 30 * 60;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

export interface OauthNonce {
  /** The secret: goes into the browser's cookie, and nowhere else. */
  nonce: string;
  /** SHA-256 of `nonce`, as hex: goes into the signed state. */
  nonceHash: string;
}

export function newOauthNonce(): OauthNonce {
  const nonce = randomBytes(32).toString('hex');
  return { nonce, nonceHash: sha256(nonce).toString('hex') };
}

/**
 * Attributes of the nonce cookie, for res.cookie. The start and the callback are both top-level
 * navigations to the API's host (from the app, then from accounts.google.com), so a SameSite=Lax
 * first-party cookie is sent on the callback. No Domain: only the API's own host ever sees it.
 * Secure everywhere but development, where the API is plain http on localhost.
 */
export function oauthNonceCookieOptions(isDev: boolean) {
  return {
    httpOnly: true,
    secure: !isDev,
    sameSite: 'lax' as const,
    path: OAUTH_NONCE_COOKIE_PATH,
    maxAge: OAUTH_STATE_LIFETIME_SECONDS * 1000, // res.cookie takes milliseconds and writes Max-Age in seconds
  };
}

/**
 * One cookie out of a Cookie header. The server has no cookie parser and needs exactly one name, so this
 * reads that and nothing else: the name must match whole (not a longer or shorter name), the first of
 * two cookies of that name wins (browsers send the most specific path first), and a value that is not
 * valid percent-encoding is read as it is, which then matches nothing.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** Equal hashes, compared in constant time. Anything that is not a SHA-256 in hex simply does not match. */
function matchesHash(cookieNonce: string, nonceHash: string): boolean {
  const expected = Buffer.from(nonceHash, 'hex');
  const actual = sha256(cookieNonce);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Why a callback is not finishing the sign-in that started in this browser: the four reasons it is logged under. */
export type BindingRefusal = 'no state' | 'bad state' | 'no cookie' | 'cookie mismatch';

/**
 * Whether the browser that came back is the browser that left: null when it is, else the reason it is not.
 * `rawState` is what arrived; `nonceHash` is what the state carried once it verified (nothing for a state
 * that did not verify, or that was signed before this rule and has no nonce); `cookieNonce` is what the
 * browser sent back.
 */
export function browserBindingRefusal(input: {
  rawState: string | undefined;
  nonceHash: string | undefined;
  cookieNonce: string | undefined;
}): BindingRefusal | null {
  if (!input.rawState) return 'no state';
  if (!input.nonceHash) return 'bad state';
  if (!input.cookieNonce) return 'no cookie';
  return matchesHash(input.cookieNonce, input.nonceHash) ? null : 'cookie mismatch';
}
