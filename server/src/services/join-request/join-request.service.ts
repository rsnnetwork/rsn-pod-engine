// ─── Join Request Service ─────────────────────────────────────────────────────
// Handles the "Request to Join" flow: submission, listing, approval, decline.

import { query } from '../../db';
import logger from '../../config/logger';
import config from '../../config';
import { AppError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { sendJoinRequestConfirmationEmail, sendJoinRequestWelcomeEmail, sendJoinRequestDeclineEmail, sendJoinRequestReminderEmail } from '../email/email.service';

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
  adminNotes: string | null;
  lastRemindedAt: Date | null;
  reminderCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** True when the applicant has created a user account (joined via login link). */
  hasActivated?: boolean;
  /** Days since approval (only meaningful for approved requests). */
  daysSinceApproval?: number;
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
    adminNotes: row.admin_notes,
    lastRemindedAt: row.last_reminded_at,
    reminderCount: row.reminder_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasActivated: row.has_activated ?? undefined,
    daysSinceApproval: row.days_since_approval != null ? Number(row.days_since_approval) : undefined,
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
    whereClause = `WHERE jr.status = $${params.length}`;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) FROM join_requests jr ${whereClause}`,
    params
  );
  const total = parseInt(String(countResult.rows[0]?.count ?? '0'), 10);

  params.push(pageSize, offset);
  const result = await query(
    `SELECT jr.*,
            (u.id IS NOT NULL) AS has_activated,
            CASE WHEN jr.status = 'approved' AND jr.reviewed_at IS NOT NULL
                 THEN FLOOR(EXTRACT(EPOCH FROM NOW() - jr.reviewed_at) / 86400)
                 ELSE NULL END AS days_since_approval
     FROM join_requests jr
     LEFT JOIN users u ON LOWER(u.email) = LOWER(jr.email)
     ${whereClause}
     ORDER BY jr.created_at DESC
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
  // Reset reminder tracking when (re-)approving so auto-reminders start fresh
  const result = await query(
    `UPDATE join_requests
     SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3, updated_at = NOW(),
         reminder_count = CASE WHEN $1 = 'approved' THEN 0 ELSE reminder_count END,
         last_reminded_at = CASE WHEN $1 = 'approved' THEN NULL ELSE last_reminded_at END
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

export async function updateAdminNotes(id: string, notes: string): Promise<JoinRequest> {
  const result = await query(
    `UPDATE join_requests SET admin_notes = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [notes, id]
  );
  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.INVALID_INPUT, 'Join request not found');
  }
  return mapRow(result.rows[0]);
}

// ─── Nudge / Poke ──────────────────────────────────────────────────────────

/**
 * Send a reminder email to an approved applicant who hasn't signed up yet.
 * Enforces a 24-hour cooldown between pokes.
 */
export async function pokeJoinRequest(id: string): Promise<JoinRequest> {
  // Fetch the request
  const reqResult = await query(`SELECT * FROM join_requests WHERE id = $1`, [id]);
  if (reqResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.INVALID_INPUT, 'Join request not found');
  }
  const jr = mapRow(reqResult.rows[0]);

  if (jr.status !== 'approved') {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, 'Can only poke approved requests');
  }

  // Check if already activated (user exists)
  const userCheck = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [jr.email]);
  if (userCheck.rows.length > 0) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, 'This person has already signed up');
  }

  // 24-hour cooldown
  if (jr.lastRemindedAt) {
    const hoursSinceLast = (Date.now() - new Date(jr.lastRemindedAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLast < 24) {
      throw new AppError(429, ErrorCodes.INVALID_INPUT, `Please wait ${Math.ceil(24 - hoursSinceLast)} more hours before poking again`);
    }
  }

  // Update reminder tracking
  const updated = await query(
    `UPDATE join_requests
     SET last_reminded_at = NOW(), reminder_count = reminder_count + 1, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );

  const poked = mapRow(updated.rows[0]);

  // Send reminder email (non-blocking)
  const loginUrl = `${config.clientUrl}/login`;
  sendJoinRequestReminderEmail(poked.email, poked.fullName, loginUrl, poked.reminderCount).catch(err =>
    logger.error({ err, email: poked.email }, 'Failed to send reminder email')
  );

  logger.info({ id, email: poked.email, reminderCount: poked.reminderCount }, 'Join request poked');
  return poked;
}

/**
 * Bulk poke: send reminders to multiple approved-but-unactivated requests.
 */
export async function bulkPokeJoinRequests(ids: string[]): Promise<{ poked: number; skipped: number }> {
  let poked = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      await pokeJoinRequest(id);
      poked++;
    } catch {
      skipped++;
    }
  }
  return { poked, skipped };
}

// ─── Auto-Reminder Engine ──────────────────────────────────────────────────

/**
 * Find approved requests that need automatic reminders:
 * - Day 3: first auto-reminder (reminder_count = 0)
 * - Day 7: second auto-reminder (reminder_count = 1)
 * - Day 30: mark as expired (reminder_count >= 2, no more emails)
 *
 * Only targets requests where the applicant has NOT created a user account.
 */
export async function processAutoReminders(): Promise<{ reminded: number; expired: number }> {
  // Find approved requests with no user account, eligible for auto-reminder
  const result = await query(
    `SELECT jr.*
     FROM join_requests jr
     LEFT JOIN users u ON LOWER(u.email) = LOWER(jr.email)
     WHERE jr.status = 'approved'
       AND u.id IS NULL
       AND jr.reviewed_at IS NOT NULL`
  );

  let reminded = 0;
  let expired = 0;

  for (const row of result.rows) {
    const jr = mapRow(row);
    const daysSinceApproval = jr.reviewedAt
      ? (Date.now() - new Date(jr.reviewedAt).getTime()) / (1000 * 60 * 60 * 24)
      : 0;

    // Respect 24h cooldown from last manual or auto poke
    if (jr.lastRemindedAt) {
      const hoursSinceLast = (Date.now() - new Date(jr.lastRemindedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLast < 24) continue;
    }

    // Day 30+: mark as expired (change status to 'declined' with note)
    if (daysSinceApproval >= 30 && jr.reminderCount >= 2) {
      await query(
        `UPDATE join_requests
         SET status = 'declined', admin_notes = COALESCE(admin_notes || E'\n', '') || '[Auto-expired: never signed up after 30 days]', updated_at = NOW()
         WHERE id = $1`,
        [jr.id]
      );
      expired++;
      logger.info({ id: jr.id, email: jr.email }, 'Auto-expired join request (30 days, never activated)');
      continue;
    }

    // Day 3+: first reminder (if reminder_count = 0)
    if (daysSinceApproval >= 3 && jr.reminderCount === 0) {
      try {
        await pokeJoinRequest(jr.id);
        reminded++;
      } catch (err) {
        logger.warn({ err, id: jr.id }, 'Auto-reminder failed');
      }
      continue;
    }

    // Day 7+: second reminder (if reminder_count = 1)
    if (daysSinceApproval >= 7 && jr.reminderCount === 1) {
      try {
        await pokeJoinRequest(jr.id);
        reminded++;
      } catch (err) {
        logger.warn({ err, id: jr.id }, 'Auto-reminder failed');
      }
    }
  }

  if (reminded > 0 || expired > 0) {
    logger.info({ reminded, expired }, 'Auto-reminder cycle completed');
  }

  return { reminded, expired };
}
