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

// Generate URL-safe invite codes (8 chars, alphanumeric)
const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 8);

const INVITE_COLUMNS = `
  id, code, type, inviter_id AS "inviterId", invitee_email AS "inviteeEmail",
  pod_id AS "podId", session_id AS "sessionId", status, max_uses AS "maxUses",
  use_count AS "useCount", expires_at AS "expiresAt",
  accepted_by_user_id AS "acceptedByUserId", accepted_at AS "acceptedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// ─── Create Invite ──────────────────────────────────────────────────────────

export async function createInvite(userId: string, input: CreateInviteInput): Promise<Invite> {
  const code = generateCode();

  let expiresAt: Date | null = null;
  if (input.expiresInHours) {
    expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
  }

  // Validate pod/session references
  if (input.type === InviteType.POD && input.podId) {
    await podService.getPodById(input.podId);
  }
  if (input.type === InviteType.SESSION && input.sessionId) {
    await sessionService.getSessionById(input.sessionId);
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
      input.maxUses || 1,
      expiresAt,
    ]
  );

  logger.info({ code, type: input.type, userId }, 'Invite created');
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
      throw new AppError(400, 'INVITE_ALREADY_USED', 'This invite has reached its maximum uses');
    }

    if (invite.inviteeEmail) {
      // Check if the accepting user matches the intended email
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
}): Promise<{ invites: Invite[]; total: number }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE inviter_id = $1';
  const values: unknown[] = [userId];
  let paramIdx = 2;

  if (params.type) {
    whereClause += ` AND type = $${paramIdx}`;
    values.push(params.type);
    paramIdx++;
  }

  if (params.status) {
    whereClause += ` AND status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM invites ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(pageSize, offset);
  const result = await query<Invite>(
    `SELECT ${INVITE_COLUMNS} FROM invites ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { invites: result.rows, total };
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
