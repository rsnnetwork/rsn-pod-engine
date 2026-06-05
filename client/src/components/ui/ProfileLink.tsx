import { ReactNode } from 'react';

// WS2/S3 (27 May remaining work) — the ONE way to link a user's name or
// avatar to their profile from ANY surface. Always opens in a NEW TAB:
// inside a live event a same-tab navigation tears down the socket +
// LiveKit connection and ejects the user from the event (the original
// "clicking a chat name kicked me out" bug, Phase 0 a0070bd — this
// component generalizes that fix so no surface can regress it). Outside
// events the new tab is still the right behavior for a quick profile
// peek from a list.
//
// Do NOT hand-roll <a href="/profile/..."> or navigate('/profile/...')
// anywhere a display name renders — the live-event regression pin
// (ws2-profile-link-safety.test.ts) fails the build if one appears in
// features/live/.
export default function ProfileLink({ userId, className, children, title }: {
  userId: string;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <a
      href={`/profile/${userId}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
    >
      {children}
    </a>
  );
}
