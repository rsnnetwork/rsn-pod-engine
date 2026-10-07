// ─── A Google sign-in only finishes in the browser that started it ───────────
//
// 7 Oct 2026. The OAuth state (google-photo-link.ts) is signed, so only the server can write one. But
// a signature proves the server wrote the state, not that the browser arriving at the callback is the
// one that left. So an attacker could start a sign-in in their own browser, finish Google with THEIR
// account, and send a victim the callback address (their code, their valid state): the victim's browser
// would end up signed into the ATTACKER's account, and whatever the victim then typed into it (private
// answers, the things RSN exists to hold) would be the attacker's to read. The same goes for a photo-link
// state started in someone else's browser and finished in a victim's.
//
// What this does NOT cover: a photo-link START ADDRESS that an attacker minted for their own account (the photo
// token is a bearer token in that address) and a victim then opens. The victim's own browser starts that flow,
// so it is bound, and the victim's Google picture would land on the attacker's account. Closing that needs the
// photo link tied to the signed-in member, which is a separate change.
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

/** Where the Google sign-in start lives on the API (routes/auth.ts is mounted at /api/auth, as index.ts does). */
export const GOOGLE_START_PATH = '/api/auth/google';

/**
 * Production has two API hosts, and the cookie above belongs to ONE of them. The client builds its start from
 * rsn-api-h04m.onrender.com (client/src/lib/runtimeEndpoints.ts), but Google is told to return to
 * `${API_BASE_URL}/api/auth/google/callback` (api.rsn.network), and a cookie with no Domain goes to the host that set it
 * and to no other: set on the first host it never reaches the second, and every callback would be refused.
 *
 * So the start has to run on the host Google will return to. A start that arrives on any other host is answered with
 * ONE redirect to the same start there, before anything is minted or set, and this returns that address (or null when
 * there is nothing to do):
 *  - The destination is always the configured API origin and the fixed start path. Only the query comes from the
 *    request, and it is re-encoded, so a request cannot steer the browser anywhere else.
 *  - The query is kept as it came (the site, the invite code, the photo link, the return path). The second request may
 *    carry no Referer (Helmet's Referrer-Policy: no-referrer on the redirect takes it away), so when the request named
 *    no site, `carryOrigin` (the site the first request resolved from its Referer) rides in `origin=` instead.
 *  - `hop=1` marks the redirect, and a request that already carries it is never redirected again, so a proxy that makes
 *    every request look foreign ends the start where it is instead of looping.
 *
 * `hostname` is req.hostname: with `trust proxy` as index.ts sets it, X-Forwarded-Host when a proxy sends one, else the
 * Host header, port left off. An API_BASE_URL that is not a URL gives no hop: it must not take sign-in down with it.
 */
export function canonicalStartLocation(input: {
  hostname: string | undefined;
  originalUrl: string;
  apiBaseUrl: string;
  carryOrigin: string | undefined;
}): string | null {
  let canonical: URL;
  try {
    canonical = new URL(input.apiBaseUrl);
  } catch {
    return null;
  }
  if (input.hostname?.toLowerCase() === canonical.hostname) return null;

  const at = input.originalUrl.indexOf('?');
  const query = new URLSearchParams(at < 0 ? '' : input.originalUrl.slice(at + 1));
  if (query.has('hop')) return null;
  if (input.carryOrigin !== undefined) {
    // Whatever shape the old value had (empty, repeated, a list, an object), the second request reads this one string.
    for (const key of [...query.keys()]) if (key === 'origin' || key.startsWith('origin[')) query.delete(key);
    query.set('origin', input.carryOrigin);
  }
  query.set('hop', '1');
  return `${canonical.origin}${GOOGLE_START_PATH}?${query}`;
}
