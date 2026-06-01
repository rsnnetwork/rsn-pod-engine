// ─── Session State Module ───────────────────────────────────────────────────
// Extracted from orchestration.service.ts — shared state, types, guards,
// and helpers that every orchestration sub-module depends on.

import { Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus, SessionConfig } from '@rsn/shared';
import { getRedisClient } from '../../redis/redis.client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActiveSession {
  sessionId: string;
  hostUserId: string;
  config: SessionConfig;
  currentRound: number;
  status: SessionStatus;
  timer: NodeJS.Timeout | null;
  timerSyncInterval: NodeJS.Timeout | null; // Track 5-second timer sync interval for cleanup
  timerEndsAt: Date | null;
  isPaused: boolean;
  pausedTimeRemaining: number | null;
  presenceMap: Map<string, { lastHeartbeat: Date; socketId: string; reconnectedAt?: Date }>;
  pendingRoundNumber: number | null;  // Round number for pre-generated matches awaiting host confirmation
  manuallyLeftRound: Set<string>;     // Users who clicked "Leave Conversation" — skip in reconnect/reassignment
  // Tier-1 A1: per-session cache for display names used by emitHostDashboard
  // and sendMatchPreview. Names don't change during an event, so we populate
  // on first lookup and reuse until the session ends.
  displayNameCache?: Map<string, string>;
  // T0-2 (Issue 7) — track actual LiveKit room presence (NOT socket
  // presence). presenceMap.has(userId) is true once the participant's
  // socket joins the session room, but their LiveKit client may still be
  // fetching tokens or negotiating WebRTC. Until the client emits
  // `presence:room_joined { matchId, roomId }` after the LiveKit
  // `room.connect()` resolves, this Map stays empty for that user — so
  // emitHostDashboard reports `isConnected: false` and the host can see
  // the room hasn't actually started.
  roomParticipants?: Map<string, { matchId: string; roomId: string; joinedAt: Date }>;
  // Phase 1 (1 May spec) — participant state machine. Authoritative
  // in-memory canonical state per user. Mutated only via
  // services/orchestration/state/participant-state-machine.ts
  // transitionParticipant(). DB session_participants.status is a projection
  // for cross-process visibility, not the source of truth.
  participantStates?: Map<string, {
    state: string; // ParticipantState enum value
    currentRoomId: string | null;
    updatedAt: Date;
  }>;
}

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  message: string;
  timestamp: string;
  scope: 'lobby' | 'room';
  isHost: boolean;
  roomId?: string; // breakout room ID for room-scope messages
  reactions: Record<string, string[]>; // emoji → userIds
}

// ─── State Stores ───────────────────────────────────────────────────────────

export const activeSessions = new Map<string, ActiveSession>();

/** Track disconnect timeouts so they can be cancelled on reconnect */
export const disconnectTimeouts = new Map<string, NodeJS.Timeout>();

/** Per-session operation lock — prevents concurrent host actions on same session */
export const sessionLocks = new Map<string, Promise<void>>();

export const MAX_CHAT_MESSAGES = 50;
export const chatMessages = new Map<string, ChatMessage[]>(); // sessionId -> messages

// ─── Session Guard ──────────────────────────────────────────────────────────

/** Serialise operations on the same session to prevent race conditions */
export async function withSessionGuard<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending operation on this session to finish
  while (sessionLocks.has(sessionId)) {
    await sessionLocks.get(sessionId);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  sessionLocks.set(sessionId, lock);
  try {
    return await fn();
  } finally {
    sessionLocks.delete(sessionId);
    resolve!();
  }
}

// ─── Session State Persistence ──────────────────────────────────────────────

const REDIS_SESSION_PREFIX = 'rsn:session:';
const REDIS_CHAT_PREFIX = 'rsn:chat:';
const REDIS_TTL = 14400; // 4 hours — matches in-memory TTL cleanup

