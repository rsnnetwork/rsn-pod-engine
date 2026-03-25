// ─── Session Service ─────────────────────────────────────────────────────────
// Handles session CRUD, participant registration, and session state management.

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  Session, SessionParticipant, SessionConfig, SessionStatus,
  ParticipantStatus, CreateSessionInput, UpdateSessionInput,
  DEFAULT_SESSION_CONFIG, UserRole, hasRoleAtLeast,
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
  session_participants.id, session_id AS "sessionId", user_id AS "userId", session_participants.status,
  joined_at AS "joinedAt", left_at AS "leftAt", current_room_id AS "currentRoomId",
  is_no_show AS "isNoShow", rounds_completed AS "roundsCompleted",
  session_participants.created_at AS "createdAt"
`;

// ─── Session CRUD ───────────────────────────────────────────────────────────

export async function createSession(userId: string, input: CreateSessionInput, userRole?: UserRole): Promise<Session> {
  // Verify pod exists (will throw NotFoundError if not)
  await podService.getPodById(input.podId);

  // Admins can create sessions in any pod; others must be director or host
  const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
  if (!isAdmin) {
    const memberRole = await podService.getMemberRole(input.podId, userId);
    if (!memberRole || !['director', 'host'].includes(memberRole)) {
      throw new ForbiddenError('Only pod directors and hosts can create sessions');
    }
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

  // Auto-register the host as a participant
  await query(
    `INSERT INTO session_participants (session_id, user_id, status) VALUES ($1, $2, 'registered')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, userId]
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

