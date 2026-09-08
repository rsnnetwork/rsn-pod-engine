// ─── 1:1 meeting calls (W-meet, 8 Sep 2026) ─────────────────────────────────
//
// A meeting on RSN is a real audio/video call the two people join on our own
// platform, using the same LiveKit video the events use. The room is stable per
// conversation (`dm-<conversationId>`), so a scheduled Join and an instant "Meet
// now" enter the same place. Tokens are minted only for the two participants,
// and never when either has blocked the other.

import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { getVideoProvider } from '../video/video.service';
import * as blockService from '../block/block.service';
import { isActive } from '../presence/presence.service';

const CALL_TOKEN_TTL_SECONDS = 4 * 60 * 60; // a call can run a while

export function callRoomId(conversationId: string): string {
  return `dm-${conversationId}`;
}

interface ConvParticipants {
  id: string;
  user_a_id: string;
  user_b_id: string;
  partnerId: string;
}

/** Load the conversation, prove the caller is in it and not blocked either way. */
async function requireCallParticipant(conversationId: string, userId: string): Promise<ConvParticipants> {
  const r = await query<{ id: string; user_a_id: string; user_b_id: string }>(
    `SELECT id, user_a_id, user_b_id FROM dm_conversations WHERE id = $1`,
    [conversationId],
  );
  const conv = r.rows[0];
  if (!conv) throw new NotFoundError('Conversation', conversationId);
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your conversation');
  }
  const partnerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
  if (await blockService.areBlocked(userId, partnerId)) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You cannot call this member');
  }
  return { ...conv, partnerId };
}

/**
 * Is the other participant actually on the platform right now? Uses the
 * app-level presence heartbeat (foreground pings) so a lingering/backgrounded
 * socket doesn't read as online. Falls back to a live socket check only when
 * Redis (the presence store) is unavailable.
 */
export async function isPartnerOnline(conversationId: string, userId: string): Promise<boolean> {
  const conv = await requireCallParticipant(conversationId, userId);
  const active = await isActive(conv.partnerId);
  if (active !== null) return active;
  // Redis down → best-effort socket presence.
  try {
    const { io } = await import('../../index');
    const sockets = await io.in(`user:${conv.partnerId}`).fetchSockets();
    return sockets.length > 0;
  } catch (err) {
    logger.warn({ err, conversationId }, 'partner presence check failed');
    return false;
  }
}

export interface CallToken {
  token: string;
  url: string;
  roomName: string;
  kind: 'audio' | 'video';
}

/** Mint a LiveKit token so this participant can join the conversation's call. */
export async function getCallToken(
  conversationId: string,
  userId: string,
  kind: 'audio' | 'video',
): Promise<CallToken> {
  await requireCallParticipant(conversationId, userId);
  const me = (await query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [userId],
  )).rows[0];
  const roomName = callRoomId(conversationId);
  const issued = await getVideoProvider().issueJoinToken(
    userId, roomName, me?.display_name || 'Member', CALL_TOKEN_TTL_SECONDS,
  );
  return { token: issued.token, url: config.livekit.host, roomName, kind: kind === 'audio' ? 'audio' : 'video' };
}

/**
 * "Meet now": start an instant call. The partner must be online (a live socket),
 * else the caller is told to schedule instead. Notifies the partner in-app + via
 * socket, drops a system line in the thread, and returns the caller's token.
 */
export async function startCall(
  conversationId: string,
  userId: string,
  kind: 'audio' | 'video',
): Promise<CallToken> {
  const conv = await requireCallParticipant(conversationId, userId);
  const callKind: 'audio' | 'video' = kind === 'audio' ? 'audio' : 'video';

  // Partner must be actually online right now (foreground heartbeat), same
  // signal that gates the button. Fall back to a socket check if Redis is down.
  let partnerOnline = false;
  const active = await isActive(conv.partnerId);
  if (active !== null) {
    partnerOnline = active;
  } else {
    try {
      const { io } = await import('../../index');
      const sockets = await io.in(`user:${conv.partnerId}`).fetchSockets();
      partnerOnline = sockets.length > 0;
    } catch (err) {
      logger.warn({ err, conversationId }, 'could not check partner presence for call');
    }
  }
  if (!partnerOnline) {
    throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'They are offline right now — schedule a meeting instead.');
  }

  const me = (await query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [userId],
  )).rows[0];
  const callerName = me?.display_name || 'Someone';
  const link = `/meet/${conversationId}`;

  // A system line in the thread so the call shows in history for both sides.
  try {
    const dmService = await import('./dm.service');
    const sent = await dmService.sendBroadcastMessage(userId, conv.partnerId, `📞 Started a ${callKind} call`);
    const { io } = await import('../../index');
    const { broadcastDmMessage } = await import('../orchestration/handlers/dm-handlers');
    await broadcastDmMessage(io, userId, conv.partnerId, sent.conversationId, sent.message, { notify: false });
  } catch (err) {
    logger.warn({ err, conversationId }, 'call system message failed (non-fatal)');
  }

  // Ring the partner: bell notification + a live socket event they can answer.
  try {
    const notif = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES (gen_random_uuid(), $1, 'incoming_call', $2, $3, $4)
       RETURNING id, created_at`,
      [conv.partnerId, `${callerName} is calling`, `Tap to join the ${callKind} call.`, link],
    );
    const { io } = await import('../../index');
    io.to(`user:${conv.partnerId}`).emit('notification:new', {
      id: notif.rows[0].id, type: 'incoming_call', title: `${callerName} is calling`,
      body: `Tap to join the ${callKind} call.`, link, isRead: false, createdAt: notif.rows[0].created_at,
    });
    io.to(`user:${conv.partnerId}`).emit('call:incoming', {
      conversationId, fromUserId: userId, fromName: callerName, kind: callKind, link,
    });
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    emitEntities(io, [conv.partnerId], [E.userNotifications(conv.partnerId)]).catch(() => {});
  } catch (err) {
    logger.warn({ err, conversationId }, 'incoming-call ring failed (non-fatal)');
  }

  return getCallToken(conversationId, userId, callKind);
}
