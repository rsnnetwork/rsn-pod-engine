// ─── The notices an event sends about its time (Part 2 foundation, Task 10; spec 03 Communications) ────────────────
//
// What is shared by the reminder worker (24 hours and 1 hour before) and the time-change notice: how a time reads to
// one person (in their own zone, as "in 1 hour" or "tomorrow at 18:00"), how a bell is written and pushed, and the
// time-change notice itself, which updateSession sends when a published, scheduled event is moved.
//
// Everything here is dark until config.eventComms is 'on'. Nothing here throws at its caller: a notice that cannot be
// sent is logged, never the reason an event edit or a reminder tick fails.

import { eventLifecycleOf } from '@rsn/shared';
import config from '../../config';
import logger from '../../config/logger';
import { query } from '../../db';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import * as emailService from '../email/email.service';
import { meetingTime } from '../meetings/meeting-time';
import { activeMemberSql } from '../users/active-member';

/** An event's lifecycle facts, as the SQL columns name them. */
export interface EventFacts {
  status: string;
  publication: 'draft' | 'published';
  archived_at: Date | string | null;
  registration_opens_at: Date | string | null;
}

/**
 * Whether an event still has a start to be told about: scheduled, published (its registration open or not yet), and
 * not archived. A draft, a cancelled, a completed, a live and an archived event are not. One rule, the shared lifecycle.
 */
export function isRemindable(event: EventFacts, now: Date): boolean {
  if (event.status !== 'scheduled') return false;
  const lifecycle = eventLifecycleOf({
    status: event.status, publication: event.publication, archivedAt: event.archived_at, registrationOpensAt: event.registration_opens_at,
  }, now);
  return lifecycle === 'published' || lifecycle === 'registration_open';
}

interface LocalParts { year: number; month: number; day: number; hour: string; minute: string }

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0';
  return { year: Number(part('year')), month: Number(part('month')), day: Number(part('day')), hour: part('hour'), minute: part('minute') };
}

function localPartsOrUtc(at: Date, timeZone: string | null | undefined): LocalParts {
  try {
    return localParts(at, timeZone || 'UTC');
  } catch {
    return localParts(at, 'UTC');
  }
}

/**
 * When an event starts, as one person reads it, from `now`: "in 12 minutes", "in 1 hour", "in 3 hours",
 * "today at 18:00", "tomorrow at 18:00", else the day ("Fri 13 Nov, 18:00"). The wall-clock time and the day are in
 * the person's own zone (UTC when none is on file or the zone is one Intl refuses).
 */
