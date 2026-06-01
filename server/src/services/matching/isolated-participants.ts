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
 */
export async function findIsolatedParticipants(
  sessionId: string,
  roundNumber: number,
  presenceMap: PresenceMap,
  excludeUserId?: string,
): Promise<string[]> {
  const participantsRes = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants
     WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
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
