// ─── Session Access Control ──────────────────────────────────────────────────
// Read-access gate for session detail endpoints. Prevents metadata leaks to
// authenticated users who are neither participants nor pod members. Also who
// an event lets into its live room (eventRoomAdmission) and who may say they
// are in one of its breakout rooms (mayClaimBreakoutRoom). What the live join
// does with those facts lives in orchestration/event-room-entry.ts.

import { UserRole, hasRoleAtLeast } from '@rsn/shared';
import { query } from '../../db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAdminRole(role: string | undefined): boolean {
  return !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
}

/**
 * Determines if a user is allowed to view a session's details.
 *
 * Rules (short-circuit in order):
 *   1. Admin / super_admin → allowed
 *   2. Session host or co-host → allowed
 *   3. Registered participant (status != 'removed') → allowed
 *   4. ACTIVE pod member → allowed (H1 fix round 1: a left, pending, invited,
 *      declined or removed membership no longer counts; such a person cannot
 *      register for the pod's events either)
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
    is_cohost: boolean;
  }>(
    `SELECT s.host_user_id, s.pod_id, p.visibility AS pod_visibility,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost
     FROM sessions s
     LEFT JOIN pods p ON p.id = s.pod_id
     WHERE s.id = $1`,
    [sessionId, userId],
  );
  if (sessRes.rows.length === 0) return false;
  const s = sessRes.rows[0];

  if (s.host_user_id === userId || s.is_cohost) return true;

  const partRes = await query<{ status: string }>(
    `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
    [sessionId, userId],
  );
  if (partRes.rows.length > 0 && partRes.rows[0].status !== 'removed') return true;

  if (s.pod_id) {
    const memRes = await query<{ role: string }>(
      `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
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
  if (facts.is_host || facts.is_cohost || isAdminRole(userRole) || facts.participant_status !== null) return 'admitted';
  return 'refused';
}

/**
 * Whether someone may say they are in a breakout room (presence:room_joined), which puts them among the
 * people that room's chat and reactions reach: someone in that match, or the event's host, a co-host or an
 * admin visiting it. The match must belong to the event, carry that room id and still be running (H1b): a
 * late signal for a room the host moved them out of, or one whose round has ended, would otherwise put them
 * back in it. Every path that puts people in a room makes its match active before telling them, so their own
 * signal always finds it running. A removed person never may. One read.
 */
export async function mayClaimBreakoutRoom(
  sessionId: string,
  matchId: string,
  roomId: string,
  userId: string,
  userRole: string | undefined,
): Promise<boolean> {
  if (!UUID.test(sessionId) || !UUID.test(matchId)) return false;
  const result = await query<{ in_match: boolean; is_host: boolean; is_cohost: boolean; participant_status: string | null }>(
    `SELECT COALESCE(m.participant_a_id = $3 OR m.participant_b_id = $3 OR m.participant_c_id = $3, FALSE) AS in_match,
            s.host_user_id = $3 AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $3) AS is_cohost,
            p.status::text AS participant_status
       FROM matches m JOIN sessions s ON s.id = m.session_id
       LEFT JOIN session_participants p ON p.session_id = s.id AND p.user_id = $3
      WHERE m.id = $1 AND m.session_id = $2 AND m.room_id = $4 AND m.status = 'active'`,
    [matchId, sessionId, userId, roomId],
  );
  const facts = result.rows[0];
  if (!facts || facts.participant_status === 'removed') return false;
  return facts.in_match || facts.is_host || facts.is_cohost || isAdminRole(userRole);
}