export function relativeEventWhen(at: Date, now: Date, timeZone?: string | null): string {
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes <= 59) return minutes === 1 ? 'in 1 minute' : `in ${minutes} minutes`;
  if (minutes < 6 * 60) {
    const hours = Math.max(1, Math.round(minutes / 60));
    return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  }
  const start = localPartsOrUtc(at, timeZone);
  const today = localPartsOrUtc(now, timeZone);
  const dayGap = Math.round(
    (Date.UTC(start.year, start.month - 1, start.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000,
  );
  const clock = `${start.hour}:${start.minute}`;
  if (dayGap === 0) return `today at ${clock}`;
  if (dayGap === 1) return `tomorrow at ${clock}`;
  return meetingTime(at, timeZone).short;
}

/** A time written out for a bell or an email, in the person's own zone and named: "Tuesday 17 November, 14:00 (CET)". */
export function eventTimeInZone(at: Date, timeZone?: string | null): string {
  const t = meetingTime(at, timeZone);
  return `${t.long} (${t.zone})`;
}

/** The event's page, as a path (a bell) and as an address (an email). */
export const eventPagePath = (sessionId: string): string => `/sessions/${sessionId}`;
export const eventPageUrl = (sessionId: string): string => `${config.clientUrl}${eventPagePath(sessionId)}`;

export type EventBellType = 'event_reminder' | 'event_rescheduled';

export interface EventBell {
  userId: string;
  title: string;
}

/**
 * Ring one bell per person (one statement), then push each to the person's open screens. The title is the person's
 * own (it carries their own zone's time). Returns how many were written; never throws.
 */
export async function ringEventBells(type: EventBellType, bells: EventBell[], body: string, link: string): Promise<number> {
  if (bells.length === 0) return 0;
  try {
    const inserted = await query<{ id: string; user_id: string; title: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT t.user_id, $3, t.title, $4, $5
         FROM unnest($1::uuid[], $2::text[]) AS t(user_id, title)
       RETURNING id, user_id, title, created_at`,
      [bells.map((b) => b.userId), bells.map((b) => b.title), type, body, link],
    );
    const io = getRealtimeIo();
    if (io) {
      for (const bell of inserted.rows) {
        io.to(`user:${bell.user_id}`).emit('notification:new', {
          id: bell.id, type, title: bell.title, body, link, isRead: false, createdAt: bell.created_at,
        });
        emitEntities(io, [bell.user_id], [E.userNotifications(bell.user_id)]).catch((err: unknown) => {
          logger.warn({ err, userId: bell.user_id }, 'Event bell written, its live tag was not sent (non-fatal)');
        });
      }
    }
    return inserted.rows.length;
  } catch (err) {
    logger.warn({ err, type }, 'Event bells could not be written (non-fatal)');
    return 0;
  }
}

// ─── The time-change notice ──────────────────────────────────────────────────

interface MovedEventRow extends EventFacts {
  id: string;
  title: string;
}

interface MovedRecipient {
  id: string;
  email: string | null;
  timezone: string | null;
  notify_email: boolean | null;
}

/**
 * Tell everyone with a place that a published, scheduled event has moved: one bell each ("{title} has moved to
 * {when}") and an email when their email switch and the admin's 'event_rescheduled' switch are both on. Everyone who
 * holds a place (not removed, left or no-show), the host and the co-hosts, but not the organiser who moved it. Only
 * while config.eventComms is 'on'; a time that did not change tells nobody. Never throws. A move, like a
 * cancellation, is not a reminder: it ignores the "event reminders" preference.
 *
 * A move that lands inside the 24 hour window also gets a reminder for the new time (a new key) on the next tick, so
 * a person can have both a "moved" bell and a "starts tomorrow at ..." bell. That is kept on purpose: the notice says
 * what changed and is the only one that reaches people with reminders off or registered less than 30 minutes ago, and
 * the reminder says when. Suppressing one for the other would silently leave those people uninformed.
 */
export async function notifyEventRescheduled(
  sessionId: string, previousAt: Date, nextAt: Date, actorId: string,
): Promise<{ notified: number }> {
  if (config.eventComms !== 'on') return { notified: 0 };
  if (previousAt.getTime() === nextAt.getTime()) return { notified: 0 };
  try {
    const found = await query<MovedEventRow>(
      `SELECT s.id, s.title, s.status::text AS status, s.publication, s.archived_at, s.registration_opens_at
         FROM sessions s WHERE s.id = $1`,
      [sessionId],
    );
    const event = found.rows[0];
    if (!event || !isRemindable(event, new Date())) return { notified: 0 };

    const recipients = await query<MovedRecipient>(
      `SELECT u.id, u.email, u.timezone, u.notify_email
         FROM users u
        WHERE u.id <> $2 AND ${activeMemberSql('u')}
          AND (u.id IN (SELECT sp.user_id FROM session_participants sp
                         WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show'))
               OR u.id IN (SELECT c.user_id FROM session_cohosts c WHERE c.session_id = $1)
               OR u.id IN (SELECT s.host_user_id FROM sessions s WHERE s.id = $1))`,
      [sessionId, actorId],
    );
    if (recipients.rows.length === 0) return { notified: 0 };

    const notified = await ringEventBells(
      'event_rescheduled',
      recipients.rows.map((r) => ({ userId: r.id, title: `${event.title} has moved to ${eventTimeInZone(nextAt, r.timezone)}` })),
      'Join from the event page.',
      eventPagePath(sessionId),
    );
    await emailMove(event, previousAt, nextAt, recipients.rows);
    return { notified };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Event moved, but its notices could not all be sent (non-fatal)');
    return { notified: 0 };
  }
}

async function emailMove(event: MovedEventRow, previousAt: Date, nextAt: Date, recipients: MovedRecipient[]): Promise<void> {
  try {
    if (!(await emailService.isEmailTypeEnabled('event_rescheduled'))) return;
    const wanted = recipients.filter((r) => r.email && r.notify_email !== false);
    if (wanted.length === 0) return;
    const link = eventPageUrl(event.id);
    await emailService.asBulkEmail(async () => {
      for (const person of wanted) {
        await emailService.sendEventRescheduledEmail(person.email as string, {
          eventTitle: event.title,
          previousWhen: eventTimeInZone(previousAt, person.timezone),
          when: eventTimeInZone(nextAt, person.timezone),
          link,
        }).catch((err: unknown) => {
          logger.warn({ err, sessionId: event.id, userId: person.id }, 'Event-moved email failed (non-fatal)');
        });
      }
    });
  } catch (err) {
    logger.warn({ err, sessionId: event.id }, 'Event-moved emails could not be sent (non-fatal)');
  }
}
