// client/src/components/calendar/invite-words.ts
// What a booking says about the calendar invitation (11 Nov 2026, Shirley Palmer's RSN 09: "Add to calendar" opened an
// Outlook sign-in after the invitation had already been emailed, and she lost her place). The rule: "Meeting booked.
// Calendar invitation sent by email." only when the server's sent-invitation log says it went; otherwise a sentence
// that is true. Adding it by hand is a secondary "Add manually", whose menu starts with the calendar file (no sign-in)
// and says which choices open another site and may ask to sign in. Pure on purpose (no React), so a test reads the
// exact sentences: server/src/__tests__/client/shirley-s5-safety-calls.test.ts.
import type { InviteEmailState } from '@rsn/shared';

export const ADD_MANUALLY = 'Add manually';
export const ADD_TO_CALENDAR = 'Add to calendar';

/** Where the sentence is read: in a toast, or on a card whose Add manually button sits below it. */
export type InviteWhere = 'toast' | 'card';

/** The invitation went, or is on its way: adding it by hand is optional and may duplicate it. */
export const inviteEmailed = (state: InviteEmailState | null | undefined): boolean => state === 'sent' || state === 'sending';

/** The second half of the booking sentence: what happened to this person's invitation. Null when nothing is known. */
export function inviteLine(state: InviteEmailState | null | undefined, moved: boolean, where: InviteWhere): string | null {
  const invitation = moved ? 'updated invitation' : 'calendar invitation';
  const addIt = where === 'card' ? 'add it manually below' : 'you can add it manually';
  switch (state) {
    case 'sent': return moved ? 'Updated invitation sent by email.' : 'Calendar invitation sent by email.';
    case 'sending': return `We're emailing the ${invitation} now.`;
    case 'not_sent': return `We couldn't email the ${invitation}; ${addIt}.`;
    case 'no_address': return `We have no email address for you, so ${addIt}.`;
    default: return null;
  }
}

/** "Meeting booked. Calendar invitation sent by email.", or what is true instead. */
export function bookedSentence(state: InviteEmailState | null | undefined, moved: boolean, where: InviteWhere = 'toast'): string {
  const head = moved ? 'Meeting moved.' : 'Meeting booked.';
  const line = inviteLine(state, moved, where);
  return line ? `${head} ${line}` : head;
}

export const ICS_OPTION = 'Download calendar file (.ics)';
export const icsNote = (emailed: boolean): string =>
  emailed ? 'Updates the emailed invitation. No sign-in.' : 'Works with Apple, Google and Outlook calendars. No sign-in.';
export const GOOGLE_NOTE = 'Opens Google in a new tab. May ask you to sign in.';
export const OUTLOOK_NOTE = 'Opens Microsoft in a new tab. May ask you to sign in.';
export const EMAILED_NOTE = 'You already have this in your email. Adding it here may create a second entry.';
export const NOT_EMAILED_NOTE = 'The calendar file needs no sign-in.';
