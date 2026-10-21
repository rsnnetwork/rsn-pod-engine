// ─── The LinkedIn address on a join request (21 Oct 2026) ────────────────────
//
// LinkedIn is optional on the request form ("Recommend LinkedIn, but let people add it later"). When an
// address IS given it must be a LinkedIn profile, linkedin.com/in/<name>, and it is stored in one shape,
// https://www.linkedin.com/in/<name>, however it was typed: with or without www., http or https, a trailing
// slash, a query string, another country's subdomain (uk.linkedin.com), a page under the profile.
//
// It is checked strictly, and rebuilt from the name alone, because admins see it as a link in the queue and
// in the approval email: a stored address can never take them to another site, and nothing but the name
// the person gave is ever kept from what they typed. (The check used to be "is it a URL at all", which
// also let "javascript:" addresses through.)
//
// enrichment.service.ts has a normaliser of its own, normalizeLinkedinUrl. It is deliberately lenient (it
// hands back what it was given when it cannot read it) because it prepares an address for a lookup. This
// one is the opposite: it answers null for anything that is not a LinkedIn profile.
//
// The request form runs the same rules in the browser (client/src/features/auth/linkedin-link.ts) so a
// mistake is shown next to the box. They are separate files, because the client does not import from the
// server, and one test (server/src/__tests__/client/join-form-linkedin.test.ts) runs both over the same
// addresses so they cannot drift apart.

/** What the person is told when what they gave is not a LinkedIn profile address. */
export const LINKEDIN_PROFILE_HELP = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** The /in/<name> at the start of the path. Whatever follows the name (a slash, a page under the profile) is dropped. */
const PROFILE_PATH = /^\/in\/([^/]+)/i;
/** What a profile name holds once the address has been read: letters outside A to Z arrive percent-encoded. */
const NAME_CHARACTERS = /^[A-Za-z0-9._%-]+$/;
const HAS_LETTER_OR_DIGIT = /[A-Za-z0-9]/;

/**
 * The profile address `input` stands for, as https://www.linkedin.com/in/<name>, or null when it is not a
 * LinkedIn profile address. The name keeps the capitals it was written with. Nothing is cut or changed
 * beyond that: a name with a character LinkedIn names never hold is refused, not repaired.
 */
export function canonicalLinkedinProfileUrl(input: string): string | null {
  const typed = input.trim();
  if (!typed || /\s/.test(typed)) return null;

  let address: URL;
  try {
    address = new URL(HAS_SCHEME.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if (address.protocol !== 'https:' && address.protocol !== 'http:') return null;

  const host = address.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const name = PROFILE_PATH.exec(address.pathname)?.[1];
  if (!name || !NAME_CHARACTERS.test(name) || !HAS_LETTER_OR_DIGIT.test(name)) return null;

  return `https://www.linkedin.com/in/${name}`;
}
