import * as Sentry from '@sentry/react';

// Tier-1 A9 — known-benign error patterns that are NOT our bugs but were
// generating alert noise (one mail per occurrence). All are user-environment
// or LiveKit SDK-internal races during rapid mobile room transitions and
// functionally recover on the next reconnect. We silence them in Sentry
// so real bugs don't get buried in the alert queue.
//
// If a real regression masquerades as one of these, we'll see it in the
// Render logs (server-side is not filtered) and user reports.
const BENIGN_ERROR_PATTERNS: RegExp[] = [
  /Network Error/i,
  // LiveKit track-publish race during room swap (RSN-CLIENT-2/3/4)
  /publishing rejected as engine not connected/i,
  // LiveKit transport abort during user-initiated disconnect (RSN-CLIENT-7)
  /AbortError:\s*The operation was aborted/i,
  // Camera / mic permission denied by user — UX signal, not a bug (RSN-CLIENT-5)
  /NotAllowedError:\s*Permission denied/i,
  // Browser-side camera failure (another app holding the device) — not our bug (RSN-CLIENT-6)
  /NotReadableError:\s*Could not start video source/i,
];

/** Preview builds (preview.rsn.network, Vercel branch aliases) report as "preview", not "production". */
function sentryEnvironment(): string {
  const host = typeof window === 'undefined' ? '' : window.location.hostname;
  if (host.startsWith('preview.') || host.includes('-git-')) return 'preview';
  return import.meta.env.MODE;
}

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: sentryEnvironment(),
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0,   // No session replays (saves quota)
    replaysOnErrorSampleRate: 0.5, // 50% of error sessions get replay
    beforeSend(event) {
      const message = event.exception?.values?.[0]?.value || event.message || '';
      if (!message) return event;
      for (const pattern of BENIGN_ERROR_PATTERNS) {
        if (pattern.test(message)) return null;
      }
      return event;
    },
  });
}

export { Sentry };
