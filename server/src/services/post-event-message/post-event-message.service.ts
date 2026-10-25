// ─── Post-Event Broadcast Message Service ────────────────────────────────────
// Assembles recipients, previews a dry-run, creates durable jobs, and returns
// job status.  The actual email/DM sends are performed by a separate worker that
// reads post_event_message_jobs rows in 'pending' status.
//
// Two versions live side by side.  Version 1 (assembleRecipients, previewJob,
// createJob) sends the fixed feedback template and is what production's client
// still calls.  Version 2 (assembleRecipientsV2, countAudience, createJobV2) sends
// the organiser's own words to everyone who took part; it is reached only when the
// caller asks for it (26 Oct 2026).

import type {
  BroadcastAudience,
  PostEventMessageBucket,
  PostEventMessagePreview,
  PostEventMessageJob,
} from '@rsn/shared';
import { ErrorCodes } from '@rsn/shared';
import { query, transaction } from '../../db';
import { AppError, ConflictError } from '../../middleware/errors';
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

interface SessionFacts {
  hostUserId: string;
  eventEndedAt: Date | null;
  /** Whether the event ever matched anyone: a video meeting never does, and has no rounds to count. */
  eventHadMatches: boolean;
}

async function loadSessionFacts(sessionId: string): Promise<SessionFacts> {
  const result = await query<{
    host_user_id: string | null;
    ended_at: Date | null;
    updated_at: Date;
    has_matches: boolean;
  }>(
    `SELECT host_user_id, ended_at, updated_at,
            EXISTS (SELECT 1 FROM matches WHERE session_id = sessions.id) AS has_matches
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return {
    hostUserId: row?.host_user_id ?? '',
    eventEndedAt: row?.ended_at ?? row?.updated_at ?? null,
    eventHadMatches: row?.has_matches === true,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

// ─── Version 1: the feedback template ─────────────────────────────────────────

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

  // 2. Fetch the event's host, its end time and whether it ever had a match
  const { hostUserId, eventEndedAt, eventHadMatches } = await loadSessionFacts(sessionId);

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
        eventHadMatches,
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
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        ErrorCodes.VALIDATION_ERROR,
        'A message job is already running for this event',
      );
    }
    throw err;
  }
}

// ─── Version 2: the organiser's own words ─────────────────────────────────────

/** Why a person on the list is not messaged: someone blocked the other, or the account is closed. */
export type RecipientSkipReason = 'blocked' | 'inactive';

export interface PlannedRecipient {
  userId: string;
  bucket: PostEventMessageBucket;
  /** Joined the event (or hosted it) versus registered and never came. */
  kind: 'took_part' | 'no_show';
  /** Why this person will not be messaged; null when they will. */
  skip: RecipientSkipReason | null;
}

interface PersonRow {
  user_id: string;
  account_status: string;
  blocked: boolean;
}

interface ParticipantPersonRow extends PersonRow {
  joined_at: Date | null;
  left_at: Date | null;
  rounds_completed: number | null;
}

/** A closed, suspended or banned account has no one to message; a block in either direction is a refusal. */
function skipReasonFor(person: PersonRow): RecipientSkipReason | null {
  if (person.account_status !== 'active') return 'inactive';
  if (person.blocked) return 'blocked';
  return null;
}

/**
 * Everyone a message from `senderId` could reach, and why some of them will not be reached:
 *   - everyone who joined the event, plus the host when someone else is sending;
 *   - people who registered and never joined, marked as such (the sender chooses whether to include them);
 *   - never the sender, and never someone the organiser removed from the event;
 *   - admins are people like any other: there is no filter on account role.
 * Blocked pairs (either direction) and accounts that are not active stay on the list, marked to skip,
 * so the job records that they were left out and why.
 */
export async function assembleRecipientsV2(
  sessionId: string,
  senderId: string,
): Promise<PlannedRecipient[]> {
  const { hostUserId, eventEndedAt, eventHadMatches } = await loadSessionFacts(sessionId);

  const participants = await query<ParticipantPersonRow>(
    `SELECT sp.user_id, sp.joined_at, sp.left_at, sp.rounds_completed,
            u.status AS account_status,
            EXISTS (SELECT 1 FROM user_blocks b
                     WHERE (b.blocker_id = $2 AND b.blocked_id = sp.user_id)
                        OR (b.blocker_id = sp.user_id AND b.blocked_id = $2)) AS blocked
       FROM session_participants sp
       JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = $1 AND sp.user_id <> $2 AND sp.status <> 'removed'`,
    [sessionId, senderId],
  );

  const planned: PlannedRecipient[] = [];
  for (const row of participants.rows) {
    if (row.user_id === senderId) continue;
    const joined = row.joined_at !== null;
    const isHost = row.user_id === hostUserId;
    planned.push({
      userId: row.user_id,
      bucket: joined
        ? classifyParticipant(
            {
              joinedAt: row.joined_at,
              leftAt: row.left_at,
              roundsCompleted: row.rounds_completed ?? 0,
              eventHadMatches,
            },
            eventEndedAt,
          )
        : isHost ? 'stayed' : 'no_show',
      kind: joined || isHost ? 'took_part' : 'no_show',
      skip: skipReasonFor(row),
    });
  }

  // The host runs the event, so a co-host, director or admin writing to everyone writes to the host too,
  // even if the host has no participant row of their own.
  if (hostUserId && hostUserId !== senderId && !planned.some((r) => r.userId === hostUserId)) {
    const host = await query<PersonRow>(
      `SELECT u.id AS user_id, u.status AS account_status,
              EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
                          OR (b.blocker_id = u.id AND b.blocked_id = $2)) AS blocked
         FROM users u WHERE u.id = $1`,
      [hostUserId, senderId],
    );
    const person = host.rows[0];
    if (person) {
      planned.push({
        userId: person.user_id,
        bucket: 'stayed',
        kind: 'took_part',
        skip: skipReasonFor(person),
      });
    }
  }

  return planned;
}

/**
 * How many people a send from `senderId` would reach, counted the way the send counts them. People who
 * would be skipped are not counted, so the sender is never told that someone blocked them.
 */
export async function countAudience(sessionId: string, senderId: string): Promise<BroadcastAudience> {
  const planned = await assembleRecipientsV2(sessionId, senderId);
  const audience: BroadcastAudience = { tookPart: 0, registeredNoShow: 0 };
  for (const r of planned) {
    if (r.skip) continue;
    if (r.kind === 'took_part') audience.tookPart += 1;
    else audience.registeredNoShow += 1;
  }
  return audience;
}

const ANOTHER_ORGANISER_SENDING = "Another organiser's message is being sent; try again in a minute.";
const YOUR_MESSAGE_SENDING = 'Your message is already being sent.';

/**
 * The 409 for a send that cannot start because one is already going out for this event. Says whose it is,
 * so the person who pressed Send twice is not told that somebody else is writing.
 */
export async function conflictForActiveSend(sessionId: string, userId: string): Promise<ConflictError> {
  const active = await query<{ created_by: string }>(
    `SELECT created_by FROM post_event_message_jobs
      WHERE session_id = $1 AND status IN ('pending', 'processing')
      LIMIT 1`,
    [sessionId],
  );
  const mine = active.rows[0]?.created_by === userId;
  return new ConflictError(ErrorCodes.VALIDATION_ERROR, mine ? YOUR_MESSAGE_SENDING : ANOTHER_ORGANISER_SENDING);
}

export interface SendInput {
  /** The organiser's words, already trimmed and checked. Sent as written. */
  body: string;
  includeNoShows: boolean;
}

/**
 * Create a pending job carrying the organiser's text, and one row per person on the list, in ONE
 * transaction.  Each send is a new message, so nobody is filtered out for having been reached before.
 * People to skip get a 'skipped' row with the reason; people who registered and never came are left off
 * the job entirely unless the sender asked for them.  `total_recipients` counts only those who will be
 * messaged, so "x of y" is true.  A second send while one is going out meets the unique active-job index
 * and is turned into a 409.
 */
export async function createJobV2(
  sessionId: string,
  createdBy: string,
  input: SendInput,
): Promise<PostEventMessageJob> {
  const planned = await assembleRecipientsV2(sessionId, createdBy);
  const chosen = planned.filter((r) => r.kind === 'took_part' || input.includeNoShows);
  const sendable = chosen.filter((r) => r.skip === null);
  if (sendable.length === 0) {
    throw new ConflictError(ErrorCodes.VALIDATION_ERROR, 'Nobody else took part in this event.');
  }

  try {
    const jobRow = await transaction(async (client) => {
      const jobResult = await client.query<JobRow>(
        `INSERT INTO post_event_message_jobs
           (session_id, created_by, status, total_recipients, body, include_no_shows)
         VALUES ($1, $2, 'pending', $3, $4, $5)
         RETURNING id, session_id, status, total_recipients, sent_count, failed_count,
                   error, created_at, started_at, completed_at`,
        [sessionId, createdBy, sendable.length, input.body, input.includeNoShows],
      );
      const job = jobResult.rows[0];

      await client.query(
        `INSERT INTO post_event_message_recipients (job_id, user_id, bucket, status, error)
         SELECT $1::uuid, r.user_id, r.bucket::post_event_message_bucket,
                r.status::post_event_message_recipient_status, r.error
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS r(user_id, bucket, status, error)`,
        [
          job.id,
          chosen.map((r) => r.userId),
          chosen.map((r) => r.bucket),
          chosen.map((r) => (r.skip ? 'skipped' : 'pending')),
          chosen.map((r) => r.skip),
        ],
      );

      return job;
    });

    return mapJobRow(jobRow);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) throw await conflictForActiveSend(sessionId, createdBy);
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
