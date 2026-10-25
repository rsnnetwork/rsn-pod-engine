// ─── Post-event message worker ───────────────────────────────────────────────
//
// Drains the post_event_message_jobs / post_event_message_recipients tables
// created by the post-event-message service. Called every 10 s via setInterval
// in index.ts.
//
// Crash safety, and what happens to a send a stopped server left half done:
//   - Only 'pending' recipients are ever selected, and each recipient's UPDATE commits on its own (no outer
//     transaction wraps the drain loop), so a run that stops partway leaves exactly the people it had not
//     reached as 'pending'.
//   - A job is 'processing' while a worker drains it, and nothing moves it on if the process dies (Render
//     redeploys on every push to main). The unique index allows one pending-or-processing job per event, so
//     such a job would refuse every later send for the event, for ever. So a 'processing' job that has shown
//     no sign of life for STALE_AFTER_MINUTES is picked up again, like a pending one, and drained from the
//     people still pending. A sign of life is a recipient sent to, or a worker taking the job: the claim
//     sets started_at to now, and a run that is working sends to someone every few seconds. Neither the
//     Redis lock (EX 55, never renewed) nor the first started_at says anything about a long job that is
//     still running, which is why neither is used.
//   - The claim is one UPDATE that asks the same question again, so two instances (or a run that came back
//     to life) cannot both take the job; the loser does nothing.
//   - Someone whose message was written just before the stop, with the row not yet marked sent, is found by
//     its words and marked sent, not sent to twice.
//   - A resumed job older than MAX_RESUME_AGE_HOURS is failed instead, which frees the event; so is one
//     that throws while being carried on.
//   - A Redis NX lock stops two instances starting a cycle in the same moment. If Redis is unavailable the
//     lock is skipped (single-instance fallback).

import type { Server as SocketServer } from 'socket.io';
import { query } from '../../db';
import logger from '../../config/logger';
import { getRedisClient } from '../redis/redis.client';
import { buildMessage } from './templates';
import { reportProgress, resolveProgressAudience } from './send-progress';
import { skipReasonFor, type RecipientSkipReason } from './skip-rule';
import { CLAIM_SQL, PICK_SQL, PROBE_SQL, STALE_AFTER_MINUTES } from './job-queue-sql';
import { sendBroadcastMessage } from '../dm/dm.service';
import { BroadcastBlockedError } from '../dm/broadcast-errors';
import { broadcastDmMessage } from '../orchestration/handlers/dm-handlers';
import type { PostEventMessageBucket } from '@rsn/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'processing' | 'completed' | 'completed_with_errors' | 'failed';

interface ClaimableJob {
  id: string;
  session_id: string;
  created_by: string;
  /** The organiser's own words (version 2). NULL on a template job, which is every job made before 26 Oct 2026. */
  body: string | null;
  /** 'pending' for a new job; 'processing' for one an earlier run stopped partway through. */
  previous_status: 'pending' | 'processing';
  created_at: Date;
}

