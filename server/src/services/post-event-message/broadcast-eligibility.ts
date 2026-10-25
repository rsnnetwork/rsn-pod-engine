import {
  UserRole,
  hasRoleAtLeast,
  POST_EVENT_MESSAGE_LIMITS,
  type BroadcastAudience,
  type BroadcastEligibility,
  type BroadcastEligibilityV2,
} from '@rsn/shared';
import { query } from '../../db';
import { NotFoundError } from '../../middleware/errors';
import { getEventOrganiserAccess } from './event-organisers';
import { countAudience } from './post-event-message.service';

export interface EligibilityInputs {
  role: UserRole;
  isPro: boolean;
  isDirector: boolean;
}

/** Pure policy. v1: only admins are enabled; pro/director see coming-soon. */
export function computeEligibility(i: EligibilityInputs): BroadcastEligibility {
  if (hasRoleAtLeast(i.role, UserRole.ADMIN)) {
    return { enabled: true, visible: true, reason: 'admin' };
  }
  if (i.isPro) return { enabled: false, visible: true, reason: 'pro_coming_soon' };
  if (i.isDirector) return { enabled: false, visible: true, reason: 'director_coming_soon' };
  return { enabled: false, visible: false, reason: 'not_allowed' };
}

/** Resolve the inputs for a user against the event's pod, then apply policy. */
export async function getEligibilityForEvent(
  userId: string,
  userRole: UserRole,
  sessionId: string,
): Promise<BroadcastEligibility> {
  const sub = await query<{ plan: string }>(
    `SELECT plan FROM user_subscriptions WHERE user_id = $1`, [userId],
  );
  const isPro = sub.rows[0]?.plan === 'premium';

  const dir = await query<{ role: string }>(
    `SELECT pm.role FROM pod_members pm
     JOIN sessions s ON s.pod_id = pm.pod_id
     WHERE s.id = $1 AND pm.user_id = $2 AND pm.role = 'director' AND pm.status = 'active'
     LIMIT 1`,
    [sessionId, userId],
  );
  const isDirector = dir.rows.length > 0;

  return computeEligibility({ role: userRole, isPro, isDirector });
}

// ─── Version 2: organisers and admins, once the event has ended ───────────────
//
// Asked for with `?v=2`. Enabled when ALL of these hold:
//   - the person runs the event or is an admin (event-organisers.ts),
//   - the event has ended,
//   - nothing is being sent for it right now,
//   - at least one other person took part,
//   - the person has sent fewer than 3 messages for this event in the last 24 hours.
// The plan is not part of the question any more. When the answer is no, it says why in a sentence a
// screen can show as text: a tooltip is invisible on a phone, and that is how Claus met "Pro — coming soon".

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ONE: BroadcastAudience = { tookPart: 0, registeredNoShow: 0 };

export interface EligibilityV2Inputs {
  isOrganiser: boolean;
  eventCompleted: boolean;
  audience: BroadcastAudience;
  /** The send going out for this event right now, if any: how many people, how many done. */
  activeJob: { total: number; sent: number; failed: number } | null;
  /** When this person's sends for this event inside the last 24 hours were made. */
  recentSends: Date[];
  /** The latest send that reached anyone. */
  lastSent: { at: Date; recipients: number } | null;
  /** The person's own time zone, so a time in a sentence is true on their clock. */
  timeZone: string | null;
}

/** HH:mm on the clock of `timeZone`; UTC when none is stored or the stored one is not a zone the platform knows. */
function clock(at: Date, timeZone: string | null): string {
  const format = (zone: string) => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
  try {
    return format(timeZone ?? 'UTC');
  } catch {
    return format('UTC');
  }
}

