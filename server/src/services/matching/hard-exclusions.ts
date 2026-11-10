// ─── The pairs of an event's people who must never meet: one loader (10 Nov 2026 spec, Part 2 Task 5) ──────
//
// The live engine (generateSingleRound) and the one room checker's context (constraint-context.ts, read by the
// matching board and live repairs) both ask here, so the two can never disagree about who may not meet:
//   - an inviter and the person who accepted their invite to this event (`inviter_invitee_block`);
//   - a block, either way (`user_block`), through the block service, the same source that gates DMs;
//   - a report between two of them that was not dismissed (P3-2), folded into the blocks.
// The reads and their order are exactly the ones generateSingleRound made before this loader existed: invites,
// then blocks, then reports. Failure behaviour is the engine's, everywhere: an invites or blocks read that fails
// throws (the caller's matching fails, as before); a reports read that fails is logged and treated as "no reports"
// (best effort, as P3-2 decided), so matching carries on without those pairs.

import { query } from '../../db';
import logger from '../../config/logger';
import * as blockService from '../block/block.service';

/** The two hard-constraint pair lists, each entry `"<a>:<b>"` as the engine's hard constraints read them. */
export interface HardExclusions {
  /** `"<inviterId>:<inviteeId>"`, from this event's accepted invites. */
  inviterInvitee: string[];
  /** `"<blockerId>:<blockedId>"` for blocks, then `"<reporterId>:<reportedId>"` for reports not dismissed. */
  blocked: string[];
}

/**
 * P3-2: non-dismissed violation reports between two participants become exclusion
 * pairs ("reporterId:reportedId"), so a member is never re-paired with someone they
 * reported. Dismissed reports (false alarms) are ignored. Best-effort — a failure
 * never blocks matching. pairKey normalises direction, so order doesn't matter.
 */
export async function getViolationPairsForUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length < 2) return [];
  try {
    const r = await query<{ reporter_id: string; reported_user_id: string }>(
      `SELECT reporter_id, reported_user_id FROM violations
        WHERE status <> 'dismissed' AND reporter_id IS NOT NULL
          AND reporter_id = ANY($1::uuid[]) AND reported_user_id = ANY($1::uuid[])`,
      [userIds],
    );
    return r.rows.map((v) => `${v.reporter_id}:${v.reported_user_id}`);
  } catch (err) {
    logger.warn({ err }, 'getViolationPairsForUsers failed — matching continues without violation exclusion');
    return [];
  }
}

/** Who among `participantIds` must never meet whom in this event. */
export async function loadHardExclusions(sessionId: string, participantIds: string[]): Promise<HardExclusions> {
  const inviterInviteeResult = await query<{ inviter_id: string; accepted_by_user_id: string }>(
    `SELECT inviter_id, accepted_by_user_id FROM invites
     WHERE session_id = $1 AND accepted_by_user_id IS NOT NULL AND status = 'accepted'`,
    [sessionId]
  );
  const inviterInvitee = inviterInviteeResult.rows
    .filter(r => r.inviter_id && r.accepted_by_user_id)
    .map(r => `${r.inviter_id}:${r.accepted_by_user_id}`);
  const blocked = [
    ...await blockService.getBlockedPairsForUsers(participantIds),
    ...await getViolationPairsForUsers(participantIds),
  ];
  return { inviterInvitee, blocked };
}
