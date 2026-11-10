// ─── An in-person event ends itself (30 Oct 2026, T12, L18) ──────────────────────────────────────
//
// An in-person event has no Go Live and no End Event: nobody opens a room for it. Without this it would sit
// "Upcoming" for ever, because the abandoned-event reaper looks at live events only. Once its start plus its length
// (at most 480 minutes) has passed it is completed: it moves to Ended on every page that shows it (the same
// fan-out as any completed event), with no LiveKit room to close and no recap email.

import { SessionStatus } from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { updateSessionStatus } from './session.service';
import { fanoutSessionCompleted } from '../../realtime/fanout';
import { recordEventAudit } from '../audit/event-audit';

/** How often the server looks for in-person events that are over. */
export const IN_PERSON_ENDING_INTERVAL_MS = 60 * 1000;

/**
 * Completes every scheduled in-person event whose start plus its length has passed, at most 50 a tick, and
 * returns their ids. Its start and end are stamped as scheduled. A length that is not a number counts as the
 * format's default, 60 minutes. Each event is ended on its own, so one failure leaves the rest to finish and is
 * tried again next tick; an event cancelled meanwhile stays cancelled (updateSessionStatus keeps a terminal state).
 */
export async function endFinishedInPersonEvents(): Promise<string[]> {
  const due = await query<{ id: string; scheduled_at: Date; ends_at: Date }>(
    `SELECT id, scheduled_at, ends_at FROM (
       SELECT id, scheduled_at,
              scheduled_at + make_interval(mins => CASE
                WHEN config->>'durationMinutes' ~ '^[0-9]+([.][0-9]+)?$'
                  THEN LEAST(480, GREATEST(1, CEIL((config->>'durationMinutes')::numeric)))::int
                ELSE 60 END) AS ends_at
         FROM sessions
        WHERE event_format = 'physical_event' AND status = 'scheduled' AND scheduled_at IS NOT NULL
     ) due
     WHERE ends_at <= NOW()
     ORDER BY ends_at
     LIMIT 50`,
  );
  const ended: string[] = [];
  for (const row of due.rows) {
    try {
      await updateSessionStatus(row.id, SessionStatus.COMPLETED, {
        startedAt: new Date(row.scheduled_at), endedAt: new Date(row.ends_at),
      });
      await fanoutSessionCompleted(row.id);
      void recordEventAudit({
        sessionId: row.id, actorId: null, action: 'event.completed', automatic: true,
        reason: 'An in-person event ends at its scheduled end time',
      });
      ended.push(row.id);
    } catch (err) {
      logger.warn({ err, sessionId: row.id }, 'In-person ending: could not end that one (will retry next tick)');
    }
  }
  if (ended.length > 0) logger.info({ count: ended.length, sessionIds: ended }, 'In-person events ended at their end time');
  return ended;
}
