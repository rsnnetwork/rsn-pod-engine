// ─── A LinkedIn profile address, in the one form REASON stores (21 Oct 2026) ──────────────────────
//
// One rule for every place a person gives their LinkedIn profile: the request to join and onboarding v2,
// both checked on the server with this, so the two can never store the same profile differently. It has no
// imports, so a browser can run it as it is.
//
// The stored form is https://www.linkedin.com/in/<name>:
// - the name keeps the capitals it was written with (LinkedIn reads a name in any case, and every
//   comparison on the server goes through linkedinSlug(), which ignores case and encoding);
// - a letter outside A to Z is percent-encoded as UTF-8 with capital hex digits, which is what a browser
//   copies from its address bar, so the stored address is plain ASCII and safe as a link anywhere. However
//   the name was typed (as it reads, encoded, in lower-case hex, with its accents as separate marks), it is
//   stored the same way.
//
// Accepted: any linkedin.com/in/<name> form, with or without a protocol, www., another country's or the
// mobile subdomain, a trailing slash, a query, a fragment or a page under the profile. Refused: another
// site or a lookalike of LinkedIn's, a page that is not a person's (a company, a school), a port, a user
// name or password, any protocol but http and https, spaces, and a name LinkedIn could not have issued.
//
// The live request form (the main app until go-live) puts "https://linkedin.com/in/" in front of anything
// typed without http, so "linkedin.com/in/jane-doe" arrives as https://linkedin.com/in/linkedin.com/in/jane-doe.
// A name is never a LinkedIn address, so when the part after /in/ is one, the name is read after the /in/
// that follows it.

/** What a person is told when what they gave is not a LinkedIn profile address. */
export const LINKEDIN_PROFILE_HELP = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';

/** The most anyone may type into the box. */
const MAX_TYPED = 500;
const STARTS_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SCHEME_AND_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * A name LinkedIn could have issued, once read: 2 to 100 characters, a letter or a digit first, then
 * letters (with their marks), digits, underscores, dots and hyphens.
 */
const NAME_SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]{1,99}$/u;

/** linkedin.com itself or one of its own subdomains: www., a country (uk., de.), the mobile site (m.). */
function isLinkedinHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'linkedin.com' || h.endsWith('.linkedin.com');
}

/**
 * The name in a profile path, from its segments ("in", then the name). A name that is itself a LinkedIn
 * address is passed over, and the name is read after the "in" that follows it. Null when there is none.
 */
function profileName(segments: string[]): string | null {
  let rest = segments;
  while (rest[0]?.toLowerCase() === 'in') {
    let name: string;
    try {
      name = decodeURIComponent(rest[1] ?? '').normalize('NFC');
    } catch {
      return null;
    }
    if (!isLinkedinHost(name)) return NAME_SHAPE.test(name) ? name : null;
    rest = rest.slice(2);
  }
  return null;
}

/**
 * The profile address `typed` stands for, in the stored form https://www.linkedin.com/in/<name>, or null
 * when it is not a LinkedIn profile address.
 */
export function linkedinProfileUrl(typed: string | null | undefined): string | null {
  const text = (typed ?? '').trim();
  if (!text || text.length > MAX_TYPED || /\s/.test(text)) return null;

  const withScheme = STARTS_WITH_SCHEME.test(text) ? text : `https://${text}`;
  let address: URL;
  try {
    address = new URL(withScheme);
  } catch {
    return null;
  }
  if (address.protocol !== 'https:' && address.protocol !== 'http:') return null;
  // No user name, no password and no port, the https port written out included.
  const authority = withScheme.replace(SCHEME_AND_SLASHES, '').split(/[/?#]/, 1)[0];
  if (/[@:]/.test(authority)) return null;
  if (!isLinkedinHost(address.hostname)) return null;

  const name = profileName(address.pathname.split('/').slice(1));
  return name ? `https://www.linkedin.com/in/${encodeURIComponent(name)}` : null;
}
