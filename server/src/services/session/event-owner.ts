// ─── The event's owner, as the database says (Part 3 Task 12) ──────────────────────────────────────────────────────
//
// Some choices about an event are its owner's alone (host_user_id), or a super admin's: never a co-host's, a pod
// director's or a platform admin's, and never decided from the token's role. Who may override the event's group
// rules (event_matching_rules.override_by) is the first. Kept apart from the groups service, whose SQL never reads a
// platform role (spec 05, "Critical distinction": a role decides who runs the event, never anyone's group).

import type { PoolClient } from 'pg';
import { UserRole } from '@rsn/shared';

/** Whether this person owns the event or is a super admin, read in the caller's transaction. An unknown event: false. */
export async function isEventOwnerOrSuperAdmin(client: PoolClient, sessionId: string, actorId: string): Promise<boolean> {
  const result = await client.query<{ host_user_id: string | null; role: string | null }>(
    `SELECT s.host_user_id, (SELECT u.role FROM users u WHERE u.id = $2) AS role FROM sessions s WHERE s.id = $1`,
    [sessionId, actorId],
  );
  const row = result.rows[0];
  return !!row && (row.host_user_id === actorId || row.role === UserRole.SUPER_ADMIN);
}
