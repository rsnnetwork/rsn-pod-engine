// ─── Session Access Control ──────────────────────────────────────────────────
// Read-access gate for session detail endpoints. Prevents metadata leaks to
// authenticated users who are neither participants nor pod members. Also who
// an event lets into its live room (eventRoomAdmission), and what it tells
// everyone else (eventRoomRefusal).

import { ErrorCodes, UserRole, hasRoleAtLeast } from '@rsn/shared';
import { query } from '../../db';

/**
 * Determines if a user is allowed to view a session's details.
 *
 * Rules (short-circuit in order):
 *   1. Admin / super_admin → allowed
 *   2. Session host → allowed
 *   3. Registered participant (status != 'removed') → allowed
 *   4. Pod member → allowed
 *   5. Pod is public → allowed to any authenticated user (discovery)
 *   6. Else → denied
 *
 * Callers that need more nuance (e.g. write permissions) should add their own
 * checks on top of this read-access gate.
 */
export async function canViewSession(
  userId: string,
  sessionId: string,
  userRole: string,
): Promise<boolean> {
  if (userRole === 'admin' || userRole === 'super_admin') return true;

  const sessRes = await query<{
    host_user_id: string;
    pod_id: string | null;
    pod_visibility: string | null;
  }>(
    `SELECT s.host_user_id, s.pod_id, p.visibility AS pod_visibility
     FROM sessions s
     LEFT JOIN pods p ON p.id = s.pod_id
     WHERE s.id = $1`,
    [sessionId],
  );
  if (sessRes.rows.length === 0) return false;
  const s = sessRes.rows[0];

  if (s.host_user_id === userId) return true;

  const partRes = await query<{ status: string }>(
    `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
    [sessionId, userId],
  );
  if (partRes.rows.length > 0 && partRes.rows[0].status !== 'removed') return true;

  if (s.pod_id) {
    const memRes = await query<{ role: string }>(
      `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 LIMIT 1`,
      [s.pod_id, userId],
    );
    if (memRes.rows.length > 0) return true;
    if (s.pod_visibility === 'public') return true;
  }

  return false;
}

// ─── Who joins an event's live room (H1, 26 Oct 2026) ────────────────────────

/** What a join does with a socket: let it into the event's room, give a removed member the terminal bounce, or refuse it. */
export type EventRoomAdmission = 'admitted' | 'removed' | 'refused';

/**
 * Whether someone may be in an event's live room (`session:<id>`), which receives the event's chat,
 * reactions, presence and round events. Admitted: the event's host; a co-host or moderator
 * (session_cohosts); a platform admin or super admin, who may act as host; anyone whose participant row
 * is not removed: someone who left and is coming back (left is recoverable), someone reconnecting, a
 * refresh or a second tab, a late joiner the registration has just admitted. A removed row is terminal
 * and wins over every role, as the registration's own REMOVED_FROM_EVENT does. Anyone else, and an event
 * that does not exist, is refused. One read.
 */
export async function eventRoomAdmission(
  sessionId: string,
  userId: string,
  userRole: string | undefined,
): Promise<EventRoomAdmission> {
  const result = await query<{ is_host: boolean; is_cohost: boolean; participant_status: string | null }>(
    `SELECT s.host_user_id = $2 AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
            p.status::text AS participant_status
       FROM sessions s
       LEFT JOIN session_participants p ON p.session_id = s.id AND p.user_id = $2
      WHERE s.id = $1`,
    [sessionId, userId],
  );
  const facts = result.rows[0];
  if (!facts) return 'refused';
  if (facts.participant_status === 'removed') return 'removed';
  const admin = !!userRole && hasRoleAtLeast(userRole as UserRole, UserRole.ADMIN);
  if (facts.is_host || facts.is_cohost || admin || facts.participant_status !== null) return 'admitted';
  return 'refused';
}

/**
 * The one refusal someone the event does not admit receives, as the socket `error` production's live page
 * shows (a toast and a banner with the sentence). Words that are true for them: the event is over, it is
 * only for its pod's members (the registration refused them as not one), or the join could not be
 * completed and a refresh tries again.
 */
export function eventRoomRefusal(
  eventStatus: string,
  registrationCode: string | undefined,
): { code: string; message: string } {
  if (eventStatus === 'completed') return { code: ErrorCodes.EVENT_ENDED, message: 'This event has ended.' };
  if (eventStatus === 'cancelled') return { code: ErrorCodes.EVENT_ENDED, message: 'This event was cancelled.' };
  if (registrationCode === ErrorCodes.AUTH_FORBIDDEN) {
    return { code: ErrorCodes.AUTH_FORBIDDEN, message: 'This event is only open to its pod\'s members.' };
  }
  return { code: 'JOIN_FAILED', message: 'You could not join this event. Refresh the page to try again.' };
}
