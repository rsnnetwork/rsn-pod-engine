// ─── Event reminders, 24 hours and 1 hour before (Part 2 foundation, Task 10; spec 03 Communications) ──────────────
//
// Called every 60 seconds from index.ts. Dark until config.eventComms is 'report' or 'on':
//   off     nothing is selected, written or sent (the worker does not even query).
//   report  log which events would remind how many people, and write and send nothing.
//   on      claim, ring and email.
//
// Which events: published, still scheduled, not archived, with a start (the shared lifecycle decides, in
// isRemindable; a draft, cancelled, completed, live or archived event is never reminded). `24h` while the start is
// more than 60 minutes and at most 24 hours away, for people who registered at least 30 minutes ago; `1h` while it is
// within the hour, for people who registered at least 10 minutes ago (so nobody is reminded of an event they just
// signed up to). The host and the co-hosts are reminded too. Only active accounts with "event reminders" on.
//
// Once, on every instance, across restarts: the claim is one INSERT ... ON CONFLICT DO NOTHING RETURNING into
// event_reminder_sends, whose key is (event, person, kind, planned start). Whoever's insert lands owns the reminder.
// A send that fails after the claim is not retried (better than reminding twice). The claim and the bell are two
// statements on purpose: the contract is at most once, so a crash between them loses that one bell and never doubles
// it (a rolled-back claim would be retried by the next tick, and a bell with no claim could be rung twice). The
// reminder emails are sent from the claim's result, so they follow the same rule; a failed bell or email is logged. An event that is moved has a new
// planned start, so a new key: it is reminded again at its new time. "Now" is the database's clock unless a caller
// passes one (this machine's clock may be skewed; the database's is the one every other time is held to).

import config from '../../config';
import logger from '../../config/logger';
import { query } from '../../db';
import * as emailService from '../email/email.service';
import { activeMemberSql } from '../users/active-member';
import { relativeEventTime } from '@rsn/shared';
import { eventPagePath, eventPageUrl, isRemindable, ringEventBells, type EventFacts } from './event-notices';
import { eventImageColumns, eventImageUrlOf } from './event-image-url';

/** How often the server looks for reminders due. */
export const EVENT_REMINDER_INTERVAL_MS = 60 * 1000;
/** The most reminders one tick claims; the rest wait for the next. */
export const EVENT_REMINDERS_PER_TICK = 200;
/** The events one tick reads (those starting within 24 hours, soonest first). */
const EVENTS_PER_TICK = 200;
/** A person must have held their place this long before the 24h / 1h reminder is claimed for them. */
export const REGISTERED_MIN_BEFORE_24H = 30;
export const REGISTERED_MIN_BEFORE_1H = 10;
/** Report mode repeats an unchanged list at most this often (it runs every minute, on every instance). */
export const EVENT_REPORT_REPEAT_MS = 30 * 60 * 1000;

export type EventCommsMode = 'off' | 'report' | 'on';
export type ReminderKind = '24h' | '1h';

export interface EventReminderResult {
  /** Events due a reminder (in either window). */
  due: number;
  /** People claimed: one row each in event_reminder_sends. Always 0 in report mode. */
  claimed: number;
  belled: number;
  emailed: number;
}

interface DueEvent extends EventFacts {
  id: string;
  title: string;
  scheduled_at: Date;
  now_at: Date;
  /** The event's own zone: "tomorrow at 09:00 (CET)" is judged and written on its clock (Part 3 Task 1, K1). */
  timezone: string | null;
  has_image: boolean | null;
  image_updated_at: Date | null;
}

interface ClaimedPerson {
  user_id: string;
  email: string | null;
  notify_email: boolean | null;
}

