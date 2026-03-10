// ─── Join Request Service ─────────────────────────────────────────────────────
// Handles the "Request to Join" flow: submission, listing, approval, decline.

import { query } from '../../db';
import logger from '../../config/logger';
import config from '../../config';
import { AppError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { sendJoinRequestConfirmationEmail, sendJoinRequestWelcomeEmail, sendJoinRequestDeclineEmail } from '../email/email.service';

export interface JoinRequest {
  id: string;
  fullName: string;
  email: string;
  linkedinUrl: string;
  reason: string;
  status: 'pending' | 'approved' | 'declined';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CreateJoinRequestInput {
  fullName: string;
  email: string;
  linkedinUrl: string;
  reason: string;
}

function mapRow(row: any): JoinRequest {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    linkedinUrl: row.linkedin_url,
    reason: row.reason,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createJoinRequest(input: CreateJoinRequestInput): Promise<JoinRequest> {
  // Check for duplicate pending request
  const existing = await query(
    `SELECT id FROM join_requests WHERE email = $1 AND status = 'pending'`,
    [input.email]
  );
  if (existing.rows.length > 0) {
    throw new AppError(409, ErrorCodes.INVALID_INPUT, 'You already have a pending request.');
  }

  const result = await query(
    `INSERT INTO join_requests (full_name, email, linkedin_url, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.fullName, input.email, input.linkedinUrl, input.reason]
  );

  logger.info({ email: input.email }, 'New join request submitted');

  // Send confirmation email (non-blocking)
  sendJoinRequestConfirmationEmail(input.email, input.fullName).catch(err =>
    logger.error({ err, email: input.email }, 'Failed to send join request confirmation')
  );

  return mapRow(result.rows[0]);
}

export async function listJoinRequests(options: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ requests: JoinRequest[]; total: number }> {
  const { status, page = 1, pageSize = 20 } = options;
  const offset = (page - 1) * pageSize;

  let whereClause = '';
  const params: unknown[] = [];

  if (status) {
    params.push(status);
    whereClause = `WHERE status = $${params.length}`;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) FROM join_requests ${whereClause}`,
    params
  );
  const total = parseInt(String(countResult.rows[0]?.count ?? '0'), 10);

  params.push(pageSize, offset);
  const result = await query(
    `SELECT * FROM join_requests ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    requests: result.rows.map(mapRow),
    total,
  };
}

export async function getJoinRequestById(id: string): Promise<JoinRequest> {
  const result = await query(`SELECT * FROM join_requests WHERE id = $1`, [id]);
  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.INVALID_INPUT, 'Join request not found');
  }
  return mapRow(result.rows[0]);
}

export async function reviewJoinRequest(
  id: string,
  decision: 'approved' | 'declined',
  reviewedBy: string,
  reviewNotes?: string
): Promise<JoinRequest> {
  const result = await query(
    `UPDATE join_requests
     SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3, updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [decision, reviewedBy, reviewNotes || null, id]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.INVALID_INPUT, 'Join request not found');
  }

  logger.info({ id, decision, reviewedBy }, 'Join request reviewed');

  const reviewed = mapRow(result.rows[0]);

  // Send approval/decline email (non-blocking)
  if (decision === 'approved') {
    const loginUrl = `${config.clientUrl}/login`;
    sendJoinRequestWelcomeEmail(reviewed.email, reviewed.fullName, loginUrl).catch(err =>
      logger.error({ err, email: reviewed.email }, 'Failed to send welcome email')
    );
  } else {
    sendJoinRequestDeclineEmail(reviewed.email, reviewed.fullName).catch(err =>
      logger.error({ err, email: reviewed.email }, 'Failed to send decline email')
    );
  }

  return reviewed;
}
