// ─── Who a broadcast skips ───────────────────────────────────────────────────
//
// One rule, read by the plan that makes a job (post-event-message.service.ts) and by the worker that
// sends it (post-event-message.worker.ts), so the two can never disagree about who is left out. It sits
// in a module of its own, with no imports, so the worker does not have to load the session service to
// read three lines.

/**
 * Why a person is not messaged: someone blocked the other, the account is closed, or it is an event guest's (Part 2,
 * Task 3, fix round 1: messages are for members, so a guest who came to the event gets no thread and no email).
 */
export type RecipientSkipReason = 'blocked' | 'inactive' | 'event_guest';

export interface SkipCandidate {
  /** users.status of the person, as of the read. */
  account_status: string;
  /** users.account_kind of the person, as of the read: only 'member' is messaged. */
  account_kind: string;
  /** Whether either person has blocked the other, as of the read. */
  blocked: boolean;
}

/**
 * A closed, suspended or banned account has no one to message; an account that is not a member's (an event guest)
 * is not messaged either; a block in either direction is a refusal.
 */
export function skipReasonFor(person: SkipCandidate): RecipientSkipReason | null {
  if (person.account_status !== 'active') return 'inactive';
  if (person.account_kind !== 'member') return 'event_guest';
  if (person.blocked) return 'blocked';
  return null;
}
