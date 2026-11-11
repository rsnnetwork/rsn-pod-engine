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
//   c) (Part 2, Task 4) an event with an admission mode that has entitled them: their address on its allowed list, a
//      code of its they redeemed, an invite to it (the three restrictedEntitlementSql reads), or a request of theirs
//      the organisers approved. An event with no mode never widens a guest's reach.
//
//   d) (Part 2, Task 6) the event whose RSN Call link the guest is entering by right now (arrivedThroughCallLink).
//
//   e) (Part 3, Task 3) the event whose waiting list the guest is on, while it promotes them (onWaitlist, read only when
//      the promotion asks: fromWaitlist). A guest reaches a waiting list only through the call link (d), so this is the
//      same say-so carried to the moment a place opens, when the guest is no longer on the link.
//
// Task 6 extends guestMayRegister (keep its name and its facts-in, boolean-out shape).

import { ErrorCodes, type AdmissionMode } from '@rsn/shared';
import { readAccountGate } from '../../middleware/auth';
import { AppError } from '../../middleware/errors';
import { accountKindUnavailable } from '../../middleware/guest-scope';
import { restrictedEntitlementSql } from './event-access';

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
  /** Part 2, Task 4: sessions.admission_mode (absent or null: the event has none, and nothing below counts). */
  admissionMode?: AdmissionMode | null;
  /** Part 2, Task 4: an allowed email, a redeemed code or an invite for this event (restrictedEntitlementSql). */
  admissionEntitled?: boolean;
  /** Part 2, Task 4: the organisers approved the guest's request (or are approving it in this registration). */
  approvedRequest?: boolean;
  /**
   * Part 2, Task 6: the guest is entering this event through its own RSN Call link right now (call-entry.service's
   * enterCall is the only caller that says so, for the event its code resolved to). It lets the guest ask; who gets a
   * place is still canRegister's, so an invitation-only or approval event holds its own rules.
   */
  arrivedThroughCallLink?: boolean;
  /**
   * Part 3, Task 3: the guest is waiting on this event's waiting list and is being promoted from it now
   * (promoteFromWaitlist, through registerParticipantTx's fromWaitlist).
   */
  onWaitlist?: boolean;
}

/** What a guest who may not register here is told. */
export const GUEST_REGISTRATION_MESSAGE =
  'This event is for members. As a guest you can take part in the event you were invited to.';

/** Whether an event guest may take, or take back, a place in this event. */
export function guestMayRegister(facts: GuestRegistrationFacts): boolean {
  if (facts.holdsPlace) return true;
  if (facts.guestFirstSessionId !== null && facts.guestFirstSessionId === facts.sessionId) return true;
  if (facts.arrivedThroughCallLink) return true;
  if (facts.onWaitlist) return true;
  return !!facts.admissionMode && (!!facts.admissionEntitled || !!facts.approvedRequest);
}

/** The facts for guestMayRegister, in one read. */
export async function readGuestRegistrationFacts(
  run: GuestRegistrationQuery,
  sessionId: string,
  userId: string,
): Promise<GuestRegistrationFacts> {
  const r = await run(
    `SELECT u.guest_first_session_id,
            EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = $1 AND sp.user_id = $2) AS holds_place,
            s.admission_mode,
            (s.admission_mode IS NOT NULL AND ${restrictedEntitlementSql('s', '$2')}) AS admission_entitled,
            (s.admission_mode IS NOT NULL AND EXISTS (
              SELECT 1 FROM event_join_requests gr WHERE gr.session_id = s.id AND gr.user_id = $2 AND gr.status = 'approved'
            )) AS approved_request,
            EXISTS (SELECT 1 FROM event_waitlist gw WHERE gw.session_id = $1 AND gw.user_id = $2 AND gw.status = 'waiting') AS on_waitlist
       FROM users u
       LEFT JOIN sessions s ON s.id = $1
      WHERE u.id = $2`,
    [sessionId, userId],
  );
  const row = r.rows[0];
  const mode = row?.admission_mode;
  return {
    sessionId,
    guestFirstSessionId: (row?.guest_first_session_id as string | null | undefined) ?? null,
    holdsPlace: row?.holds_place === true,
    admissionMode: mode === 'open' || mode === 'approval' || mode === 'restricted' ? mode : null,
    admissionEntitled: row?.admission_entitled === true,
    approvedRequest: row?.approved_request === true,
    onWaitlist: row?.on_waitlist === true,
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
  options: { approvedRequest?: boolean; arrivedThroughCallLink?: boolean; fromWaitlist?: boolean } = {},
): Promise<{ isGuest: boolean }> {
  const gate = await readAccountGate(userId);
  if (gate.kind === 'member') return { isGuest: false };
  if (gate.kindUnknown) throw accountKindUnavailable();
  const read = await readGuestRegistrationFacts(run, sessionId, userId);
  // The approve route registers before it marks the request approved, so its say-so arrives as an option.
  const facts = {
    ...read,
    approvedRequest: read.approvedRequest || !!options.approvedRequest,
    arrivedThroughCallLink: !!options.arrivedThroughCallLink,
    // Only the promotion's own say-so counts: a guest who is waiting registers anywhere else under the rules above.
    onWaitlist: read.onWaitlist === true && !!options.fromWaitlist,
  };
  if (!guestMayRegister(facts)) {
    throw new AppError(403, ErrorCodes.GUEST_MEMBERSHIP_REQUIRED, GUEST_REGISTRATION_MESSAGE);
  }
  return { isGuest: true };
}
