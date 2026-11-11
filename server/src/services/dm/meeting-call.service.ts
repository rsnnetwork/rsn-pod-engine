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
//
// 1 Nov 2026 (30 Oct review item 4, L12): "Users should be able to start a video call right away with a
// connection, without scheduling a meeting." A VIDEO call now needs a connection (call-eligibility.ts),
// not a held meeting; audio keeps the unlock. calls_unlocked_at keeps its meaning and is still set only by
// a scheduled meeting both attended (production's thread hides its scheduler once it is set). An answered
// call is a meetings row of its own (source 'instant', migration 124), written with the accept: it lists
// under Events, and its window lets both people into the room. An offline callee is told in a sentence,
// with no missed-call bell.

import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, ConflictError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes, type LiveCallRequest, type PresenceState } from '@rsn/shared';
import { getVideoProvider } from '../video/video.service';
import * as blockService from '../block/block.service';
import { presenceState } from '../presence/presence.service';
import { stampAttendance } from '../meetings/meeting.service';
import { emitMeetingChanged } from '../meetings/meeting-tags';
import { CURRENT_MEETING_ID } from '../meetings/current-meeting';
import { requireConnection, requireMembers } from './call-eligibility';

const CALL_TOKEN_TTL_SECONDS = 4 * 60 * 60; // a call can run a while
// The scheduled-meeting window: you may enter from 5 min before, and it stays
// open until 30 min after the end (overruns / reconnects). Mirrors MeetPage.
const EARLY_JOIN_MS = 5 * 60 * 1000;
const MEETING_GRACE_MS = 30 * 60 * 1000;
/** A call request is answered within this window or it lapses. */
export const CALL_REQUEST_TTL_MS = 2 * 60 * 1000;
export const MIN_CALL_MIN = 5;
export const MAX_CALL_MIN = 240;

/**
 * The pair's call room. A block during a call (11 Nov 2026, item 16) moves the pair to a new room (call_room_epoch, one
 * up, migration 150) and closes the old one, so a token minted before the block (it lasts 4 hours, and LiveKit makes a
 * room again for anyone who joins with one) only ever reaches an empty room nobody else is sent to. Epoch 0 is the room
 * every conversation has always had.
 */
export function callRoomId(conversationId: string, epoch = 0): string {
  return epoch > 0 ? `dm-${conversationId}-${epoch}` : `dm-${conversationId}`;
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
  /**
   * The meetings row the conversation's meeting is (migration 110), read through the guard
   * (current-meeting.ts): null when the pointer names a row that no longer stands at that time.
   */
  current_meeting_id: string | null;
  /** Which call room the pair is in now (callRoomId). */
  call_room_epoch: number;
}

