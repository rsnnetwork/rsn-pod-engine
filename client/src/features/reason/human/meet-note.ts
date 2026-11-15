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
