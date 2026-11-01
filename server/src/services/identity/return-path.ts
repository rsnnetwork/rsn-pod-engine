// ─── The page a member was going to, kept through sign-in (1 Nov 2026) ──────
//
// A signed-out member who follows a meeting link is sent to sign in; afterwards they belong on that meeting, not
// on Home. The sign-in page sends the path it was asked to return to, and the emailed link carries it to the verify
// page, which may open in another tab or on another device. Only a path on the same site is ever carried: it
// starts with one slash, never two or a backslash (which a browser reads as another host), holds no control
// character, and is not a sign-in page itself. Anything else is left out, and the member lands on Home as before.

const MAX_RETURN_PATH = 512;
const SIGN_IN_PAGES = /^\/(login|welcome|auth\/)/i;

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH) return null;
  if (!raw.startsWith('/') || raw[1] === '/' || raw[1] === '\\') return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (SIGN_IN_PAGES.test(raw)) return null;
  return raw;
}