/** The answer, before the latest send is attached. Checked in the order the person would meet them. */
function decideV2(i: EligibilityV2Inputs): BroadcastEligibilityV2 {
  if (!i.isOrganiser) {
    return { enabled: false, visible: false, reason: 'not_organiser', explanation: '', audience: { ...NO_ONE } };
  }
  if (!i.eventCompleted) {
    return {
      enabled: false, visible: true, reason: 'not_ended',
      explanation: 'You can message everyone after the event ends.',
      audience: { ...NO_ONE },
    };
  }
  if (i.activeJob) {
    return {
      enabled: false, visible: true, reason: 'sending',
      explanation: `Sending… ${i.activeJob.sent + i.activeJob.failed} of ${i.activeJob.total}.`,
      audience: i.audience,
    };
  }
  if (i.audience.tookPart === 0) {
    return {
      enabled: false, visible: true, reason: 'no_recipients',
      explanation: 'Nobody else took part in this event.',
      audience: i.audience,
    };
  }
  const perDay = POST_EVENT_MESSAGE_LIMITS.sendsPerDay;
  if (i.recentSends.length >= perDay) {
    // The next send is allowed once only perDay - 1 remain inside the window, which is when the
    // (length - perDay + 1)th oldest has aged out: with exactly perDay sends, the oldest of them.
    const sends = [...i.recentSends].sort((a, b) => a.getTime() - b.getTime());
    const nextSendAt = new Date(sends[sends.length - perDay].getTime() + DAY_MS);
    return {
      enabled: false, visible: true, reason: 'limit',
      explanation: `You can send another message at ${clock(nextSendAt, i.timeZone)}.`,
      audience: i.audience,
      nextSendAt: nextSendAt.toISOString(),
    };
  }
  return { enabled: true, visible: true, reason: 'ok', explanation: '', audience: i.audience };
}

/** Pure policy for version 2. */
export function computeEligibilityV2(i: EligibilityV2Inputs): BroadcastEligibilityV2 {
  const answer = decideV2(i);
  // Only people who run the event are told what was sent, and only once there is something to tell.
  if (!i.isOrganiser || !i.lastSent) return answer;
  return { ...answer, lastSent: { at: i.lastSent.at.toISOString(), recipients: i.lastSent.recipients } };
}

async function readActiveJob(sessionId: string): Promise<EligibilityV2Inputs['activeJob']> {
  const result = await query<{ total_recipients: number; sent_count: number; failed_count: number }>(
    `SELECT total_recipients, sent_count, failed_count
       FROM post_event_message_jobs
      WHERE session_id = $1 AND status IN ('pending', 'processing')
      LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { total: row.total_recipients, sent: row.sent_count, failed: row.failed_count };
}

/** A job that failed before it reached anyone sent nothing, so it does not use up one of the day's sends. */
async function readRecentSends(sessionId: string, userId: string): Promise<Date[]> {
  const result = await query<{ created_at: Date }>(
    `SELECT created_at
       FROM post_event_message_jobs
      WHERE session_id = $1 AND created_by = $2
        AND created_at > NOW() - INTERVAL '24 hours'
        AND NOT (status = 'failed' AND sent_count = 0)
      ORDER BY created_at ASC`,
    [sessionId, userId],
  );
  return result.rows.map((r) => r.created_at);
}

async function readLastSent(sessionId: string): Promise<EligibilityV2Inputs['lastSent']> {
  const result = await query<{ sent_count: number; sent_at: Date }>(
    `SELECT sent_count, COALESCE(completed_at, created_at) AS sent_at
       FROM post_event_message_jobs
      WHERE session_id = $1 AND sent_count > 0
        AND status IN ('completed', 'completed_with_errors', 'failed')
      ORDER BY COALESCE(completed_at, created_at) DESC
      LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { at: row.sent_at, recipients: row.sent_count };
}

/**
 * Version 2 for a real person and a real event. Reads the audience and the sends only for an organiser of
 * an event that has ended: everyone else gets the answer from one query, and learns nothing about who came.
 * `userRole` is the account role from the verified sign-in token. An event that does not exist is a 404.
 */
export async function getEligibilityV2ForEvent(
  userId: string,
  userRole: UserRole,
  sessionId: string,
): Promise<BroadcastEligibilityV2> {
  const access = await getEventOrganiserAccess(userId, userRole, sessionId);
  if (!access) throw new NotFoundError('Session', sessionId);

  const eventCompleted = access.status === 'completed';
  if (!access.isOrganiser || !eventCompleted) {
    return computeEligibilityV2({
      isOrganiser: access.isOrganiser,
      eventCompleted,
      audience: NO_ONE,
      activeJob: null,
      recentSends: [],
      lastSent: null,
      timeZone: access.timeZone,
    });
  }

  const [audience, activeJob, recentSends, lastSent] = await Promise.all([
    countAudience(sessionId, userId),
    readActiveJob(sessionId),
    readRecentSends(sessionId, userId),
    readLastSent(sessionId),
  ]);
  return computeEligibilityV2({
    isOrganiser: true,
    eventCompleted: true,
    audience,
    activeJob,
    recentSends,
    lastSent,
    timeZone: access.timeZone,
  });
}