/** Load the conversation, prove the caller is in it and not blocked either way. */
async function requireCallParticipant(conversationId: string, userId: string): Promise<ConvParticipants> {
  const r = await query<{
    id: string; user_a_id: string; user_b_id: string;
    calls_unlocked_at: Date | null; meeting_start_at: Date | null; meeting_duration_min: number | null;
    current_meeting_id: string | null; call_room_epoch: number | null;
  }>(
    `SELECT id, user_a_id, user_b_id, calls_unlocked_at, meeting_start_at, meeting_duration_min, call_room_epoch, ${CURRENT_MEETING_ID}
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
  return { ...conv, call_room_epoch: conv.call_room_epoch ?? 0, partnerId, iAmA: conv.user_a_id === userId };
}

/** Calls are only available once this pair's first scheduled meeting has happened. */
function requireUnlocked(conv: ConvParticipants): void {
  if (!conv.calls_unlocked_at) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Calls unlock after your first scheduled meeting together.');
  }
}

/**
 * Where the other person in the conversation is now (11 Nov 2026, RSN 07): online, away or offline, or null when the
 * read could not tell (presence.service.ts). Only a participant may ask, and never across a block (a 403, as for a call).
 */
export async function partnerPresence(conversationId: string, userId: string): Promise<PresenceState | null> {
  const conv = await requireCallParticipant(conversationId, userId);
  return presenceState(conv.partnerId);
}

export interface CallToken {
  token: string;
  url: string;
  roomName: string;
  kind: 'audio' | 'video';
  /**
   * The meeting this entry counts as attending (standingMeeting): a booked meeting in its window, or the answered
   * call's own row; null when none stands (calls unlocked, no meeting). Leaving the room asks how this meeting went
   * (5 Nov 2026: answered direct calls ask too, as Google Meet and WhatsApp do after a call).
   */
  meetingId: string | null;
}

/** A scheduled meeting stands on the conversation and has not ended (its end plus the grace period). */
function hasUnendedMeeting(conv: ConvParticipants): boolean {
  if (!conv.meeting_start_at) return false;
  const end = conv.meeting_start_at.getTime() + (conv.meeting_duration_min ?? 30) * 60_000;
  return Date.now() <= end + MEETING_GRACE_MS;
}

/** A meetings row that lets the pair into the room now, and whose attendance entering it stamps. */
interface StandingMeeting {
  id: string;
  source: 'scheduled' | 'instant';
}

/**
 * The meeting standing on the conversation now: a meetings row, scheduled (not cancelled), whose window holds
 * now (its start − 5 min … its end + 30 min). A booked one counts only when it is the one the conversation names
 * (the guarded pointer, current-meeting.ts: a stale row is never stamped); an answered call counts as itself.
 * When both stand, the booked meeting wins: entering in its window is attending it.
 */
async function standingMeeting(conv: ConvParticipants): Promise<StandingMeeting | null> {
  const r = await query<StandingMeeting>(
    `SELECT id, source FROM meetings
      WHERE conversation_id = $1 AND status = 'scheduled'
        AND (source = 'instant' OR id = $2)
        AND start_at - INTERVAL '5 minutes' <= NOW()
        AND NOW() <= start_at + (duration_min + 30) * INTERVAL '1 minute'
      ORDER BY (source = 'scheduled') DESC, start_at DESC
      LIMIT 1`,
    [conv.id, conv.current_meeting_id],
  );
  return r.rows[0] ?? null;
}

/** The refusal production's call screen shows, above its "Back to chat", when there is no meeting to enter. */
async function noMeetingToJoin(conversationId: string): Promise<AppError> {
  const latest = await query<{ status: string }>(
    `SELECT status FROM meetings WHERE conversation_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [conversationId],
  );
  const message = latest.rows[0]?.status === 'cancelled'
    ? 'This meeting was cancelled. Pick a new time to meet in your chat.'
    : "There's no meeting to join right now. Pick a time to meet in your chat.";
  return new AppError(403, ErrorCodes.AUTH_FORBIDDEN, message);
}

/** The conversation's scheduled meeting window (start − 5 min … end + 30 min) holds now. */
function insideScheduledWindow(conv: ConvParticipants): boolean {
  if (!conv.meeting_start_at) return false; // nothing scheduled → nothing to attend
  const start = conv.meeting_start_at.getTime();
  const end = start + (conv.meeting_duration_min ?? 30) * 60_000;
  const now = Date.now();
  return now >= start - EARLY_JOIN_MS && now <= end + MEETING_GRACE_MS;
}

/**
 * Entering the room counts as attending the meeting that stands (standingMeeting), on that meeting's
 * own row (26 Oct 2026: the "attended" Events shows): the scheduled meeting inside its window, whether
 * or not calls are already unlocked, or else an answered call (1 Nov 2026).
 * Inside the scheduled meeting's window, and before calls unlock, it is also stamped on the conversation;
 * once BOTH sides have attended, calls unlock for the pair and both clients are told (the scheduler goes
 * away, the call buttons appear). An answered call never stamps the conversation, so it never unlocks.
 * Both stamps are one transaction, the conversation first: the order every booking locks them in.
 */
