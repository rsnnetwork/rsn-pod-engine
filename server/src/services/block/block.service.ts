// ─── Block Service ────────────────────────────────────────────────────────────
// Phase B of chat-fix-and-dm-system plan (1 May 2026). Single source of truth
// for user-to-user block relationships. Used by:
//
//   - DM service: rejects sends if either party has blocked the other
//   - Matching engine: blocked pairs added as a hard constraint, never matched
//   - Profile UI: Block / Unblock buttons read this state
//
// A block is one-directional in storage (blocker_id, blocked_id) but enforced
// bidirectionally at read time via areBlocked(a, b) which checks both
// directions. This keeps writes simple and reads symmetric.

import { query } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

export interface UserBlock {
  id: string;
  blockerId: string;
  blockedId: string;
  reason: string | null;
  createdAt: Date;
}

export interface BlockedUserSummary {
  blockedId: string;
  displayName: string | null;
  avatarUrl: string | null;
  reason: string | null;
  createdAt: Date;
}

/**
 * Block another user. Idempotent — re-blocking with a new reason updates
 * the reason field. Self-blocks are rejected. Returns the block record.
 */
export async function block(
  blockerId: string,
  blockedId: string,
  reason?: string,
): Promise<UserBlock> {
  if (blockerId === blockedId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot block yourself');
  }
  // Verify the blocked user exists
  const userExists = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1`,
    [blockedId],
  );
  if (userExists.rows.length === 0) {
    throw new NotFoundError('User', blockedId);
  }

  const result = await query<{
    id: string; blocker_id: string; blocked_id: string; reason: string | null; created_at: Date;
  }>(
    `INSERT INTO user_blocks (blocker_id, blocked_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (blocker_id, blocked_id) DO UPDATE
       SET reason = EXCLUDED.reason
     RETURNING id, blocker_id, blocked_id, reason, created_at`,
    [blockerId, blockedId, reason || null],
  );

  logger.info({ blockerId, blockedId }, 'User blocked');

  return {
    id: result.rows[0].id,
    blockerId: result.rows[0].blocker_id,
    blockedId: result.rows[0].blocked_id,
    reason: result.rows[0].reason,
    createdAt: result.rows[0].created_at,
  };
}

/**
 * Remove a block. Idempotent — if no block exists, returns silently
 * (we already arrived at the desired state).
 */
export async function unblock(blockerId: string, blockedId: string): Promise<void> {
  await query(
    `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
    [blockerId, blockedId],
  );
  logger.info({ blockerId, blockedId }, 'User unblocked');
}

/**
 * Returns true if EITHER direction is blocked between the two users.
 * This is the symmetric check that DM and matching consumers should use.
 * Single roundtrip query.
 */
export async function areBlocked(userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return false;
  const result = await query<{ id: string }>(
    `SELECT id FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2)
        OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [userA, userB],
  );
  return result.rows.length > 0;
}

/**
 * Bulk version of areBlocked for matching-engine integration. Given a list
 * of user IDs that are candidates for matching in a session, returns the
 * set of pairs (any direction) that should be excluded.
 *
 * Returns pairs in the canonical "blockerId:blockedId" string format used by
 * HardConstraint params, so the caller can pass it straight to the engine
 * without further transformation.
 */
export async function getBlockedPairsForUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const result = await query<{ blocker_id: string; blocked_id: string }>(
    `SELECT blocker_id, blocked_id FROM user_blocks
     WHERE blocker_id = ANY($1) AND blocked_id = ANY($1)`,
    [userIds],
  );
  return result.rows.map(r => `${r.blocker_id}:${r.blocked_id}`);
}

/**
 * List the users that I have blocked, with display info for the Settings
 * "Blocked Users" management UI.
 */
export async function listBlocked(blockerId: string): Promise<BlockedUserSummary[]> {
  const result = await query<{
    blocked_id: string;
    display_name: string | null;
    avatar_url: string | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT ub.blocked_id, u.display_name, u.avatar_url, ub.reason, ub.created_at
     FROM user_blocks ub
     JOIN users u ON u.id = ub.blocked_id
     WHERE ub.blocker_id = $1
     ORDER BY ub.created_at DESC`,
    [blockerId],
  );
  return result.rows.map(r => ({
    blockedId: r.blocked_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/**
 * Returns true if the current user has blocked the target. Asymmetric check
 * (used by the profile UI to decide whether to show Block or Unblock).
 */
export async function hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1`,
    [blockerId, blockedId],
  );
  return result.rows.length > 0;
}
