// Small pure helpers for showing a person on a REASON screen. No axios, store or router, so a test can run
// them: server/src/__tests__/client/reason-m1-data-layer.test.ts.
import type { RelationshipState } from '@rsn/shared';

/** Where a meeting request between the member and a person stands, as the For You list reports it. */
export type PokeStatus = 'pending' | 'accepted' | null;

// What the rest of the app already calls a member who has no name to show (Matches, circles, pods, invites).
const NO_NAME = 'Member';

/** The text of an optional field, or null when it is empty or only spaces. */
export function visibleText(text: string | null | undefined): string | null {
  return text?.trim() || null;
}

/** The server types a name as nullable; a page shows this rather than a blank heading. */
export function personName(name: string | null | undefined): string {
  return visibleText(name) ?? NO_NAME;
}

export function stateFromPoke(status: PokeStatus, sentByOwner: boolean | null): RelationshipState {
  if (status === 'accepted') return 'connected';
  if (status === 'pending') return sentByOwner ? 'requested' : 'incoming';
  return 'none';
}
