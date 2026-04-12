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
import * as matchingService from '../../matching/matching.service';

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
      // Broadcast to everyone in the session
      io.to(sessionRoom(sessionId)).emit('chat:message', chatMsg);
    } else {
      // Room scope: find the user's current breakout room match and emit only to those users
      const activeSessionForRoom = activeSessions.get(sessionId);
      if (!activeSessionForRoom || activeSessionForRoom.status !== SessionStatus.ROUND_ACTIVE) {
        // Not in a round, fall back to lobby broadcast
        chatMsg.scope = 'lobby';
        io.to(sessionRoom(sessionId)).emit('chat:message', chatMsg);
        return;
      }

      const matches = await matchingService.getMatchesByRound(sessionId, activeSessionForRoom.currentRound);
      const userMatch = matches.find(
        m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'active'
      );

      if (userMatch) {
        chatMsg.roomId = userMatch.roomId || undefined;
        // Emit to all participants in this match
        const participantIds = [userMatch.participantAId, userMatch.participantBId];
        if (userMatch.participantCId) participantIds.push(userMatch.participantCId);
        for (const pid of participantIds) {
          io.to(userRoom(pid)).emit('chat:message', chatMsg);
        }
      } else {
        // Not matched, send only to self
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

    // Broadcast updated reactions to all in session (lobby-scope messages visible to all)
    io.to(sessionRoom(sessionId)).emit('chat:reaction_update', {
      messageId,
      reactions: msg.reactions,
    });
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
    if (!isHost && !isCohost) {
      const activeSession = activeSessions.get(sessionId);
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
    const activeSession = activeSessions.get(sessionId);
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE && data.matchId) {
      // Room-scoped: find match participants and emit only to them
      const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);
      const userMatch = matches.find(
        m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'active'
      );
      if (userMatch) {
        const participantIds = [userMatch.participantAId, userMatch.participantBId];
        if (userMatch.participantCId) participantIds.push(userMatch.participantCId);
        for (const pid of participantIds) {
          io.to(userRoom(pid)).emit('reaction:received', reactionPayload);
        }
      } else {
        socket.emit('reaction:received', reactionPayload);
      }
    } else {
      // Lobby/transition: broadcast to everyone
      io.to(sessionRoom(sessionId)).emit('reaction:received', reactionPayload);
    }
  } catch (err) {
    logger.error({ err }, 'Error handling reaction');
  }
}
