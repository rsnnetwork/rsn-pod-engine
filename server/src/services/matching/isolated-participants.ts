import { query } from '../../db';

type PresenceMap = Map<string, { lastHeartbeat: Date; socketId: string; reconnectedAt?: Date }>;

/**
 * Returns user IDs who are present in the session (socket connected, in presenceMap)
 * but NOT participants of any match currently in 'active' state for the given round.
 *
 * Replaces the previous pattern of querying `matches WHERE status='no_show'`, which
 * required overloading the no_show status as a scratch flag for reassign logic.
 *
 * Used by: voluntary leave flow, host-remove flow, disconnect flow — anywhere we
 * need to pair a solo user with another solo user mid-round.
 *
 * Phase R1 (20 May 2026 — live-test post-mortem). The event host, every
 * session_cohosts row, and every session_participants row with
 * acting_as_host=TRUE are filtered out at SQL level. These three identity
 * classes are NEVER matchable: pairing them into a breakout creates phantom
 * matches that cascade into per-client count desync, premature rating-screen
 * triggers (host's match ends -> rating window opens for host), and
 * ghost-participant bugs in subsequent rounds. The host has a
 * session_participants row whenever they join the event for presence tracking
 * (even without "Join as participant" opt-in), so the prior
 * status-only filter let them through.
 */
export async function findIsolatedParticipants(
  sessionId: string,
  roundNumber: number,
  presenceMap: PresenceMap,
  excludeUserId?: string,
): Promise<string[]> {
  const participantsRes = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants
     WHERE session_id = $1
       AND status NOT IN ('removed', 'left', 'no_show')
       AND user_id NOT IN (
         SELECT host_user_id FROM sessions WHERE id = $1
         UNION
         SELECT user_id FROM session_cohosts WHERE session_id = $1
         UNION
         SELECT user_id FROM session_participants WHERE session_id = $1 AND acting_as_host = TRUE
       )`,
    [sessionId],
  );

  const activeMatchesRes = await query<{
    participant_a_id: string | null;
    participant_b_id: string | null;
    participant_c_id: string | null;
  }>(
    `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches
     WHERE session_id = $1 AND round_number = $2 AND status = 'active'`,
    [sessionId, roundNumber],
  );

  const busyIds = new Set<string>();
  for (const m of activeMatchesRes.rows) {
    if (m.participant_a_id) busyIds.add(m.participant_a_id);
    if (m.participant_b_id) busyIds.add(m.participant_b_id);
    if (m.participant_c_id) busyIds.add(m.participant_c_id);
  }

  const isolated: string[] = [];
  for (const row of participantsRes.rows) {
    if (row.user_id === excludeUserId) continue;
    if (busyIds.has(row.user_id)) continue;
    if (!presenceMap.has(row.user_id)) continue;
    isolated.push(row.user_id);
  }
  return isolated;
}