/** A job that was already half sent and is older than this is failed rather than carried on. */
const MAX_RESUME_AGE_HOURS = 24;
const MAX_RESUME_AGE_MS = MAX_RESUME_AGE_HOURS * 60 * 60 * 1000;

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
 * Take one job that needs a worker (a new one, or one a stopped server left silent), drain its pending
 * recipients in batches of 25, and finalize it. Safe to call on an interval — exits immediately if no job
 * needs a worker or if another instance holds the Redis lock.
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
  //
  // "Needs a worker" is a pending job, or a processing job gone silent (see the header): still one
  // cheap read on an idle tick, and the silence test only runs for the rare processing row.
  const pending = await query<{ exists: boolean }>(PROBE_SQL, [STALE_AFTER_MINUTES]);
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
  // ── 2. Pick the oldest job that needs a worker ─────────────────────────────
  const pickResult = await query<ClaimableJob>(PICK_SQL, [STALE_AFTER_MINUTES]);
  if (pickResult.rows.length === 0) return;

  const job = pickResult.rows[0];
  const jobId = job.id;
  const sessionId = job.session_id;
  const createdBy = job.created_by;
  // A body means the organiser wrote this message: it goes out as they wrote it, under a bell that says
  // why they wrote. No body means the older feedback template, with the bell it always had.
  const organiserBody = typeof job.body === 'string' ? job.body : null;
  // 'processing' at the pick means an earlier run stopped partway through this job.
  const resumed = job.previous_status === 'processing';

  // ── 3. Claim it ────────────────────────────────────────────────────────────
  // One statement that asks the pick's question again, so a job another instance took first (or one that
  // came back to life) is not taken twice. Losing the claim means there is nothing for this run to do.
  const claim = await query<{ id: string }>(CLAIM_SQL, [jobId, STALE_AFTER_MINUTES]);
  if (claim.rows.length === 0) return;

  if (resumed) {
    logger.warn(
      { jobId, sessionId, createdAt: job.created_at },
      'Post-event message job was left half sent by a run that stopped; carrying on from the people still pending',
    );
    if (Date.now() - new Date(job.created_at).getTime() > MAX_RESUME_AGE_MS) {
      // Too late for the message to mean what it was meant to, and a job that keeps being interrupted must
      // not be tried for ever. Failing it frees the event's one-active-job slot.
      logger.error({ jobId, sessionId }, 'Post-event message job was interrupted too long ago to carry on; failing it');
      await failJob(jobId, 'The server stopped while this message was being sent, and too long has passed to carry on.');
      await reportProgress(io, await resolveProgressAudience(sessionId, createdBy), sessionId);
      return;
    }
  }

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
          // Not a failure: nobody did anything wrong, and the job is not an "error" for it.
          const skipReason = skipReasonFor(row);
          if (skipReason) {
            await markSkipped(jobId, row.id, skipReason);
            continue;
          }

          const content = organiserBody ?? buildMessage(row.bucket, {
            firstName: row.first_name || '',
            eventTitle,
            eventDate,
            senderName,
          });

          if (resumed) {
            // The run that stopped may have written this person's message in the moment before it stopped,
            // with the row not yet marked sent. Send again and they would have the same words twice.
            const earlier = await findEarlierCopy(createdBy, row.user_id, content, job.created_at);
            if (earlier) {
              await markSent(jobId, row.id, earlier);
              continue;
            }
          }

          const { message, conversationId } = await sendBroadcastMessage(
            createdBy,
            row.user_id,
            content,
          );

          await broadcastDmMessage(io, createdBy, row.user_id, conversationId, message, dmOptions);

          await markSent(jobId, row.id, message.id);
        } catch (err: unknown) {
          if (err instanceof BroadcastBlockedError) {
            // A block landed after this batch was read. Nothing was written, so this is a skip like any
            // other block, not a failure that would end the job "with errors".
            await markSkipped(jobId, row.id, 'blocked');
            continue;
          }
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

    await failJob(jobId, errMsg).catch(() => {});
    await reportProgress(io, progressAudience, sessionId);
  }
}

// ─── Recording what happened to a recipient or a job ──────────────────────────

/** The recipient got the message: row 'sent', and the job counts it. */
async function markSent(jobId: string, recipientId: string, messageId: string): Promise<void> {
  await query(
    `UPDATE post_event_message_recipients
     SET status='sent', message_id=$1, sent_at=NOW()
     WHERE id=$2`,
    [messageId, recipientId],
  );

  await query(
    `UPDATE post_event_message_jobs
     SET sent_count = sent_count + 1
     WHERE id=$1`,
    [jobId],
  );
}

/** The recipient is left out, and why. Taken off the job's total as well, so "x of y" can reach y. */
async function markSkipped(jobId: string, recipientId: string, reason: RecipientSkipReason): Promise<void> {
  await query(
    `UPDATE post_event_message_recipients
     SET status='skipped', error=$1
     WHERE id=$2`,
    [reason, recipientId],
  );
  await query(
    `UPDATE post_event_message_jobs
     SET total_recipients = total_recipients - 1
     WHERE id=$1`,
    [jobId],
  );
}

/** The job ends here, whatever its recipients: it leaves pending/processing, which frees the event for the next send. */
async function failJob(jobId: string, reason: string): Promise<void> {
  await query(
    `UPDATE post_event_message_jobs
     SET status = 'failed', error = $1, completed_at = NOW()
     WHERE id = $2`,
    [reason, jobId],
  );
}

/**
 * The id of a message from the sender to this person with these exact words, written since the job was
 * made: the one a run that stopped had already written. Only asked when a job is being carried on. The bell
 * and the live tell of such a message may not have gone out; a missing bell on a message that is in their
 * Messages is the smaller harm next to the same words arriving twice.
 */
async function findEarlierCopy(senderId: string, recipientId: string, content: string, since: Date): Promise<string | null> {
  const found = await query<{ id: string }>(
    `SELECT dm.id
       FROM direct_messages dm
       JOIN dm_conversations c ON c.id = dm.conversation_id
      WHERE dm.from_user_id = $1 AND dm.content = $2 AND dm.created_at >= $3
        AND (c.user_a_id = $4 OR c.user_b_id = $4)
      LIMIT 1`,
    [senderId, content.trim(), since, recipientId],
  );
  return found.rows[0]?.id ?? null;
}