async function recordJoin(conv: ConvParticipants, userId: string, standing: StandingMeeting | null): Promise<void> {
  const stampConversation = !conv.calls_unlocked_at && insideScheduledWindow(conv);
  if (!stampConversation && !standing) return; // nothing to attend, or nothing left to stamp
  const meetingId = standing?.id ?? null;
  const { attended, unlocked } = await transaction(async (client) => {
    let bothJoined = false;
    if (stampConversation) {
      const col = conv.iAmA ? 'meeting_joined_a_at' : 'meeting_joined_b_at';
      const stamped = await client.query<{ a: Date | null; b: Date | null }>(
        `UPDATE dm_conversations SET ${col} = COALESCE(${col}, NOW())
          WHERE id = $1
          RETURNING meeting_joined_a_at AS a, meeting_joined_b_at AS b`,
        [conv.id],
      );
      const row = stamped.rows[0];
      bothJoined = !!row?.a && !!row?.b;
      if (bothJoined) {
        await client.query(
          `UPDATE dm_conversations SET calls_unlocked_at = COALESCE(calls_unlocked_at, NOW()) WHERE id = $1`,
          [conv.id],
        );
      }
    }
    const firstJoin = meetingId ? await stampAttendance(client, meetingId, conv.iAmA ? 'a' : 'b') : false;
    return { attended: firstJoin, unlocked: bothJoined };
  });

  if (attended && meetingId) await emitMeetingChanged(meetingId, [conv.user_a_id, conv.user_b_id]);
  if (!unlocked) return;
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

/**
 * The member has left the conversation's call on purpose (leave fix, 2 Nov 2026). Their app has already said so in
 * the room and sent LiveKit its own leave, but on LiveKit Cloud neither always reached the room, and LiveKit then kept
 * them listed until their connection timed out (over 30 s), so the other person was not told. Our server asks LiveKit
 * itself to take that very connection (participant sid) out, which tells the other person at once. A newer connection
 * of theirs (they came back in) stays. Being in the conversation is enough: a block does not keep anyone in a room.
 * A LiveKit failure never fails the leave.
 */
export async function leaveCallRoom(conversationId: string, userId: string, sid: string): Promise<{ removed: boolean }> {
  const r = await query<{ user_a_id: string; user_b_id: string; call_room_epoch: number | null }>(
    `SELECT user_a_id, user_b_id, call_room_epoch FROM dm_conversations WHERE id = $1`,
    [conversationId],
  );
  const conv = r.rows[0];
  if (!conv) throw new NotFoundError('Conversation', conversationId);
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your conversation');
  }
  try {
    const room = callRoomId(conversationId, conv.call_room_epoch ?? 0);
    return { removed: await getVideoProvider().removeParticipantIfSession(room, userId, sid) };
  } catch (err) {
    logger.warn({ err, conversationId, userId }, 'taking a member who left out of the call room failed (non-fatal)');
    return { removed: false };
  }
}

/** Mint a LiveKit token so this participant can join the conversation's room. */
export async function getCallToken(
  conversationId: string,
  userId: string,
  kind: 'audio' | 'video',
): Promise<CallToken> {
  const conv = await requireCallParticipant(conversationId, userId);
  // 26 Oct 2026: before calls unlock, the room is the scheduled meeting's. It is never refused for
  // being early (production's MeetPage mints this token on mount, under its own countdown); it is
  // refused once no meeting stands (none booked, cancelled, or over), so an old Join lands on a clear
  // sentence instead of an empty room. 1 Nov 2026: an answered call standing (its own meetings row)
  // lets the two in too, whatever the conversation's schedule says.
  const standing = await standingMeeting(conv);
  if (!conv.calls_unlocked_at && !hasUnendedMeeting(conv) && !standing) throw await noMeetingToJoin(conversationId);
  await recordJoin(conv, userId, standing);
  const me = (await query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [userId],
  )).rows[0];
  const roomName = callRoomId(conversationId, conv.call_room_epoch);
  const issued = await getVideoProvider().issueJoinToken(
    userId, roomName, me?.display_name || 'Member', CALL_TOKEN_TTL_SECONDS,
  );
  return {
    token: issued.token, url: config.livekit.host, roomName, kind: kind === 'audio' ? 'audio' : 'video',
    meetingId: standing?.id ?? null,
  };
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
 * Tell both people's screens that the pair's call changed: the conversation (its thread and scheduler) and each
 * one's own calls (user:<id>:calls, the app-wide incoming and outgoing call reads). A tag of its own, so a busy
 * chat (user:<id>:dms on every message) never makes those reads run. Best-effort: the change is already saved.
 */
async function emitCallChanged(conversationId: string, userIds: string[]): Promise<void> {
  try {
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await Promise.all([...new Set(userIds)].map((id) =>
      emitEntities(io, [id], [E.dmConversation(conversationId), E.userCalls(id)])));
  } catch (err) {
    logger.warn({ err, conversationId }, 'call entity emit failed (non-fatal)');
  }
}

/** Close the banner on the callee's other devices: the existing call:cancelled, to their own user room. */
async function closeCalleeBanners(rq: RequestRow): Promise<void> {
  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.to_user_id}`).emit('call:cancelled', { requestId: rq.id, conversationId: rq.conversation_id });
  } catch (err) {
    logger.warn({ err, requestId: rq.id }, 'callee banner close failed (non-fatal)');
  }
}

/** Video asks a real mutual connection; audio keeps its own rule (calls unlocked) and asks only the two accounts. */
function requireCallable(kind: 'audio' | 'video', callerId: string, calleeId: string): Promise<{ name: string }> {
  return kind === 'audio' ? requireMembers(callerId, calleeId) : requireConnection(callerId, calleeId);
}

/** A ring that leaves no line in the thread (the two may not message each other yet). */
class SkipLine extends Error {}

/** What the offline refusal says: exactly the plan's sentence (L12). */
export function offlineSentence(name: string): string {
  return `${name} isn't online right now. Send a message instead.`;
}

