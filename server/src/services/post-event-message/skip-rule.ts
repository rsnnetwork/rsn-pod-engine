// ─── Who a broadcast skips ───────────────────────────────────────────────────
//
// One rule, read by the plan that makes a job (post-event-message.service.ts) and by the worker that
// sends it (post-event-message.worker.ts), so the two can never disagree about who is left out. It sits
// in a module of its own, with no imports, so the worker does not have to load the session service to
// read three lines.

/** Why a person is not messaged: someone blocked the other, or the account is closed. */
export type RecipientSkipReason = 'blocked' | 'inactive';

export interface SkipCandidate {
  /** users.status of the person, as of the read. */
  account_status: string;
  /** Whether either person has blocked the other, as of the read. */
  blocked: boolean;
}

/** A closed, suspended or banned account has no one to message; a block in either direction is a refusal. */
export function skipReasonFor(person: SkipCandidate): RecipientSkipReason | null {
  if (person.account_status !== 'active') return 'inactive';
  if (person.blocked) return 'blocked';
  return null;
}
