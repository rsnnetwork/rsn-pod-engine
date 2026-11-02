// ─── Which call this tab rang, kept across a refresh of the tab (finding F3, 2 Nov 2026) ─────────────
//
// Only the tab that rang a call goes into the room when it is answered (call-signals.ts). The mark lives on the call
// in the store (RingingCall.placedHere); this keeps it for the tab's own refresh while the call rings, so a caller who
// reloads the page they rang from still goes in. sessionStorage belongs to one tab: another tab, or another device,
// reading the same call from the server finds nothing here and leaves the call as rung elsewhere.

const KEY = 'rsn:call:placed-here';

/** This tab has just rung this call. */
export function rememberPlacedHere(requestId: string): void {
  try {
    sessionStorage.setItem(KEY, requestId);
  } catch {
    // Storage refused (a private window, a full quota): the mark on the call in the store still holds until a refresh.
  }
}

/** Whether this tab rang this call (before a refresh of the tab). */
export function wasPlacedHere(requestId: string): boolean {
  try {
    return sessionStorage.getItem(KEY) === requestId;
  } catch {
    return false;
  }
}
