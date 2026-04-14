import * as Sentry from '@sentry/react';

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0,   // No session replays (saves quota)
    replaysOnErrorSampleRate: 0.5, // 50% of error sessions get replay
    beforeSend(event) {
      // Filter out network errors that aren't actionable
      if (event.exception?.values?.[0]?.value?.includes('Network Error')) return null;
      return event;
    },
  });
}

export { Sentry };
