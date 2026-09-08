// ─── Report Service ──────────────────────────────────────────────────────────
//
// Phase H of chat-fix-and-dm-system plan (1 May 2026). Stefan: "people
// should be able to report people". Reports go into an admin moderation
// queue. Distinct from blocks (silent, per-user, no admin involvement).

import { v4 as uuid } from 'uuid';
import { query } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

export type ReportReason =
  | 'spam' | 'harassment' | 'inappropriate_content'
  | 'fake_profile' | 'safety' | 'other';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export interface UserReport {
  id: string;
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  createdAt: Date;
}

export interface ReportWithUsers extends UserReport {
  reporterDisplayName: string | null;
  reporterEmail: string | null;
  reportedDisplayName: string | null;
  reportedEmail: string | null;
  // Auto-flag count: total open reports against the reported user.
  totalOpenAgainstReported: number;
}

const VALID_REASONS: ReportReason[] = [
  'spam', 'harassment', 'inappropriate_content',
  'fake_profile', 'safety', 'other',
];

/**
 * Submit a report. Reporter cannot report self. Description is optional
 * but recommended.
 */
export async function submitReport(
  reporterId: string,
  reportedId: string,
  reason: ReportReason,
  description?: string,
  conversationId?: string | null,
): Promise<UserReport> {
  if (reporterId === reportedId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot report yourself');
  }
  if (!VALID_REASONS.includes(reason)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Invalid reason: ${reason}`);
  }

  const reportedExists = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1`, [reportedId],
  );
  if (reportedExists.rows.length === 0) {
    throw new NotFoundError('User', reportedId);
  }

  // Only accept a conversation the reporter is actually part of, so the context
  // link can't be spoofed to a chat they don't belong to.
  let convId: string | null = null;
  if (conversationId) {
    const conv = await query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)`,
      [conversationId, reporterId],
    );
    convId = conv.rows[0]?.id ?? null;
  }

  const result = await query<{
    id: string; reporter_id: string; reported_id: string;
    reason: ReportReason; description: string | null;
    status: ReportStatus; resolved_by: string | null;
    resolved_at: Date | null; resolution_notes: string | null;
    created_at: Date;
  }>(
    `INSERT INTO user_reports (id, reporter_id, reported_id, reason, description, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, reporter_id, reported_id, reason, description, status,
               resolved_by, resolved_at, resolution_notes, created_at`,
    [uuid(), reporterId, reportedId, reason, description?.trim().slice(0, 2000) || null, convId],
  );

  const r = result.rows[0];
  logger.info({ reportId: r.id, reporterId, reportedId, reason }, 'User report submitted');

  return {
    id: r.id, reporterId: r.reporter_id, reportedId: r.reported_id,
    reason: r.reason, description: r.description,
    status: r.status, resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at, resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
  };
}

/**
 * List all open reports for the admin moderation queue. Includes both
 * users' display info + total open reports against the reported user
 * (auto-flag signal).
 */
export async function listOpenReports(): Promise<ReportWithUsers[]> {
  const result = await query<{
    id: string; reporter_id: string; reported_id: string;
    reason: ReportReason; description: string | null;
    status: ReportStatus; resolved_by: string | null;
    resolved_at: Date | null; resolution_notes: string | null;
    created_at: Date;
    reporter_name: string | null; reporter_email: string | null;
    reported_name: string | null; reported_email: string | null;
    total_open: string;
  }>(
    `SELECT r.id, r.reporter_id, r.reported_id, r.reason, r.description,
            r.status, r.resolved_by, r.resolved_at, r.resolution_notes, r.created_at,
            ur.display_name AS reporter_name, ur.email AS reporter_email,
            ud.display_name AS reported_name, ud.email AS reported_email,
            (SELECT COUNT(*)::text FROM user_reports r2
              WHERE r2.reported_id = r.reported_id AND r2.status = 'open') AS total_open
     FROM user_reports r
     JOIN users ur ON ur.id = r.reporter_id
     JOIN users ud ON ud.id = r.reported_id
     WHERE r.status = 'open'
     ORDER BY r.created_at DESC`,
  );
  return result.rows.map(r => ({
    id: r.id, reporterId: r.reporter_id, reportedId: r.reported_id,
    reason: r.reason, description: r.description,
    status: r.status, resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at, resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
    reporterDisplayName: r.reporter_name,
    reporterEmail: r.reporter_email,
    reportedDisplayName: r.reported_name,
    reportedEmail: r.reported_email,
    totalOpenAgainstReported: parseInt(r.total_open || '0', 10),
  }));
}

/**
 * Admin marks a report as resolved (action taken) with optional notes.
 */
export async function resolveReport(
  reportId: string,
  adminId: string,
  notes?: string,
): Promise<UserReport> {
  return updateReportStatus(reportId, adminId, 'resolved', notes);
}

/**
 * Admin dismisses a report (no action needed).
 */
export async function dismissReport(
  reportId: string,
  adminId: string,
  notes?: string,
): Promise<UserReport> {
  return updateReportStatus(reportId, adminId, 'dismissed', notes);
}

async function updateReportStatus(
  reportId: string,
  adminId: string,
  newStatus: 'resolved' | 'dismissed',
  notes?: string,
): Promise<UserReport> {
  const result = await query<{
    id: string; reporter_id: string; reported_id: string;
    reason: ReportReason; description: string | null;
    status: ReportStatus; resolved_by: string | null;
    resolved_at: Date | null; resolution_notes: string | null;
    created_at: Date;
  }>(
    `UPDATE user_reports
     SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_notes = $4
     WHERE id = $1 AND status = 'open'
     RETURNING id, reporter_id, reported_id, reason, description, status,
               resolved_by, resolved_at, resolution_notes, created_at`,
    [reportId, newStatus, adminId, notes?.trim().slice(0, 2000) || null],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Report', reportId);
  }
  const r = result.rows[0];
  logger.info({ reportId: r.id, adminId, newStatus }, 'Report status updated');
  return {
    id: r.id, reporterId: r.reporter_id, reportedId: r.reported_id,
    reason: r.reason, description: r.description,
    status: r.status, resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at, resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
  };
}
