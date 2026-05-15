// ─── DM Socket Handlers ──────────────────────────────────────────────────────
//
// Phase D of chat-fix-and-dm-system plan (1 May 2026). Real-time DM delivery
// + bell-icon notifications + offline-email fallback.
//
// Socket events:
//
//   client → server:
//     dm:send       — { toUserId, content } — send a DM
//     dm:read       — { conversationId } — mark conversation as read
//
//   server → both users:
//     dm:message    — full DmMessage payload, broadcast to sender's
//                     userRoom AND recipient's userRoom so any of their
//                     open tabs / sessions see the message live
//     dm:conversation_updated — { conversationId, lastMessageAt, unreadCount,
//                                 lastMessage } — for inbox sort + badge
//
//   server → sender only:
//     dm:read_receipt — { conversationId, readBy, readAt, markedCount }
//
// Notification path:
//   - On every dm:send, insert a row into the notifications table with
//     type='direct_message' and emit `notification:new` to the recipient's
//     userRoom (existing pattern reused from invite notifications).
//
// Email path:
//   - If the recipient has no live socket OR has been idle >10 minutes,
//     send an email via the existing emailService.
//   - Debounce via Redis: one email per (sender, recipient) pair per hour
//     so a flurry of messages doesn't generate a flurry of emails.

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { v4 as uuid } from 'uuid';
import * as dmService from '../../dm/dm.service';
import * as emailService from '../../email/email.service';
import * as prefsService from '../../notification-prefs/notification-prefs.service';
import { getRedisClient } from '../../redis/redis.client';
import config from '../../../config';

const userRoom = (userId: string) => `user:${userId}`;

// Email debounce: one email per (sender, recipient) pair per hour.
const DM_EMAIL_DEBOUNCE_TTL_SECONDS = 3600;
// Recipient considered "offline enough to email" if they're not connected
// to ANY socket. We don't need to check idle time — if they're not
// connected, they're not seeing the bell badge either.

/**
 * Get the user's socket connections in the io server. Returns the count.
 * Zero means the recipient is not currently online and we should email them.
 */
async function isUserOnline(io: SocketServer, userId: string): Promise<boolean> {
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  return sockets.length > 0;
}

/**
 * Send the recipient an email only if we haven't already sent one for this
 * pair in the last hour. Best-effort: any error is logged and swallowed.
 */
async function maybeSendDmEmail(
  fromUserId: string,
  toUserId: string,
  contentSnippet: string,
  conversationId: string,
): Promise<void> {
  // Phase J — respect recipient's notification preferences. Skip email
  // entirely if they've turned off DM email in settings.
  if (!(await prefsService.shouldSendEmail(toUserId, 'dm'))) return;

  const redis = getRedisClient();
  const debounceKey = `dm:email-debounce:${fromUserId}:${toUserId}`;

  // Check debounce
  if (redis) {
    try {
      const exists = await redis.get(debounceKey);
      if (exists) return; // recently emailed, skip
    } catch (err) {
      logger.warn({ err, debounceKey }, 'Redis debounce check failed; falling through to send');
    }
  }

  // Look up sender + recipient details for the email body
  const userResult = await query<{
    id: string; email: string | null; display_name: string | null;
  }>(
    `SELECT id, email, display_name FROM users WHERE id = ANY($1)`,
    [[fromUserId, toUserId]],
  );
  const sender = userResult.rows.find(u => u.id === fromUserId);
  const recipient = userResult.rows.find(u => u.id === toUserId);
  if (!recipient || !recipient.email || !sender) {
    logger.warn({ fromUserId, toUserId }, 'DM email skipped: missing sender or recipient details');
    return;
  }

  try {
    await emailService.sendDmNotificationEmail(
      recipient.email,
      recipient.display_name || 'there',
      {
        senderName: sender.display_name || 'Someone',
        snippet: contentSnippet.slice(0, 200),
        threadUrl: `${config.clientUrl}/messages/${conversationId}`,
      },
    );
    logger.info({ fromUserId, toUserId }, 'DM email sent');

    if (redis) {
      try {
        await redis.set(debounceKey, '1', 'EX', DM_EMAIL_DEBOUNCE_TTL_SECONDS);
      } catch (err) {
        logger.warn({ err, debounceKey }, 'Failed to write debounce key');
      }
    }
  } catch (err) {
    logger.warn({ err, fromUserId, toUserId }, 'DM email failed to send (non-fatal)');
  }
}