export async function persistSessionState(sessionId: string, activeSession: ActiveSession): Promise<void> {
  try {
    const state = {
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      hostUserId: activeSession.hostUserId,
      isPaused: activeSession.isPaused,
      timerEndsAt: activeSession.timerEndsAt?.toISOString() || null,
      pausedTimeRemaining: activeSession.pausedTimeRemaining || null,
    };
    await query(
      `UPDATE sessions SET active_state = $1, active_state_updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(state), sessionId]
    );
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to persist session state to DB — non-fatal');
  }

  // Redis write-through (async, non-blocking)
  persistToRedis(sessionId, activeSession).catch(() => {});
}

export async function clearPersistedState(sessionId: string): Promise<void> {
  try {
    await query(`UPDATE sessions SET active_state = NULL, active_state_updated_at = NULL WHERE id = $1`, [sessionId]);
  } catch { /* non-fatal */ }
  deleteFromRedis(sessionId).catch(() => {});
}

// ─── Redis Write-Through ─────────────────────────────────────────────────

async function persistToRedis(sessionId: string, session: ActiveSession): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const serialized = JSON.stringify({
      sessionId: session.sessionId,
      hostUserId: session.hostUserId,
      config: session.config,
      currentRound: session.currentRound,
      status: session.status,
      timerEndsAt: session.timerEndsAt?.toISOString() || null,
      isPaused: session.isPaused,
      pausedTimeRemaining: session.pausedTimeRemaining,
      pendingRoundNumber: session.pendingRoundNumber,
      presenceMap: Object.fromEntries(
        Array.from(session.presenceMap.entries()).map(([k, v]) => [k, {
          lastHeartbeat: v.lastHeartbeat.toISOString(),
          socketId: v.socketId,
          reconnectedAt: v.reconnectedAt?.toISOString() || null,
        }])
      ),
      manuallyLeftRound: Array.from(session.manuallyLeftRound),
    });
    await redis.setex(`${REDIS_SESSION_PREFIX}${sessionId}`, REDIS_TTL, serialized);
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to persist session to Redis');
  }
}

async function deleteFromRedis(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(`${REDIS_SESSION_PREFIX}${sessionId}`);
    await redis.del(`${REDIS_CHAT_PREFIX}${sessionId}`);
  } catch { /* non-fatal */ }
}

export async function restoreAllFromRedis(): Promise<Map<string, any>> {
  const redis = getRedisClient();
  if (!redis) return new Map();

  try {
    const keys = await redis.keys(`${REDIS_SESSION_PREFIX}*`);
    const sessions = new Map<string, any>();
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        try {
          sessions.set(key.replace(REDIS_SESSION_PREFIX, ''), JSON.parse(data));
        } catch { /* skip malformed */ }
      }
    }
    logger.info({ count: sessions.size }, 'Restored sessions from Redis');
    return sessions;
  } catch (err) {
    logger.warn({ err }, 'Failed to restore from Redis — falling back to DB');
    return new Map();
  }
}

// ─── Socket Room Helpers ────────────────────────────────────────────────────

export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function getUserIdFromSocket(socket: Socket): string | null {
  return (socket.data as any)?.userId || null;
}

// ─── Chat Helpers ───────────────────────────────────────────────────────────

/** Get chat messages for a session (returns empty array if none) */
export function getSessionChat(sessionId: string): ChatMessage[] {
  return chatMessages.get(sessionId) || [];
}

/** Add a chat message to a session, enforcing the max message limit */
export function addSessionChat(sessionId: string, message: ChatMessage): void {
  let messages = chatMessages.get(sessionId);
  if (!messages) {
    messages = [];
    chatMessages.set(sessionId, messages);
  }
  messages.push(message);
  // Trim oldest messages when over limit
  if (messages.length > MAX_CHAT_MESSAGES) {
    messages.splice(0, messages.length - MAX_CHAT_MESSAGES);
  }
  // Redis write-through for chat
  persistChatToRedis(sessionId, messages).catch(() => {});
}

/** Remove all chat messages for a session */
export function cleanupChatMessages(sessionId: string): void {
  chatMessages.delete(sessionId);
  const redis = getRedisClient();
  if (redis) redis.del(`${REDIS_CHAT_PREFIX}${sessionId}`).catch(() => {});
}

async function persistChatToRedis(sessionId: string, messages: ChatMessage[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.setex(
      `${REDIS_CHAT_PREFIX}${sessionId}`,
      REDIS_TTL,
      JSON.stringify(messages.slice(-MAX_CHAT_MESSAGES))
    );
  } catch { /* non-fatal */ }
}

// ─── Rating Emit Dedup Helper ───────────────────────────────────────────────
//
// Centralised dedup for `rating:window_open` emits. Many flows can fire this
// event for the same (matchId, userId): voluntary leave, host-remove,
// breakout-end, disconnect→reassign, reconnect-replay, end-of-round. Without
// dedup, a user who already submitted a rating gets the form again — they
// either resubmit (duplicate insert attempt → ConflictError, with the rating
// silently overwritten via ON CONFLICT DO UPDATE) or are confused by a stale
// prompt for a partner they already rated.
//
// This helper checks the ratings table and skips the emit if a rating exists.
// Fail-open: if the DB query errors, we still emit (better a duplicate prompt
// than a missed one — and the rating service itself will reject the dup).

export async function emitRatingWindowOnce(
  io: { to: (room: string) => { emit: (event: string, payload: unknown) => void } },
  userId: string,
  matchId: string,
  payload: unknown,
): Promise<void> {
  try {
    const existing = await query<{ id: string }>(
      `SELECT id FROM ratings WHERE match_id = $1 AND from_user_id = $2 LIMIT 1`,
      [matchId, userId],
    );
    if (existing.rows.length > 0) {
      logger.info({ matchId, userId }, 'Skipping rating:window_open — user already rated this match');
      return;
    }
  } catch (err) {
    logger.warn({ err, matchId, userId }, 'rating dedup check failed — emitting anyway (fail-open)');
  }
  io.to(userRoom(userId)).emit('rating:window_open', payload);
}

// ─── Health / Diagnostics ───────────────────────────────────────────────────

/** Number of active sessions currently tracked in memory */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}
