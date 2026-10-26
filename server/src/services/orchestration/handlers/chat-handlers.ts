// ─── Chat Handlers ─────────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — chat message sending, per-message
// reactions, floating emoji reactions, and the chat history.
//
// These handlers are independent of the session state machine (no withSessionGuard).
//
// 26 Oct 2026 — the event chat is kept in Postgres (services/event-chat): each message is stored before
// anyone receives it, and the history and reactions are read back from there. There is no copy in memory or
// in Redis any more, so a restart or a deploy in the middle of an event loses nothing.

import { Server as SocketServer, Socket } from 'socket.io';
import { z } from 'zod';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus, ErrorCodes } from '@rsn/shared';
import type { ChatSendAck } from '@rsn/shared';
import { AppError } from '../../../middleware/errors';
import {
  activeSessions, sessionRoom, userRoom, getUserIdFromSocket,
} from '../state/session-state';
import * as sessionService from '../../session/session.service';
import {
  CHAT_REACTION_EMOJIS, EVENT_CHAT_CLOSED, EVENT_CHAT_MAX_LENGTH, EVENT_CHAT_ROOM_ID_MAX, EVENT_CHAT_SEND_FAILED,
  EVENT_CHAT_TOO_FAST, NewEventChatMessage, canReadEventChat, chatBlockedUserIds, isChatClosed, isUuid,
  listLiveChatHistory, persistEventChatMessage, takeChatHistorySlot, takeChatReactSlot, takeChatSendSlot,
  toggleEventChatReaction,
} from '../../event-chat/event-chat.service';
// matchingService removed — using direct queries for room-scoped chat

// ─── Constants ─────────────────────────────────────────────────────────────

const VALID_REACTIONS = ['raise_hand', 'heart', 'clap', 'thumbs_up', 'fire', 'laugh', 'surprise', 'wave', 'party', 'hundred'];

/** chat:send. clientId (new clients only) stores a retried message once. */
const chatSendSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string(),
  scope: z.enum(['lobby', 'room']),
  clientId: z.string().uuid().optional(),
});

/** chat:request_history. Production's client also sends a matchId, no longer needed: a room message records who it reached. */
const historyRequestSchema = z.object({ sessionId: z.string().uuid() });

// ─── Chat Send ─────────────────────────────────────────────────────────────

