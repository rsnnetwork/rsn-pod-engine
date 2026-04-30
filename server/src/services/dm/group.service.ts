// ─── Group DM Service ────────────────────────────────────────────────────────
//
// Phase I of chat-fix-and-dm-system plan (1 May 2026). Stefan: "groups
// too — and pods too". Two group types:
//   - 'custom': user-created with explicit member list (everyone they've
//     met can be added; encounter-gate enforced at addMember time)
//   - 'pod':    auto-provisioned per pod, members synced with pod_members
//
// Group messages share the direct_messages table via the new optional
// group_id column (XOR with conversation_id).

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import * as blockService from '../block/block.service';

export interface DmGroup {
  id: string;
  name: string;
  type: 'custom' | 'pod';
  podId: string | null;
  createdBy: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface GroupMember {
  userId: string;
  role: 'admin' | 'member';
  lastReadAt: Date | null;
  joinedAt: Date;
}

/**
 * Create a custom group chat. Caller becomes admin. Initial members must
 * pass the encounter-gate (creator must have met them at least once).
 * Pod chats are NOT created via this method — they're auto-provisioned.
 */
export async function createCustomGroup(
  creatorId: string,
  name: string,
  initialMemberIds: string[],
): Promise<DmGroup> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Group name must be 1-200 chars');
  }
  if (initialMemberIds.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Add at least one other member');
  }

  // Encounter-gate every initial member against the creator.
  for (const memberId of initialMemberIds) {
    if (memberId === creatorId) continue;
    if (await blockService.areBlocked(creatorId, memberId)) {
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Cannot add a blocked user');
    }
    const [a, b] = creatorId < memberId ? [creatorId, memberId] : [memberId, creatorId];
    const enc = await query<{ id: string }>(
      `SELECT id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 LIMIT 1`,
      [a, b],
    );
    if (enc.rows.length === 0) {
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, `You haven't met user ${memberId} yet`);
    }
  }

  return transaction(async (client) => {
    const groupResult = await client.query<{
      id: string; name: string; type: 'custom' | 'pod';
      pod_id: string | null; created_by: string | null;
      last_message_at: Date | null; created_at: Date;
    }>(
      `INSERT INTO dm_groups (id, name, type, created_by)
       VALUES ($1, $2, 'custom', $3)
       RETURNING id, name, type, pod_id, created_by, last_message_at, created_at`,
      [uuid(), trimmed, creatorId],
    );
    const g = groupResult.rows[0];

    // Insert members: creator as admin, others as members.
    const memberRows = [
      [uuid(), g.id, creatorId, 'admin'],
      ...initialMemberIds
        .filter(id => id !== creatorId)
        .map(id => [uuid(), g.id, id, 'member']),
    ];
    for (const [memberId, groupId, userId, role] of memberRows) {
      await client.query(
        `INSERT INTO dm_group_members (id, group_id, user_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [memberId, groupId, userId, role],
      );
    }

    logger.info({ groupId: g.id, creatorId, memberCount: memberRows.length }, 'Custom group created');

    return {
      id: g.id, name: g.name, type: g.type, podId: g.pod_id,
      createdBy: g.created_by, lastMessageAt: g.last_message_at, createdAt: g.created_at,
    };
  });
}

/**
 * Auto-provision a pod chat. Called when a pod is created. Idempotent:
 * if a group already exists for this pod, returns it. Initial members
 * are synced from pod_members (active status only).
 */
export async function ensurePodGroup(podId: string): Promise<DmGroup> {
  return transaction(async (client) => {
    // Check existing
    const existing = await client.query<{
      id: string; name: string; type: 'custom' | 'pod';
      pod_id: string | null; created_by: string | null;
      last_message_at: Date | null; created_at: Date;
    }>(
      `SELECT id, name, type, pod_id, created_by, last_message_at, created_at
       FROM dm_groups WHERE pod_id = $1 AND type = 'pod' LIMIT 1`,
      [podId],
    );
    if (existing.rows.length > 0) {
      const e = existing.rows[0];
      return {
        id: e.id, name: e.name, type: e.type, podId: e.pod_id,
        createdBy: e.created_by, lastMessageAt: e.last_message_at, createdAt: e.created_at,
      };
    }

    // Look up pod info for the group name + creator.
    const podResult = await client.query<{ name: string; created_by: string | null }>(
      `SELECT name, created_by FROM pods WHERE id = $1`,
      [podId],
    );
    if (podResult.rows.length === 0) {
      throw new NotFoundError('Pod', podId);
    }
    const pod = podResult.rows[0];

    // Create the group.
    const groupResult = await client.query<{
      id: string; name: string; type: 'custom' | 'pod';
      pod_id: string | null; created_by: string | null;
      last_message_at: Date | null; created_at: Date;
    }>(
      `INSERT INTO dm_groups (id, name, type, pod_id, created_by)
       VALUES ($1, $2, 'pod', $3, $4)
       RETURNING id, name, type, pod_id, created_by, last_message_at, created_at`,
      [uuid(), pod.name, podId, pod.created_by],
    );
    const g = groupResult.rows[0];

    // Sync initial members from pod_members.
    await client.query(
      `INSERT INTO dm_group_members (id, group_id, user_id, role)
       SELECT uuid_generate_v4(), $1, pm.user_id,
              CASE WHEN pm.role IN ('director', 'host') THEN 'admin' ELSE 'member' END
       FROM pod_members pm
       WHERE pm.pod_id = $2 AND pm.status = 'active'
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [g.id, podId],
    );

    logger.info({ groupId: g.id, podId }, 'Pod chat auto-provisioned');

    return {
      id: g.id, name: g.name, type: g.type, podId: g.pod_id,
      createdBy: g.created_by, lastMessageAt: g.last_message_at, createdAt: g.created_at,
    };
  });
}

