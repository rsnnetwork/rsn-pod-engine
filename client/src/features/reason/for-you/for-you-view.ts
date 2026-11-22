// client/src/features/reason/for-you/for-you-view.ts
// Small pure rules For You draws by (22 Nov 2026). No React, axios or store behind them, so a test can run them:
// server/src/__tests__/client/for-you-waiting.test.ts.
import type { WaitingRequest } from '../api';

/** How many of the member's waiting requests the row names before "and n more". */
export const WAITING_SHOWN = 6;

/** The first WAITING_SHOWN waiting requests, and how many more there are (the count can exceed the list sent). */
export function waitingRow(waiting: WaitingRequest[] | undefined, waitingCount: number | undefined): { shown: WaitingRequest[]; more: number } {
  const list = waiting ?? [];
  const shown = list.slice(0, WAITING_SHOWN);
  return { shown, more: Math.max(0, (waitingCount ?? list.length) - shown.length) };
}

/**
 * The person a Meet sheet request is for, read off the mutation's variables, or null for any other mutation.
 * MeetSheet.tsx sends { userId, displayName, note, format } (its MeetRequest); the Meet sheet has no mutation key,
 * so the shape is what tells its requests apart.
 */
export function meetRequestUserId(variables: unknown): string | null {
  if (!variables || typeof variables !== 'object') return null;
  const v = variables as Record<string, unknown>;
  return typeof v.userId === 'string' && typeof v.note === 'string' && typeof v.format === 'string' ? v.userId : null;
}

/**
 * The people asked since the list on screen was fetched. A request the member sends takes the person off the
 * suggestions into "Waiting for their answer", but only once the list is fetched again; until then their card says
 * "Request sent", so the press is never followed by a card that still offers Meet.
 */
export function askedSinceFetch(asked: Array<{ userId: string | null; submittedAt: number }>, dataUpdatedAt: number): Set<string> {
  return new Set(asked.filter((a) => a.userId && a.submittedAt > dataUpdatedAt).map((a) => a.userId as string));
}