export async function handleChatSend(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; message: string; scope: 'lobby' | 'room'; clientId?: string },
  ack?: (res: ChatSendAck) => void,
): Promise<void> {
  // A refusal reaches the sender alone: through the acknowledgement when the client sent one (new clients),
  // otherwise as the `error` event production's client shows.
  const refuse = (code: string, message: string) => {
    if (ack) ack({ ok: false, code, message });
    else socket.emit('error', { code, message });
  };
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) {
      refuse('UNAUTHORIZED', 'Not authenticated');
      return;
    }

    // A malformed or empty message is ignored, as it always was; a client that asked for an answer gets one.
    const parsed = chatSendSchema.safeParse(data);
    if (!parsed.success) {
      ack?.({ ok: false, code: ErrorCodes.VALIDATION_ERROR, message: 'That message could not be sent. Try again.' });
      return;
    }
    const { sessionId, scope, clientId } = parsed.data;
    const text = parsed.data.message.trim();
    if (text.length === 0) {
      ack?.({ ok: false, code: ErrorCodes.VALIDATION_ERROR, message: 'Write a message first.' });
      return;
    }

    // Verify user is in the session room
    const rooms = socket.rooms;
    if (!rooms.has(sessionRoom(sessionId))) {
      refuse('NOT_IN_SESSION', 'You are not in this event.');
      return;
    }

    // At most 10 messages in any 10 seconds, counted before any work on the text or the database.
    if (!takeChatSendSlot(userId)) {
      refuse(ErrorCodes.RATE_LIMIT_EXCEEDED, EVENT_CHAT_TOO_FAST);
      return;
    }

    // Cut to 500 characters as the database counts them (one emoji is one). 500 characters fit in 1,000 code
    // units, so only those are split into characters, however long the message that was sent.
    const trimmed = Array.from(text.slice(0, EVENT_CHAT_MAX_LENGTH * 2)).slice(0, EVENT_CHAT_MAX_LENGTH).join('');

    // Determine if sender is host/co-host
    const session = await sessionService.getSessionById(sessionId).catch(() => null);
    // The chat closes when the event ends. A late send used to re-create the event's chat in memory, where it
    // leaked; now it is refused here, and the store refuses it too (it checks the event row it writes beside).
    if (session && isChatClosed(session.status)) {
      refuse(ErrorCodes.EVENT_ENDED, EVENT_CHAT_CLOSED);
      return;
    }
    const isHost = session?.hostUserId === userId;
    const cohostResult = isHost ? { rows: [] } : await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2`, [sessionId, userId]
    ).catch(() => ({ rows: [] }));
    const isCohost = cohostResult.rows.length > 0;

    // In lobby phase, only allow chat when host is present (host/co-hosts always allowed)
    // Ship B — this gate deliberately stays on the presenceMap: heartbeat
    // freshness is the right "host is actively here" signal for unlocking chat.
    const activeSession = activeSessions.get(sessionId);
    if (!isHost && !isCohost && scope === 'lobby') {
      const hostPresent = activeSession?.presenceMap.has(session?.hostUserId || '');
      if (!hostPresent) {
        refuse('CHAT_DISABLED', 'Chat is available once the host joins');
        return;
      }
    }

    const displayName = (socket.data as any)?.displayName || 'Unknown';
    // The message as it is stored; a room message gains its room and audience below. Each of the three ways
    // out (lobby, room, sender only) stores it first and sends the stored message only once that has worked.
    const chatMsg: NewEventChatMessage = {
      sessionId,
      senderId: userId,
      senderName: displayName,
      senderIsHost: isHost,
      scope,
      content: trimmed,
      clientId: clientId ?? null,
    };
    // People blocked either way are skipped, so what is sent agrees with what the history shows.
    const blocked = await chatBlockedUserIds(userId);

    if (scope === 'lobby') {
      // Broadcast to lobby users only — exclude users in active breakout rooms
      const activeMatchedRes = await query<{ pid: string }>(
        `SELECT unnest(ARRAY[participant_a_id, participant_b_id, participant_c_id]) AS pid
         FROM matches WHERE session_id = $1 AND status = 'active'`,
        [sessionId]
      );
      const inBreakout = new Set(activeMatchedRes.rows.map(r => r.pid).filter(Boolean));
      const socketsInSession = await io.in(sessionRoom(sessionId)).fetchSockets();
      const { message: stored, created } = await persistEventChatMessage(chatMsg);
      // A retried clientId was sent the first time: nothing goes out again.
      if (created) {
        for (const sk of socketsInSession) {
          const uid = (sk.data as any)?.userId;
          if (!inBreakout.has(uid) && !blocked.has(uid)) {
            sk.emit('chat:message', stored);
          }
        }
      }
      ack?.({ ok: true, id: stored.id, duplicate: !created });
    } else {
      // Room scope: resolve recipients via in-memory roomParticipants FIRST
      // (the source of truth for "who is in which LiveKit room right now"),
      // and fall back to a relaxed match query if needed.
      //
      // Phase A (1 May 2026 spec) — pre-fix this branch hard-filtered on
      // `status = 'active'`. That excluded users in rooms whose match was
      // mid-state-transition (active → round_rating just-completed trios,
      // active → reassigned during host-pull-back, scheduled rooms not yet
      // flipped to active), so chat-send returned 0 rows and the handler's
      // last-resort `socket.emit` only went back to the sender. Result:
      // users could type, the chat window showed their message, but no one
      // else in the room ever saw it. The user reported this as the very
      // first issue in the 30 April test event.
      //
      // Resolution order (Ship B):
      //   1. Canonical location — carries the real roomId/matchId since
      //      Ship A, survives restarts, no invalidation race. 'main' or
      //      unavailable falls through unchanged.
      //   2. activeSession.roomParticipants[userId] — set when the LiveKit
      //      `room.connect()` resolves and the client emits
      //      `presence:room_joined`.
      //   3. Relaxed DB query: any match in this session containing the
      //      user, where status is NOT 'cancelled' or 'no_show'. Picks up
      //      users in 'completed', 'reassigned', or 'scheduled' rooms that
      //      are still talking.
      //   4. socket.emit-self only (the truly-orphan sender path — kept as
      //      a safety net so we never throw the message away).
      let resolvedRoomId: string | null = null;
      let resolvedMatchId: string | null = null;
      const recipientIds: Set<string> = new Set();

      const { readCanonical } = await import('../state/canonical-state');
      const canonDoc = await readCanonical(sessionId).catch(() => null);
      const senderLoc = canonDoc?.participants[userId]?.location;
      if (senderLoc?.type === 'breakout') {
        resolvedRoomId = senderLoc.roomId;
        resolvedMatchId = senderLoc.matchId;
        for (const [uid, p] of Object.entries(canonDoc!.participants)) {
          if (p.location.type === 'breakout' && p.location.roomId === senderLoc.roomId) {
            recipientIds.add(uid);
          }
        }
      }

      const senderRoomEntry = activeSession?.roomParticipants?.get(userId);
      if (recipientIds.size === 0 && senderRoomEntry) {
        // The in-memory presence map. Find every userId
        // currently in the same LiveKit room.
        resolvedRoomId = senderRoomEntry.roomId;
        resolvedMatchId = senderRoomEntry.matchId;
        for (const [uid, info] of activeSession!.roomParticipants!) {
          if (info.roomId === senderRoomEntry.roomId) recipientIds.add(uid);
        }
      } else if (recipientIds.size === 0) {
        // Fallback: tightened to active/scheduled only.
        // Phase 8A.4 (8 May spec) — Stefan #8: pre-fix the filter
        // accepted 'completed'/'reassigned' rows too, so a chat sent
        // mid-round-transition could be delivered to the OLD match's
        // participants who had already moved on. Now: room-scope
        // chat is only routed to active or about-to-start matches.
        const matchRes = await query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null; room_id: string }>(
          `SELECT id, participant_a_id, participant_b_id, participant_c_id, room_id
           FROM matches
           WHERE session_id = $1
             AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
             AND status IN ('active', 'scheduled')
           ORDER BY started_at DESC NULLS LAST, created_at DESC
           LIMIT 1`,
          [sessionId, userId]
        );
        if (matchRes.rows[0]) {
          const m = matchRes.rows[0];
          resolvedRoomId = m.room_id || null;
          resolvedMatchId = m.id;
          for (const pid of [m.participant_a_id, m.participant_b_id, m.participant_c_id]) {
            if (pid) recipientIds.add(pid);
          }
        }
      }

      // A client names its own room (presence:room_joined) and the id is stored with the message: one longer
      // than any real room id is refused without a word (a client that asked for an answer gets one).
      if (resolvedRoomId !== null && resolvedRoomId.length > EVENT_CHAT_ROOM_ID_MAX) {
        logger.warn({ sessionId, userId, length: resolvedRoomId.length }, 'Chat message refused: its room id is too long');
        ack?.({ ok: false, code: ErrorCodes.VALIDATION_ERROR, message: EVENT_CHAT_SEND_FAILED });
        return;
      }

      if (resolvedRoomId !== null && recipientIds.size > 0) {
        // Phase 8A.4 — guarantee non-undefined roomId for room-scope
        // messages: the client shows a room message only in its own room.
        chatMsg.roomId = resolvedRoomId || chatMsg.roomId || undefined;
        // Stored with exactly who it reaches (blocked people skipped): the history and the reactions on it
        // reach the same people later.
        const delivered = [...recipientIds].filter((pid) => !blocked.has(pid));
        const { message: stored, created } = await persistEventChatMessage({
          ...chatMsg, matchId: resolvedMatchId, audienceIds: delivered,
        });
        if (created) {
          for (const pid of delivered) {
            io.to(userRoom(pid)).emit('chat:message', stored);
          }
        }
        ack?.({ ok: true, id: stored.id, duplicate: !created });
      } else {
        // Truly orphan: the sender isn't in any tracked room and has no
        // matching DB row. Honour the request locally so they at least see
        // their own message rendered, but nothing more. Stored for them alone.
        const { message: stored, created } = await persistEventChatMessage({ ...chatMsg, audienceIds: [userId] });
        if (created) socket.emit('chat:message', stored);
        ack?.({ ok: true, id: stored.id, duplicate: !created });
      }
    }
  } catch (err: any) {
    // The event has ended (found when storing): the sender is told why, and nothing was sent to anyone.
    if (err instanceof AppError) {
      refuse(err.code, err.message);
      return;
    }
    // The store failed: nothing was sent to anyone, and the sender is told.
    logger.error({ err }, 'Error handling chat message');
    refuse('CHAT_FAILED', EVENT_CHAT_SEND_FAILED);
  }
}

// ─── Per-Message Chat Reactions ─────────────────────────────────────────────

export async function handleChatReact(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; messageId: string; emoji: string }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;

    const { sessionId, messageId, emoji } = data ?? ({} as Partial<typeof data>);
    if (!sessionId || !messageId || !emoji) return;
    if (!(CHAT_REACTION_EMOJIS as readonly string[]).includes(emoji)) return;
    // A message from before chat was kept had a made-up id: nothing is stored to react to.
    if (!isUuid(messageId)) return;
    if (!socket.rooms.has(sessionRoom(sessionId))) return;
    // 20 reactions per member in any 10 seconds; one over is dropped without a word.
    if (!takeChatReactSlot(userId)) return;

    // Toggle in the database: add if not present, remove if already reacted.
    const result = await toggleEventChatReaction({ sessionId, messageId, userId, emoji });
    if (!result) return;

    // The update reaches whoever has the message: the people a room message was stored as reaching (exact,
    // including a host who visited the room), or the whole event for a lobby message.
    const update = { messageId, reactions: result.reactions };
    if (result.scope === 'room') {
      for (const pid of result.audienceIds ?? []) {
        io.to(userRoom(pid)).emit('chat:reaction_update', update);
      }
    } else {
      io.to(sessionRoom(sessionId)).emit('chat:reaction_update', update);
    }
  } catch (err) {
    logger.error({ err }, 'Error handling chat reaction');
  }
}

// ─── Floating Reactions ────────────────────────────────────────────────────

export async function handleReactionSend(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; type: string; matchId?: string }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;

    const { sessionId, type } = data;
    if (!VALID_REACTIONS.includes(type)) return;

    if (!socket.rooms.has(sessionRoom(sessionId))) return;

    // In lobby phase, block reactions when host is not present (host/co-hosts always allowed)
    const session = await sessionService.getSessionById(sessionId).catch(() => null);
    const isHost = session?.hostUserId === userId;
    const cohostCheck = isHost ? { rows: [] } : await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2`, [sessionId, userId]
    ).catch(() => ({ rows: [] }));
    const isCohost = cohostCheck.rows.length > 0;
    // Hoisted: needed both for the lobby-host-presence guard below AND for
    // the room-scope resolution further down (Phase A fix).
    const activeSession = activeSessions.get(sessionId);
    if (!isHost && !isCohost) {
      // Ship B — deliberate presenceMap stay (heartbeat freshness gate).
      const hostPresent = activeSession?.presenceMap.has(session?.hostUserId || '');
      if (!hostPresent && (!activeSession || activeSession.status === SessionStatus.LOBBY_OPEN || activeSession.status === SessionStatus.SCHEDULED)) {
        return; // Silently ignore reactions when host is absent in lobby
      }
    }

    const displayName = (socket.data as any)?.displayName || 'User';

    const reactionPayload = {
      userId,
      displayName,
      type,
      timestamp: new Date().toISOString(),
    };

    // Scope reactions: during active rounds, only show to breakout room participants.
    // In lobby/transition phases, broadcast to everyone.
    //
    // Phase A (1 May 2026 spec) — same status-race bug as handleChatSend.
    // Ship B — canonical location first (same rationale as handleChatSend),
    // then roomParticipants, then the relaxed match query that doesn't
    // hard-filter on `status='active'` so reactions survive state
    // transitions (round_active → round_rating after End Round).
    const recipientIdsRx: Set<string> = new Set();
    const { readCanonical } = await import('../state/canonical-state');
    const canonDocRx = await readCanonical(sessionId).catch(() => null);
    const senderLocRx = canonDocRx?.participants[userId]?.location;
    if (senderLocRx?.type === 'breakout') {
      for (const [uid, p] of Object.entries(canonDocRx!.participants)) {
        if (p.location.type === 'breakout' && p.location.roomId === senderLocRx.roomId) {
          recipientIdsRx.add(uid);
        }
      }
    }
    const senderRoomEntryRx = activeSession?.roomParticipants?.get(userId);
    if (recipientIdsRx.size === 0 && senderRoomEntryRx) {
      for (const [uid, info] of activeSession!.roomParticipants!) {
        if (info.roomId === senderRoomEntryRx.roomId) recipientIdsRx.add(uid);
      }
    } else if (recipientIdsRx.size === 0) {
      const reactionMatchRes = await query<{ participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
        `SELECT participant_a_id, participant_b_id, participant_c_id
         FROM matches
         WHERE session_id = $1
           AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
           AND status NOT IN ('cancelled', 'no_show')
         ORDER BY started_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [sessionId, userId]
      );
      if (reactionMatchRes.rows[0]) {
        const m = reactionMatchRes.rows[0];
        for (const pid of [m.participant_a_id, m.participant_b_id, m.participant_c_id]) {
          if (pid) recipientIdsRx.add(pid);
        }
      }
    }

    if (recipientIdsRx.size > 0) {
      for (const pid of recipientIdsRx) {
        io.to(userRoom(pid)).emit('reaction:received', reactionPayload);
      }
    } else {
      // Lobby/transition: broadcast only to non-breakout users
      const activeMatchedRes2 = await query<{ pid: string }>(
        `SELECT unnest(ARRAY[participant_a_id, participant_b_id, participant_c_id]) AS pid
         FROM matches WHERE session_id = $1 AND status = 'active'`,
        [sessionId]
      );
      const inBreakout2 = new Set(activeMatchedRes2.rows.map(r => r.pid).filter(Boolean));
      const socketsInSession2 = await io.in(sessionRoom(sessionId)).fetchSockets();
      for (const sk of socketsInSession2) {
        const uid = (sk.data as any)?.userId;
        if (!inBreakout2.has(uid)) {
          sk.emit('reaction:received', reactionPayload);
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error handling reaction');
  }
}

// ─── Phase 4B (5 May spec) — Chat history force-fetch on demand ────────────
//
// Stefan #8: "Message received notification appears, message itself not shown."
// Pre-fix, chat history was only emitted on session-join. If the chat panel
// opened later (or local message state somehow lost a message), there was no
// way to recover — the user saw an empty / stale chat.
//
// This handler lets the client request a fresh chat history snapshot on
// demand (typically: when the chat panel mounts, or when the local message
// count is behind the server's notification count).
//
// 26 Oct 2026 — read from the database: the event's lobby messages and the room messages this member was
// sent (the last 200, oldest first). X3: it used to answer any signed-in socket that named an event. Now it
// answers anyone canReadEventChat allows (who took part, the hosts; someone registered whose socket is in the
// room while the chat is open; an admin, lobby messages only). Anyone else gets no answer at all: production's
// chat panel asks when it mounts, before its session:join reaches the server, and an `error` here was a red
// toast on nearly every first entry. The join sends the history a moment later.
export async function handleChatRequestHistory(
  _io: SocketServer,
  socket: Socket,
  data: { sessionId: string; matchId?: string },
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    const parsed = historyRequestSchema.safeParse(data);
    if (!userId || !parsed.success) return;
    // 20 requests per member in any 10 seconds; one over is dropped without a word.
    if (!takeChatHistorySlot(userId)) return;
    const { sessionId } = parsed.data;
    const access = await canReadEventChat(userId, socket.data?.role, sessionId, {
      inSessionRoom: socket.rooms.has(sessionRoom(sessionId)),
    });
    if (!access) return;
    const messages = await listLiveChatHistory(sessionId, userId, access);
    socket.emit('chat:history', { messages });
  } catch (err) {
    // An event that does not exist answers nothing.
    if (err instanceof AppError) return;
    logger.error({ err }, 'Error handling chat:request_history');
  }
}

/**
 * On joining an event: the chat so far, from the database. Sent only when there is something to show, since
 * production's client keeps what it has on an empty answer. While the event runs, the member who has just
 * joined its room reads it; once it is over, only the people canReadEventChat allows do (anyone can open an
 * ended event's live page, which joins its room).
 */
export async function sendJoinChatHistory(socket: Socket, sessionId: string, userId: string): Promise<void> {
  try {
    const access = await canReadEventChat(userId, socket.data?.role, sessionId, { inSessionRoom: true });
    if (!access) return;
    const messages = await listLiveChatHistory(sessionId, userId, access);
    if (messages.length > 0) socket.emit('chat:history', { messages });
  } catch (err) {
    logger.warn({ err, sessionId, userId }, 'Could not send the chat history on join (non-fatal)');
  }
}