/**
 * Ask the partner for a call of a chosen length. A video call needs a real mutual connection, no block and
 * both members (requireConnection); an audio call keeps the 9 Sep rule, calls unlocked (the first meeting
 * happened), with no block and both members (requireMembers). The partner must not be offline (online or away). Rings them with a bell notification + a live
 * `call:request`, and leaves a line in the thread. The caller then waits for accept/decline.
 */
export async function requestCall(
  conversationId: string,
  userId: string,
  kind: 'audio' | 'video',
  durationMin: number,
): Promise<CallRequest> {
  const conv = await requireCallParticipant(conversationId, userId);
  const callKind: 'audio' | 'video' = kind === 'audio' ? 'audio' : 'video';
  if (callKind === 'audio') requireUnlocked(conv);
  const { name: partnerName } = await requireCallable(callKind, userId, conv.partnerId);
  const minutes = clampDuration(durationMin);

  // Only someone with no connection at all is refused (11 Nov 2026, RSN 07): an away member still gets the banner and
  // the bell, and a read that could not tell lets the ring go rather than say offline wrongly. The refusal names them,
  // so the screen can offer Try again, Find a time and Send a message.
  if ((await presenceState(conv.partnerId)) === 'offline') {
    throw new ConflictError(ErrorCodes.CALL_PARTNER_OFFLINE, offlineSentence(partnerName), { partnerName });
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
      throw new ConflictError(ErrorCodes.CALL_ALREADY_WAITING, 'A call request is already waiting for an answer.');
    }
    throw err;
  }

  const me = (await query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [userId],
  )).rows[0];
  const callerName = me?.display_name || 'Someone';

  // A line in the thread so the request shows in history for both sides, only where the two may already
  // message each other: one message in a thread lets both write freely (dm.service canMessage, its grandfather
  // rule), so a ring must not be what opens it (fix round 1). Without the line the ring still rings, bell and all.
  try {
    const dmService = await import('./dm.service');
    const [mine, theirs] = await Promise.all([
      dmService.canMessage(userId, conv.partnerId), dmService.canMessage(conv.partnerId, userId),
    ]);
    if (!mine.allowed || !theirs.allowed) throw new SkipLine();
    const sent = await dmService.sendBroadcastMessage(userId, conv.partnerId, `📞 Requested a ${minutes}-min ${callKind} call`);
    const { io } = await import('../../index');
    const { broadcastDmMessage } = await import('../orchestration/handlers/dm-handlers');
    await broadcastDmMessage(io, userId, conv.partnerId, sent.conversationId, sent.message, { notify: false });
  } catch (err) {
    if (!(err instanceof SkipLine)) logger.warn({ err, conversationId }, 'call request system message failed (non-fatal)');
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
  // A lapsed request this replaced, and the new one, on both people's screens.
  await emitCallChanged(conversationId, [userId, conv.partnerId]);

  return {
    id: inserted.id, conversationId, fromUserId: userId, toUserId: conv.partnerId,
    kind: callKind, durationMin: minutes, status: 'pending', createdAt: inserted.created_at,
  };
}

/**
 * Ring a person for a video call (POST /calls/user/:userId, 1 Nov 2026): for screens that know a person, not a
 * conversation (the profile). The connection is checked FIRST, before the pair's conversation is found or made:
 * a conversation itself makes the two a connection, so making one for a stranger would open the door it guards.
 * Then it is requestCall, exactly as the thread's call button rings.
 */
export async function requestCallToUser(callerId: string, calleeId: string, durationMin: number): Promise<CallRequest> {
  await requireConnection(callerId, calleeId);
  const dmService = await import('./dm.service');
  const conversationId = await dmService.findOrCreateConversation(callerId, calleeId);
  return requestCall(conversationId, callerId, 'video', durationMin);
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

interface LiveRow extends RequestRow {
  partner_name: string | null;
}

function mapLive(r: LiveRow): LiveCallRequest {
  const createdAt = new Date(r.created_at);
  return {
    id: r.id, conversationId: r.conversation_id, fromUserId: r.from_user_id, toUserId: r.to_user_id,
    partnerName: r.partner_name?.trim() || 'Member', kind: r.kind, durationMin: r.duration_min,
    createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + CALL_REQUEST_TTL_MS).toISOString(),
  };
}

