// ─── Session Service ─────────────────────────────────────────────────────────
// Handles session CRUD, participant registration, and session state management.

import { v4 as uuid } from 'uuid';
import { query } from '../../db';
import logger from '../../config/logger';
import {
  Session, SessionParticipant, SessionConfig, SessionStatus,
  ParticipantStatus, CreateSessionInput, UpdateSessionInput,
  DEFAULT_SESSION_CONFIG,
} from '@rsn/shared';
import { NotFoundError, ConflictError, ForbiddenError, AppError } from '../../middleware/errors';
import * as podService from '../pod/pod.service';

// ─── Column helpers ─────────────────────────────────────────────────────────

const SESSION_COLUMNS = `
  id, pod_id AS "podId", title, description, scheduled_at AS "scheduledAt",
  started_at AS "startedAt", ended_at AS "endedAt", status,
  current_round AS "currentRound", config, host_user_id AS "hostUserId",
  lobby_room_id AS "lobbyRoomId", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const PARTICIPANT_COLUMNS = `
  id, session_id AS "sessionId", user_id AS "userId", status,
  joined_at AS "joinedAt", left_at AS "leftAt", current_room_id AS "currentRoomId",
  is_no_show AS "isNoShow", rounds_completed AS "roundsCompleted",
  created_at AS "createdAt"
