// ─── Direct Messages Service ───────────────────────────────────────────────
//
// Phase C of chat-fix-and-dm-system plan (1 May 2026). 1:1 DMs at the
// platform level. Persistent (Postgres). Independent of any session, room,
// or event. The data model lives across migrations 044, 045, 046.
//
// Authorization rules baked in:
//   1. Two users must share at least one row in encounter_history (they've
//      been matched in the same room at least once anywhere on RSN).
//   2. Neither user has blocked the other (block.service.areBlocked).
//   3. Self-DMs are forbidden.
//
// Design notes:
//   - Conversation rows store the pair sorted (user_a_id < user_b_id) so
//     UNIQUE dedupes regardless of which side initiates.
//   - Sending a message creates the conversation if it didn't exist
//     (idempotent INSERT ... ON CONFLICT).
//   - Soft-delete is per-user. Deleting only hides MY view of the
//     conversation; the other party's thread continues. A new incoming
//     message clears my deletion timestamp so the conversation
//     re-appears in my inbox.
//   - read_at is NULL until the recipient calls markRead.

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import * as blockService from '../block/block.service';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DmConversation {
  id: string;
  userAId: string;
  userBId: string;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface DmMessage {
  id: string;
  conversationId: string;
  fromUserId: string;
  content: string;
  readAt: Date | null;
  createdAt: Date;
  // Phase E: emoji reactions, aggregated per emoji type → list of reactor userIds.
  // Optional so callers that build a DmMessage from an INSERT result (which
  // can never have reactions yet) don't have to supply an empty record.
  // listMessages always returns it as at least {}.
  reactions?: Record<string, string[]>;
  // Feature 19 (13 May spec) — Cloudinary-hosted image attachment.
  // attachmentType is 'image' for this release; reserved for 'audio' / 'file'
  // in later features. attachmentMeta carries width/height/bytes/format so
  // the client can render an aspect-correct thumbnail without an extra
  // Cloudinary transform call. All three are null for text-only messages.
  attachmentUrl?: string | null;
  attachmentType?: string | null;
  attachmentMeta?: Record<string, any> | null;
}

// ─── Reaction allow-list ───────────────────────────────────────────────────
//
// Reactions are stored as short type strings on the server so the table
// stays compact. The client picks the unicode glyph it wants to render for
// each type. Extending this list is a code-only change; no migration needed.
export const REACTION_EMOJI_ALLOWLIST: ReadonlyArray<string> = [
  'heart',
  'clap',
  'thumbs_up',
  'laugh',
  'fire',
  'wow',
] as const;

export interface ConversationSummary {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageFromMe: boolean;
  unreadCount: number;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function normalizePair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

// ─── Authorization ─────────────────────────────────────────────────────────

/**
 * canMessage(a, b) — true iff a and b are allowed to DM each other right
 * now. Encounter-gate + block-gate. The DM UI's "Message" button calls
 * this so we render the right state on the profile page.
 */
export async function canMessage(
  userA: string,
  userB: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (userA === userB) {
    return { allowed: false, reason: 'self' };
  }

  // Block gate first — cheaper query, more common rejection.
  if (await blockService.areBlocked(userA, userB)) {
    return { allowed: false, reason: 'blocked' };
  }

  // Encounter gate: must share at least one encounter_history row.
  const [orderedA, orderedB] = normalizePair(userA, userB);
  const result = await query<{ id: string }>(
    `SELECT id FROM encounter_history
     WHERE user_a_id = $1 AND user_b_id = $2
     LIMIT 1`,
    [orderedA, orderedB],
  );
  if (result.rows.length === 0) {
    return { allowed: false, reason: 'no_encounter' };
  }

  return { allowed: true };
}

// ─── Sending ───────────────────────────────────────────────────────────────

/**
 * Send a DM. Creates the conversation row if it doesn't yet exist
 * (idempotent first-message). Updates last_message_at. Clears any prior
 * soft-delete on the sender's side (their own send means they want this
 * conversation back). Returns the created message + conversation id so
 * the caller can broadcast via socket.
 *
 * Authorization is re-checked here — the canMessage() guard at the UI
 * level is convenient but the source of truth is server-side.
 */
export interface SendMessageAttachment {
  url: string;
  // Feature 20 (13 May) — audio voice messages join images as a supported
  // attachment type. Both upload to Cloudinary via the same unsigned preset
  // and live on res.cloudinary.com.
  type: 'image' | 'audio';
  meta?: Record<string, any> | null;
}

export async function sendMessage(
  fromUserId: string,
  toUserId: string,
  content: string,
  attachment?: SendMessageAttachment | null,
): Promise<{ message: DmMessage; conversationId: string }> {
  if (fromUserId === toUserId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot DM yourself');
  }

  const trimmed = (content ?? '').trim();
  const hasText = trimmed.length > 0;
  const hasAttachment = !!attachment?.url;

  // Feature 19 (13 May spec) — a message must carry text, an attachment, or
  // both. Pure-empty submissions are still rejected.
  if (!hasText && !hasAttachment) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message cannot be empty');
  }
  if (trimmed.length > 4000) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message too long (max 4000 characters)');
  }
  if (hasAttachment) {
    if (attachment!.type !== 'image' && attachment!.type !== 'audio') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Unsupported attachment type');
    }
    // Defence-in-depth: only accept Cloudinary URLs so a hostile client can't
    // smuggle an arbitrary endpoint into the timeline. The unsigned upload
    // preset already restricts file type and size on Cloudinary's side.
    if (!/^https:\/\/res\.cloudinary\.com\//.test(attachment!.url)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Attachment URL must be hosted on Cloudinary');
    }
  }

  const auth = await canMessage(fromUserId, toUserId);
  if (!auth.allowed) {
    const message =
      auth.reason === 'blocked' ? 'You can no longer message this user'
      : auth.reason === 'no_encounter' ? "You can't DM someone you haven't met yet"
      : 'You cannot DM this user';
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, message);
  }

  return transaction(async (client) => {
    const [orderedA, orderedB] = normalizePair(fromUserId, toUserId);

    // Upsert the conversation row. The deleter side's timestamp is cleared
    // on the sender's edge so their inbox re-shows the conversation.
    const isSenderA = fromUserId === orderedA;
    const clearDeletedColumn = isSenderA ? 'user_a_deleted_at' : 'user_b_deleted_at';

    const convResult = await client.query<{ id: string }>(
      `INSERT INTO dm_conversations (id, user_a_id, user_b_id, last_message_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_a_id, user_b_id) DO UPDATE
         SET last_message_at = NOW(),
             ${clearDeletedColumn} = NULL
       RETURNING id`,
      [uuid(), orderedA, orderedB],
    );
    const conversationId = convResult.rows[0].id;

    const msgResult = await client.query<{
      id: string; conversation_id: string; from_user_id: string;
      content: string; read_at: Date | null; created_at: Date;
      attachment_url: string | null; attachment_type: string | null;
      attachment_meta: Record<string, any> | null;
    }>(
      `INSERT INTO direct_messages (
         id, conversation_id, from_user_id, content,
         attachment_url, attachment_type, attachment_meta
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, conversation_id, from_user_id, content, read_at, created_at,
                 attachment_url, attachment_type, attachment_meta`,
      [
        uuid(), conversationId, fromUserId,
        hasText ? trimmed : '',
        hasAttachment ? attachment!.url : null,
        hasAttachment ? attachment!.type : null,
        hasAttachment ? (attachment!.meta ?? null) : null,
      ],
    );

    const m = msgResult.rows[0];
    logger.info({ fromUserId, toUserId, conversationId, messageId: m.id, attachment: hasAttachment }, 'DM sent');

    return {
      conversationId,
      message: {
        id: m.id,
        conversationId: m.conversation_id,
        fromUserId: m.from_user_id,
        content: m.content,
        readAt: m.read_at,
        createdAt: m.created_at,
        attachmentUrl: m.attachment_url,
        attachmentType: m.attachment_type,
        attachmentMeta: m.attachment_meta,
      },
    };
  });
}

