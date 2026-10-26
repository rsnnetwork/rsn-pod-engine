// ─── Where a profile's Back goes (26 Oct 2026) ───────────────────────────────────────────────────
//
// A profile can be the first page this app ever shows in a tab: a link opened from a live event, a link in an email,
// an address pasted into a tab. Its Back used to do nothing, or take the member off the site. So Back steps back only
// when an earlier page of THIS app is behind it, and otherwise goes to the dashboard.
//
// "Is there an earlier page of this app?" is read from the router's own count. React Router keeps, in each history
// entry's state, `idx`: how many pages of the app were opened in this tab since the document loaded, 0 for the first.
// It survives a reload (the entry's state does), and it is not fooled by what the browser's own history holds:
//   - a tab that already showed another site has earlier entries, but none of them is this app's (history.length);
//   - a page the app reached by replacing the first has a router key, but nothing to step back to (the key);
//   - going Back to the first page after the member went on from it is idx 0 again, so Back does not do nothing.
// Every profile link inside the app is a router link now, never a plain anchor that reloads the page (which would
// start the count again at 0 while the tab has history), so a member who came from a page of the app is idx 1 or more.
//
// Only a whole number is the router's count. An entry whose state was replaced behind the router's back (with a state of
// its own, so no idx) leaves every page opened after it counted on from nothing: idx NaN, which is a number, and
// NaN > 0 is false, so such a profile's Back went to the dashboard with a page of the app behind it. A count that is not
// a whole number says nothing, and the router's key decides.

/**
 * Whether there is an earlier page of this app to go back to. `historyState` is `window.history.state`. The router's
 * location key answers when there is no usable count: a future router that stops keeping `idx`, or an entry whose
 * state lost it.
 */
export function hasEarlierAppPage(historyState: unknown, locationKey: string): boolean {
  const idx = (historyState as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && Number.isInteger(idx) ? idx > 0 : locationKey !== 'default';
}
