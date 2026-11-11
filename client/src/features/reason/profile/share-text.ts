// client/src/features/reason/profile/share-text.ts
// Sharing your profile (Shirley pilot S6, RSN 12): the two links and what the screens say about them. Pure on purpose
// (no React, axios, store or router), so a test can run it: server/src/__tests__/client/shirley-s6-profiles.test.ts.

/** Your member link: opens your Human Profile for a member who is signed in, and never for anyone else. */
export const memberLinkFor = (origin: string, userId: string): string => `${origin}/people/${encodeURIComponent(userId)}`;

/** Your public link, from the path the server gives (`/p/<token>`). */
export const publicLinkFor = (origin: string, path: string): string => `${origin}${path}`;

export const PREVIEW_TO = '/profile/preview';

export const SHARE_WORDS = {
  memberCopied: 'Link copied. Members who are signed in can open it.',
  publicCopied: 'Public link copied. Anyone with it can see your public card.',
  copyFailed: 'Could not copy the link on this device. Try again, or press and hold the link to copy it.',
  made: 'Your public link is on. Copy it to share.',
  remade: 'You have a new public link. The old one no longer works.',
  revoked: 'Your public link is off. Nobody can open it any more.',
  // The consent line under the public link: what it shows, to whom, and what it never shows.
  consent: 'Anyone with this link can see your public card: your name, photo, banner, role, company, bio, links and what '
    + 'you can bring, even people who are not on REASON. It never shows your answers, your email, your communities or a way '
    + 'to contact you. Turn it off or make a new link at any time.',
  paused: 'Your public link is paused while your profile is hidden from search. Show your profile in search again in '
    + 'Settings, or turn the link off.',
  revokeTitle: 'Turn off your public link?',
  revokeBody: 'Anyone who has it, and every place you shared it, will no longer be able to open your profile.',
  remakeTitle: 'Make a new public link?',
  remakeBody: 'The link you have now stops working at once, everywhere you shared it.',
} as const;