// ─── Reading ───────────────────────────────────────────────────────────────

/**
 * List conversations for me. Most recent first. Includes other user's
 * display name + avatar, last message snippet, unread count, who sent
 * the last message. Soft-deleted conversations (from MY side) are
 * filtered out — but they re-appear when the other user sends a new
 * message via the deleted-clear logic in sendMessage().
 */
export async function listConversations(
  userId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ conversations: ConversationSummary[]; total: number }> {
  const page = options.page || 1;
  const pageSize = Math.min(options.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  // Count for pagination.
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM dm_conversations
     WHERE (user_a_id = $1 AND user_a_deleted_at IS NULL)
        OR (user_b_id = $1 AND user_b_deleted_at IS NULL)`,
    [userId],
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Main query: includes the other user's profile + last message snippet
  // + unread count in a single round-trip.
  const result = await query<{
    conversation_id: string;
    other_user_id: string;
    other_display_name: string | null;
    other_avatar_url: string | null;
    last_message: string | null;
    last_message_at: Date | null;
    last_message_from: string | null;
    last_attachment_type: string | null;
    unread_count: string;
  }>(
    // Feature 19 (13 May spec) — also surface the last message's attachment
    // type so the inbox can render "📷 Photo" when an image was the most
    // recent send and there's no text caption.
    `SELECT
        c.id AS conversation_id,
        CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS other_user_id,
        u.display_name AS other_display_name,
        u.avatar_url   AS other_avatar_url,
        last_msg.content    AS last_message,
        c.last_message_at,
        last_msg.from_user_id AS last_message_from,
        last_msg.attachment_type AS last_attachment_type,
        COALESCE(unread.cnt, '0')::text AS unread_count
     FROM dm_conversations c
     JOIN users u ON u.id = (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END)
     LEFT JOIN LATERAL (
       SELECT content, from_user_id, attachment_type
       FROM direct_messages
       WHERE conversation_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) last_msg ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::text AS cnt
       FROM direct_messages
       WHERE conversation_id = c.id
         AND from_user_id != $1
         AND read_at IS NULL
     ) unread ON TRUE
     WHERE (c.user_a_id = $1 AND c.user_a_deleted_at IS NULL)
        OR (c.user_b_id = $1 AND c.user_b_deleted_at IS NULL)
     ORDER BY c.last_message_at DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, offset],
  );

  return {
    conversations: result.rows.map(r => {
      // Feature 19 — inbox preview falls back to a small icon-text when the
      // last message is an attachment with no caption, so the recipient
      // doesn't see an empty preview row.
      const hasText = !!(r.last_message && r.last_message.trim().length > 0);
      const previewText = hasText
        ? r.last_message
        : r.last_attachment_type === 'image'
          ? '📷 Photo'
          : r.last_attachment_type === 'audio'
            ? '🎤 Voice message'
            : null;
      return {
        conversationId: r.conversation_id,
        otherUserId: r.other_user_id,
        otherDisplayName: r.other_display_name,
        otherAvatarUrl: r.other_avatar_url,
        lastMessage: previewText,
        lastMessageAt: r.last_message_at,
        lastMessageFromMe: r.last_message_from === userId,
        unreadCount: parseInt(r.unread_count, 10),
      };
    }),
    total,
  };
}

