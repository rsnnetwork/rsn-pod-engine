// client/src/lib/tab-title.ts
// The browser tab's title (30 Oct 2026 review, item 4.4, L8): Stefan, "no count in the browser tab (like Messenger shows
// '(1)')". Pure on purpose, so a test can run it: server/src/__tests__/client/t6-messaging.test.ts.

/** The product's name, as index.html titles the page. */
export const APP_TITLE = 'REASON';

/** "(3) REASON" while there are unread messages, "REASON" when there are none (or nobody is signed in). */
export function tabTitle(unread: number): string {
  return unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${APP_TITLE}` : APP_TITLE;
}
