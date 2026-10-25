// ─── Meeting reminders, 10 minutes before (26 Oct 2026) ──────────────────────
//
// Called every 60 seconds from index.ts, beside the post-event message worker. One UPDATE claims the
// meetings that start within 10 minutes and have not been reminded: its subquery takes them FOR
// UPDATE SKIP LOCKED, so with several server instances each meeting is claimed by exactly one, once.
// A meeting is reminded at most once. A send that fails after the claim is not retried, which is
// better than reminding twice; a move clears reminder_sent_at, so a moved meeting is reminded again.
//
// Both people get a bell. Each also gets an email when their notify_email switch is on and the admin
// email_config switch for 'meeting_reminder' is too (that one fails open, like every email type).
// No reminder is sent for a meeting booked or moved inside the last 10 minutes (the confirmation was
// just in front of them), for one with a closed account, or for a pair a block stands between.

import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import type { MeetingKind } from '@rsn/shared';
import * as blockService from '../block/block.service';
import { meetingJoinPath } from '../dm/meeting-windows.service';
import { emitMeetingChanged } from './meeting-tags';
import { meetingTime } from './meeting-time';

/** How long before the start a meeting is reminded. */
export const REMINDER_LEAD_MIN = 10;
const MEETING_REMINDER_EMAIL_TYPE = 'meeting_reminder';

interface DueMeeting {
  id: string;
  conversation_id: string;
  user_a_id: string;
  user_b_id: string;
  start_at: Date;
  duration_min: number;
  kind: MeetingKind;
  /** When it was booked, or last moved. */
  updated_at: Date;
}

interface Person {
  id: string;
  display_name: string | null;
  email: string | null;
  timezone: string | null;
  status: string;
  notify_email: boolean;
}

/** Claim and remind every meeting that is due. Returns how many were claimed. */
export async function processMeetingReminders(now = new Date()): Promise<number> {
  const claimed = await query<DueMeeting>(
    `UPDATE meetings SET reminder_sent_at = NOW()
      WHERE id IN (
        SELECT id FROM meetings
         WHERE status = 'scheduled' AND reminder_sent_at IS NULL
           AND start_at > $1 AND start_at <= $1::timestamptz + INTERVAL '${REMINDER_LEAD_MIN} minutes'
         ORDER BY start_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED)
      RETURNING id, conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, updated_at`,
    [now],
  );
  for (const meeting of claimed.rows) {
    try {
      await remind(meeting, now);
    } catch (err) {
      logger.warn({ err, meetingId: meeting.id }, 'meeting reminder failed (claimed, not retried)');
    }
  }
  return claimed.rows.length;
}

async function remind(meeting: DueMeeting, now: Date): Promise<void> {
  const leadMs = REMINDER_LEAD_MIN * 60_000;
  if (meeting.updated_at.getTime() > meeting.start_at.getTime() - leadMs) return;

  const people = (await query<Person>(
    `SELECT id, display_name, email, timezone, status, notify_email FROM users WHERE id = ANY($1)`,
    [[meeting.user_a_id, meeting.user_b_id]],
  )).rows;
  const a = people.find((p) => p.id === meeting.user_a_id);
  const b = people.find((p) => p.id === meeting.user_b_id);
  if (a?.status !== 'active' || b?.status !== 'active') return;
  if (await blockService.areBlocked(a.id, b.id)) return;

  // 10 on time; the truth when the worker is late, so a reminder never promises time that is gone.
  const minutesToGo = Math.min(REMINDER_LEAD_MIN, Math.max(1, Math.ceil((meeting.start_at.getTime() - now.getTime()) / 60_000)));
  const startsIn = minutesToGo === 1 ? '1 minute' : `${minutesToGo} minutes`;
  const nameOf = (p: Person) => p.display_name?.trim() || 'your match';
  const link = `/messages/${meeting.conversation_id}`;
  const bellFor = (me: Person, other: Person) => {
    const t = meetingTime(meeting.start_at, me.timezone);
    return {
      userId: me.id,
      title: `Your meeting with ${nameOf(other)} starts in ${startsIn}`,
      body: `${t.short} ${t.zone} · ${meeting.duration_min} min ${meeting.kind} call`,
    };
  };
  const bells = [bellFor(a, b), bellFor(b, a)];

  try {
    const inserted = await query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES (gen_random_uuid(), $1, 'meeting_reminder', $2, $3, $4), (gen_random_uuid(), $5, 'meeting_reminder', $6, $7, $8)
       RETURNING id, user_id, created_at`,
      bells.flatMap((bell) => [bell.userId, bell.title, bell.body, link]),
    );
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    for (const row of inserted.rows) {
      const bell = bells.find((x) => x.userId === row.user_id);
      if (!bell) continue;
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id, type: 'meeting_reminder', title: bell.title, body: bell.body, link, isRead: false, createdAt: row.created_at,
      });
      await emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)]);
    }
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'meeting reminder bells failed (non-fatal)');
  }
  await emitMeetingChanged(meeting.id, [a.id, b.id]);

  try {
    const emailService = await import('../email/email.service');
    if (!(await emailService.isEmailTypeEnabled(MEETING_REMINDER_EMAIL_TYPE))) return;
    for (const [me, other] of [[a, b], [b, a]] as const) {
      if (!me.email || !me.notify_email) continue;
      void emailService.sendMeetingReminderEmail(me.email, me.display_name || 'there', {
        partnerName: nameOf(other),
        startAt: meeting.start_at,
        durationMin: meeting.duration_min,
        kind: meeting.kind,
        recipientTimezone: me.timezone,
        minutesToGo,
        joinUrl: `${config.clientUrl}${meetingJoinPath(meeting.conversation_id, meeting.kind)}`,
        eventsUrl: `${config.clientUrl}/sessions`,
      }).catch((err) => logger.warn({ err, meetingId: meeting.id }, 'meeting reminder email failed (non-fatal)'));
    }
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'meeting reminder emails failed (non-fatal)');
  }
}
