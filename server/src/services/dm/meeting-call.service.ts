// ─── 1:1 meeting calls (W-meet, 8 Sep 2026; call gate + requests, 9 Sep) ───
//
// A meeting on RSN is a real audio/video call the two people join on our own
// platform, using the same LiveKit video the events use. The room is stable per
// conversation (`dm-<conversationId>`), so a scheduled Join and a later call
// enter the same place. Tokens are minted only for the two participants, and
// never when either has blocked the other.
//
// Ali's model (9 Sep 2026): after an accepted intro the pair can chat and use the
// meeting scheduler, but NOT call. Once a scheduled meeting has actually
// happened — both joined the room inside its window — calls unlock for that
// pair and the scheduler steps aside. Calls then go request → accept, with a
// duration the caller types (Stefan: "choose the intended duration, start once
// the other accepts").

import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { getVideoProvider } from '../video/video.service';
import * as blockService from '../block/block.service';
import { isActive } from '../presence/presence.service';

const CALL_TOKEN_TTL_SECONDS = 4 * 60 * 60; // a call can run a while
// The scheduled-meeting window: you may enter from 5 min before, and it stays
// open until 30 min after the end (overruns / reconnects). Mirrors MeetPage.
const EARLY_JOIN_MS = 5 * 60 * 1000;
const MEETING_GRACE_MS = 30 * 60 * 1000;
/** A call request is answered within this window or it lapses. */
export const CALL_REQUEST_TTL_MS = 2 * 60 * 1000;
export const MIN_CALL_MIN = 5;
export const MAX_CALL_MIN = 240;

export function callRoomId(conversationId: string): string {
  return `dm-${conversationId}`;
}

interface ConvParticipants {
  id: string;
  user_a_id: string;
  user_b_id: string;
  partnerId: string;
  iAmA: boolean;
  calls_unlocked_at: Date | null;
  meeting_start_at: Date | null;
  meeting_duration_min: number | null;
}

/** Load the conversation, prove the caller is in it and not blocked either way. */
async function requireCallParticipant(conversationId: string, userId: string): Promise<ConvParticipants> {
  const r = await query<{
    id: string; user_a_id: string; user_b_id: string;
    calls_unlocked_at: Date | null; meeting_start_at: Date | null; meeting_duration_min: number | null;
  }>(
    `SELECT id, user_a_id, user_b_id, calls_unlocked_at, meeting_start_at, meeting_duration_min
       FROM dm_conversations WHERE id = $1`,
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
  return { ...conv, partnerId, iAmA: conv.user_a_id === userId };
}

/** Calls are only available once this pair's first scheduled meeting has happened. */
function requireUnlocked(conv: ConvParticipants): void {
  if (!conv.calls_unlocked_at) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Calls unlock after your first scheduled meeting together.');
  }
}

/** Is the partner actually on the platform now? Heartbeat first, socket fallback. */
async function partnerIsOnline(partnerId: string, conversationId: string): Promise<boolean> {
  const active = await isActive(partnerId);
  if (active !== null) return active;
  try {
    const { io } = await import('../../index');
    const sockets = await io.in(`user:${partnerId}`).fetchSockets();
    return sockets.length > 0;
  } catch (err) {
    logger.warn({ err, conversationId }, 'partner presence check failed');
    return false;
  }
}

/**
 * Is the other participant actually on the platform right now? Uses the
 * app-level presence heartbeat (foreground pings) so a lingering/backgrounded
 * socket doesn't read as online. Falls back to a live socket check only when
 * Redis (the presence store) is unavailable.
 */
export async function isPartnerOnline(conversationId: string, userId: string): Promise<boolean> {
  const conv = await requireCallParticipant(conversationId, userId);
  return partnerIsOnline(conv.partnerId, conversationId);
}

export interface CallToken {
  token: string;
  url: string;
  roomName: string;
  kind: 'audio' | 'video';
}

/**
 * Entering the room before calls are unlocked can only mean joining the
 * scheduled meeting. If that's inside the meeting's window it counts as
 * attending; once BOTH sides have attended, calls unlock for the pair and both
 * clients are told (the scheduler goes away, the call buttons appear).
 */
