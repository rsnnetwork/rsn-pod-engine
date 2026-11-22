// ─── What the organiser's event settings say when a request fails (Part 2 Task 11) ──────────────────────────────────
// Pure (no axios, store or router), so server/src/__tests__/client/p2-organiser-settings.test.ts runs it. The server's
// refusals on these routes are written for organisers ("Admission can't change while the event is live."), so its
// sentence is shown when it is fit to show (short, no ids); anything else reads as the caller's fallback.
import { CONNECTION_LOST, firstDetail, gotNoAnswer, memberSentence } from '../reason/errors';

interface FailedRequest {
  response?: { status?: number; data?: { error?: { message?: unknown; details?: unknown } } };
}

const SLOW_DOWN = 'Slow down a moment, then try again.';

function statusOf(err: unknown): number | undefined {
  return (typeof err === 'object' && err !== null ? (err as FailedRequest).response?.status : undefined);
}

/** One sentence for a failed organiser request. */
export function organiserSentence(err: unknown, fallback: string): string {
  const response = (typeof err === 'object' && err !== null ? (err as FailedRequest).response : undefined);
  if (!response) return gotNoAnswer(err) ? CONNECTION_LOST : fallback;
  if (response.status === 429) return SLOW_DOWN;
  const error = response.data?.error;
  if (response.status === 400 && error?.details != null) return memberSentence(firstDetail(error.details)) ?? fallback;
  if (response.status !== undefined && response.status >= 400 && response.status < 500) {
    return memberSentence(error?.message) ?? fallback;
  }
  return fallback;
}

/**
 * A read refused as "not for you" (403) or "no such thing" (404): the card is for someone else, or the route it reads
 * is not on this server yet, so the card draws nothing rather than an error.
 */
export function notForThisViewer(err: unknown): boolean {
  const status = statusOf(err);
  return status === 403 || status === 404;
}
