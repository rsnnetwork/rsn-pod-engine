// ─── What the event guard does with a failed read of the event ──────────────────────────────────────

export const RETRY_DELAYS_MS = [1000, 2000, 4000]; // 3 retries with backoff

/** Said to a person the event is closed to; final, so it never follows a "Reconnecting" screen. */
export const REFUSED_SENTENCE = 'This event is not open to you.';
export const UNREACHABLE_SENTENCE = "We couldn't reach this event. Check your connection and try again.";

export type GuardFailure = 'refused' | 'retry' | 'gone' | 'error';

/**
 * A 403 is the server's answer, not a hiccup: there is nothing to retry. A 404 or a network error is retried
 * with backoff (the event may still be starting); once the retries are spent a 404 is "gone", anything else "error".
 */
export function classifyGuardFailure(status: number | undefined, attempt: number): GuardFailure {
  if (status === 403) return 'refused';
  if (attempt < RETRY_DELAYS_MS.length) return 'retry';
  return status === 404 ? 'gone' : 'error';
}
