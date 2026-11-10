// ─── The people running an event, kept out of matching (moved from host-actions.ts, 10 Nov 2026, Part 2 Task 8) ──
//
// The live handlers re-export this from orchestration/handlers/host-actions.ts, as before. The matching board
// reads it from here: host-actions imports matching.service, so a schedule service importing host-actions would
// close the require cycle matching.service.ts describes at repairFutureRounds.

import { query } from '../../db';

/**
 * Get all user IDs that should be excluded from matching: the event
 * director + any formally-assigned co-hosts.
 *
 * 23 May (Stefan + Ali) — the acting-as-host opt-in/opt-out picker is
 * removed. No participant can self-select host any more, so an admin or
 * super-admin who merely opens someone else's event is now an ordinary,
 * matchable participant. This is the root fix for "admin shows in the
 * room but the engine never matches them" — they were landing in this
 * host set via the old picker (acting_as_host = TRUE).
 */
export async function getAllHostIds(sessionId: string, hostUserId: string): Promise<string[]> {
  const cohostResult = await query<{ user_id: string }>(
    `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
    [sessionId]
  );
  // Stefan's rule (9 Jun) — a super_admin (only Stefan now) ALWAYS acts as host
  // on every event, even without a cohost row, so they belong in the host set
  // wherever they appear: excluded from matching and counted as a host. Scoped
  // to THIS session's participants so it never pulls in super_admins who aren't
  // actually here.
  const superAdminResult = await query<{ user_id: string }>(
    `SELECT sp.user_id FROM session_participants sp
       JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = $1 AND u.role = 'super_admin'`,
    [sessionId]
  );
  return Array.from(new Set<string>([
    hostUserId,
    ...cohostResult.rows.map(r => r.user_id),
    ...superAdminResult.rows.map(r => r.user_id),
  ]));
}
