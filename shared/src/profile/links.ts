// ─── The links on a member's profile, beside LinkedIn (10 Nov 2026) ──────────────────────────────────────
//
// Website, Instagram, X and Facebook: one rule for what a member may type and what is stored, run by the
// edit form (so a wrong address is said next to the box) and by the server (which never trusts the form).
// It has no imports, so a browser can run it as it is.
//
// Stored form: an https (or http) address. Typed without a scheme, "example.com" becomes "https://example.com".
// Refused: any other scheme (javascript:, data:, mailto:), spaces, a name or password in the address, an address
// with no real host, anything over 300 characters, and for Instagram, X and Facebook an address on any other site
// (so "evil.com/instagram.com" is not an Instagram link).

export type ProfileLinkKind = 'website' | 'instagram' | 'x' | 'facebook';

/** The most a stored link may hold; the database checks the same number. */
export const PROFILE_LINK_MAX = 300;

/** What a member is told when an address is not one we can show. */
export const PROFILE_LINK_HELP: Record<ProfileLinkKind, string> = {
  website: 'Enter a web address, for example example.com',
  instagram: 'Enter your Instagram link, for example instagram.com/your-name',
  x: 'Enter your X link, for example x.com/your-name',
  facebook: 'Enter your Facebook link, for example facebook.com/your-name',
};

const PLATFORM_HOSTS: Record<Exclude<ProfileLinkKind, 'website'>, readonly string[]> = {
  instagram: ['instagram.com'],
  x: ['x.com', 'twitter.com'],
  facebook: ['facebook.com', 'fb.com'],
};

// "javascript:alert(1)" has a scheme with no slashes; "example.com:8080/x" has a port, so a digit follows the colon.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

export type ProfileLinkResult = { ok: true; url: string | null } | { ok: false };

/** Reads what was typed: blank is fine (no link), a good address is returned in its stored form, anything else is refused. */
export function parseProfileUrl(kind: ProfileLinkKind, raw: string | null | undefined): ProfileLinkResult {
  const typed = (raw ?? '').trim();
  if (!typed) return { ok: true, url: null };
  if (typed.length > PROFILE_LINK_MAX || /\s/.test(typed) || typed.startsWith('/')) return { ok: false };
  let address: URL;
  try {
    address = new URL(HAS_SCHEME.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { ok: false };
  }
  if (address.protocol !== 'https:' && address.protocol !== 'http:') return { ok: false };
  if (address.username || address.password) return { ok: false };
  const host = address.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return { ok: false };
  if (kind !== 'website') {
    const bare = host.replace(/^(www|m)\./, '');
    if (!PLATFORM_HOSTS[kind].includes(bare)) return { ok: false };
  }
  const bareAddress = address.pathname === '/' && !address.search && !address.hash;
  const url = bareAddress ? `${address.protocol}//${address.host}` : address.href;
  return url.length > PROFILE_LINK_MAX ? { ok: false } : { ok: true, url };
}

/** The stored form of what was typed, or null when it is blank or refused (parseProfileUrl tells the two apart). */
export function normaliseProfileUrl(kind: ProfileLinkKind, raw: string): string | null {
  const result = parseProfileUrl(kind, raw);
  return result.ok ? result.url : null;
}
