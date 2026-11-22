// The note a meeting request starts with (field test, 13 Nov 2026: "improve the default message"). It greets the
// person by their first name, so a request sent as it is still reads like one person writing to another.
import { NO_NAME } from '../person';

/**
 * The first word of a display name, or null when there is none to greet: no name, only spaces, or the "Member"
 * that a page shows in place of a missing name (personName).
 */
export function firstNameOf(displayName: string | null | undefined): string | null {
  const name = (displayName ?? '').trim();
  if (!name || name === NO_NAME) return null;
  return name.split(/\s+/)[0];
}

export function defaultMeetNote(displayName: string | null | undefined): string {
  const first = firstNameOf(displayName);
  return `${first ? `Hi ${first}` : 'Hi'}, I think we have a good reason to talk. Would you be up for a short call to compare notes?`;
}

// ─── The member's own standard message (Stefan, 21 Nov 2026) ──────────────────────────────────────────────────────
// "I should be able in my profile to state my 'standard message' and preferred format". The member saves a note on
// Edit profile; {first} in it is where the person's first name goes. Written as the member may type it: {First} and
// { first } count too.

/** The word a member writes where the person's first name should go. */
export const FIRST_NAME_TOKEN = '{first}';
const TOKEN = /\{\s*first\s*\}/gi;
// The token straight after a word ("Hi {first},"), with the spaces before it: dropped whole when there is no name, so
// the note reads "Hi," as REASON's own does.
const AFTER_A_WORD = /(\S)[ \t]+\{\s*first\s*\}/gi;

/** REASON's own note written with the token: what the profile form shows as an example of the token at work. */
export const MEET_NOTE_EXAMPLE = defaultMeetNote(FIRST_NAME_TOKEN);

/**
 * The note with every {first} turned into the person's first name. With no name to greet, a token after a word goes
 * with its spaces ("Hi {first}," reads "Hi,") and any other becomes "there". Nothing that is sent ever holds {first}.
 */
export function fillFirstName(note: string, displayName: string | null | undefined): string {
  const first = firstNameOf(displayName);
  if (first) return note.replace(TOKEN, () => first);
  return note.replace(AFTER_A_WORD, '$1').replace(TOKEN, 'there');
}

/** What the Meet sheet opens on: the member's saved note made out to this person, or REASON's own when none is saved. */
export function startingMeetNote(saved: string | null | undefined, displayName: string | null | undefined): string {
  const own = (saved ?? '').trim();
  return own ? fillFirstName(own, displayName) : defaultMeetNote(displayName);
}