export async function updateSession(sessionId: string, userId: string, input: UpdateSessionInput, userRole?: UserRole): Promise<Session> {
  const session = await getSessionById(sessionId);

  // Admin/super_admin or session host can update
  const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
  if (!isAdmin && session.hostUserId !== userId) {
    throw new ForbiddenError('Only the session host can update the session');
  }

  // Cannot update once started
  if (session.status !== SessionStatus.SCHEDULED) {
    throw new AppError(400, 'SESSION_ALREADY_STARTED', 'Cannot update an event that has already started');
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
  userId?: string;
  isAdmin?: boolean;
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
    whereClause += ` AND s.pod_id = $${paramIdx}`;
    values.push(params.podId);
    paramIdx++;
  } else if (params.isAdmin) {
    // Admins see all sessions across all pods
  } else if (params.userId) {
    // Show sessions from public/invite_only pods AND private pods user is a member of
    whereClause += ` AND (s.pod_id IN (SELECT id FROM pods WHERE visibility IN ('public', 'invite_only')) OR s.pod_id IN (SELECT pod_id FROM pod_members WHERE user_id = $${paramIdx} AND status = 'active'))`;
    values.push(params.userId);
    paramIdx++;
  } else {
    // Browsing all sessions: hide sessions from private pods
    whereClause += ` AND s.pod_id IN (SELECT id FROM pods WHERE visibility IN ('public', 'invite_only'))`;
  }

  if (params.status) {
    whereClause += ` AND s.status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM sessions s ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(pageSize, offset);
  const result = await query<Session & { podName?: string; hostDisplayName?: string }>(
    `SELECT s.id, s.pod_id AS "podId", s.title, s.description, s.scheduled_at AS "scheduledAt",
            s.started_at AS "startedAt", s.ended_at AS "endedAt", s.status,
            s.current_round AS "currentRound", s.config, s.host_user_id AS "hostUserId",
            s.lobby_room_id AS "lobbyRoomId", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
            p.name AS "podName",
            u.display_name AS "hostDisplayName"
     FROM sessions s
     LEFT JOIN pods p ON s.pod_id = p.id
     LEFT JOIN users u ON s.host_user_id = u.id
     ${whereClause}
     ORDER BY s.scheduled_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { sessions: result.rows, total };
}

// ─── Participant Registration ───────────────────────────────────────────────

export async function registerParticipant(sessionId: string, userId: string, userRole?: UserRole): Promise<SessionParticipant> {
  return transaction(async (client) => {
    // Lock the session row to serialize concurrent registrations
    const sessionResult = await client.query<Session>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    if (sessionResult.rows.length === 0) {
      throw new NotFoundError('Session', sessionId);
    }
    const session = sessionResult.rows[0];

    // Check session is open for registration
    const closedStatuses: SessionStatus[] = [SessionStatus.COMPLETED, SessionStatus.CANCELLED];
    if (closedStatuses.includes(session.status)) {
      throw new AppError(400, 'SESSION_NOT_SCHEDULED', 'This event is no longer accepting participants');
    }

    // Enforce pod visibility rules for session access (admin/super_admin bypass)
    const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
    const podResult = await client.query(
      `SELECT visibility FROM pods WHERE id = $1`,
      [session.podId]
    );
    if (podResult.rows.length > 0 && !isAdmin) {
      const podVisibility = podResult.rows[0].visibility;
      const memberResult = await client.query(
        `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
        [session.podId, userId]
      );
      const isMember = memberResult.rows.length > 0;

      if (podVisibility === 'public' && !isMember) {
        // Auto-add to pod when registering for a session in a public pod
        try {
          await client.query(
            `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')
             ON CONFLICT (pod_id, user_id) DO UPDATE SET status = 'active', joined_at = NOW(), left_at = NULL`,
            [session.podId, userId]
          );
        } catch { /* ignore if already member */ }
      } else if ((podVisibility === 'invite_only' || podVisibility === 'private') && !isMember) {
        // Check if user has a valid invite for this session — if so, auto-add to pod
        const inviteCheck = await client.query(
          `SELECT i.id FROM invites i
           JOIN users u ON u.email = i.invitee_email
           WHERE i.session_id = $1 AND u.id = $2 AND i.status IN ('pending', 'accepted')
           LIMIT 1`,
          [session.id, userId]
        );
        if (inviteCheck.rows.length > 0) {
          try {
            await client.query(
              `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')
               ON CONFLICT (pod_id, user_id) DO UPDATE SET status = 'active', joined_at = NOW(), left_at = NULL`,
              [session.podId, userId]
            );
          } catch { /* ignore if already member */ }
        } else {
          throw new ForbiddenError('You must be a pod member to register for sessions in a private pod');
        }
      }
    }

    // Check capacity
    const config = typeof session.config === 'string'
      ? JSON.parse(session.config as unknown as string)
      : session.config;

    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left')`,
      [sessionId]
    );
    const currentCount = parseInt(countResult.rows[0].count, 10);

    if (config.maxParticipants && currentCount >= config.maxParticipants) {
      throw new ConflictError('SESSION_FULL', 'This event has reached its maximum participant count');
    }

    // Check for existing registration
    const existing = await client.query(
      `SELECT id, status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    if (existing.rows.length > 0) {
      const existingStatus = existing.rows[0].status as string;
      if (['registered', 'checked_in', 'in_lobby', 'in_round'].includes(existingStatus)) {
        throw new ConflictError('SESSION_ALREADY_REGISTERED', 'You are already registered for this event');
      }
      // Re-register
      const result = await client.query<SessionParticipant>(
        `UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE
         WHERE session_id = $1 AND user_id = $2
         RETURNING ${PARTICIPANT_COLUMNS}`,
        [sessionId, userId]
      );
      return result.rows[0];
    }

    const result = await client.query<SessionParticipant>(
      `INSERT INTO session_participants (session_id, user_id, status)
       VALUES ($1, $2, 'registered')
       RETURNING ${PARTICIPANT_COLUMNS}`,
      [sessionId, userId]
    );

    logger.info({ sessionId, userId }, 'Participant registered');
    return result.rows[0];
  });
}

export async function unregisterParticipant(sessionId: string, userId: string): Promise<void> {
  const session = await getSessionById(sessionId);

  if (session.status !== SessionStatus.SCHEDULED) {
    throw new AppError(400, 'SESSION_IN_PROGRESS', 'Cannot unregister from an active event');
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
): Promise<(SessionParticipant & { displayName?: string; email?: string; avatarUrl?: string; jobTitle?: string; company?: string })[]> {
  let sql = `SELECT ${PARTICIPANT_COLUMNS}, u.display_name AS "displayName", u.email,
                    u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle", u.company
             FROM session_participants
             JOIN users u ON u.id = session_participants.user_id
             WHERE session_id = $1`;
  const values: unknown[] = [sessionId];

  if (status) {
    sql += ' AND session_participants.status = $2';
    values.push(status);
  }

  sql += ' ORDER BY session_participants.created_at ASC';
  const result = await query<SessionParticipant & { displayName?: string; email?: string; avatarUrl?: string; jobTitle?: string; company?: string }>(sql, values);
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

// Valid participant status transitions. A null source means "from any state".
const VALID_STATUS_TRANSITIONS: Record<string, string[] | null> = {
  [ParticipantStatus.REGISTERED]: null, // initial state only
  [ParticipantStatus.CHECKED_IN]: [ParticipantStatus.REGISTERED, ParticipantStatus.DISCONNECTED],
  [ParticipantStatus.IN_LOBBY]: [ParticipantStatus.REGISTERED, ParticipantStatus.CHECKED_IN, ParticipantStatus.IN_ROUND, ParticipantStatus.DISCONNECTED],
  [ParticipantStatus.IN_ROUND]: [ParticipantStatus.IN_LOBBY, ParticipantStatus.CHECKED_IN, ParticipantStatus.DISCONNECTED],
  [ParticipantStatus.DISCONNECTED]: null, // can disconnect from any state
  [ParticipantStatus.LEFT]: null, // can leave from any state
  [ParticipantStatus.REMOVED]: null, // host can remove from any state
  [ParticipantStatus.NO_SHOW]: [ParticipantStatus.REGISTERED, ParticipantStatus.CHECKED_IN, ParticipantStatus.IN_LOBBY, ParticipantStatus.IN_ROUND, ParticipantStatus.DISCONNECTED],
};

export async function updateParticipantStatus(
  sessionId: string,
  userId: string,
  status: ParticipantStatus,
  roomId?: string
): Promise<void> {
  // Validate transition if rules exist for the target status
  const validFrom = VALID_STATUS_TRANSITIONS[status];
  if (validFrom !== null && validFrom !== undefined) {
    const currentResult = await query<{ status: string }>(
      `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    if (currentResult.rows.length > 0) {
      const currentStatus = currentResult.rows[0].status;
      if (!validFrom.includes(currentStatus as ParticipantStatus)) {
        logger.warn({ sessionId, userId, from: currentStatus, to: status },
          'Invalid participant status transition — allowing as fallback');
        // Log but don't block — orchestration depends on these transitions
      }
    }
  }

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

// ─── Delete Session ─────────────────────────────────────────────────────────

export async function deleteSession(sessionId: string, userId: string, userRole?: UserRole): Promise<void> {
  const session = await getSessionById(sessionId);

  // Admin/super_admin can delete any session; otherwise only session host
  const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
  if (!isAdmin && session.hostUserId !== userId) {
    throw new ForbiddenError('Only the session host can delete the session');
  }

  // Admins can delete in any state; non-admins only scheduled or completed
  if (!isAdmin && session.status !== SessionStatus.SCHEDULED && session.status !== SessionStatus.COMPLETED) {
    throw new AppError(400, 'SESSION_IN_PROGRESS', 'Cannot delete an event that is currently in progress');
  }

  // Soft-delete: mark as cancelled
  await query(`UPDATE sessions SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [sessionId]);
  logger.info({ sessionId, userId }, 'Session deleted (cancelled)');
}

// ─── Hard Delete Session (super_admin only) ─────────────────────────────────

export async function hardDeleteSession(sessionId: string): Promise<void> {
  await getSessionById(sessionId); // Verify exists

  await transaction(async (client) => {
    await client.query(`DELETE FROM ratings WHERE match_id IN (SELECT id FROM matches WHERE session_id = $1)`, [sessionId]);
    await client.query(`DELETE FROM matches WHERE session_id = $1`, [sessionId]);
    await client.query(`DELETE FROM session_participants WHERE session_id = $1`, [sessionId]);
    await client.query(`DELETE FROM invites WHERE session_id = $1`, [sessionId]);
    await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  });

  logger.info({ sessionId }, 'Session permanently deleted by admin');
}

export async function generateLiveKitToken(sessionId: string, userId: string, roomId?: string): Promise<{ token: string; livekitUrl: string }> {
  const { AccessToken } = await import('livekit-server-sdk');
  const config = (await import('../../config')).default;

  // Verify session exists
  const session = await getSessionById(sessionId);

  // Verify user is a participant or host
  const participantResult = await query<SessionParticipant>(
    `SELECT * FROM session_participants WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );

  if (participantResult.rows.length === 0 && session.hostUserId !== userId) {
    throw new ForbiddenError('User is not a participant in this event');
  }

  try {
    // Generate LiveKit access token
    const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
      identity: userId,
      ttl: 3600,
    });

    // Use the match-specific room if provided, otherwise fall back to session room
    const roomName = roomId || session.lobbyRoomId || `session-${sessionId}`;
    at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });

    const token = await at.toJwt();
    logger.info(`Generated LiveKit token for user ${userId} in room ${roomName}`);

    return { token, livekitUrl: config.livekitUrl };
  } catch (err) {
    logger.error('Failed to generate LiveKit token:', err);
    throw new AppError(500, 'LIVEKIT_TOKEN_ERROR', 'Failed to generate video room access token');
  }
}

// ─── Check if user is a participant in a session ──────────────────────────

export async function getParticipantStatusCounts(sessionId: string): Promise<{
  registered: number;
  checked_in: number;
  in_lobby: number;
  in_round: number;
  left: number;
  removed: number;
  disconnected: number;
  no_show: number;
  total: number;
  pendingInvites: number;
}> {
  const statusResult = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
     FROM session_participants
     WHERE session_id = $1
     GROUP BY status`,
    [sessionId]
  );

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of statusResult.rows) {
    counts[row.status] = parseInt(row.count, 10);
    if (row.status !== 'removed' && row.status !== 'left') {
      total += parseInt(row.count, 10);
    }
  }

  // Count pending invites for this session
  const inviteResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM invites
     WHERE session_id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId]
  );
  const pendingInvites = parseInt(inviteResult.rows[0]?.count || '0', 10);

  return {
    registered: counts['registered'] || 0,
    checked_in: counts['checked_in'] || 0,
    in_lobby: counts['in_lobby'] || 0,
    in_round: counts['in_round'] || 0,
    left: counts['left'] || 0,
    removed: counts['removed'] || 0,
    disconnected: counts['disconnected'] || 0,
    no_show: counts['no_show'] || 0,
    total,
    pendingInvites,
  };
}

export async function isSessionParticipant(sessionId: string, userId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2 AND status NOT IN ('removed', 'left')`,
    [sessionId, userId]
  );
  return result.rows.length > 0;
}

// ─── Premium Selections ───────────────────────────────────────────────────────

export async function getPremiumSelections(sessionId: string, userId: string) {
  return query<{ selectedUserId: string; displayName: string; avatarUrl: string | null }>(
    `SELECT ps.selected_user_id AS "selectedUserId",
            u.display_name AS "displayName", u.avatar_url AS "avatarUrl"
     FROM premium_selections ps
     JOIN users u ON u.id = ps.selected_user_id
     WHERE ps.session_id = $1 AND ps.user_id = $2
     ORDER BY ps.created_at`,
    [sessionId, userId]
  );
}

export async function setPremiumSelections(sessionId: string, userId: string, selectedUserIds: string[]): Promise<void> {
  await transaction(async (client) => {
    // Clear existing selections for this user+session
    await client.query(
      `DELETE FROM premium_selections WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId]
    );
    // Insert new selections
    for (const selectedId of selectedUserIds) {
      if (selectedId === userId) continue; // skip self (constraint would catch it, but be safe)
      await client.query(
        `INSERT INTO premium_selections (user_id, session_id, selected_user_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, session_id, selected_user_id) DO NOTHING`,
        [userId, sessionId, selectedId]
      );
    }
  });
}
