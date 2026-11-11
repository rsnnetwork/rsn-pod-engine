// ─── Presence, pushed (11 Nov 2026, Shirley Palmer's RSN 07) ─────────────────────────────────────────────
//
// When a member comes online, steps away or goes offline, the people who can see them are told at once with the entity
// tag `user:<id>:presence`, so a thread header, an inbox dot and a profile's call button redraw without polling (it was
// a 20 s poll, which showed "Offline" for up to 20 s after someone came back).
//
// Who is told: the member's conversation partners (the only people whose screens show their presence: the inbox and
// thread read it for their own conversations only, and a profile's call button only for a connection, whose accepted
// request opened a conversation). Never a pair where either has blocked the other: a block hides presence both ways.
// One bounded query on dm_conversations, by its two user indexes.

import { query } from '../../db';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import logger from '../../config/logger';

/** The most partners one change is sent to. */
export const PRESENCE_AUDIENCE_MAX = 500;

/** The member's conversation partners, neither side having blocked the other. */
export async function presenceAudience(userId: string): Promise<string[]> {
  const r = await query<{ partner_id: string }>(
    `SELECT CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS partner_id
       FROM dm_conversations c
      WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = c.user_a_id AND b.blocked_id = c.user_b_id)
              OR (b.blocker_id = c.user_b_id AND b.blocked_id = c.user_a_id))
      LIMIT $2`,
    [userId, PRESENCE_AUDIENCE_MAX],
  );
  return r.rows.map((row) => row.partner_id);
}

/** Tell the member's partners that where they are has changed. Best-effort: presence is never worth a failure. */
export async function pushPresence(userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const audience = await presenceAudience(userId);
    if (audience.length > 0) await emitEntities(io, audience, [E.userPresence(userId)]);
  } catch (err) {
    logger.warn({ err, userId }, 'presence push failed (non-fatal)');
  }
}
