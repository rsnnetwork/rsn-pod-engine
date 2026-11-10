// ─── Which events an event guest may take a place in (Part 2, Task 3, fix round 1, 10 Nov 2026) ────────────
//
// An event guest (users.account_kind = 'event_guest') came in through one event's link. Until admission (Task 4)
// and the RSN Call link entry (Task 6) give them their own entitlements, a guest may register for, or come back
// to, only:
//   a) an event where they already hold a participant row (any status: a removal is still decided afterwards by
//      registerParticipant's own row checks, so a removed guest stays out), or
//   b) the event they came in through (users.guest_first_session_id).
// Everything else is refused with GUEST_MEMBERSHIP_REQUIRED. registerParticipant asks this first, so every way in
// is covered: the REST register, the live join's auto-register (socket session:join), an invite accept and an
// approved request. A guest never becomes a pod member through a registration (registerParticipant skips the public
// pod's auto-add for them, and pod.service addMember refuses them).
//
// Task 4/6 extend guestMayRegister (keep its name and its facts-in, boolean-out shape).

import { ErrorCodes } from '@rsn/shared';
import { readAccountGate } from '../../middleware/auth';
import { AppError } from '../../middleware/errors';
import { accountKindUnavailable } from '../../middleware/guest-scope';

/** Runs one statement: the transaction's client, or the pool. */
export type GuestRegistrationQuery = (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** What a guest's registration is decided on. */
export interface GuestRegistrationFacts {
  /** The event being registered for. */
  sessionId: string;
  /** users.guest_first_session_id: the event the guest came in through (null once that event is deleted). */
  guestFirstSessionId: string | null;
  /** Whether the guest already holds a session_participants row for this event, whatever its status. */
  holdsPlace: boolean;
}

/** What a guest who may not register here is told. */
export const GUEST_REGISTRATION_MESSAGE =
  'This event is for members. As a guest you can take part in the event you were invited to.';

/** Whether an event guest may take, or take back, a place in this event. */
export function guestMayRegister(facts: GuestRegistrationFacts): boolean {
  if (facts.holdsPlace) return true;
  return facts.guestFirstSessionId !== null && facts.guestFirstSessionId === facts.sessionId;
}

/** The facts for guestMayRegister, in one read. */
export async function readGuestRegistrationFacts(
  run: GuestRegistrationQuery,
  sessionId: string,
  userId: string,
): Promise<GuestRegistrationFacts> {
  const r = await run(
    `SELECT u.guest_first_session_id,
            EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = $1 AND sp.user_id = $2) AS holds_place
       FROM users u
      WHERE u.id = $2`,
    [sessionId, userId],
  );
  const row = r.rows[0];
  return {
    sessionId,
    guestFirstSessionId: (row?.guest_first_session_id as string | null | undefined) ?? null,
    holdsPlace: row?.holds_place === true,
  };
}

/**
 * Refuses a registration an event guest may not make (403 GUEST_MEMBERSHIP_REQUIRED), and answers whether the person
 * is a guest. A member costs no extra read beyond the account gate's 60-second cache. When the kind cannot be read
 * (a database error with nothing cached) the registration is refused with a retryable 503: never let through, and
 * never told it is a guest.
 */
export async function assertGuestMayRegister(
  run: GuestRegistrationQuery,
  sessionId: string,
  userId: string,
): Promise<{ isGuest: boolean }> {
  const gate = await readAccountGate(userId);
  if (gate.kind === 'member') return { isGuest: false };
  if (gate.kindUnknown) throw accountKindUnavailable();
  const facts = await readGuestRegistrationFacts(run, sessionId, userId);
  if (!guestMayRegister(facts)) {
    throw new AppError(403, ErrorCodes.GUEST_MEMBERSHIP_REQUIRED, GUEST_REGISTRATION_MESSAGE);
  }
  return { isGuest: true };
}
