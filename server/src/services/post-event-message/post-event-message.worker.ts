// ─── Post-event message worker ───────────────────────────────────────────────
//
// Drains the post_event_message_jobs / post_event_message_recipients tables
// created by the post-event-message service. Called every 10 s via setInterval
// in index.ts.
//
// Idempotency / crash safety:
//   - Only 'pending' recipients are ever selected, so a crash mid-batch simply
//     leaves the remaining rows as 'pending' and the next run resumes from them.
//   - Each recipient's UPDATE commits independently — no outer transaction
//     wraps the whole drain loop.
//   - A Redis NX lock prevents two instances running the same job concurrently.
//     If Redis is unavailable the lock is skipped (single-instance fallback).

import type { Server as SocketServer } from 'socket.io';
import { query } from '../../db';
import logger from '../../config/logger';
import { getRedisClient } from '../redis/redis.client';
import { buildMessage } from './templates';
import { sendBroadcastMessage } from '../dm/dm.service';
import { broadcastDmMessage } from '../orchestration/handlers/dm-handlers';
import type { PostEventMessageBucket } from '@rsn/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'processing' | 'completed' | 'completed_with_errors' | 'failed';

interface PendingJob {
  id: string;
  session_id: string;
  created_by: string;
}

interface RecipientRow {
  id: string;
  user_id: string;
  bucket: PostEventMessageBucket;
  first_name: string | null;
}

// ─── Date formatter ───────────────────────────────────────────────────────────

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

// ─── Worker ───────────────────────────────────────────────────────────────────

/**
 * Pick one pending job, drain all its pending recipients in batches of 25,
 * and finalize the job. Safe to call on an interval — exits immediately if
 * no pending jobs exist or if another instance holds the Redis lock.
 */
export async function processPendingJobs(io: SocketServer): Promise<void> {
  const redis = getRedisClient();
  let lockAcquired = false;

  // ── 1. Acquire Redis lock (multi-instance safety) ──────────────────────────
  if (redis) {
    const ok = await redis.set('pem:worker:lock', '1', 'EX', 55, 'NX');
    if (!ok) return; // another instance is already running
    lockAcquired = true;
  }

  try {
    await _runWorkerCycle(io);
  } finally {
    if (redis && lockAcquired) {
      await redis.del('pem:worker:lock').catch(() => {});
    }
  }
}

async function _runWorkerCycle(io: SocketServer): Promise<void> {
  // ── 2. Pick one pending job ────────────────────────────────────────────────
  const pickResult = await query<PendingJob>(
    `SELECT id, session_id, created_by
     FROM post_event_message_jobs
     WHERE status = 'pending'
     ORDER BY created_at
     LIMIT 1`,
  );
  if (pickResult.rows.length === 0) return;

  const job = pickResult.rows[0];
  const jobId = job.id;
  const sessionId = job.session_id;
  const createdBy = job.created_by;

  // ── 3. Mark processing ─────────────────────────────────────────────────────
  await query(
    `UPDATE post_event_message_jobs
     SET status='processing', started_at = COALESCE(started_at, NOW())
     WHERE id = $1`,
    [jobId],
  );

  try {
    // ── 4. Load context once ─────────────────────────────────────────────────
    const sessionResult = await query<{ title: string; ended_at: Date | null; scheduled_at: Date }>(
      `SELECT title, ended_at, scheduled_at FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const sessionRow = sessionResult.rows[0];
    const eventTitle = sessionRow?.title ?? 'the event';
    const rawDate = sessionRow?.ended_at ?? sessionRow?.scheduled_at ?? new Date();
    const eventDate = dateFormatter.format(new Date(rawDate));

    const senderResult = await query<{ first_name: string | null; display_name: string | null }>(
      `SELECT first_name, display_name FROM users WHERE id = $1`,
      [createdBy],
    );
    const senderRow = senderResult.rows[0];
    const senderName = senderRow?.first_name || senderRow?.display_name || 'The team';

    // ── 5. Drain in batches of 25 ─────────────────────────────────────────────
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batchResult = await query<RecipientRow>(
        `SELECT r.id, r.user_id, r.bucket, u.first_name
         FROM post_event_message_recipients r
         JOIN users u ON u.id = r.user_id
         WHERE r.job_id = $1 AND r.status = 'pending'
         ORDER BY r.created_at
         LIMIT 25`,
        [jobId],
      );

      if (batchResult.rows.length === 0) break;

      for (const row of batchResult.rows) {
        try {
          const content = buildMessage(row.bucket, {
            firstName: row.first_name || '',
            eventTitle,
            eventDate,
            senderName,
          });

          const { message, conversationId } = await sendBroadcastMessage(
            createdBy,
            row.user_id,
            content,
          );

          await broadcastDmMessage(io, createdBy, row.user_id, conversationId, message);

          await query(
            `UPDATE post_event_message_recipients
             SET status='sent', message_id=$1, sent_at=NOW()
             WHERE id=$2`,
            [message.id, row.id],
          );

          await query(
            `UPDATE post_event_message_jobs
             SET sent_count = sent_count + 1
             WHERE id=$1`,
            [jobId],
          );
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(
            { err, jobId, recipientId: row.id, userId: row.user_id },
            'Post-event message: failed to send to recipient',
          );

          await query(
            `UPDATE post_event_message_recipients
             SET status='failed', error=$1
             WHERE id=$2`,
            [errMsg, row.id],
          );

          await query(
            `UPDATE post_event_message_jobs
             SET failed_count = failed_count + 1
             WHERE id=$1`,
            [jobId],
          );
        }
      }
    }

    // ── 6. Finalize ───────────────────────────────────────────────────────────
    const finalResult = await query<{ failed_count: number }>(
      `SELECT failed_count FROM post_event_message_jobs WHERE id = $1`,
      [jobId],
    );
    const failedCount = finalResult.rows[0]?.failed_count ?? 0;
    const finalStatus: JobStatus = failedCount > 0 ? 'completed_with_errors' : 'completed';

    await query(
      `UPDATE post_event_message_jobs
       SET status = $1, completed_at = NOW()
       WHERE id = $2`,
      [finalStatus, jobId],
    );

    logger.info({ jobId, finalStatus, failedCount }, 'Post-event message job finalized');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId }, 'Post-event message job failed unexpectedly');

    await query(
      `UPDATE post_event_message_jobs
       SET status = 'failed', error = $1, completed_at = NOW()
       WHERE id = $2`,
      [errMsg, jobId],
    ).catch(() => {});
  }
}
