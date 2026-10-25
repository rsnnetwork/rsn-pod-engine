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
import { reportProgress, resolveProgressAudience } from './send-progress';
import { sendBroadcastMessage } from '../dm/dm.service';
import { broadcastDmMessage } from '../orchestration/handlers/dm-handlers';
import type { PostEventMessageBucket } from '@rsn/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'processing' | 'completed' | 'completed_with_errors' | 'failed';

interface PendingJob {
  id: string;
  session_id: string;
  created_by: string;
  /** The organiser's own words (version 2). NULL on a template job, which is every job made before 26 Oct 2026. */
  body: string | null;
}

interface RecipientRow {
  id: string;
  user_id: string;
  bucket: PostEventMessageBucket;
  first_name: string | null;
  /** users.status of the recipient right now: only 'active' accounts are messaged. */
  account_status: string;
  /** Whether either person has blocked the other, as of this read. */
  blocked: boolean;
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
  // ── 0. Is there anything to do at all? ─────────────────────────────────────
  //
  // This runs every 10 s forever. Taking the Redis lock first meant a SET plus
  // a DEL on every idle tick — roughly 17k commands a day against an Upstash
  // free tier of 10k, so the quota was gone before any real work happened, and
  // the lock protecting that work was the thing that exhausted it.
  //
  // Postgres is already in the hot path and this probe hits an indexed status
  // column, so ask it first and touch Redis only when there is a job to guard.
  // The lock is still acquired BEFORE any row is claimed, so two instances
  // cannot process the same job: the loser exits at the lock, as before.
  const pending = await query<{ exists: boolean }>(
    `SELECT TRUE AS exists FROM post_event_message_jobs WHERE status = 'pending' LIMIT 1`,
  );
  if (pending.rows.length === 0) return;

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
    `SELECT id, session_id, created_by, body
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
  // A body means the organiser wrote this message: it goes out as they wrote it, under a bell that says
  // why they wrote. No body means the older feedback template, with the bell it always had.
  const organiserBody = typeof job.body === 'string' ? job.body : null;

  // ── 3. Mark processing ─────────────────────────────────────────────────────
  await query(
    `UPDATE post_event_message_jobs
     SET status='processing', started_at = COALESCE(started_at, NOW())
     WHERE id = $1`,
    [jobId],
  );

  let progressAudience: string[] = [createdBy];
  try {
    progressAudience = await resolveProgressAudience(sessionId, createdBy);

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
    // The bell names the person as the rest of the DM system does (the display name), not as a sign-off.
    const bellSenderName = senderRow?.display_name || senderRow?.first_name || 'The team';
    const dmOptions = organiserBody === null
      ? {}
      : { bellTitle: `${bellSenderName} messaged everyone from ‘${eventTitle}’` };

    // ── 5. Drain in batches of 25 ─────────────────────────────────────────────
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Blocks and account status are read here, in the same query, as of this moment: a person who
      // blocked the sender or closed their account since the job was made is skipped, not messaged.
      const batchResult = await query<RecipientRow>(
        `SELECT r.id, r.user_id, r.bucket, u.first_name, u.status AS account_status,
                EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = $2 AND b.blocked_id = r.user_id)
                            OR (b.blocker_id = r.user_id AND b.blocked_id = $2)) AS blocked
         FROM post_event_message_recipients r
         JOIN users u ON u.id = r.user_id
         WHERE r.job_id = $1 AND r.status = 'pending'
         ORDER BY r.created_at
         LIMIT 25`,
        [jobId, createdBy],
      );

      if (batchResult.rows.length === 0) break;

      for (const row of batchResult.rows) {
        try {
          const skipReason = row.account_status !== 'active' ? 'inactive' : row.blocked ? 'blocked' : null;
          if (skipReason) {
            // Not a failure: nobody did anything wrong, and the job is not an "error" for it. Taken off
            // the total as well, so "x of y" can reach y.
            await query(
              `UPDATE post_event_message_recipients
               SET status='skipped', error=$1
               WHERE id=$2`,
              [skipReason, row.id],
            );
            await query(
              `UPDATE post_event_message_jobs
               SET total_recipients = total_recipients - 1
               WHERE id=$1`,
              [jobId],
            );
            continue;
          }

          const content = organiserBody ?? buildMessage(row.bucket, {
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

          await broadcastDmMessage(io, createdBy, row.user_id, conversationId, message, dmOptions);

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

      // The people running the event watch "Sending… x of y": tell them it moved.
      await reportProgress(io, progressAudience, sessionId);
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
    await reportProgress(io, progressAudience, sessionId);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId }, 'Post-event message job failed unexpectedly');

    await query(
      `UPDATE post_event_message_jobs
       SET status = 'failed', error = $1, completed_at = NOW()
       WHERE id = $2`,
      [errMsg, jobId],
    ).catch(() => {});
    await reportProgress(io, progressAudience, sessionId);
  }
}
