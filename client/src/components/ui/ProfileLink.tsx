import { ReactNode } from 'react';
import { personHref, type KnownSource } from '@/features/reason/human/profile-text';

// WS2/S3 (27 May remaining work) — the ONE way to link a user's name or
// avatar to their profile from ANY surface. Always opens in a NEW TAB:
// inside a live event a same-tab navigation tears down the socket +
// LiveKit connection and ejects the user from the event (the original
// "clicking a chat name kicked me out" bug, Phase 0 a0070bd — this
// component generalizes that fix so no surface can regress it). Outside
// events the new tab is still the right behavior for a quick profile
// peek from a list.
//
// It opens the Human Profile, saying where it was opened from (final
// review, 21 Oct 2026); the old /profile/:id page is for admin links only.
//
// Do NOT hand-roll <a href="/people/..."> or navigate('/people/...')
// anywhere a display name renders — the live-event regression pin
// (ws2-profile-link-safety.test.ts) fails the build if one appears in
// features/live/.
export default function ProfileLink({ userId, from, className, children, title }: {
  userId: string;
  /** Where the profile is opened from: the Human Profile names it. */
  from: KnownSource;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <a
      href={personHref(userId, from)}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
    >
      {children}
    </a>
  );
}