`;

// ─── Session CRUD ───────────────────────────────────────────────────────────

export async function createSession(userId: string, input: CreateSessionInput): Promise<Session> {
  // Verify pod exists and user has host/director role
  // Verify pod exists (will throw NotFoundError if not)
  await podService.getPodById(input.podId);
  const memberRole = await podService.getMemberRole(input.podId, userId);

  if (!memberRole || !['director', 'host'].includes(memberRole)) {
    throw new ForbiddenError('Only pod directors and hosts can create sessions');
  }

  const sessionConfig: SessionConfig = {
    ...DEFAULT_SESSION_CONFIG,
    ...(input.config || {}),
  };

  const sessionId = uuid();

  const result = await query<Session>(
    `INSERT INTO sessions (id, pod_id, title, description, scheduled_at, config, host_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SESSION_COLUMNS}`,
    [
      sessionId,
      input.podId,
      input.title,
      input.description || null,
      input.scheduledAt,
      JSON.stringify(sessionConfig),
      userId,
    ]
  );

  logger.info({ sessionId, podId: input.podId, userId }, 'Session created');
  return result.rows[0];
}

export async function getSessionById(sessionId: string): Promise<Session> {
  const result = await query<Session>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Session', sessionId);
  }
  return result.rows[0];
}

export async function updateSession(sessionId: string, userId: string, input: UpdateSessionInput): Promise<Session> {
  const session = await getSessionById(sessionId);

  // Only host can update
  if (session.hostUserId !== userId) {
    throw new ForbiddenError('Only the session host can update the session');
  }

  // Cannot update once started
  if (session.status !== SessionStatus.SCHEDULED) {
    throw new AppError(400, 'SESSION_ALREADY_STARTED', 'Cannot update a session that has already started');
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (input.title) {
    setClauses.push(`title = $${paramIdx}`);
    values.push(input.title);
    paramIdx++;
  }

  if (input.description !== undefined) {
    setClauses.push(`description = $${paramIdx}`);
    values.push(input.description);
    paramIdx++;
  }

  if (input.scheduledAt) {
    setClauses.push(`scheduled_at = $${paramIdx}`);
    values.push(input.scheduledAt);
    paramIdx++;
  }

  if (input.config) {
    const currentConfig = typeof session.config === 'string'
      ? JSON.parse(session.config as unknown as string)
      : session.config;
    const newConfig = { ...currentConfig, ...input.config };
    setClauses.push(`config = $${paramIdx}`);
    values.push(JSON.stringify(newConfig));
    paramIdx++;
  }

  if (setClauses.length === 0) {
    return session;
  }

  values.push(sessionId);
  const result = await query<Session>(
    `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING ${SESSION_COLUMNS}`,
    values
  );

  return result.rows[0];
}

export async function listSessions(params: {
  podId?: string;
  status?: SessionStatus;
  page?: number;
  pageSize?: number;
}): Promise<{ sessions: Session[]; total: number }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE 1=1';
  const values: unknown[] = [];
  let paramIdx = 1;

  if (params.podId) {
    whereClause += ` AND pod_id = $${paramIdx}`;
    values.push(params.podId);
    paramIdx++;
  }

  if (params.status) {
    whereClause += ` AND status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM sessions ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(pageSize, offset);
  const result = await query<Session>(
    `SELECT ${SESSION_COLUMNS} FROM sessions ${whereClause}
     ORDER BY scheduled_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { sessions: result.rows, total };
}

// ─── Participant Registration ───────────────────────────────────────────────

export async function registerParticipant(sessionId: string, userId: string): Promise<SessionParticipant> {
  const session = await getSessionById(sessionId);

  // Check session is open for registration
  if (session.status !== SessionStatus.SCHEDULED && session.status !== SessionStatus.LOBBY_OPEN) {
    throw new AppError(400, 'SESSION_NOT_SCHEDULED', 'Session is not open for registration');
  }

  // Check capacity
  const config = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left')`,
    [sessionId]
  );
  const currentCount = parseInt(countResult.rows[0].count, 10);

  if (config.maxParticipants && currentCount >= config.maxParticipants) {
    throw new ConflictError('SESSION_FULL', 'This session has reached its maximum participant count');
  }

  // Check for existing registration
  const existing = await query(
    `SELECT id, status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );

  if (existing.rows.length > 0) {
    const existingStatus = existing.rows[0].status as string;
    if (['registered', 'checked_in', 'in_lobby', 'in_round'].includes(existingStatus)) {
      throw new ConflictError('SESSION_ALREADY_REGISTERED', 'You are already registered for this session');
    }
    // Re-register
    const result = await query<SessionParticipant>(
      `UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE
       WHERE session_id = $1 AND user_id = $2
       RETURNING ${PARTICIPANT_COLUMNS}`,
      [sessionId, userId]
    );
    return result.rows[0];
  }

  const result = await query<SessionParticipant>(
    `INSERT INTO session_participants (session_id, user_id, status)
     VALUES ($1, $2, 'registered')
     RETURNING ${PARTICIPANT_COLUMNS}`,
    [sessionId, userId]
  );

  logger.info({ sessionId, userId }, 'Participant registered');
  return result.rows[0];
}

export async function unregisterParticipant(sessionId: string, userId: string): Promise<void> {
  const session = await getSessionById(sessionId);

  if (session.status !== SessionStatus.SCHEDULED) {
    throw new AppError(400, 'SESSION_IN_PROGRESS', 'Cannot unregister from an active session');
  }

  const result = await query(
    `UPDATE session_participants SET status = 'left', left_at = NOW()
     WHERE session_id = $1 AND user_id = $2 AND status = 'registered'`,
    [sessionId, userId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Registration');
  }
}

export async function getSessionParticipants(
  sessionId: string,
  status?: ParticipantStatus
): Promise<SessionParticipant[]> {
  let sql = `SELECT ${PARTICIPANT_COLUMNS} FROM session_participants WHERE session_id = $1`;
  const values: unknown[] = [sessionId];

  if (status) {
    sql += ' AND status = $2';
    values.push(status);
  }

  sql += ' ORDER BY created_at ASC';
  const result = await query<SessionParticipant>(sql, values);
  return result.rows;
}

export async function getParticipantCount(sessionId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM session_participants
     WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
    [sessionId]
  );
  return parseInt(result.rows[0].count, 10);
}

// ─── Session State Changes ──────────────────────────────────────────────────

export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  updates?: Partial<{ currentRound: number; lobbyRoomId: string; startedAt: Date; endedAt: Date }>
): Promise<Session> {
  const setClauses = ['status = $1'];
  const values: unknown[] = [status];
  let paramIdx = 2;

  if (updates?.currentRound !== undefined) {
    setClauses.push(`current_round = $${paramIdx}`);
    values.push(updates.currentRound);
    paramIdx++;
  }

  if (updates?.lobbyRoomId !== undefined) {
    setClauses.push(`lobby_room_id = $${paramIdx}`);
    values.push(updates.lobbyRoomId);
    paramIdx++;
  }

  if (updates?.startedAt !== undefined) {
    setClauses.push(`started_at = $${paramIdx}`);
    values.push(updates.startedAt);
    paramIdx++;
  }

  if (updates?.endedAt !== undefined) {
    setClauses.push(`ended_at = $${paramIdx}`);
    values.push(updates.endedAt);
    paramIdx++;
  }

  values.push(sessionId);
  const result = await query<Session>(
    `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING ${SESSION_COLUMNS}`,
    values
  );

  logger.info({ sessionId, status }, 'Session status updated');
  return result.rows[0];
}

export async function updateParticipantStatus(
  sessionId: string,
  userId: string,
  status: ParticipantStatus,
  roomId?: string
): Promise<void> {
  const setClauses = ['status = $1'];
  const values: unknown[] = [status];
  let paramIdx = 2;

  if (roomId !== undefined) {
    setClauses.push(`current_room_id = $${paramIdx}`);
    values.push(roomId);
    paramIdx++;
  }

  if (status === ParticipantStatus.IN_LOBBY || status === ParticipantStatus.CHECKED_IN) {
    setClauses.push(`joined_at = COALESCE(joined_at, NOW())`);
  }

  if (status === ParticipantStatus.LEFT || status === ParticipantStatus.REMOVED) {
    setClauses.push(`left_at = NOW()`);
  }

  if (status === ParticipantStatus.NO_SHOW) {
    setClauses.push(`is_no_show = TRUE`);
  }

  values.push(sessionId, userId);
  await query(
    `UPDATE session_participants SET ${setClauses.join(', ')} WHERE session_id = $${paramIdx} AND user_id = $${paramIdx + 1}`,
    values
  );
}

export async function incrementRoundsCompleted(sessionId: string, userId: string): Promise<void> {
  await query(
    `UPDATE session_participants SET rounds_completed = rounds_completed + 1
     WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
}

// ─── LiveKit Token Generation ──────────────────────────────────────────────

export async function generateLiveKitToken(sessionId: string, userId: string): Promise<{ token: string; livekitUrl: string }> {
  const { AccessToken } = await import('livekit-server-sdk');
  const config = (await import('../../config')).default;

  // Verify session exists
  const session = await getSessionById(sessionId);

  // Verify user is a participant or host
  const participant = await query<SessionParticipant>(
    `SELECT * FROM session_participants WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );

  if (!participant && session.hostUserId !== userId) {
    throw new ForbiddenError('User is not a participant in this session');
  }

  try {
    // Generate LiveKit access token
    const at = new AccessToken(config.liveKitApiKey, config.liveKitApiSecret, {
      identity: userId,
      ttl: 3600,
    });

    // Room name is the lobby room for this session
    const roomName = session.lobbyRoomId || `session-${sessionId}`;
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });

    const token = await at.toJwt();
    logger.info(`Generated LiveKit token for user ${userId} in room ${roomName}`);

    return { token, livekitUrl: config.livekitUrl };
  } catch (err) {
    logger.error('Failed to generate LiveKit token:', err);
    throw new AppError('Failed to generate video room access token');
  }
}
