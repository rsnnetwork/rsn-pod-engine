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

    // Real-time fan-out: emit to BOTH users' rooms so any open tab updates.
    const payload = {
      id: message.id,
      conversationId: message.conversationId,
      fromUserId: message.fromUserId,
      content: message.content,
      readAt: message.readAt,
      createdAt: message.createdAt,
    };
    io.to(userRoom(userId)).emit('dm:message', payload);
    io.to(userRoom(data.toUserId)).emit('dm:message', payload);

    // Inbox sort hint: lastMessageAt updated for both users' inbox UIs.
    const updatedPayload = {
      conversationId,
      lastMessageAt: message.createdAt,
      lastMessage: message.content,
      lastMessageFromUserId: userId,
    };
    io.to(userRoom(userId)).emit('dm:conversation_updated', updatedPayload);
    io.to(userRoom(data.toUserId)).emit('dm:conversation_updated', updatedPayload);

    // Bell notification — write to notifications table, emit notification:new.
    // Use the existing pattern from invites so the bell icon counts DMs
    // alongside invites consistently.
    const senderResult = await query<{ display_name: string | null }>(
      `SELECT display_name FROM users WHERE id = $1`, [userId],
    );
    const senderName = senderResult.rows[0]?.display_name || 'Someone';
    const notifId = uuid();
    const notifTitle = `${senderName} sent you a message`;
    const notifBody = data.content.slice(0, 140);
    const notifLink = `/messages/${conversationId}`;

    try {
      const notifResult = await query<{ id: string; created_at: Date }>(
        `INSERT INTO notifications (id, user_id, type, title, body, link)
         VALUES ($1, $2, 'direct_message', $3, $4, $5)
         RETURNING id, created_at`,
        [notifId, data.toUserId, notifTitle, notifBody, notifLink],
      );
      io.to(userRoom(data.toUserId)).emit('notification:new', {
        id: notifResult.rows[0].id,
        type: 'direct_message',
        title: notifTitle,
        body: notifBody,
        link: notifLink,
        isRead: false,
        createdAt: notifResult.rows[0].created_at,
      });
    } catch (err) {
      logger.warn({ err, fromUserId: userId, toUserId: data.toUserId }, 'DM notification insert failed (non-fatal)');
    }

    // Offline fallback: email the recipient (debounced).
    const recipientOnline = await isUserOnline(io, data.toUserId);
    if (!recipientOnline) {
      // Don't await — email send is best-effort and we don't want to block
      // the socket response on it.
      void maybeSendDmEmail(userId, data.toUserId, data.content, conversationId);
    }
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
