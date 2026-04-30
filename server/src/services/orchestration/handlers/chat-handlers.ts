// ─── Chat Handlers ─────────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — chat message sending, per-message
// reactions, and floating emoji reactions.
//
// These handlers are independent of the session state machine (no withSessionGuard).

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus } from '@rsn/shared';
import {
  activeSessions, sessionRoom, userRoom, getUserIdFromSocket,
  ChatMessage, chatMessages, MAX_CHAT_MESSAGES,
} from '../state/session-state';
import * as sessionService from '../../session/session.service';
// matchingService removed — using direct queries for room-scoped chat

// ─── Constants ─────────────────────────────────────────────────────────────

const CHAT_REACTION_EMOJIS = ['heart', 'clap', 'thumbs_up'];

const VALID_REACTIONS = ['raise_hand', 'heart', 'clap', 'thumbs_up', 'fire', 'laugh', 'surprise', 'wave', 'party', 'hundred'];

// ─── Chat Send ─────────────────────────────────────────────────────────────

export async function handleChatSend(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; message: string; scope: 'lobby' | 'room' }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }

    const { sessionId, message, scope } = data;

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) return;
    const trimmed = message.trim().slice(0, 500); // Cap at 500 chars

    // Verify user is in the session room
    const rooms = socket.rooms;
    if (!rooms.has(sessionRoom(sessionId))) {
      socket.emit('error', { code: 'NOT_IN_SESSION', message: 'You are not in this session' });
      return;
    }

    // Determine if sender is host/co-host
    const session = await sessionService.getSessionById(sessionId).catch(() => null);
    const isHost = session?.hostUserId === userId;
    const cohostResult = isHost ? { rows: [] } : await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2`, [sessionId, userId]
    ).catch(() => ({ rows: [] }));
    const isCohost = cohostResult.rows.length > 0;

    // In lobby phase, only allow chat when host is present (host/co-hosts always allowed)
    const activeSession = activeSessions.get(sessionId);
    if (!isHost && !isCohost && scope === 'lobby') {
      const hostPresent = activeSession?.presenceMap.has(session?.hostUserId || '');
      if (!hostPresent) {
        socket.emit('error', { code: 'CHAT_DISABLED', message: 'Chat is available once the host joins' });
        return;
      }
    }

    const displayName = (socket.data as any)?.displayName || 'Unknown';
    const chatMsg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      displayName,
      message: trimmed,
      timestamp: new Date().toISOString(),
      scope,
      isHost,
      reactions: {},
    };

    // Store message in memory
    if (!chatMessages.has(sessionId)) chatMessages.set(sessionId, []);
    const msgs = chatMessages.get(sessionId)!;
    msgs.push(chatMsg);
    // Keep only the last MAX_CHAT_MESSAGES
    if (msgs.length > MAX_CHAT_MESSAGES) msgs.splice(0, msgs.length - MAX_CHAT_MESSAGES);

    if (scope === 'lobby') {
      // Broadcast to lobby users only — exclude users in active breakout rooms
      const activeMatchedRes = await query<{ pid: string }>(
        `SELECT unnest(ARRAY[participant_a_id, participant_b_id, participant_c_id]) AS pid
         FROM matches WHERE session_id = $1 AND status = 'active'`,
        [sessionId]
      );
      const inBreakout = new Set(activeMatchedRes.rows.map(r => r.pid).filter(Boolean));
      const socketsInSession = await io.in(sessionRoom(sessionId)).fetchSockets();
      for (const sk of socketsInSession) {
        const uid = (sk.data as any)?.userId;
        if (!inBreakout.has(uid)) {
          sk.emit('chat:message', chatMsg);
        }
      }
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
      // Resolution order:
      //   1. activeSession.roomParticipants[userId] — set when the LiveKit
      //      `room.connect()` resolves and the client emits
      //      `presence:room_joined`. This is the most accurate source.
      //   2. Relaxed DB query: any match in this session containing the
      //      user, where status is NOT 'cancelled' or 'no_show'. Picks up
      //      users in 'completed', 'reassigned', or 'scheduled' rooms that
      //      are still talking.
      //   3. socket.emit-self only (the truly-orphan sender path — kept as
      //      a safety net so we never throw the message away).
      let resolvedRoomId: string | null = null;
      const recipientIds: Set<string> = new Set();

      const senderRoomEntry = activeSession?.roomParticipants?.get(userId);
      if (senderRoomEntry) {
        // Primary source: the in-memory presence map. Find every userId
        // currently in the same LiveKit room.
        resolvedRoomId = senderRoomEntry.roomId;
        for (const [uid, info] of activeSession!.roomParticipants!) {
          if (info.roomId === senderRoomEntry.roomId) recipientIds.add(uid);
        }
      } else {
        // Fallback: relaxed match query. status filter intentionally
        // excludes only the truly-dead states. Pick most recent.
        const matchRes = await query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null; room_id: string }>(
          `SELECT id, participant_a_id, participant_b_id, participant_c_id, room_id
           FROM matches
           WHERE session_id = $1
             AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
             AND status NOT IN ('cancelled', 'no_show')
           ORDER BY started_at DESC NULLS LAST, created_at DESC
           LIMIT 1`,
          [sessionId, userId]
        );
        if (matchRes.rows[0]) {
          const m = matchRes.rows[0];
          resolvedRoomId = m.room_id || null;
          for (const pid of [m.participant_a_id, m.participant_b_id, m.participant_c_id]) {
            if (pid) recipientIds.add(pid);
          }
        }
      }

      if (resolvedRoomId !== null && recipientIds.size > 0) {
        chatMsg.roomId = resolvedRoomId || undefined;
        for (const pid of recipientIds) {
          io.to(userRoom(pid)).emit('chat:message', chatMsg);
        }
      } else {
        // Truly orphan: the sender isn't in any tracked room and has no
        // matching DB row. Honour the request locally so they at least see
        // their own message rendered, but nothing more.
        socket.emit('chat:message', chatMsg);
      }
    }
  } catch (err: any) {
    logger.error({ err }, 'Error handling chat message');
    socket.emit('error', { code: 'CHAT_FAILED', message: 'Failed to send message' });
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

    const { sessionId, messageId, emoji } = data;
    if (!sessionId || !messageId || !emoji) return;
    if (!CHAT_REACTION_EMOJIS.includes(emoji)) return;

    const msgs = chatMessages.get(sessionId);
    if (!msgs) return;

    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;

    // Toggle: add if not present, remove if already reacted
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx >= 0) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(userId);
    }

    // Scope reaction broadcast: lobby messages go to all, room messages only to room
    if (msg.scope === 'room' && msg.roomId) {
      // Find participants of the match that owns this room message
      const roomMatchRes = await query<{ participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
        `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches WHERE room_id = $1 LIMIT 1`,
        [msg.roomId]
      );
      if (roomMatchRes.rows[0]) {
        const pids = [roomMatchRes.rows[0].participant_a_id, roomMatchRes.rows[0].participant_b_id, roomMatchRes.rows[0].participant_c_id]
          .filter((id): id is string => !!id);
        for (const pid of pids) {
          io.to(userRoom(pid)).emit('chat:reaction_update', { messageId, reactions: msg.reactions });
        }
      }
    } else {
      io.to(sessionRoom(sessionId)).emit('chat:reaction_update', { messageId, reactions: msg.reactions });
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
    // Use roomParticipants as primary source, fall back to a relaxed match
    // query that doesn't hard-filter on `status='active'` so reactions
    // survive state transitions (round_active → round_rating after End Round).
    const senderRoomEntryRx = activeSession?.roomParticipants?.get(userId);
    const recipientIdsRx: Set<string> = new Set();
    if (senderRoomEntryRx) {
      for (const [uid, info] of activeSession!.roomParticipants!) {
        if (info.roomId === senderRoomEntryRx.roomId) recipientIdsRx.add(uid);
      }
    } else {
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
