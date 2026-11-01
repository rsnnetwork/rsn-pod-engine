// ─── The 6-digit sign-in code (1 Nov 2026) ───────────────────────────────────
//
// Stefan could not sign in on 30 Oct: he expected a password. REASON has none; it emails a sign-in link, and a
// link signs in the browser that opens it, so a member who reads the email on a phone, or in a mail app's own
// browser, leaves the waiting tab waiting. The same email now also carries a 6-digit code to type there.
//
// The rules (the plan's L14):
//   - the code is crypto-random and is never stored: magic_links.code_hash keeps a keyed hash of it, bound to that
//     row's token hash, so a copy of the table alone cannot be turned back into a code;
//   - it works for 15 minutes (the link keeps its own 60);
//   - it is spent with the link: using the link refuses the code, and using the code marks the link used (the link
//     then keeps only its 2-minute scanner grace, which already lets the same link sign in twice);
//   - every try is counted, and the fifth wrong one kills the link and the code together.

import crypto from 'crypto';
import config from '../../config';

export const SIGN_IN_CODE_TTL_MINUTES = 15;
export const SIGN_IN_CODE_MAX_ATTEMPTS = 5;

/** Six digits from the operating system's random source, leading zeros kept. */
export function newSignInCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * The stored form of a code: an HMAC keyed with the server's own secret over the link's token hash and the code.
 * The label keeps it apart from anything else that secret signs, and the token hash makes the same six digits hash
 * differently on every link.
 */
export function hashSignInCode(tokenHash: string, code: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(`sign-in-code:${tokenHash}:${code}`).digest('hex');
}

/** Compare a code with a stored hash in constant time. */
export function signInCodeMatches(tokenHash: string, code: string, storedHash: string): boolean {
  const given = Buffer.from(hashSignInCode(tokenHash, code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}
