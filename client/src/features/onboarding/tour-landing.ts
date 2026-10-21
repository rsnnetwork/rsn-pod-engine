// Where the tour leaves a member when it closes (final review, 21 Oct 2026). The tour opens over the page the flow
// put them on, and finishing it used to take them to For You from anywhere: an invited member who followed a link to
// an event never saw the event on a phone, and a finished member whose edit made the tour due was taken off the page
// they came back to.
//
// A page the flow opens itself carries LANDED in its history entry (flow.ts). Edit mode goes back through the
// browser's history, which can carry nothing, so that is remembered here instead: per member, for the visit (this
// tab, through a refresh). The tour reads it as it draws (its last button then says Done) and forgets it at the first
// press. Run by server/src/__tests__/client/onboarding-v2-flow.test.ts.

import { returnedKey } from './flow';

interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** This tab's sessionStorage, read through globalThis so a test can stand one in. Reading it can throw where it is blocked. */
const tab = (): TabStorage | undefined => (globalThis as { sessionStorage?: TabStorage }).sessionStorage;

/** Edit mode is sending this member back to the page they came from. */
export function markReturned(memberId: string | undefined): void {
  if (!memberId) return;
  try {
    tab()?.setItem(returnedKey(memberId), '1');
  } catch {
    // Storage switched off (a locked-down browser): the tour then takes them to For You, as it did before.
  }
}

/** Whether edit mode sent this member back. Reading it changes nothing. */
export function hasReturned(memberId: string | undefined): boolean {
  if (!memberId) return false;
  try {
    return tab()?.getItem(returnedKey(memberId)) === '1';
  } catch {
    return false;
  }
}

/** It counts for one tour: forgotten at that tour's first press. */
export function forgetReturned(memberId: string | undefined): void {
  if (!memberId) return;
  try {
    tab()?.removeItem(returnedKey(memberId));
  } catch {
    // Storage switched off: there is nothing to forget.
  }
}
