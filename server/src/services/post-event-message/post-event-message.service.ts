// ─── Post-Event Broadcast Message Service ────────────────────────────────────
// Assembles recipients, previews a dry-run, creates durable jobs, and returns
// job status.  The actual email/DM sends are performed by a separate worker that
// reads post_event_message_jobs rows in 'pending' status.

import type { PostEventMessageBucket, PostEventMessagePreview, PostEventMessageJob } from '@rsn/shared';
import { ErrorCodes } from '@rsn/shared';
import { query, transaction } from '../../db';
import { AppError } from '../../middleware/errors';
import { getSessionParticipants } from '../session/session.service';
import { classifyParticipant } from './classify';

// ─── Private helpers ──────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  session_id: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_at: Date;
  completed_at: Date | null;
}

function mapJobRow(row: JobRow): PostEventMessageJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status as PostEventMessageJob['status'],
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Eligible recipients = all session participants MINUS the event host and any
 * user whose role is 'admin' or 'super_admin' (internal accounts).  Each row
 * is classified into a bucket using the event's ended_at.
 */
export async function assembleRecipients(sessionId: string): Promise<Array<{
  userId: string;
  firstName: string;
  bucket: PostEventMessageBucket;
}>> {
  // 1. Fetch all session participants (with displayName, email)
  const participants = await getSessionParticipants(sessionId);

  // 2. Fetch session row to get host_user_id and ended_at
  const sessionResult = await query<{
    host_user_id: string;
    ended_at: Date | null;
    updated_at: Date;
    title: string;
  }>(
    `SELECT host_user_id, ended_at, updated_at, title FROM sessions WHERE id = $1`,
    [sessionId],
  );

  const sessionRow = sessionResult.rows[0];
  const hostUserId = sessionRow?.host_user_id ?? '';
  const eventEndedAt: Date | null = sessionRow?.ended_at ?? sessionRow?.updated_at ?? null;

  // 3. Fetch roles for all participant user IDs
  const participantUserIds = participants.map((p) => p.userId);
  const usersResult = await query<{ id: string; role: string; first_name: string }>(
    `SELECT id, role, first_name FROM users WHERE id = ANY($1)`,
    [participantUserIds],
  );

  const roleMap = new Map<string, { role: string; firstName: string }>();
  for (const u of usersResult.rows) {
    roleMap.set(u.id, { role: u.role, firstName: u.first_name ?? '' });
  }

  // 4. Filter out host + internal-role accounts; classify remainder
  const excluded = new Set<string>([hostUserId]);
  const internalRoles = new Set(['admin', 'super_admin']);

  const result: Array<{ userId: string; firstName: string; bucket: PostEventMessageBucket }> = [];

  for (const p of participants) {
    if (excluded.has(p.userId)) continue;
    const userInfo = roleMap.get(p.userId);
    if (userInfo && internalRoles.has(userInfo.role)) continue;

    const bucket = classifyParticipant(
      {
        joinedAt: p.joinedAt ?? null,
        leftAt: p.leftAt ?? null,
        roundsCompleted: p.roundsCompleted ?? 0,
      },
      eventEndedAt,
    );

    result.push({
      userId: p.userId,
      firstName: userInfo?.firstName ?? '',
      bucket,
    });
  }

  return result;
}

/**
 * Dry-run: classify recipients and return grouped counts.  Sends nothing.
 */
export async function previewJob(sessionId: string): Promise<PostEventMessagePreview> {
  const recipients = await assembleRecipients(sessionId);

  const bucketCounts = new Map<PostEventMessageBucket, number>();
  for (const r of recipients) {
    bucketCounts.set(r.bucket, (bucketCounts.get(r.bucket) ?? 0) + 1);
  }

  return {
    sessionId,
    totalRecipients: recipients.length,
    buckets: Array.from(bucketCounts.entries()).map(([bucket, count]) => ({ bucket, count })),
  };
}

/**
 * Create a pending job + its recipient rows in ONE transaction.
 * Maps the Postgres 23505 unique-violation (active-job index) to AppError(409).
 * Skips any user already 'sent' in a prior job for this event (idempotent re-send).
 */
export async function createJob(sessionId: string, createdBy: string): Promise<PostEventMessageJob> {
  // 1. Assemble all potential recipients
  const allRecipients = await assembleRecipients(sessionId);

  // 2. Find users already 'sent' in a prior job for this event
  const alreadySentResult = await query<{ user_id: string }>(
    `SELECT r.user_id
     FROM post_event_message_recipients r
     JOIN post_event_message_jobs j ON j.id = r.job_id
     WHERE j.session_id = $1 AND r.status = 'sent'`,
    [sessionId],
  );

  const alreadySentIds = new Set(alreadySentResult.rows.map((r) => r.user_id));

  // 3. Filter out already-sent users
  const recipients = allRecipients.filter((r) => !alreadySentIds.has(r.userId));

  // 4. Create job + recipient rows in a single transaction
  try {
    const jobRow = await transaction(async (client) => {
      // Insert the job row
      const jobResult = await client.query<JobRow>(
        `INSERT INTO post_event_message_jobs
           (session_id, created_by, status, total_recipients)
         VALUES ($1, $2, 'pending', $3)
         RETURNING id, session_id, status, total_recipients, sent_count, failed_count,
                   error, created_at, started_at, completed_at`,
        [sessionId, createdBy, recipients.length],
      );

      const job = jobResult.rows[0];

      // Insert one row per recipient
      for (const r of recipients) {
        await client.query(
          `INSERT INTO post_event_message_recipients (job_id, user_id, bucket, status)
           VALUES ($1, $2, $3, 'pending')`,
          [job.id, r.userId, r.bucket],
        );
      }

      return job;
    });

    return mapJobRow(jobRow);
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      throw new AppError(
        409,
        ErrorCodes.VALIDATION_ERROR,
        'A message job is already running for this event',
      );
    }
    throw err;
  }
}

/**
 * Most-recent job for the event (for the button state), or null.
 */
export async function getLatestJob(sessionId: string): Promise<PostEventMessageJob | null> {
  const result = await query<JobRow>(
    `SELECT id, session_id, status, total_recipients, sent_count, failed_count,
            error, created_at, started_at, completed_at
     FROM post_event_message_jobs
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId],
  );

  if (result.rows.length === 0) return null;
  return mapJobRow(result.rows[0]);
}