/**
 * The newest unanswered, unexpired request on one side of me ('to' = ringing me, 'from' = rung by me), named after
 * the other person, who is a member and not blocked either way. For any screen opened or refreshed while it rings.
 * The other person's status check is inline: switch to activeMemberSql after T2.
 */
async function liveRequest(userId: string, side: 'to' | 'from'): Promise<LiveCallRequest | null> {
  const mine = side === 'to' ? 'r.to_user_id' : 'r.from_user_id';
  const theirs = side === 'to' ? 'r.from_user_id' : 'r.to_user_id';
  const r = await query<LiveRow>(
    `SELECT r.*, p.display_name AS partner_name
       FROM call_requests r
       JOIN users p ON p.id = ${theirs}
      WHERE ${mine} = $1 AND r.status = 'pending' AND r.created_at >= NOW() - INTERVAL '2 minutes'
        AND p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = $1 AND b.blocked_id = p.id) OR (b.blocker_id = p.id AND b.blocked_id = $1))
      ORDER BY r.created_at DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0] ? mapLive(r.rows[0]) : null;
}

/** A call ringing me now, wherever I am in the app (the banner after a refresh). */
export function getIncomingCallRequest(userId: string): Promise<LiveCallRequest | null> {
  return liveRequest(userId, 'to');
}

/** A call I rang that is still waiting for an answer (the "Calling…" card after a refresh). */
export function getOutgoingCallRequest(userId: string): Promise<LiveCallRequest | null> {
  return liveRequest(userId, 'from');
}

/**
 * The callee accepts → the call is a meeting, the caller is told, and the callee gets a room token.
 *
 * In one transaction: the request is claimed (pending → accepted, only once), and one meetings row is written
 * for the call (1 Nov 2026): source 'instant', starting now, the length asked for, booked by the caller, and
 * already counted as reminded so the reminder worker never picks it. The conversation's meeting columns and its
 * pointer stay as they are: they describe the pair's scheduled meeting, and only that unlocks calls. A second
 * accept (another device, a double press) finds the request taken and writes nothing.
 */
export async function acceptCallRequest(requestId: string, userId: string): Promise<CallToken & { conversationId: string }> {
  const rq = await loadRequest(requestId);
  if (rq.to_user_id !== userId) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your call request');
  if (rq.status !== 'pending') throw new AppError(409, ErrorCodes.VALIDATION_ERROR, `This call request was ${rq.status}.`);
  if (isExpired(rq)) {
    await query(`UPDATE call_requests SET status = 'expired', responded_at = NOW() WHERE id = $1`, [requestId]);
    await emitCallChanged(rq.conversation_id, [rq.from_user_id, rq.to_user_id]);
    throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'This call request has expired — ask them to call again.');
  }
  // Blocked, closed or no longer connected since it rang: nothing is answered.
  const conv = await requireCallParticipant(rq.conversation_id, userId);
  await requireCallable(rq.kind, userId, rq.from_user_id);

  const meetingId = await transaction(async (client) => {
    const claimed = await client.query<{ id: string }>(
      `UPDATE call_requests SET status = 'accepted', responded_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id`,
      [requestId],
    );
    if (!claimed.rows[0]) return null;
    const written = await client.query<{ id: string }>(
      `INSERT INTO meetings (conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, source, confirmed_by, reminder_sent_at)
       VALUES ($1, $2, $3, NOW(), $4, $5, 'instant', $6, NOW())
       RETURNING id`,
      [conv.id, conv.user_a_id, conv.user_b_id, rq.duration_min, rq.kind, rq.from_user_id],
    );
    return written.rows[0].id;
  });
  if (!meetingId) {
    const now = await loadRequest(requestId);
    throw new AppError(409, ErrorCodes.VALIDATION_ERROR, `This call request was ${now.status}.`);
  }

  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.from_user_id}`).emit('call:accepted', {
      requestId, conversationId: rq.conversation_id, kind: rq.kind, durationMin: rq.duration_min,
    });
  } catch (err) {
    logger.warn({ err, requestId }, 'call accepted signal failed (non-fatal)');
  }
  await closeCalleeBanners(rq);
  await emitCallChanged(rq.conversation_id, [rq.from_user_id, rq.to_user_id]);
  await emitMeetingChanged(meetingId, [rq.from_user_id, rq.to_user_id]);
  const token = await getCallToken(rq.conversation_id, userId, rq.kind);
  return { ...token, conversationId: rq.conversation_id };
}

