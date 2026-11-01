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

/** Under the refusal when the server gives no reason of its own to show. */
export const REFUSED_DETAIL = 'If you think this is a mistake, ask the person who runs the event.';

/** The event's own access refusals (T11), whose server sentences say why and are written for the person. */
const SAID_AS_IS = new Set(['EVENT_PRIVATE', 'EVENT_NEEDS_APPROVAL']);

/**
 * What the final screen says under "This event is not open to you." (P1 item 9): a private event or one whose places
 * the host approves says why, in the server's words, and the latter points to the event page where the request is made.
 * Any other refusal keeps the plain line: never a code, never another raw server text.
 */
export function refusalOf(err: unknown): { detail: string; requestOnEventPage: boolean } {
  const error = (err as { response?: { data?: { error?: { code?: string; message?: string } } } } | undefined)?.response?.data?.error;
  const message = error?.message?.trim();
  if (!error?.code || !SAID_AS_IS.has(error.code) || !message) return { detail: REFUSED_DETAIL, requestOnEventPage: false };
  return { detail: message, requestOnEventPage: error.code === 'EVENT_NEEDS_APPROVAL' };
}