/** Soonest first, the events that start within 24 hours: the claim then splits each by how near its start is. */
export const DUE_EVENTS_SQL = `
  SELECT s.id, s.title, s.scheduled_at, s.status::text AS status, s.publication, s.archived_at,
         s.registration_opens_at, COALESCE($1::timestamptz, NOW()) AS now_at,
         s.timezone, ${eventImageColumns('s')}
    FROM sessions s
   WHERE s.status = 'scheduled' AND s.publication = 'published' AND s.archived_at IS NULL
     AND s.scheduled_at IS NOT NULL
     AND s.scheduled_at > COALESCE($1::timestamptz, NOW())
     AND s.scheduled_at <= COALESCE($1::timestamptz, NOW()) + INTERVAL '24 hours'
   ORDER BY s.scheduled_at
   LIMIT ${EVENTS_PER_TICK}`;

/**
 * The people owed this event's reminder of this kind and not yet claimed: those who held a place (not removed, left
 * or no-show) for long enough, and the host and co-hosts, active, with event reminders on. $1 event, $2 kind,
 * $3 the event's planned start, $4 now, $5 minutes a person must have been registered, $6 how many at most.
 */
export const OWED_SQL = `
  SELECT u.id AS user_id, u.email, u.notify_email
    FROM users u
   WHERE ${activeMemberSql('u')} AND u.notify_event_reminders = TRUE
     AND (u.id IN (SELECT sp.user_id FROM session_participants sp
                    WHERE sp.session_id = $1::uuid AND sp.status NOT IN ('removed', 'left', 'no_show')
                      AND sp.created_at <= $4::timestamptz - make_interval(mins => $5::int))
          OR u.id IN (SELECT c.user_id FROM session_cohosts c WHERE c.session_id = $1)
          OR u.id IN (SELECT s.host_user_id FROM sessions s WHERE s.id = $1))
     AND NOT EXISTS (SELECT 1 FROM event_reminder_sends r
                      WHERE r.session_id = $1 AND r.user_id = u.id AND r.kind = $2::text AND r.scheduled_for = $3::timestamptz)
   ORDER BY u.id
   LIMIT $6`;

export const CLAIM_SQL = `
  WITH owed AS (${OWED_SQL}),
       claimed AS (
         INSERT INTO event_reminder_sends (session_id, user_id, kind, scheduled_for)
         SELECT $1::uuid, owed.user_id, $2::text, $3::timestamptz FROM owed
         ON CONFLICT (session_id, user_id, kind, scheduled_for) DO NOTHING
         RETURNING user_id)
  SELECT owed.user_id, owed.email, owed.notify_email
    FROM claimed JOIN owed ON owed.user_id = claimed.user_id`;

/** The kind and the registration age that go with how far away an event's start is. */
export function reminderKindFor(startsAt: Date, now: Date): { kind: ReminderKind; minRegisteredMinutes: number } | null {
  const ms = startsAt.getTime() - now.getTime();
  if (ms <= 0 || ms > 24 * 60 * 60_000) return null;
  return ms <= 60 * 60_000
    ? { kind: '1h', minRegisteredMinutes: REGISTERED_MIN_BEFORE_1H }
    : { kind: '24h', minRegisteredMinutes: REGISTERED_MIN_BEFORE_24H };
}

let lastReport: { key: string; at: number } | null = null;

/** Whether report mode should log this list now: it changed, or the last log of it is 30 minutes old. */
function reportIsDue(key: string, now: Date): boolean {
  if (lastReport && lastReport.key === key && now.getTime() - lastReport.at < EVENT_REPORT_REPEAT_MS) return false;
  lastReport = { key, at: now.getTime() };
  return true;
}

/** Test seam: forget the last report. */
export function resetEventReminderReport(): void {
  lastReport = null;
}

/**
 * Find the events due a reminder and, in `on` mode, tell their people. `now` and `mode` are for tests and for a
 * caller that knows better; the server passes neither (the database's clock, config.eventComms).
 */
