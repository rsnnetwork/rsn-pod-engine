// e2e/helpers/profile-link.ts
// A member's profile link, on either of the app's two clients. The live app opens the old /profile/:id page; the REASON
// preview opens the Human Profile, /people/:id?from=<where it was opened> (final review, 21 Oct 2026). A spec that walks
// a surface both clients have accepts either, so it holds on the live app and on the preview.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A CSS selector for the link to `userId`'s profile, opened from `from` on the preview. */
export const profileLinkSelector = (userId: string, from: string): string =>
  `a[href="/profile/${userId}"], a[href="/people/${userId}?from=${encodeURIComponent(from)}"]`;

/** The whole href of that link. */
export const profileHref = (userId: string, from: string): RegExp =>
  new RegExp(`^/(?:profile/${escape(userId)}|people/${escape(userId)}\\?from=${escape(encodeURIComponent(from))})$`);

/** The address of a tab that link opened. */
export const profilePage = (userId: string): RegExp => new RegExp(`/(?:profile|people)/${escape(userId)}(?:[?#]|$)`);
