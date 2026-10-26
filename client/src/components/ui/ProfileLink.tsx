import { ReactNode } from 'react';
import { Link } from 'react-router-dom';

// WS2/S3 (27 May remaining work) — the ONE way to link a user's name or
// avatar to their profile from ANY surface.
//
// Inside a live event a same-tab navigation tears down the socket + LiveKit
// connection and ejects the user from the event (the original "clicking a chat
// name kicked me out" bug, Phase 0 a0070bd — this component generalizes that
// fix so no surface can regress it). Every link in features/live therefore
// passes `newTab`, and the live-event regression pin
// (ws2-profile-link-safety.test.ts) fails the build if one does not.
//
// 25 Oct 2026 (Stefan and Claus on production): everywhere else the profile now
// opens in the SAME tab. "View full profile" on a meeting request opened a new
// tab where Back did nothing, because a new tab has no history behind it; in
// the same tab Back returns to the request. A `newTab` link says so, with an
// arrow for the eye and "(opens in a new tab)" for a screen reader.
//
// Do NOT hand-roll <a href="/profile/..."> or navigate('/profile/...')
// anywhere a display name renders in features/live/ — the pin fails the build.
export default function ProfileLink({ userId, className, children, title, newTab = false }: {
  userId: string;
  className?: string;
  children: ReactNode;
  title?: string;
  /** Inside a live event only: a same-tab move there would drop the call. Opens a new tab, and says so. */
  newTab?: boolean;
}) {
  const href = `/profile/${userId}`;

  if (!newTab) {
    return (
      <Link to={href} className={className} title={title}>
        {children}
      </Link>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
    >
      {children}
      {/* Its own colour: the page's default text is near-white, and this sits on light and dark surfaces alike. */}
      <span aria-hidden="true" className="ml-1 shrink-0 text-gray-500">↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
