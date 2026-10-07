// ─── Where the links an applicant receives open (7 Oct 2026) ─────────────────
//
// A join request remembers the site it was made on (join_requests.sign_in_origin), so the
// approval email and the reminders open the preview for someone who asked on the preview,
// and the app for someone who asked on the app. The sites are the exact allow-list in
// client-origin.ts, the same one the email-link sign-in uses.
//
// Two rules carry the safety. The Origin header is the caller's to forge, so only one of
// OUR sites that is not the main app is ever stored. And the stored value is checked again
// when a link is built, so a value that is no longer ours (or never was) can only give the
// main app, never a link, with a live sign-in token in it, to another site.
//
// Links for ADMINS (the review dashboard, the approve and reject buttons) are not built
// here: they stay on CLIENT_URL.

import config from '../../config';
import { resolveClientBaseUrl } from '../identity/client-origin';

const ourSites = () => ({ clientUrl: config.clientUrl, isDev: config.isDev });

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The site to remember for a request made from `requestOrigin` (the Origin header): one of our
 * sites other than the main app, or null. Null already means "the main app", so the live app
 * stores nothing, and a request from anywhere that is not ours is treated as no request origin.
 */
export function signInOriginFor(requestOrigin: string | undefined): string | null {
  if (!requestOrigin) return null;
  // Anything that is not ours resolves to the main app, which is then null here too.
  const site = originOf(resolveClientBaseUrl(requestOrigin, ourSites()));
  return site && site !== originOf(config.clientUrl) ? site : null;
}

/**
 * The site an applicant's own links open on: where they asked from, if that is still one of
 * ours, else the main app exactly as configured. `request` is a join_requests row.
 */
export function applicantBaseUrl(request: { sign_in_origin?: string | null }): string {
  if (!request.sign_in_origin) return config.clientUrl;
  return resolveClientBaseUrl(request.sign_in_origin, ourSites());
}