/**
 * Pod-membership change hook. Call from podService.addMember /
 * podService.removeMember to keep the pod chat membership in sync.
 */
export async function syncPodMember(
  podId: string,
  userId: string,
  action: 'add' | 'remove',
): Promise<void> {
  // Find the pod chat group; create if missing.
  const group = await ensurePodGroup(podId);

  if (action === 'add') {
    await query(
      `INSERT INTO dm_group_members (id, group_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [uuid(), group.id, userId],
    );
  } else {
    await query(
      `DELETE FROM dm_group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, userId],
    );
  }
  logger.info({ podId, userId, action, groupId: group.id }, 'Pod chat membership synced');
}

/**
 * Send a message to a group. Caller must be a member. Block-gate is NOT
 * enforced here — group blocking is a richer feature (mute/leave) that
 * Phase J's notification preferences cover.
 */
export async function sendGroupMessage(
  groupId: string,
  fromUserId: string,
  content: string,
): Promise<{ messageId: string; createdAt: Date }> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message cannot be empty');
  }
  if (trimmed.length > 4000) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message too long (max 4000 chars)');
  }

  // Membership check.
  const memberResult = await query<{ id: string }>(
    `SELECT id FROM dm_group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
    [groupId, fromUserId],
  );
  if (memberResult.rows.length === 0) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You are not a member of this group');
  }

  return transaction(async (client) => {
    const insert = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO direct_messages (id, group_id, from_user_id, content)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [uuid(), groupId, fromUserId, trimmed],
    );
    await client.query(
      `UPDATE dm_groups SET last_message_at = NOW() WHERE id = $1`,
      [groupId],
    );
    return { messageId: insert.rows[0].id, createdAt: insert.rows[0].created_at };
  });
}

/**
 * List groups the user is a member of, sorted by recent activity.
 */
export async function listMyGroups(userId: string): Promise<DmGroup[]> {
  const result = await query<{
    id: string; name: string; type: 'custom' | 'pod';
    pod_id: string | null; created_by: string | null;
    last_message_at: Date | null; created_at: Date;
  }>(
    `SELECT g.id, g.name, g.type, g.pod_id, g.created_by, g.last_message_at, g.created_at
     FROM dm_groups g
     JOIN dm_group_members m ON m.group_id = g.id
     WHERE m.user_id = $1
     ORDER BY g.last_message_at DESC NULLS LAST`,
    [userId],
  );
  return result.rows.map(r => ({
    id: r.id, name: r.name, type: r.type, podId: r.pod_id,
    createdBy: r.created_by, lastMessageAt: r.last_message_at, createdAt: r.created_at,
  }));
}

/**
 * List messages in a group. Caller must be a member.
 */
export async function listGroupMessages(
  groupId: string,
  userId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ messages: Array<{ id: string; fromUserId: string; content: string; createdAt: Date }>; total: number }> {
  const memberResult = await query<{ id: string }>(
    `SELECT id FROM dm_group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
    [groupId, userId],
  );
  if (memberResult.rows.length === 0) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You are not a member of this group');
  }

  const page = options.page || 1;
  const pageSize = Math.min(options.pageSize || 50, 200);
  const offset = (page - 1) * pageSize;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM direct_messages WHERE group_id = $1`,
    [groupId],
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  const messagesResult = await query<{
    id: string; from_user_id: string; content: string; created_at: Date;
  }>(
    `SELECT id, from_user_id, content, created_at
     FROM direct_messages
     WHERE group_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [groupId, pageSize, offset],
  );

  return {
    messages: messagesResult.rows.map(r => ({
      id: r.id, fromUserId: r.from_user_id, content: r.content, createdAt: r.created_at,
    })),
    total,
  };
}