export async function processEventReminders(now?: Date, mode: EventCommsMode = config.eventComms): Promise<EventReminderResult> {
  const result: EventReminderResult = { due: 0, claimed: 0, belled: 0, emailed: 0 };
  if (mode === 'off') return result;
  const events = await query<DueEvent>(DUE_EVENTS_SQL, [now ?? null]);
  const wouldTell: Array<{ sessionId: string; kind: ReminderKind; people: number }> = [];
  let budget = EVENT_REMINDERS_PER_TICK;

  for (const event of events.rows) {
    if (budget <= 0) break;
    const at = new Date(event.now_at);
    if (!isRemindable(event, at)) continue;
    const startsAt = new Date(event.scheduled_at);
    const plan = reminderKindFor(startsAt, at);
    if (!plan) continue;
    result.due += 1;
    const params = [event.id, plan.kind, startsAt, at, plan.minRegisteredMinutes, budget];

    if (mode === 'report') {
      const owed = await query<ClaimedPerson>(OWED_SQL, params);
      if (owed.rows.length > 0) wouldTell.push({ sessionId: event.id, kind: plan.kind, people: owed.rows.length });
      continue;
    }

    const claimed = await query<ClaimedPerson>(CLAIM_SQL, params);
    if (claimed.rows.length === 0) continue;
    budget -= claimed.rows.length;
    result.claimed += claimed.rows.length;
    const told = await tell(event, startsAt, at, plan.kind, claimed.rows);
    result.belled += told.belled;
    result.emailed += told.emailed;
  }

  if (mode === 'report') reportWhoWouldBeTold(wouldTell, now ?? new Date());
  return result;
}

function reportWhoWouldBeTold(wouldTell: Array<{ sessionId: string; kind: ReminderKind; people: number }>, at: Date): void {
  if (wouldTell.length === 0) return;
  const key = wouldTell.map((w) => `${w.sessionId}:${w.kind}:${w.people}`).sort().join(',');
  if (!reportIsDue(key, at)) return;
  logger.info(
    { mode: 'report', events: wouldTell, people: wouldTell.reduce((sum, w) => sum + w.people, 0) },
    'Event reminders: would remind (report mode, nothing sent)',
  );
}

/** The bells (on the event's clock, its zone named), then the emails of those whose email switch is on. */
async function tell(
  event: DueEvent, startsAt: Date, now: Date, kind: ReminderKind, people: ClaimedPerson[],
): Promise<{ belled: number; emailed: number }> {
  const belled = await ringEventBells(
    'event_reminder',
    people.map((p) => ({ userId: p.user_id, title: `${event.title} starts ${relativeEventTime(startsAt, now, event.timezone)}` })),
    'Join from the event page.',
    eventPagePath(event.id),
  );
  const emailed = await emailReminders(event, startsAt, now, kind, people);
  return { belled, emailed };
}

async function emailReminders(
  event: DueEvent, startsAt: Date, now: Date, kind: ReminderKind, people: ClaimedPerson[],
): Promise<number> {
  try {
    const wanted = people.filter((p) => p.email && p.notify_email !== false);
    if (wanted.length === 0) return 0;
    if (!(await emailService.isEmailTypeEnabled('event_reminder'))) return 0;
    const link = eventPageUrl(event.id);
    const when = relativeEventTime(startsAt, now, event.timezone);
    const imageUrl = eventImageUrlOf(event.id, event);
    const sentTo: string[] = await emailService.asBulkEmail(async () => {
      const sent: string[] = [];
      for (const person of wanted) {
        const result = await emailService.sendEventReminderEmail(person.email as string, {
          eventTitle: event.title, when, link, imageUrl,
        }).catch((err: unknown) => {
          logger.warn({ err, sessionId: event.id, userId: person.user_id }, 'Event reminder email failed (claimed, not retried)');
          return { sent: false };
        });
        if (result.sent) sent.push(person.user_id);
      }
      return sent;
    });
    if (sentTo.length > 0) {
      await query(
        `UPDATE event_reminder_sends SET emailed = TRUE
          WHERE session_id = $1 AND kind = $2 AND scheduled_for = $3::timestamptz AND user_id = ANY($4::uuid[])`,
        [event.id, kind, startsAt, sentTo],
      );
    }
    return sentTo.length;
  } catch (err) {
    logger.warn({ err, sessionId: event.id }, 'Event reminder emails could not be sent (non-fatal)');
    return 0;
  }
}
