// ─── The "you're registered" email (moved here 11 Nov 2026 from routes/sessions.ts) ──────────────────────
//
// Sent after a fresh registration: the event page's Register, an approved request, and (Part 2 Task 6) an entry by
// the event's RSN Call link. One helper, so every way in sends the same email.

import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import * as emailService from '../email/email.service';
import { buildSessionCalendarEvent } from '../calendar/calendar.service';

/** The "you're registered" email with its calendar invite. Best-effort: a failure is logged, never thrown. */
export async function sendRegistrationEmail(sessionId: string, userId: string): Promise<void> {
  try {
    const u = (await query<{ email: string; display_name: string | null }>(
      `SELECT email, display_name FROM users WHERE id = $1`,
      [userId],
    )).rows[0];
    if (!u?.email) return;
    const calendarEvent = await buildSessionCalendarEvent(sessionId);
    await emailService.sendSessionRegistrationConfirmationEmail(u.email, {
      recipientName: u.display_name || undefined,
      sessionTitle: calendarEvent?.title ?? 'your REASON event',
      sessionUrl: `${config.clientUrl}/sessions/${sessionId}`,
      calendarEvent,
    });
  } catch (err) {
    logger.warn({ err, sessionId, userId }, 'registration confirmation email failed (non-fatal)');
  }
}
