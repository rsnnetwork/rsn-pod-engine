// client/src/features/profile/linkedin-box.ts
// The profile form's LinkedIn box (fix round 1, 21 Oct 2026). The form used to show the stored address with only its
// https://www.linkedin.com/in/ prefix taken off, and to check the box on every save. So a stored share link from
// LinkedIn's phone app (…/in/jane?utm_source=share&utm_medium=ios_app), …/in/stefan/?originalSubdomain=de, a #section or
// a page under the profile filled the box with something that is not a name, and every save was refused until the
// member edited a field they never touched.
//
// Now the box shows the name for any stored LinkedIn profile link, and a save checks and sends the box only when the
// member changed it, so an address they did not touch never blocks a save and is never rewritten.
//
// Pure on purpose (no React, axios, store or router), so a test can run it: server/src/__tests__/client/reason-your-profile.test.ts.
import { normalizeLinkedinInput } from '../auth/linkedin-link';
import { linkedinLink } from '../reason/human/profile-text';

const STORED_PREFIX = 'https://www.linkedin.com/in/';

/**
 * What the box shows for the stored address: the name, when the address is a LinkedIn profile link that opens (in any
 * form: a share query, a #section, a page under the profile); anything else as it is stored (an http address, text that
 * is no link), so the member sees what needs putting right. The box puts "linkedin.com/in/" in front of it.
 */
export function linkedinBoxValue(stored: string | null | undefined): string {
  const text = (stored ?? '').trim();
  const clean = linkedinLink(text) ? normalizeLinkedinInput(text) : null;
  return clean ? clean.slice(STORED_PREFIX.length) : text;
}

/** What a save does with the LinkedIn box. */
export type LinkedinSave =
  /** Send nothing: the stored address stays exactly as it is. */
  | { kind: 'keep' }
  /** Send this: the clean address, or '' for an emptied box. */
  | { kind: 'send'; url: string }
  /** Not a profile link: say so under the field and save nothing. */
  | { kind: 'refuse' };

/** Only a box the member changed is checked and sent. */
export function linkedinSave(typed: string, changed: boolean): LinkedinSave {
  if (!changed) return { kind: 'keep' };
  const url = normalizeLinkedinInput(typed);
  return url === null ? { kind: 'refuse' } : { kind: 'send', url };
}
