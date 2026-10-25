// ─── Who runs an event ───────────────────────────────────────────────────────
//
// "Message all participants" is for the people running the event, and the same people may see how a send
// is going. One definition of them, so the rule, the access check and the progress fan-out never drift:
//   - the event's host (sessions.host_user_id),
//   - its co-hosts and moderators (session_cohosts),
//   - the director or host of its pod, while that membership is active,
//   - any platform admin.
// Claus, on 25 Oct, was all of the first and third while his account role was a plain member: the old
// rule asked only for the account role and the pod's director row, and never looked at the host.

import { UserRole, hasRoleAtLeast } from '@rsn/shared';
import { query } from '../../db';

export interface EventOrganiserAccess {
  /** sessions.status of the event. */
  status: string;
  isHost: boolean;
  isCohost: boolean;
  /** An active director or host of the event's pod. */
  isPodOrganiser: boolean;
  isAdmin: boolean;
  /** Any of the above. */
  isOrganiser: boolean;
  /** The person's own time zone, for a time written into a sentence they read. */
  timeZone: string | null;
}

interface AccessRow {
  status: string;
  host_user_id: string | null;
  is_cohost: boolean;
  is_pod_organiser: boolean;
  time_zone: string | null;
}

/**
 * How this person relates to this event, or null when there is no such event.
 * `role` is the account role from the verified sign-in token.
 */
export async function getEventOrganiserAccess(
  userId: string,
  role: UserRole,
  sessionId: string,
): Promise<EventOrganiserAccess | null> {
  const result = await query<AccessRow>(
    `SELECT s.status, s.host_user_id,
            EXISTS (SELECT 1 FROM session_cohosts sc
                     WHERE sc.session_id = s.id AND sc.user_id = $2) AS is_cohost,
            EXISTS (SELECT 1 FROM pod_members pm
                     WHERE pm.pod_id = s.pod_id AND pm.user_id = $2
                       AND pm.role IN ('director', 'host') AND pm.status = 'active') AS is_pod_organiser,
            (SELECT u.timezone FROM users u WHERE u.id = $2) AS time_zone
       FROM sessions s
      WHERE s.id = $1`,
    [sessionId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const isHost = row.host_user_id === userId;
  const isAdmin = hasRoleAtLeast(role, UserRole.ADMIN);
  return {
    status: row.status,
    isHost,
    isCohost: row.is_cohost,
    isPodOrganiser: row.is_pod_organiser,
    isAdmin,
    isOrganiser: isHost || row.is_cohost || row.is_pod_organiser || isAdmin,
    timeZone: row.time_zone,
  };
}

/**
 * The people running this event, for telling their open screens that a send moved on. Admins are not
 * listed: there is no end to where an admin might be looking, and an admin who sent is the sender.
 */
export async function resolveEventOrganiserIds(sessionId: string): Promise<string[]> {
  const result = await query<{ user_id: string | null }>(
    `SELECT host_user_id AS user_id FROM sessions WHERE id = $1
     UNION
     SELECT user_id FROM session_cohosts WHERE session_id = $1
     UNION
     SELECT pm.user_id FROM pod_members pm
       JOIN sessions s ON s.pod_id = pm.pod_id
      WHERE s.id = $1 AND pm.role IN ('director', 'host') AND pm.status = 'active'`,
    [sessionId],
  );
  return [...new Set(result.rows.map((r) => r.user_id).filter((id): id is string => !!id))];
}
