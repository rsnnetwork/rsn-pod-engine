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
    visibility?: string | null;
    account_closed?: boolean;
    publication?: string | null;
  }>(
    `SELECT s.host_user_id, s.pod_id, p.visibility AS pod_visibility,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
            s.visibility,
            EXISTS (SELECT 1 FROM users ac WHERE ac.id = $2 AND ac.status <> 'active') AS account_closed,
            s.publication
     FROM sessions s
     LEFT JOIN pods p ON p.id = s.pod_id
     WHERE s.id = $1`,
    [sessionId, userId],
  );
  if (sessRes.rows.length === 0) return false;
  const s = sessRes.rows[0];
  // T11 (1 Nov 2026): a removed, suspended or banned account sees no event (sign-in refuses it within a minute too).
  if (s.account_closed === true) return false;
  // Part 2 Task 2 (D1): a draft is seen by the people who run it only (admins returned above), whatever its visibility.
  if (s.publication === 'draft') return s.host_user_id === userId || s.is_cohost === true;

  // T11 (1 Nov 2026): an event with its own visibility follows the one rule (event-access.ts). A NULL event
  // follows its pod below, exactly as before.
  if (s.visibility) {
    const { readEventAccessFacts, canSeeEvent } = await import('./event-access');
    const facts = await readEventAccessFacts(sessionId, userId);
    return !!facts && canSeeEvent(facts, userRole);
  }

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
 * and wins over every role, as the registration's own REMOVED_FROM_EVENT does. Anyone else, and an event that
 * does not exist, is refused. One read.
 */
export async function eventRoomAdmission(
  sessionId: string,
  userId: string,
  userRole: string | undefined,
): Promise<EventRoomAdmission> {
  // Part 2 Task 4: an invitation-only event (admission_mode 'restricted') asks for the entitlement on every join. The
  // fragment lives with the other access rules; a lazy import, as canViewSession's, since event-access imports this file.
  const { restrictedEntitlementSql } = await import('./event-access');
  const result = await query<{
    is_host: boolean; is_cohost: boolean; participant_status: string | null; account_closed?: boolean; publication?: string | null;
    admission_holds?: boolean;
  }>(
    `SELECT s.host_user_id = $2 AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
            p.status::text AS participant_status,
            EXISTS (SELECT 1 FROM users ac WHERE ac.id = $2 AND ac.status <> 'active') AS account_closed,
            s.publication,
            CASE WHEN s.admission_mode = 'restricted' THEN ${restrictedEntitlementSql('s', '$2')} ELSE TRUE END AS admission_holds
       FROM sessions s
       LEFT JOIN session_participants p ON p.session_id = s.id AND p.user_id = $2
      WHERE s.id = $1`,
    [sessionId, userId],
  );
  const facts = result.rows[0];
  if (!facts) return 'refused';
  if (facts.participant_status === 'removed') return 'removed';
  // T11 (1 Nov 2026): a removed, suspended or banned account enters no event, whatever row or role it holds.
  if (facts.account_closed === true) return 'refused';
  // Part 2 Task 2 (D1): a draft's room is for the people who run it only (it cannot go live, but its waiting room opens).
  if (facts.publication === 'draft') return facts.is_host || facts.is_cohost || isAdminRole(userRole) ? 'admitted' : 'refused';
  // T2 fix round 1 (1 Nov 2026): a participant row is a place the event already gave, so it admits on every
  // reconnect. An approval pod's outsider is kept out where a place is first given (registerParticipant), never
  // here, so someone already in a live event is not refused after a restart or after leaving the pod mid-event.
  if (facts.is_host || facts.is_cohost || isAdminRole(userRole)) return 'admitted';
  // Part 2 Task 4 (D3): on an invitation-only event a place admits only while its entitlement holds. An organiser who
  // takes an email off the list (or revokes a code) keeps its person out of the room; their place stays as it is.
  if (facts.admission_holds === false) return 'refused';
  if (facts.participant_status !== null) return 'admitted';
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
