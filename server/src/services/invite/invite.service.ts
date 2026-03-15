// ─── Invite Service ──────────────────────────────────────────────────────────
// Handles invite creation, acceptance, status tracking, and validation.

import { customAlphabet } from 'nanoid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  Invite, InviteStatus, InviteType, CreateInviteInput,
} from '@rsn/shared';
import { NotFoundError, ConflictError, AppError } from '../../middleware/errors';
import * as podService from '../pod/pod.service';
import * as sessionService from '../session/session.service';
import * as emailService from '../email/email.service';
import config from '../../config';

// Generate URL-safe invite codes (12 chars, alphanumeric — higher entropy for brute-force resistance)
const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 12);

const INVITE_COLUMNS = `
  id, code, type, inviter_id AS "inviterId", invitee_email AS "inviteeEmail",
  pod_id AS "podId", session_id AS "sessionId", status, max_uses AS "maxUses",
  use_count AS "useCount", expires_at AS "expiresAt",
  accepted_by_user_id AS "acceptedByUserId", accepted_at AS "acceptedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// ─── Create Invite ──────────────────────────────────────────────────────────

export async function createInvite(userId: string, input: CreateInviteInput, userRole?: string): Promise<Invite> {
  const code = generateCode();

  let expiresAt: Date | null = null;
  if (input.expiresInHours) {
    expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
  }

  const isAdmin = userRole === 'admin' || userRole === 'super_admin';

  // Block self-invites
  if (input.inviteeEmail) {
    const callerResult = await query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );
    if (callerResult.rows[0]?.email === input.inviteeEmail.toLowerCase()) {
      throw new AppError(400, 'SELF_INVITE', 'You cannot invite yourself');
    }
  }

  // Platform invites: reject if user is already registered
  if ((!input.type || input.type === InviteType.PLATFORM) && input.inviteeEmail) {
    const existingUser = await query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [input.inviteeEmail.toLowerCase()]
    );
    if (existingUser.rows.length > 0) {
      throw new AppError(409, 'ALREADY_REGISTERED', 'This user is already registered on the platform');
    }
  }

  // Validate pod/session references — require target for pod/session invites
  // IMPORTANT: membership checks come BEFORE duplicate-invite checks so the
  // user sees "already a member" instead of "pending invite exists"
  if (input.type === InviteType.POD) {
    if (!input.podId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Pod invite requires a pod to be selected');
    }
    const pod = await podService.getPodById(input.podId);

    // Cannot invite to archived pods
    if (pod.status === 'archived') {
      throw new AppError(400, 'POD_ARCHIVED', 'Cannot invite to an archived pod');
    }

    // Only directors and hosts can invite to pods (admins bypass)
    if (!isAdmin) {
      const memberRole = await podService.getMemberRole(input.podId, userId);
      if (!memberRole || (memberRole !== 'director' && memberRole !== 'host')) {
        throw new AppError(403, 'AUTH_FORBIDDEN', 'Only pod directors and hosts can send pod invites');
      }
    }

    // Check if invitee is already a member of this pod
    if (input.inviteeEmail) {
      const existingMember = await query<{ id: string }>(
        `SELECT u.id FROM users u
         JOIN pod_members pm ON pm.user_id = u.id
         WHERE u.email = $1 AND pm.pod_id = $2 AND pm.status = 'active'`,
        [input.inviteeEmail.toLowerCase(), input.podId]
      );
      if (existingMember.rows.length > 0) {
        throw new AppError(409, 'POD_MEMBER_EXISTS', 'This user is already a member of this pod');
      }
    }
  }

  if (input.type === InviteType.SESSION) {
    if (!input.sessionId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Event invite requires an event to be selected');
    }
    const session = await sessionService.getSessionById(input.sessionId);

    // Cannot invite to completed or cancelled events
    if (session.status === 'completed' || session.status === 'cancelled') {
      throw new AppError(400, 'VALIDATION_ERROR', `Cannot invite to a ${session.status} event`);
    }

    // Only the session host can invite to events (admins bypass)
    if (!isAdmin && session.hostUserId !== userId) {
      throw new AppError(403, 'AUTH_FORBIDDEN', 'Only the event host can send event invites');
    }

    // Check if invitee is already a participant of this session
    if (input.inviteeEmail) {
      const existingParticipant = await query<{ id: string }>(
        `SELECT u.id FROM users u
         JOIN session_participants sp ON sp.user_id = u.id
         WHERE u.email = $1 AND sp.session_id = $2`,
        [input.inviteeEmail.toLowerCase(), input.sessionId]
      );
      if (existingParticipant.rows.length > 0) {
        throw new AppError(409, 'SESSION_ALREADY_REGISTERED', 'This user is already a participant of this event');
      }
    }
  }

  // Block duplicate pending invites (checked AFTER membership so the right error shows)
  if (input.inviteeEmail) {
    const dupCheck = await query<{ id: string }>(
      `SELECT id FROM invites
       WHERE invitee_email = $1 AND type = $2 AND status = 'pending'
         AND ($3::uuid IS NULL OR pod_id = $3)
         AND ($4::uuid IS NULL OR session_id = $4)`,
      [input.inviteeEmail.toLowerCase(), input.type, input.podId || null, input.sessionId || null]
    );
    if (dupCheck.rows.length > 0) {
      throw new AppError(409, 'DUPLICATE_INVITE', 'A pending invite already exists for this user');
    }
  }

  const result = await query<Invite>(
    `INSERT INTO invites (code, type, inviter_id, invitee_email, pod_id, session_id, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${INVITE_COLUMNS}`,
    [
      code,
      input.type || InviteType.PLATFORM,
      userId,
      input.inviteeEmail?.toLowerCase() || null,
      input.podId || null,
      input.sessionId || null,
      input.maxUses || 2,
      expiresAt,
    ]
  );

  logger.info({ code, type: input.type, userId }, 'Invite created');

  // Send invite email if a recipient address was provided
  if (input.inviteeEmail) {
    const inviterResult = await query<{ displayName: string }>(
      `SELECT display_name AS "displayName" FROM users WHERE id = $1`,
      [userId]
    );
    const inviterName = inviterResult.rows[0]?.displayName || 'Someone';

    let targetName: string | undefined;
    if (input.type === InviteType.POD && input.podId) {
      const podResult = await query<{ name: string }>('SELECT name FROM pods WHERE id = $1', [input.podId]);
      targetName = podResult.rows[0]?.name;
    }
    if (input.type === InviteType.SESSION && input.sessionId) {
      const sessionResult = await query<{ title: string }>('SELECT title FROM sessions WHERE id = $1', [input.sessionId]);
      targetName = sessionResult.rows[0]?.title;
    }

    emailService.sendInviteEmail(input.inviteeEmail, {
      inviterName,
      type: (input.type || 'platform') as 'pod' | 'session' | 'platform',
      targetName,
      inviteUrl: `${config.clientUrl}/invite/${code}`,
    }).catch(err => logger.warn({ err }, 'Failed to send invite email (non-fatal)'));
  }

  return result.rows[0];
}

// ─── Get Invite by Code ─────────────────────────────────────────────────────

export async function getInviteByCode(code: string): Promise<Invite> {
  const result = await query<Invite>(
    `SELECT ${INVITE_COLUMNS} FROM invites WHERE code = $1`,
    [code]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Invite');
  }
  return result.rows[0];
}

// ─── Accept Invite ──────────────────────────────────────────────────────────

export async function acceptInvite(code: string, userId: string): Promise<Invite> {
  return transaction(async (client) => {
    // Lock the invite row for update
    const inviteResult = await client.query(
      `SELECT ${INVITE_COLUMNS} FROM invites WHERE code = $1 FOR UPDATE`,
      [code]
    );

    if (inviteResult.rows.length === 0) {
      throw new NotFoundError('Invite');
    }

    const invite = inviteResult.rows[0] as Invite;

    // Validation checks
    if (invite.status === InviteStatus.REVOKED) {
      throw new AppError(400, 'INVITE_REVOKED', 'This invite has been revoked');
    }

    if (invite.status === InviteStatus.EXPIRED) {
      throw new AppError(400, 'INVITE_EXPIRED', 'This invite has expired');
    }

    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      await client.query(
        `UPDATE invites SET status = 'expired' WHERE id = $1`,
        [invite.id]
      );
      throw new AppError(400, 'INVITE_EXPIRED', 'This invite has expired');
    }

    if (invite.useCount >= invite.maxUses) {
      // If the invite was already consumed by THIS user during registration (Google OAuth),
      // still apply the pod/session membership effect instead of rejecting.
      if (invite.acceptedByUserId === userId) {
        // Apply effects without re-incrementing use_count
        if (invite.type === InviteType.POD && invite.podId) {
          try { await podService.addMember(invite.podId, userId); } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
          }
        }
        if (invite.type === InviteType.SESSION && invite.sessionId) {
          try { await sessionService.registerParticipant(invite.sessionId, userId); } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
          }
        }
        logger.info({ code, userId, type: invite.type }, 'Invite effects applied (already consumed during registration)');
        return invite;
      }
      throw new AppError(400, 'INVITE_ALREADY_USED', 'This invite has reached its maximum uses');
    }

    if (invite.inviteeEmail && invite.maxUses === 1) {
      // Only enforce email check for single-use targeted invites;
      // multi-use / shared links can be accepted by anyone.
      const userResult = await client.query(
        `SELECT email FROM users WHERE id = $1`,
        [userId]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].email !== invite.inviteeEmail) {
        throw new AppError(403, 'AUTH_FORBIDDEN', 'This invite was sent to a different email address');
      }
    }

    // Update invite
    const updatedResult = await client.query(
      `UPDATE invites SET use_count = use_count + 1, accepted_by_user_id = $1, accepted_at = NOW(),
       status = CASE WHEN use_count + 1 >= max_uses THEN 'accepted'::invite_status ELSE status END
       WHERE id = $2
       RETURNING ${INVITE_COLUMNS}`,
      [userId, invite.id]
    );

    // Apply invite effects
    if (invite.type === InviteType.POD && invite.podId) {
      try {
        await podService.addMember(invite.podId, userId);
      } catch (err) {
        // Ignore if already a member
        if (!(err instanceof ConflictError)) throw err;
      }
    }

    if (invite.type === InviteType.SESSION && invite.sessionId) {
      try {
        await sessionService.registerParticipant(invite.sessionId, userId);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    }

    logger.info({ code, userId, type: invite.type }, 'Invite accepted');
    return updatedResult.rows[0] as Invite;
  });
}

// ─── List Invites ───────────────────────────────────────────────────────────

export async function listInvitesByUser(userId: string, params: {
  type?: InviteType;
  status?: InviteStatus;
  page?: number;
  pageSize?: number;
}): Promise<{ invites: (Invite & { podName?: string; sessionTitle?: string })[]; total: number }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE i.inviter_id = $1';
  const values: unknown[] = [userId];
  let paramIdx = 2;

  if (params.type) {
    whereClause += ` AND i.type = $${paramIdx}`;
    values.push(params.type);
    paramIdx++;
  }

  if (params.status) {
    whereClause += ` AND i.status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM invites i ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Enrich with pod name and session title via LEFT JOIN
  const ENRICHED_COLUMNS = `
    i.id, i.code, i.type, i.inviter_id AS "inviterId", i.invitee_email AS "inviteeEmail",
    i.pod_id AS "podId", i.session_id AS "sessionId", i.status, i.max_uses AS "maxUses",
    i.use_count AS "useCount", i.expires_at AS "expiresAt",
    i.accepted_by_user_id AS "acceptedByUserId", i.accepted_at AS "acceptedAt",
    i.created_at AS "createdAt", i.updated_at AS "updatedAt",
    p.name AS "podName", s.title AS "sessionTitle"
  `;

  values.push(pageSize, offset);
  const result = await query<Invite & { podName?: string; sessionTitle?: string }>(
    `SELECT ${ENRICHED_COLUMNS}
     FROM invites i
     LEFT JOIN pods p ON p.id = i.pod_id
     LEFT JOIN sessions s ON s.id = i.session_id
     ${whereClause}
     ORDER BY i.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { invites: result.rows, total };
}

// ─── List Received Invites ──────────────────────────────────────────────────

export async function listReceivedInvites(userEmail: string): Promise<(Invite & { podName?: string; sessionTitle?: string; inviterName?: string })[]> {
  const ENRICHED_COLUMNS = `
    i.id, i.code, i.type, i.inviter_id AS "inviterId", i.invitee_email AS "inviteeEmail",
    i.pod_id AS "podId", i.session_id AS "sessionId", i.status, i.max_uses AS "maxUses",
    i.use_count AS "useCount", i.expires_at AS "expiresAt",
    i.accepted_by_user_id AS "acceptedByUserId", i.accepted_at AS "acceptedAt",
    i.created_at AS "createdAt", i.updated_at AS "updatedAt",
    p.name AS "podName", s.title AS "sessionTitle",
    u.display_name AS "inviterName"
  `;

  const result = await query<Invite & { podName?: string; sessionTitle?: string; inviterName?: string }>(
    `SELECT ${ENRICHED_COLUMNS}
     FROM invites i
     LEFT JOIN pods p ON p.id = i.pod_id
     LEFT JOIN sessions s ON s.id = i.session_id
     LEFT JOIN users u ON u.id = i.inviter_id
     WHERE i.invitee_email = $1 AND i.status = 'pending'
       AND (i.expires_at IS NULL OR i.expires_at > NOW())
     ORDER BY i.created_at DESC`,
    [userEmail.toLowerCase()]
  );

  return result.rows;
}

// ─── Decline Invite ─────────────────────────────────────────────────────────

export async function declineInvite(code: string, userEmail: string): Promise<void> {
  const result = await query(
    `UPDATE invites SET status = 'revoked'
     WHERE code = $1 AND invitee_email = $2 AND status = 'pending'`,
    [code, userEmail.toLowerCase()]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Invite');
  }

  logger.info({ code, userEmail }, 'Invite declined by recipient');
}

// ─── Revoke Invite ──────────────────────────────────────────────────────────

export async function revokeInvite(inviteId: string, userId: string): Promise<void> {
  const result = await query(
    `UPDATE invites SET status = 'revoked' WHERE id = $1 AND inviter_id = $2 AND status = 'pending'`,
    [inviteId, userId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Invite', inviteId);
  }

  logger.info({ inviteId, userId }, 'Invite revoked');
}