async function recordScheduledJoin(conv: ConvParticipants, userId: string): Promise<void> {
  if (!conv.meeting_start_at) return; // nothing scheduled → nothing to attend
  const start = conv.meeting_start_at.getTime();
  const end = start + (conv.meeting_duration_min ?? 30) * 60_000;
  const now = Date.now();
  if (now < start - EARLY_JOIN_MS || now > end + MEETING_GRACE_MS) return; // outside the window

  const col = conv.iAmA ? 'meeting_joined_a_at' : 'meeting_joined_b_at';
  const stamped = await query<{ a: Date | null; b: Date | null }>(
    `UPDATE dm_conversations SET ${col} = COALESCE(${col}, NOW())
      WHERE id = $1
      RETURNING meeting_joined_a_at AS a, meeting_joined_b_at AS b`,
    [conv.id],
  );
  const row = stamped.rows[0];
  if (!row?.a || !row?.b) return;

  await query(
    `UPDATE dm_conversations SET calls_unlocked_at = COALESCE(calls_unlocked_at, NOW()) WHERE id = $1`,
    [conv.id],
  );
  logger.info({ conversationId: conv.id, userId }, 'calls unlocked after first meeting');
  try {
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await emitEntities(io, [conv.user_a_id, conv.user_b_id], [E.dmConversation(conv.id)]);
  } catch (err) {
    logger.warn({ err, conversationId: conv.id }, 'calls-unlocked signal failed (non-fatal)');
  }
}

/** Mint a LiveKit token so this participant can join the conversation's room. */
export async function getCallToken(
  conversationId: string,
  userId: string,
  kind: 'audio' | 'video',
): Promise<CallToken> {
  const conv = await requireCallParticipant(conversationId, userId);
  if (!conv.calls_unlocked_at) await recordScheduledJoin(conv, userId);
  const me = (await query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [userId],
  )).rows[0];
  const roomName = callRoomId(conversationId);
  const issued = await getVideoProvider().issueJoinToken(
    userId, roomName, me?.display_name || 'Member', CALL_TOKEN_TTL_SECONDS,
  );
  return { token: issued.token, url: config.livekit.host, roomName, kind: kind === 'audio' ? 'audio' : 'video' };
}

// ── Call requests (request → accept) ─────────────────────────────────────────

export type CallRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';

export interface CallRequest {
  id: string;
  conversationId: string;
  fromUserId: string;
  toUserId: string;
  kind: 'audio' | 'video';
  durationMin: number;
  status: CallRequestStatus;
  createdAt: Date;
}

interface RequestRow {
  id: string; conversation_id: string; from_user_id: string; to_user_id: string;
  kind: 'audio' | 'video'; duration_min: number; status: CallRequestStatus; created_at: Date;
}

function mapRequest(r: RequestRow): CallRequest {
  return {
    id: r.id, conversationId: r.conversation_id, fromUserId: r.from_user_id, toUserId: r.to_user_id,
    kind: r.kind, durationMin: r.duration_min, status: r.status, createdAt: r.created_at,
  };
}

export function clampDuration(minutes: number): number {
  const n = Number.isFinite(minutes) ? Math.round(minutes) : 30;
  return Math.min(MAX_CALL_MIN, Math.max(MIN_CALL_MIN, n));
}

async function loadRequest(requestId: string): Promise<RequestRow> {
  const r = await query<RequestRow>(`SELECT * FROM call_requests WHERE id = $1`, [requestId]);
  if (!r.rows[0]) throw new NotFoundError('Call request', requestId);
  return r.rows[0];
}

function isExpired(rq: RequestRow): boolean {
  return Date.now() - new Date(rq.created_at).getTime() > CALL_REQUEST_TTL_MS;
}

/**
 * Ask the partner for a call of a chosen length. Requires calls to be unlocked
 * (first meeting happened) and the partner to be online right now. Rings them
 * with a bell notification + a live `call:request`, and leaves a line in the
 * thread. The caller then waits for accept/decline.
 */
