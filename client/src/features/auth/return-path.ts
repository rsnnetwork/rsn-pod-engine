// The page a signed-out visit was going to, kept through sign-in (1 Nov 2026; 30 Oct review 5d). A member who opens a
// meeting link signed out is sent to sign in, and afterwards belongs on that meeting, not on Home, whether they sign in
// by Google (same tab: this tab's sessionStorage keeps it), by the code (same tab) or by the link (another tab or
// device: the server writes the path into the link). Only a path on this site is ever kept or followed: one leading
// slash, never two or a backslash (a browser reads those as another host), no control character, and not a sign-in
// page itself. The server applies the same rule (server/src/services/identity/return-path.ts). No imports and no
// browser globals, so the server's test suite can run it; this tab's copy lives in kept-return-path.ts.

const MAX_RETURN_PATH = 512;
const SIGN_IN_PAGES = /^\/(login|welcome|auth\/)/i;

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH) return null;
  if (!raw.startsWith('/') || raw[1] === '/' || raw[1] === '\\') return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (SIGN_IN_PAGES.test(raw)) return null;
  return raw;
}

/** Where a signed-out visit to `pathname` + `search` is sent: the sign-in page, carrying the page when it is not Home. */
export function signInPathFor(pathname: string, search: string): string {
  const back = safeReturnPath(`${pathname}${search}`);
  return back && back !== '/' ? `/login?redirect=${encodeURIComponent(back)}` : '/login';
}