/**
 * List messages in a conversation. Caller must be one of the two users.
 * Soft-deleted conversations (from MY side) return 404 — once you delete
 * a conversation it's gone for you until the other side sends again.
 */
export async function listMessages(
  conversationId: string,
  userId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ messages: DmMessage[]; total: number }> {
  const page = options.page || 1;
  const pageSize = Math.min(options.pageSize || 50, 200);
  const offset = (page - 1) * pageSize;

  // Authorize + check soft-delete state.
  const convResult = await query<{
    user_a_id: string; user_b_id: string;
    user_a_deleted_at: Date | null; user_b_deleted_at: Date | null;
  }>(
    `SELECT user_a_id, user_b_id, user_a_deleted_at, user_b_deleted_at
     FROM dm_conversations WHERE id = $1`,
    [conversationId],
  );
  if (convResult.rows.length === 0) {
    throw new NotFoundError('Conversation', conversationId);
  }
  const conv = convResult.rows[0];
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You are not part of this conversation');
  }
  const myDeletedAt = conv.user_a_id === userId ? conv.user_a_deleted_at : conv.user_b_deleted_at;
  if (myDeletedAt !== null) {
    throw new NotFoundError('Conversation', conversationId);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM direct_messages WHERE conversation_id = $1`,
    [conversationId],
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Phase E: aggregate reactions per message in a single round-trip.
  // The LATERAL subquery groups dm_message_reactions by emoji and returns
  // a jsonb object shaped { [emoji_type]: [userId, userId, ...] }.
  const messagesResult = await query<{
    id: string; conversation_id: string; from_user_id: string;
    content: string; read_at: Date | null; created_at: Date;
    reactions: Record<string, string[]> | null;
    attachment_url: string | null;
    attachment_type: string | null;
    attachment_meta: Record<string, any> | null;
  }>(
    `SELECT
        m.id, m.conversation_id, m.from_user_id,
        m.content, m.read_at, m.created_at,
        m.attachment_url, m.attachment_type, m.attachment_meta,
        COALESCE(r.reactions, '{}'::jsonb) AS reactions
     FROM direct_messages m
     LEFT JOIN LATERAL (
       SELECT jsonb_object_agg(emoji, users) AS reactions
       FROM (
         SELECT emoji, jsonb_agg(user_id::text ORDER BY created_at) AS users
         FROM dm_message_reactions
         WHERE message_id = m.id
         GROUP BY emoji
       ) g
     ) r ON TRUE
     WHERE m.conversation_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2 OFFSET $3`,
    [conversationId, pageSize, offset],
  );

  return {
    messages: messagesResult.rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      fromUserId: r.from_user_id,
      content: r.content,
      readAt: r.read_at,
      createdAt: r.created_at,
      reactions: r.reactions || {},
      attachmentUrl: r.attachment_url,
      attachmentType: r.attachment_type,
      attachmentMeta: r.attachment_meta,
    })),
    total,
  };
}

/**
 * Mark all unread messages in this conversation that the recipient (me)
 * hasn't seen yet as read. Returns the timestamp used. Sender of the
 * messages should get a `dm:read_receipt` socket event from the caller.
 */
export async function markRead(
  conversationId: string,
  userId: string,
): Promise<{ readAt: Date | null; markedCount: number }> {
  const convResult = await query<{ user_a_id: string; user_b_id: string }>(
    `SELECT user_a_id, user_b_id FROM dm_conversations WHERE id = $1`,
    [conversationId],
  );
  if (convResult.rows.length === 0) {
    throw new NotFoundError('Conversation', conversationId);
  }
  if (convResult.rows[0].user_a_id !== userId && convResult.rows[0].user_b_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You are not part of this conversation');
  }

  const result = await query<{ now: Date }>(
    `UPDATE direct_messages
     SET read_at = NOW()
     WHERE conversation_id = $1
       AND from_user_id != $2
       AND read_at IS NULL
     RETURNING NOW() AS now`,
    [conversationId, userId],
  );

  return {
    readAt: result.rows[0]?.now || null,
    markedCount: result.rowCount || 0,
  };
}

/**
 * Soft-delete the conversation from the user's view. The other party's
 * view is unaffected. A new incoming message clears the deleter's
 * timestamp (handled in sendMessage). Idempotent.
 */
export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  const convResult = await query<{ user_a_id: string; user_b_id: string }>(
    `SELECT user_a_id, user_b_id FROM dm_conversations WHERE id = $1`,
    [conversationId],
  );
  if (convResult.rows.length === 0) {
    throw new NotFoundError('Conversation', conversationId);
  }
  const conv = convResult.rows[0];
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You are not part of this conversation');
  }

  const sideColumn = conv.user_a_id === userId ? 'user_a_deleted_at' : 'user_b_deleted_at';
  await query(
    `UPDATE dm_conversations SET ${sideColumn} = NOW() WHERE id = $1`,
    [conversationId],
  );

  logger.info({ conversationId, userId }, 'DM conversation soft-deleted');
}

/**
 * Total unread DM count for the user. Used by the bell badge.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM direct_messages dm
     JOIN dm_conversations c ON c.id = dm.conversation_id
     WHERE dm.from_user_id != $1
       AND dm.read_at IS NULL
       AND ((c.user_a_id = $1 AND c.user_a_deleted_at IS NULL)
            OR (c.user_b_id = $1 AND c.user_b_deleted_at IS NULL))`,
    [userId],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

// ─── Reactions (Phase E) ───────────────────────────────────────────────────

/**
 * Look up the message + its conversation participants. Throws NotFound if
 * the message has no conversation row (it could be a group message — those
 * are out-of-scope for this phase).
 */
async function loadMessageContext(messageId: string): Promise<{
  conversationId: string;
  userAId: string;
  userBId: string;
}> {
  const result = await query<{
    conversation_id: string | null;
    user_a_id: string;
    user_b_id: string;
  }>(
    `SELECT m.conversation_id, c.user_a_id, c.user_b_id
       FROM direct_messages m
       JOIN dm_conversations c ON c.id = m.conversation_id
      WHERE m.id = $1`,
    [messageId],
  );
  if (result.rows.length === 0 || !result.rows[0].conversation_id) {
    throw new NotFoundError('Message', messageId);
  }
  return {
    conversationId: result.rows[0].conversation_id,
    userAId: result.rows[0].user_a_id,
    userBId: result.rows[0].user_b_id,
  };
}

/**
 * Add an emoji reaction to a DM. Idempotent — adding the same emoji twice
 * by the same user is a no-op (ON CONFLICT DO NOTHING). Authorization is
 * conversation-participant: only the two users in the conversation can
 * react. Emoji must be in the REACTION_EMOJI_ALLOWLIST.
 *
 * Returns the conversation id + the *other* participant's user id so the
 * caller (socket handler) can fan-out the broadcast without a second query.
 */
export async function addReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ conversationId: string; otherUserId: string }> {
  if (!REACTION_EMOJI_ALLOWLIST.includes(emoji)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `Reaction must be one of: ${REACTION_EMOJI_ALLOWLIST.join(', ')}`,
    );
  }

  const ctx = await loadMessageContext(messageId);
  if (ctx.userAId !== userId && ctx.userBId !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You cannot react in this conversation');
  }

  await query(
    `INSERT INTO dm_message_reactions (message_id, user_id, emoji)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
    [messageId, userId, emoji],
  );

  const otherUserId = ctx.userAId === userId ? ctx.userBId : ctx.userAId;
  logger.info({ messageId, userId, emoji, conversationId: ctx.conversationId }, 'DM reaction added');
  return { conversationId: ctx.conversationId, otherUserId };
}

/**
 * Remove an emoji reaction. Idempotent — removing one that doesn't exist
 * is a no-op. Authorization mirrors addReaction.
 */
export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ conversationId: string; otherUserId: string }> {
  if (!REACTION_EMOJI_ALLOWLIST.includes(emoji)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `Reaction must be one of: ${REACTION_EMOJI_ALLOWLIST.join(', ')}`,
    );
  }

  const ctx = await loadMessageContext(messageId);
  if (ctx.userAId !== userId && ctx.userBId !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You cannot react in this conversation');
  }

  await query(
    `DELETE FROM dm_message_reactions
      WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, userId, emoji],
  );

  const otherUserId = ctx.userAId === userId ? ctx.userBId : ctx.userAId;
  logger.info({ messageId, userId, emoji, conversationId: ctx.conversationId }, 'DM reaction removed');
  return { conversationId: ctx.conversationId, otherUserId };
}