export async function requestCall(
  conversationId: string,
  userId: string,
  kind: 'audio' | 'video',
  durationMin: number,
): Promise<CallRequest> {
  const conv = await requireCallParticipant(conversationId, userId);
  requireUnlocked(conv);
  const callKind: 'audio' | 'video' = kind === 'audio' ? 'audio' : 'video';
  const minutes = clampDuration(durationMin);

  if (!(await partnerIsOnline(conv.partnerId, conversationId))) {
    throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'They are offline right now — try again when they are online.');
  }

  // A stale unanswered request shouldn't block a new one.
  await query(
    `UPDATE call_requests SET status = 'expired', responded_at = NOW()
      WHERE conversation_id = $1 AND status = 'pending' AND created_at < NOW() - INTERVAL '2 minutes'`,
    [conversationId],
  );

  let inserted: { id: string; created_at: Date };
  try {
    const ins = await query<{ id: string; created_at: Date }>(
      `INSERT INTO call_requests (conversation_id, from_user_id, to_user_id, kind, duration_min)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [conversationId, userId, conv.partnerId, callKind, minutes],
    );
    inserted = ins.rows[0];
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'A call request is already waiting for an answer.');
    }
    throw err;
  }

  const me = (await query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [userId],
  )).rows[0];
  const callerName = me?.display_name || 'Someone';

  // A line in the thread so the request shows in history for both sides.
  try {
    const dmService = await import('./dm.service');
    const sent = await dmService.sendBroadcastMessage(userId, conv.partnerId, `📞 Requested a ${minutes}-min ${callKind} call`);
    const { io } = await import('../../index');
    const { broadcastDmMessage } = await import('../orchestration/handlers/dm-handlers');
    await broadcastDmMessage(io, userId, conv.partnerId, sent.conversationId, sent.message, { notify: false });
  } catch (err) {
    logger.warn({ err, conversationId }, 'call request system message failed (non-fatal)');
  }

  // Ring the partner: bell notification + a live event they can accept/decline.
  const title = `${callerName} wants a ${minutes}-min ${callKind} call`;
  try {
    const notif = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES (gen_random_uuid(), $1, 'incoming_call', $2, $3, $4)
       RETURNING id, created_at`,
      [conv.partnerId, title, 'Accept to start the call.', `/messages/${conversationId}`],
    );
    const { io } = await import('../../index');
    io.to(`user:${conv.partnerId}`).emit('notification:new', {
      id: notif.rows[0].id, type: 'incoming_call', title, body: 'Accept to start the call.',
      link: `/messages/${conversationId}`, isRead: false, createdAt: notif.rows[0].created_at,
    });
    io.to(`user:${conv.partnerId}`).emit('call:request', {
      requestId: inserted.id, conversationId, fromUserId: userId, fromName: callerName, kind: callKind, durationMin: minutes,
    });
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    emitEntities(io, [conv.partnerId], [E.userNotifications(conv.partnerId)]).catch(() => {});
  } catch (err) {
    logger.warn({ err, conversationId }, 'call request ring failed (non-fatal)');
  }

  return {
    id: inserted.id, conversationId, fromUserId: userId, toUserId: conv.partnerId,
    kind: callKind, durationMin: minutes, status: 'pending', createdAt: inserted.created_at,
  };
}

/** The live (pending, unexpired) request on a conversation, if any — lets a
 *  refreshed client restore "waiting…" / "X wants a call" state. */
export async function getPendingCallRequest(conversationId: string, userId: string): Promise<CallRequest | null> {
  await requireCallParticipant(conversationId, userId);
  const r = await query<RequestRow>(
    `SELECT * FROM call_requests
      WHERE conversation_id = $1 AND status = 'pending' AND created_at >= NOW() - INTERVAL '2 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  return r.rows[0] ? mapRequest(r.rows[0]) : null;
}

/** The callee accepts → the caller is told, and the callee gets a room token. */
export async function acceptCallRequest(requestId: string, userId: string): Promise<CallToken & { conversationId: string }> {
  const rq = await loadRequest(requestId);
  if (rq.to_user_id !== userId) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your call request');
  if (rq.status !== 'pending') throw new AppError(409, ErrorCodes.VALIDATION_ERROR, `This call request was ${rq.status}.`);
  if (isExpired(rq)) {
    await query(`UPDATE call_requests SET status = 'expired', responded_at = NOW() WHERE id = $1`, [requestId]);
    throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'This call request has expired — ask them to call again.');
  }
  await query(`UPDATE call_requests SET status = 'accepted', responded_at = NOW() WHERE id = $1 AND status = 'pending'`, [requestId]);
  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.from_user_id}`).emit('call:accepted', {
      requestId, conversationId: rq.conversation_id, kind: rq.kind, durationMin: rq.duration_min,
    });
  } catch (err) {
    logger.warn({ err, requestId }, 'call accepted signal failed (non-fatal)');
  }
  const token = await getCallToken(rq.conversation_id, userId, rq.kind);
  return { ...token, conversationId: rq.conversation_id };
}

/** The callee declines → the caller is told. */
export async function declineCallRequest(requestId: string, userId: string): Promise<void> {
  const rq = await loadRequest(requestId);
  if (rq.to_user_id !== userId) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your call request');
  if (rq.status !== 'pending') return; // already answered — idempotent
  await query(`UPDATE call_requests SET status = 'declined', responded_at = NOW() WHERE id = $1`, [requestId]);
  const me = (await query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId])).rows[0];
  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.from_user_id}`).emit('call:declined', {
      requestId, conversationId: rq.conversation_id, byName: me?.display_name || 'They',
    });
  } catch (err) {
    logger.warn({ err, requestId }, 'call declined signal failed (non-fatal)');
  }
}

/** The caller withdraws a request they're still waiting on → the callee is told. */
export async function cancelCallRequest(requestId: string, userId: string): Promise<void> {
  const rq = await loadRequest(requestId);
  if (rq.from_user_id !== userId) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your call request');
  if (rq.status !== 'pending') return; // idempotent
  await query(`UPDATE call_requests SET status = 'cancelled', responded_at = NOW() WHERE id = $1`, [requestId]);
  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.to_user_id}`).emit('call:cancelled', { requestId, conversationId: rq.conversation_id });
  } catch (err) {
    logger.warn({ err, requestId }, 'call cancelled signal failed (non-fatal)');
  }
}