// ─── Real-time broadcast helper ────────────────────────────────────────────
//
// Shared between handleDmSend (socket path) and the POST /dm/messages REST
// route handler. Pre-refactor (pre-15 May) the broadcast logic lived only
// inside handleDmSend — so when the client switched to the REST endpoint
// (the path used by the Messages UI today) messages persisted to the DB
// but never reached the recipient's open tab, who had to refresh to see
// them. Ali called this out during the 15 May DM testing. Extracting the
// helper makes both code paths fire the same `dm:message` +
// `dm:conversation_updated` + `notification:new` fan-out so realtime
// delivery works regardless of which transport sent the message.

export interface BroadcastableDmMessage {
  id: string;
  conversationId: string;
  fromUserId: string;
  content: string | null;
  readAt: Date | null;
  createdAt: Date;
  attachmentUrl?: string | null;
  attachmentType?: string | null;
  attachmentMeta?: Record<string, any> | null;
}

/**
 * Fan out a new DM to both participants' user rooms, insert a bell-icon
 * notification for the recipient, and email them if they're offline.
 * Idempotent on the side-effects: emits + insert are best-effort and any
 * failure is logged, never thrown — the caller has already persisted the
 * message so we don't want a broadcast failure to look like a send failure.
 */
export async function broadcastDmMessage(
  io: SocketServer,
  fromUserId: string,
  toUserId: string,
  conversationId: string,
  message: BroadcastableDmMessage,
): Promise<void> {
  // Real-time fan-out: emit to BOTH users' rooms so any open tab updates.
  // Attachment fields included so the recipient renders the image / audio
  // inline without needing to refetch the thread.
  const payload = {
    id: message.id,
    conversationId: message.conversationId,
    fromUserId: message.fromUserId,
    content: message.content,
    readAt: message.readAt,
    createdAt: message.createdAt,
    attachmentUrl: message.attachmentUrl ?? null,
    attachmentType: message.attachmentType ?? null,
    attachmentMeta: message.attachmentMeta ?? null,
  };
  io.to(userRoom(fromUserId)).emit('dm:message', payload);
  io.to(userRoom(toUserId)).emit('dm:message', payload);

  // Inbox sort hint: lastMessageAt updated for both users' inbox UIs.
  // The client treats this event as an invalidation signal and refetches
  // the conversation list, so the preview text comes from the server's
  // listConversations (with the 📷 Photo / 🎤 Voice message fallback).
  const updatedPayload = {
    conversationId,
    lastMessageAt: message.createdAt,
    lastMessage: message.content ?? null,
    lastMessageFromUserId: fromUserId,
  };
  io.to(userRoom(fromUserId)).emit('dm:conversation_updated', updatedPayload);
  io.to(userRoom(toUserId)).emit('dm:conversation_updated', updatedPayload);

  // Bell notification — same pattern as invites so the bell icon counts
  // DMs alongside invite events consistently.
  try {
    const senderResult = await query<{ display_name: string | null }>(
      `SELECT display_name FROM users WHERE id = $1`, [fromUserId],
    );
    const senderName = senderResult.rows[0]?.display_name || 'Someone';
    const notifTitle = `${senderName} sent you a message`;
    // For attachment-only messages, the bell body falls back to a short
    // descriptor so the bell shows useful text instead of an empty bubble.
    const notifBody = message.content && message.content.trim().length > 0
      ? message.content.slice(0, 140)
      : message.attachmentType === 'image'
        ? '📷 Photo'
        : message.attachmentType === 'audio'
          ? '🎤 Voice message'
          : 'New message';
    const notifLink = `/messages/${conversationId}`;
    const notifResult = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES ($1, $2, 'direct_message', $3, $4, $5)
       RETURNING id, created_at`,
      [uuid(), toUserId, notifTitle, notifBody, notifLink],
    );
    io.to(userRoom(toUserId)).emit('notification:new', {
      id: notifResult.rows[0].id,
      type: 'direct_message',
      title: notifTitle,
      body: notifBody,
      link: notifLink,
      isRead: false,
      createdAt: notifResult.rows[0].created_at,
    });
  } catch (err) {
    logger.warn({ err, fromUserId, toUserId }, 'DM notification insert failed (non-fatal)');
  }

  // Offline fallback: email the recipient (debounced) if they're not
  // connected. Snippet uses the content if present; attachment-only sends
  // get a small descriptor so the email body isn't empty.
  try {
    const recipientOnline = await isUserOnline(io, toUserId);
    if (!recipientOnline) {
      const snippet = message.content && message.content.trim().length > 0
        ? message.content
        : message.attachmentType === 'image'
          ? '📷 Sent you a photo'
          : message.attachmentType === 'audio'
            ? '🎤 Sent you a voice message'
            : 'New message';
      void maybeSendDmEmail(fromUserId, toUserId, snippet, conversationId);
    }
  } catch (err) {
    logger.warn({ err, fromUserId, toUserId }, 'DM offline-email check failed (non-fatal)');
  }
}

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function handleDmSend(
  io: SocketServer,
  socket: Socket,
  data: { toUserId: string; content: string },
): Promise<void> {
  try {
    const userId = (socket.data as any)?.userId;
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }
    if (!data?.toUserId || typeof data.content !== 'string') {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'toUserId and content are required' });
      return;
    }

    const { message, conversationId } = await dmService.sendMessage(
      userId, data.toUserId, data.content,
    );

    await broadcastDmMessage(io, userId, data.toUserId, conversationId, message);
  } catch (err: any) {
    const code = err?.code || 'DM_SEND_FAILED';
    const message = err?.message || 'Failed to send message';
    logger.warn({ err }, 'handleDmSend failed');
    socket.emit('error', { code, message });
  }
}

// ─── Reaction handlers (Phase E) ───────────────────────────────────────────

export async function handleDmReact(
  io: SocketServer,
  socket: Socket,
  data: { messageId: string; emoji: string },
): Promise<void> {
  try {
    const userId = (socket.data as any)?.userId;
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }
    if (!data?.messageId || typeof data.emoji !== 'string') {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'messageId and emoji are required' });
      return;
    }

    const { conversationId, otherUserId } = await dmService.addReaction(
      data.messageId, userId, data.emoji,
    );

    const payload = {
      messageId: data.messageId,
      conversationId,
      userId,
      emoji: data.emoji,
    };
    io.to(userRoom(userId)).emit('dm:reaction_added', payload);
    io.to(userRoom(otherUserId)).emit('dm:reaction_added', payload);
  } catch (err: any) {
    const code = err?.code || 'DM_REACT_FAILED';
    const message = err?.message || 'Failed to add reaction';
    logger.warn({ err }, 'handleDmReact failed');
    socket.emit('error', { code, message });
  }
}

export async function handleDmUnreact(
  io: SocketServer,
  socket: Socket,
  data: { messageId: string; emoji: string },
): Promise<void> {
  try {
    const userId = (socket.data as any)?.userId;
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }
    if (!data?.messageId || typeof data.emoji !== 'string') {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'messageId and emoji are required' });
      return;
    }

    const { conversationId, otherUserId } = await dmService.removeReaction(
      data.messageId, userId, data.emoji,
    );

    const payload = {
      messageId: data.messageId,
      conversationId,
      userId,
      emoji: data.emoji,
    };
    io.to(userRoom(userId)).emit('dm:reaction_removed', payload);
    io.to(userRoom(otherUserId)).emit('dm:reaction_removed', payload);
  } catch (err: any) {
    const code = err?.code || 'DM_UNREACT_FAILED';
    const message = err?.message || 'Failed to remove reaction';
    logger.warn({ err }, 'handleDmUnreact failed');
    socket.emit('error', { code, message });
  }
}

export async function handleDmRead(
  io: SocketServer,
  socket: Socket,
  data: { conversationId: string },
): Promise<void> {
  try {
    const userId = (socket.data as any)?.userId;
    if (!userId) return;
    if (!data?.conversationId) return;

    const { readAt, markedCount } = await dmService.markRead(data.conversationId, userId);

    if (markedCount > 0 && readAt) {
      // Find the OTHER user in this conversation so we can ping their
      // sender-side read receipt.
      const convResult = await query<{ user_a_id: string; user_b_id: string }>(
        `SELECT user_a_id, user_b_id FROM dm_conversations WHERE id = $1`,
        [data.conversationId],
      );
      const conv = convResult.rows[0];
      if (conv) {
        const otherUserId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
        const payload = {
          conversationId: data.conversationId,
          readBy: userId,
          readAt,
          markedCount,
        };
        // Sender sees the read receipt; reader's own session updates its
        // local "unread = 0" state too.
        io.to(userRoom(otherUserId)).emit('dm:read_receipt', payload);
        io.to(userRoom(userId)).emit('dm:read_receipt', payload);
      }
    }
  } catch (err: any) {
    logger.warn({ err }, 'handleDmRead failed');
  }
}
