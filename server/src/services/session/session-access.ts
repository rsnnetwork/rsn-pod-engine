// ─── Session Access Control ──────────────────────────────────────────────────
// Read-access gate for session detail endpoints. Prevents metadata leaks to
// authenticated users who are neither participants nor pod members. Also who
// an event lets into its live room (eventRoomAdmission) and who may say they
// are in one of its breakout rooms (mayClaimBreakoutRoom). What the live join
// does with those facts lives in orchestration/event-room-entry.ts.

import { ErrorCodes, UserRole, hasRoleAtLeast } from '@rsn/shared';
import { query } from '../../db';
import { AppError } from '../../middleware/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAdminRole(role: string | undefined): boolean {
  return !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
}

/** A SQL placeholder such as `$2`: the only thing the fragments below accept for the person. */
const PLACEHOLDER = /^\$[1-9][0-9]*$/;
/** A plain lower-case SQL name, for the alias of the sessions table. */
const ALIAS = /^[a-z_][a-z0-9_]*$/;

function checkedSqlParts(sessionAlias: string, userParam: string): void {
  if (!ALIAS.test(sessionAlias) || !PLACEHOLDER.test(userParam)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'An event access fragment was given something that is not an alias and a placeholder');
  }
}

/**
 * T2 (1 Nov 2026), D1 and D3: the SQL condition "the person in `userParam` may open the event aliased
 * `sessionAlias`", for lists (the Events list, For You's next event, a circle page). It is canViewSession's own rule,
 * so an event is listed exactly to the people who may open it: its host or a co-host, someone whose participant row
 * is not removed, an active member of its pod, or anyone when the pod is public. Admins see every event and are
 * left to the caller. An invite-only pod's events used to be listed to everyone and then refused on open (D1); a
 * circle page named every attached pod's events, private ones included (D3).
 */
export function visibleEventSql(sessionAlias: string, userParam: string): string {
  checkedSqlParts(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `(
    ${s}.host_user_id = ${u}
    OR EXISTS (SELECT 1 FROM pods ve_p WHERE ve_p.id = ${s}.pod_id AND ve_p.visibility = 'public')
    OR EXISTS (SELECT 1 FROM pod_members ve_m WHERE ve_m.pod_id = ${s}.pod_id AND ve_m.user_id = ${u} AND ve_m.status = 'active')
    OR EXISTS (SELECT 1 FROM session_cohosts ve_c WHERE ve_c.session_id = ${s}.id AND ve_c.user_id = ${u})
    OR EXISTS (SELECT 1 FROM session_participants ve_sp WHERE ve_sp.session_id = ${s}.id AND ve_sp.user_id = ${u} AND ve_sp.status <> 'removed')
  )`;
}

/**
 * T2 (1 Nov 2026), D2: the SQL condition "the event aliased `sessionAlias` is in a pod that asks for approval
 * (public_with_approval) and the person in `userParam` is none of the people it takes": an active member of the pod
 * (someone the pod approved), the event's host, a co-host, or someone invited to the event (an invite to this event
 * for their address or accepted by them, not withdrawn, declined or expired). Admins are left to the caller.
 * Anyone with the event's id could register for such an event, and so enter its live room.
 */
export function approvalPodOutsiderSql(sessionAlias: string, userParam: string): string {
  checkedSqlParts(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `(
    EXISTS (SELECT 1 FROM pods ao_p WHERE ao_p.id = ${s}.pod_id AND ao_p.visibility = 'public_with_approval')
    AND ${s}.host_user_id IS DISTINCT FROM ${u}
    AND NOT EXISTS (SELECT 1 FROM pod_members ao_m WHERE ao_m.pod_id = ${s}.pod_id AND ao_m.user_id = ${u} AND ao_m.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM session_cohosts ao_c WHERE ao_c.session_id = ${s}.id AND ao_c.user_id = ${u})
    AND NOT EXISTS (
      SELECT 1 FROM invites ao_i
       WHERE ao_i.session_id = ${s}.id
         AND (ao_i.accepted_by_user_id = ${u}
              OR lower(ao_i.invitee_email) = (SELECT lower(ao_u.email) FROM users ao_u WHERE ao_u.id = ${u}))
         AND (ao_i.status = 'accepted'
              OR (ao_i.status = 'pending' AND (ao_i.expires_at IS NULL OR ao_i.expires_at > NOW())))
    )
  )`;
}

/** The words someone outside an approval pod hears when they try to take a place in one of its events (D2). */
export const APPROVAL_POD_EVENT_REFUSAL = "This event is for the pod's members. Ask to join the pod first, or ask the host for an invite.";

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
 * and wins over every role, as the registration's own REMOVED_FROM_EVENT does. In a pod that asks for approval a
 * row counts only for someone the event takes (approvalPodOutsiderSql, T2). Anyone else, and an event that does
 * not exist, is refused. One read.
 */
export async function eventRoomAdmission(
  sessionId: string,
  userId: string,
  userRole: string | undefined,
): Promise<EventRoomAdmission> {
  const result = await query<{
    is_host: boolean; is_cohost: boolean; participant_status: string | null; approval_outsider?: boolean | null;
  }>(
    `SELECT s.host_user_id = $2 AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
            p.status::text AS participant_status,
            ${approvalPodOutsiderSql('s', '$2')} AS approval_outsider
       FROM sessions s
       LEFT JOIN session_participants p ON p.session_id = s.id AND p.user_id = $2
      WHERE s.id = $1`,
    [sessionId, userId],
  );
  const facts = result.rows[0];
  if (!facts) return 'refused';
  if (facts.participant_status === 'removed') return 'removed';
  if (facts.is_host || facts.is_cohost || isAdminRole(userRole)) return 'admitted';
  // T2 (D2): a place in an approval pod's event does not let in someone the pod never approved or the host never
  // invited (a place taken before the registration refused them).
  if (facts.participant_status !== null && !facts.approval_outsider) return 'admitted';
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