/**
 * Claim a request that still waits for an answer, as the accept does: one statement, so of an accept, a decline and
 * a cancel landing at once exactly one changes it, and the others find it taken (fix round 1).
 */
async function claimAnswer(requestId: string, status: 'declined' | 'cancelled'): Promise<boolean> {
  const claimed = await query<{ id: string }>(
    `UPDATE call_requests SET status = '${status}', responded_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id`,
    [requestId],
  );
  return claimed.rows.length > 0;
}

/**
 * A block ends what the two had going (11 Nov 2026, Shirley Palmer's item 16; the controller's ruling: a block during a
 * call ends it for BOTH sides). A call still ringing between them is withdrawn (both screens told, the callee's banner
 * closed). The pair moves to a new call room (call_room_epoch one up) and the old one is closed: LiveKit disconnects
 * everyone in it, both rooms go back to their thread with "The call has ended.", and a token minted before the block can
 * only reach the old room, which nobody is sent to again. No new token is minted for either while the block stands
 * (requireCallParticipant). Best-effort past the move: the block itself is already saved.
 */
export async function endCallsOnBlock(blockerId: string, blockedId: string): Promise<void> {
  const r = await query<{ id: string; call_room_epoch: number }>(
    `UPDATE dm_conversations SET call_room_epoch = call_room_epoch + 1
      WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)
      RETURNING id, call_room_epoch`,
    [blockerId, blockedId],
  );
  const moved = r.rows[0];
  if (!moved) return;
  const conversationId = moved.id;
  const withdrawn = await query<RequestRow>(
    `UPDATE call_requests SET status = 'cancelled', responded_at = NOW()
      WHERE conversation_id = $1 AND status = 'pending'
      RETURNING *`,
    [conversationId],
  );
  if (withdrawn.rows.length > 0) {
    await Promise.all(withdrawn.rows.map(closeCalleeBanners));
    await emitCallChanged(conversationId, [blockerId, blockedId]);
  }
  try {
    await getVideoProvider().closeRoom(callRoomId(conversationId, moved.call_room_epoch - 1));
  } catch (err) {
    logger.error({ err, conversationId }, 'closing the call room after a block failed');
  }
}

/** The callee declines → the caller is told. Already answered (here or on another device): nothing is said. */
export async function declineCallRequest(requestId: string, userId: string): Promise<void> {
  const rq = await loadRequest(requestId);
  if (rq.to_user_id !== userId) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your call request');
  if (rq.status !== 'pending') return; // already answered — idempotent
  if (!(await claimAnswer(requestId, 'declined'))) return; // answered on another device a moment ago
  const me = (await query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId])).rows[0];
  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.from_user_id}`).emit('call:declined', {
      requestId, conversationId: rq.conversation_id, byName: me?.display_name || 'They',
    });
  } catch (err) {
    logger.warn({ err, requestId }, 'call declined signal failed (non-fatal)');
  }
  await closeCalleeBanners(rq);
  await emitCallChanged(rq.conversation_id, [rq.from_user_id, rq.to_user_id]);
}

/** What a withdraw ends as: cancelled, or whatever answered first (accepted: the caller goes into the room). */
export interface CancelOutcome {
  status: CallRequestStatus;
  conversationId: string;
  kind: 'audio' | 'video';
}

/**
 * The caller withdraws a request they're still waiting on → the callee is told. When the answer came first (the
 * callee accepted as the caller pressed Cancel), nothing changes and the answer says so, so the caller's screen can
 * still go into the room the callee is in.
 */
export async function cancelCallRequest(requestId: string, userId: string): Promise<CancelOutcome> {
  const rq = await loadRequest(requestId);
  if (rq.from_user_id !== userId) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your call request');
  const outcome = (status: CallRequestStatus): CancelOutcome => ({ status, conversationId: rq.conversation_id, kind: rq.kind });
  if (rq.status !== 'pending') return outcome(rq.status); // idempotent
  if (!(await claimAnswer(requestId, 'cancelled'))) return outcome((await loadRequest(requestId)).status);
  try {
    const { io } = await import('../../index');
    io.to(`user:${rq.to_user_id}`).emit('call:cancelled', { requestId, conversationId: rq.conversation_id });
  } catch (err) {
    logger.warn({ err, requestId }, 'call cancelled signal failed (non-fatal)');
  }
  await emitCallChanged(rq.conversation_id, [rq.from_user_id, rq.to_user_id]);
  return outcome('cancelled');
}
