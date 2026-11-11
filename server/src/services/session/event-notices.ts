// ─── The notices an event sends about its time (Part 2 foundation, Task 10; spec 03 Communications) ────────────────
//
// What is shared by the reminder worker (24 hours and 1 hour before) and the time-change notice: how a bell is written
// and pushed, and the time-change notice itself, which updateSession sends when a published, scheduled event is moved.
// Every time they print is on the event's own clock and names its zone (Part 3 Task 1, K1: shared formatEventTime and
// relativeEventTime), whoever reads it and wherever they are.
//
// Everything here is dark until config.eventComms is 'on'. Nothing here throws at its caller: a notice that cannot be
// sent is logged, never the reason an event edit or a reminder tick fails.

import { eventLifecycleOf, formatEventTime } from '@rsn/shared';
import config from '../../config';
import logger from '../../config/logger';
import { query } from '../../db';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import * as emailService from '../email/email.service';
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

/** The event's page, as a path (a bell) and as an address (an email). */
export const eventPagePath = (sessionId: string): string => `/sessions/${sessionId}`;
export const eventPageUrl = (sessionId: string): string => `${config.clientUrl}${eventPagePath(sessionId)}`;

/** `event_schedule_changed` (Part 2 Task 9): someone's meetings changed in a newly published schedule version. */
export type EventBellType = 'event_reminder' | 'event_rescheduled' | 'event_schedule_changed';

export interface EventBell {
  userId: string;
  title: string;
}

/**
 * Ring one bell per person (one statement), then push each to the person's open screens. Each person's title is
 * their own, so a caller may word it per person. Returns how many were written; never throws.
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
  /** The event's own zone: every time in the notice is on its clock (Part 3 Task 1, K1). */
  timezone: string | null;
}

interface MovedRecipient {
  id: string;
  email: string | null;
  notify_email: boolean | null;
}

/**
 * Tell everyone with a place that a published, scheduled event has moved: one bell each ("{title} has moved to
 * {when}", on the event's clock and naming its zone) and an email when their email switch and the admin's 'event_rescheduled' switch are both on. Everyone who
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
  /**
   * The zone the old time was on, when the same edit changed the zone too (fix round 1, M2): "it was 14:00 (CET)" is
   * written on the clock people knew it by. Omitted: the event's zone as it is now.
   */
  previousZone?: string | null,
): Promise<{ notified: number }> {
  if (config.eventComms !== 'on') return { notified: 0 };
  if (previousAt.getTime() === nextAt.getTime()) return { notified: 0 };
  try {
    const found = await query<MovedEventRow>(
      `SELECT s.id, s.title, s.status::text AS status, s.publication, s.archived_at, s.registration_opens_at, s.timezone
         FROM sessions s WHERE s.id = $1`,
      [sessionId],
    );
    const event = found.rows[0];
    if (!event || !isRemindable(event, new Date())) return { notified: 0 };

    const recipients = await query<MovedRecipient>(
      `SELECT u.id, u.email, u.notify_email
         FROM users u
        WHERE u.id <> $2 AND ${activeMemberSql('u')}
          AND (u.id IN (SELECT sp.user_id FROM session_participants sp
                         WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show'))
               OR u.id IN (SELECT c.user_id FROM session_cohosts c WHERE c.session_id = $1)
               OR u.id IN (SELECT s.host_user_id FROM sessions s WHERE s.id = $1))`,
      [sessionId, actorId],
    );
    if (recipients.rows.length === 0) return { notified: 0 };

    // Written once for the event (fix round 1, M3): every person reads the same time on the event's clock.
    const when = { previous: formatEventTime(previousAt, previousZone ?? event.timezone), next: formatEventTime(nextAt, event.timezone) };
    const title = `${event.title} has moved to ${when.next}`;
    const notified = await ringEventBells(
      'event_rescheduled',
      recipients.rows.map((r) => ({ userId: r.id, title })),
      'Join from the event page.',
      eventPagePath(sessionId),
    );
    await emailMove(event, when, recipients.rows);
    return { notified };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Event moved, but its notices could not all be sent (non-fatal)');
    return { notified: 0 };
  }
}

async function emailMove(event: MovedEventRow, when: { previous: string; next: string }, recipients: MovedRecipient[]): Promise<void> {
  try {
    if (!(await emailService.isEmailTypeEnabled('event_rescheduled'))) return;
    const wanted = recipients.filter((r) => r.email && r.notify_email !== false);
    if (wanted.length === 0) return;
    const link = eventPageUrl(event.id);
    await emailService.asBulkEmail(async () => {
      for (const person of wanted) {
        await emailService.sendEventRescheduledEmail(person.email as string, {
          eventTitle: event.title,
          previousWhen: when.previous,
          when: when.next,
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
