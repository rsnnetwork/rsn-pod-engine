// What a person types into the request form's LinkedIn box, turned into the one address the server stores:
// https://www.linkedin.com/in/<name>. LinkedIn is optional, so an empty box is fine and sends nothing.
//
// The box shows "linkedin.com/in/" in front of the field, so people type a name, paste the whole address, or
// something in between ("linkedin.com/in/jane-doe/", "www.linkedin.com/in/jane-doe", an address with a share
// query on it from the phone app). All of them come out the same. The old clean-up put
// "https://linkedin.com/in/" in front of anything that did not start with http, so a half-typed address came out
// as "https://linkedin.com/in/linkedin.com/in/jane-doe" and the form called it valid.
//
// Pure on purpose (no React, no imports), so the tests run the code that ships:
// server/src/__tests__/client/join-form-linkedin.test.ts. The server checks the same rules again on its own
// (server/src/services/join-request/linkedin-profile-url.ts); that test runs both over the same addresses.

/** What the person is told when what they typed is not a LinkedIn profile. The server says the same sentence. */
export const LINKEDIN_LINK_HELP = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PROFILE_PATH = /^\/in\/([^/]+)/i;
const NAME_CHARACTERS = /^[A-Za-z0-9._%-]+$/;
const HAS_LETTER_OR_DIGIT = /[A-Za-z0-9]/;
/** A name on its own: no address in it, no spaces, and no dot (a dot means a web address, not a name). */
const BARE_NAME = /^[^\s/\\?#@:.]+$/;

/** The address `typed` stands for, as https://www.linkedin.com/in/<name>, or null when it is not a LinkedIn profile. */
function profileAddress(typed: string): string | null {
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

/**
 * The address to send for what was typed into the box: '' when the box is empty (the form then sends no address
 * at all), the clean address when it is a LinkedIn profile, or null when it is not (the form shows
 * LINKEDIN_LINK_HELP). A bare name ("jane-doe", "@jane-doe", "in/jane-doe") is taken as the name in
 * linkedin.com/in/<name>.
 */
export function normalizeLinkedinInput(typed: string): string | null {
  const text = typed.trim();
  if (!text) return '';

  const withoutPrefix = text.replace(/^@/, '').replace(/^\/?in\//i, '').replace(/\/+$/, '');
  if (BARE_NAME.test(withoutPrefix)) return profileAddress(`https://www.linkedin.com/in/${withoutPrefix}`);

  return profileAddress(text);
}
