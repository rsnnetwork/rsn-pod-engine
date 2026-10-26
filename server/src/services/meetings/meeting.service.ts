// ─── Meetings (26 Oct 2026, CON-04/05) ───────────────────────────────────────
//
// Stefan and Claus agreed a time, and nothing appeared under Events: "Now we've found a time to meet.
// What then? ... So we can't meet." A confirmed meeting is a row of its own (migration 110), booked
// and moved by meeting-windows.service.ts in the same transaction as the conversation's meeting_*
// columns. This file is what Events reads (the lists, the count, one meeting), the cancel, and the
// attendance stamp the call room writes.
//
// Who sees a meeting: only its two people, and neither once a block stands between them (they never
// see each other). A closed account reads "Former member". Cancel is a claim on the row, so a double
// press, or both people pressing at once, cancels once and tells each person once.

import type { PoolClient } from 'pg';
import type { Server as SocketServer } from 'socket.io';
import {
  ErrorCodes, MEETING_GRACE_MIN, meetingPhase,
  type Meeting, type MeetingKind, type MeetingList, type MeetingScope, type MeetingStatus, type MeetingSummary,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { ConflictError, NotFoundError } from '../../middleware/errors';
import * as dmService from '../dm/dm.service';
import { meetingJoinPath } from '../dm/meeting-windows.service';
import { emitMeetingChanged } from './meeting-tags';
import { meetingTime } from './meeting-time';
import { CURRENT_MEETING_ID } from './current-meeting';

/** A meeting row with the other person's columns, as every read here selects it. */
interface MeetingRow {
  id: string;
  conversation_id: string;
  user_a_id: string;
  user_b_id: string;
  start_at: Date;
  duration_min: number;
  kind: MeetingKind;
  status: MeetingStatus;
  context: string | null;
  joined_a_at: Date | null;
  joined_b_at: Date | null;
  calendar_sequence: number;
  confirmed_by: string | null;
  partner_id: string;
  partner_name: string | null;
  partner_avatar_url: string | null;
  partner_status: string;
}

/** The meeting's own columns, as a write returns them. */
const OWN_COLUMNS = `id, conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, status,
         context, joined_a_at, joined_b_at, calendar_sequence, confirmed_by`;

/**
 * $1 is the viewer. Their meetings, each joined to the other person, leaving out every pair a block
 * stands between, whichever of the two made it.
 */
const VIEWERS_MEETINGS = `
    FROM meetings m
    JOIN users p ON p.id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
   WHERE (m.user_a_id = $1 OR m.user_b_id = $1)
     AND NOT EXISTS (
       SELECT 1 FROM user_blocks ub
        WHERE (ub.blocker_id = $1 AND ub.blocked_id = p.id) OR (ub.blocker_id = p.id AND ub.blocked_id = $1))`;

const SELECT_MEETINGS = `
  SELECT m.id, m.conversation_id, m.user_a_id, m.user_b_id, m.start_at, m.duration_min, m.kind, m.status,
         m.context, m.joined_a_at, m.joined_b_at, m.calendar_sequence, m.confirmed_by,
         p.id AS partner_id, p.display_name AS partner_name, p.avatar_url AS partner_avatar_url, p.status AS partner_status
  ${VIEWERS_MEETINGS}`;

/** When a meeting stops being joinable: its end plus the grace period. Compared with `now`. */
const ENDS_AT = `m.start_at + (m.duration_min + ${MEETING_GRACE_MIN}) * INTERVAL '1 minute'`;

/** Rows that share the instant at a page's edge are fetched whole, up to this many. */
const MAX_TIED = 50;

function partnerName(row: { partner_name: string | null; partner_status: string }): string {
  if (row.partner_status !== 'active') return 'Former member';
  return row.partner_name?.trim() || 'Member';
}

function toMeeting(row: MeetingRow, viewerId: string, now: Date): Meeting {
  const iAmA = row.user_a_id === viewerId;
  const active = row.partner_status === 'active';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    partner: { userId: row.partner_id, displayName: partnerName(row), avatarUrl: active ? row.partner_avatar_url : null },
    startAt: row.start_at.toISOString(),
    durationMin: row.duration_min,
    kind: row.kind,
    status: row.status,
    phase: meetingPhase({ status: row.status, startAt: row.start_at, durationMin: row.duration_min }, now),
    context: row.context,
    joinPath: meetingJoinPath(row.conversation_id, row.kind),
    attended: { me: !!(iAmA ? row.joined_a_at : row.joined_b_at), them: !!(iAmA ? row.joined_b_at : row.joined_a_at) },
  };
}

/** The scope's filter and order, with the parameters it adds after the viewer ($1). */
function scopeOf(scope: MeetingScope, now: Date): { where: string; params: unknown[]; order: 'ASC' | 'DESC' } {
  if (scope === 'cancelled') return { where: `m.status = 'cancelled'`, params: [], order: 'DESC' };
  // Still to come includes a meeting that can be joined or is under way; past is what has ended.
  const comparison = scope === 'upcoming' ? '>=' : '<';
  return { where: `m.status = 'scheduled' AND ${ENDS_AT} ${comparison} $2`, params: [now], order: scope === 'upcoming' ? 'ASC' : 'DESC' };
}

/**
 * One page of the viewer's meetings. Upcoming is soonest first; past and cancelled are latest first.
 * `before` is the previous page's `nextBefore`: the start of the last meeting it listed, which the
 * next page continues after in its own order. Meetings at the same instant are never split across
 * two pages, so a page can hold a few more than `limit`.
 */
export async function listMeetings(
  userId: string,
  opts: { scope: MeetingScope; limit: number; before?: string },
  now = new Date(),
): Promise<MeetingList> {
  const { where, params: scopeParams, order } = scopeOf(opts.scope, now);
  const params: unknown[] = [userId, ...scopeParams];
  let filter = `AND ${where}`;
  if (opts.before) {
    params.push(new Date(opts.before));
    filter += ` AND m.start_at ${order === 'ASC' ? '>' : '<'} $${params.length}`;
  }
  params.push(opts.limit + 1);
  const ordered = `ORDER BY m.start_at ${order}, m.id ${order}`;
  const found = await query<MeetingRow>(`${SELECT_MEETINGS} ${filter} ${ordered} LIMIT $${params.length}`, params);

  if (found.rows.length <= opts.limit) {
    return { items: found.rows.map((r) => toMeeting(r, userId, now)), nextBefore: null };
  }
  let page = found.rows.slice(0, opts.limit);
  const edge = page[page.length - 1].start_at;
  if (found.rows[opts.limit].start_at.getTime() === edge.getTime()) {
    const tiedParams = [userId, ...scopeParams, edge, page.map((r) => r.id)];
    const tied = await query<MeetingRow>(
      `${SELECT_MEETINGS} AND ${where} AND m.start_at = $${tiedParams.length - 1} AND NOT (m.id = ANY($${tiedParams.length})) ${ordered} LIMIT ${MAX_TIED}`,
      tiedParams,
    );
    page = [...page, ...tied.rows];
  }
  return { items: page.map((r) => toMeeting(r, userId, now)), nextBefore: edge.toISOString() };
}

/**
 * The count on Events: how many of the viewer's meetings are still to come, whether one can be joined
 * right now (from 5 minutes before its start), and which is next. One read: the window functions
 * count the whole list before LIMIT takes its first row.
 */
export async function getMeetingSummary(userId: string, now = new Date()): Promise<MeetingSummary> {
  const found = await query<{
    id: string; start_at: Date; partner_name: string | null; partner_status: string; upcoming_count: number; live_now: boolean;
  }>(
    `SELECT m.id, m.start_at, p.display_name AS partner_name, p.status AS partner_status,
            CAST(count(*) OVER () AS int) AS upcoming_count,
            bool_or(m.start_at <= $2::timestamptz + INTERVAL '5 minutes') OVER () AS live_now
     ${VIEWERS_MEETINGS}
       AND m.status = 'scheduled' AND ${ENDS_AT} >= $2
     ORDER BY m.start_at ASC, m.id ASC
     LIMIT 1`,
    [userId, now],
  );
  const next = found.rows[0];
  if (!next) return { upcomingCount: 0, liveNow: false, next: null };
  return {
    upcomingCount: next.upcoming_count,
    liveNow: next.live_now,
    next: { id: next.id, startAt: next.start_at.toISOString(), partnerName: partnerName(next) },
  };
}

/** One of the viewer's meetings, or not found: someone else's and a blocked pair's read the same. */
async function loadVisible(userId: string, meetingId: string): Promise<MeetingRow> {
  const found = await query<MeetingRow>(`${SELECT_MEETINGS} AND m.id = $2`, [userId, meetingId]);
  if (!found.rows[0]) throw new NotFoundError('Meeting', undefined, "We couldn't find that meeting.");
  return found.rows[0];
}

export async function getMeeting(userId: string, meetingId: string, now = new Date()): Promise<Meeting> {
  return toMeeting(await loadVisible(userId, meetingId), userId, now);
}

type CancelOutcome =
  | { won: false; row: MeetingRow }
  | { won: true; row: MeetingRow; card: Awaited<ReturnType<typeof dmService.insertDirectMessageOn>> };

/** An instant as the thread writes it, so every client renders it in its reader's own time. */
const threadInstant = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The refusal for a meeting that has started: still under way, or ended (its grace period included). */
function tooLateToCancel(meeting: { start_at: Date; duration_min: number }, now: Date): ConflictError {
  const endsAt = meeting.start_at.getTime() + meeting.duration_min * 60_000;
  return now.getTime() < endsAt
    ? new ConflictError(ErrorCodes.MEETING_ALREADY_STARTED, 'This meeting has already started, so it can no longer be cancelled.')
    : new ConflictError(ErrorCodes.MEETING_ALREADY_ENDED, 'This meeting has already ended.');
}

/**
 * Cancel a meeting, once. In one transaction, with the conversation row locked first (the order
 * every booking and move takes, so a cancel and a move of the same meeting settle in turn):
 *   - the row is claimed only while it is scheduled and has not started;
 *   - the conversation's meeting_* columns are cleared, so production's banner and Join go away;
 *   - the time is taken off the canceller's own list, so a later save cannot book it again;
 *   - a "Meeting cancelled" card goes into the thread.
 * Then the other person's bell, both people's screens, and a cancellation email to each.
 * A meeting already cancelled answers as it stands and repeats nothing; one that has started is a
 * 409, which says whether it is under way or has ended.
 *
 * 26 Oct 2026: it was claimable until 30 minutes after its end (the time it can still be joined), so
 * a meeting that had been held could be cancelled afterwards, emailing both people a cancellation.
 */
export async function cancelMeeting(userId: string, meetingId: string, now = new Date()): Promise<Meeting> {
  const found = await loadVisible(userId, meetingId);
  const partnerId = found.user_a_id === userId ? found.user_b_id : found.user_a_id;

  const outcome = await transaction<CancelOutcome>(async (client) => {
    // The pointer through its guard: a row the old server left it naming (current-meeting.ts) is not
    // the conversation's meeting, so cancelling that row leaves the conversation's meeting standing.
    const conv = await client.query<{ meeting_confirmed_window: string | null; current_meeting_id: string | null }>(
      `SELECT meeting_confirmed_window, ${CURRENT_MEETING_ID} FROM dm_conversations WHERE id = $1 FOR UPDATE`,
      [found.conversation_id],
    );
    const claimed = await client.query<MeetingRow>(
      `UPDATE meetings
          SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(),
              calendar_sequence = calendar_sequence + 1, updated_at = NOW()
        WHERE id = $1 AND status = 'scheduled' AND start_at > $3
        RETURNING ${OWN_COLUMNS}`,
      [meetingId, userId, now],
    );
    if (!claimed.rows[0]) {
      const current = await client.query<MeetingRow>(`SELECT ${OWN_COLUMNS} FROM meetings WHERE id = $1`, [meetingId]);
      if (!current.rows[0]) throw new NotFoundError('Meeting', undefined, "We couldn't find that meeting.");
      const row = { ...found, ...current.rows[0] };
      if (row.status === 'cancelled') return { won: false, row };
      throw tooLateToCancel(row, now);
    }
    const row = { ...found, ...claimed.rows[0] };

    const standing = conv.rows[0];
    if (standing?.current_meeting_id === meetingId) {
      await client.query(
        `UPDATE dm_conversations
            SET meeting_confirmed_window = NULL, meeting_confirmed_by = NULL, meeting_confirmed_at = NULL,
                meeting_start_at = NULL, meeting_duration_min = NULL, meeting_type = NULL, current_meeting_id = NULL
          WHERE id = $1 AND current_meeting_id = $2`,
        [row.conversation_id, meetingId],
      );
      if (standing.meeting_confirmed_window) {
        await client.query(
          `DELETE FROM meeting_availability WHERE conversation_id = $1 AND user_id = $2 AND window_key = $3`,
          [row.conversation_id, userId, standing.meeting_confirmed_window],
        );
      }
    }

    const card = await dmService.insertDirectMessageOn(
      client, userId, partnerId, `📅 Meeting cancelled: ${threadInstant(row.start_at)}`, null,
      {
        kind: 'system',
        systemMeta: {
          type: 'meeting_cancelled', meetingId, startAt: row.start_at.toISOString(),
          durationMin: row.duration_min, meetingType: row.kind,
        },
      },
    );
    return { won: true, row, card };
  });

  if (outcome.won) await announceCancellation(outcome.row, userId, partnerId, outcome.card);
  return toMeeting(outcome.row, userId, now);
}

/**
 * After a cancel has committed: the card reaches both screens, the other person's bell rings, both
 * people's lists and the meeting's page redraw, and each is emailed a calendar file that removes the
 * entry. Every step is best-effort: the meeting is already cancelled.
 */
async function announceCancellation(
  meeting: MeetingRow,
  actorId: string,
  partnerId: string,
  card: Awaited<ReturnType<typeof dmService.insertDirectMessageOn>>,
): Promise<void> {
  const conversationId = meeting.conversation_id;
  let people: Array<{ id: string; display_name: string | null; email: string | null; timezone: string | null }> = [];
  try {
    people = (await query<{ id: string; display_name: string | null; email: string | null; timezone: string | null }>(
      `SELECT id, display_name, email, timezone FROM users WHERE id = ANY($1)`,
      [[actorId, partnerId]],
    )).rows;
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'cancel: people lookup failed, bell in UTC and no emails (non-fatal)');
  }
  const byId = new Map(people.map((p) => [p.id, p]));
  const actorName = byId.get(actorId)?.display_name || 'Someone';

  let io: SocketServer | null = null;
  try {
    io = (await import('../../index')).io;
    const { broadcastDmMessage } = await import('../orchestration/handlers/dm-handlers');
    await broadcastDmMessage(io, actorId, partnerId, conversationId, card.message, { notify: false });
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'cancel card broadcast failed (the card itself is stored)');
  }

  // The person who cancelled knows; the other is told, in their own time.
  try {
    const t = meetingTime(meeting.start_at, byId.get(partnerId)?.timezone);
    const title = `${actorName} cancelled your meeting on ${t.short} ${t.zone}`;
    const body = 'Open the chat to pick a new time.';
    const link = `/messages/${conversationId}`;
    const bell = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id, created_at`,
      [partnerId, 'meeting_cancelled', title, body, link],
    );
    io?.to(`user:${partnerId}`).emit('notification:new', {
      id: bell.rows[0].id, type: 'meeting_cancelled', title, body, link, isRead: false, createdAt: bell.rows[0].created_at,
    });
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'meeting-cancelled bell failed (non-fatal)');
  }

  try {
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await emitEntities(io, [actorId, partnerId], [E.dmConversation(conversationId), E.userDms(actorId), E.userDms(partnerId)]);
    await emitEntities(io, [partnerId], [E.userNotifications(partnerId)]);
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'cancel entity emit failed (non-fatal)');
  }
  await emitMeetingChanged(meeting.id, [actorId, partnerId]);

  try {
    const { generateIcsContent, meetingCalendarUid } = await import('../calendar/calendar.service');
    const { sendMeetingCancelledEmail } = await import('../email/email.service');
    // The same organizer the invite and its updates named: whoever booked the meeting first.
    const organizer = meeting.confirmed_by ? byId.get(meeting.confirmed_by) : undefined;
    for (const recipientId of [actorId, partnerId]) {
      const me = byId.get(recipientId);
      if (!me?.email) continue;
      const other = byId.get(recipientId === actorId ? partnerId : actorId);
      const ics = generateIcsContent({
        title: 'REASON meeting',
        description: `A 1:1 meeting arranged on REASON with ${other?.display_name || 'your match'}. Cancelled.`,
        startTime: meeting.start_at,
        durationMinutes: meeting.duration_min,
        location: `${config.clientUrl}${meetingJoinPath(conversationId, meeting.kind)}`,
        uid: meetingCalendarUid(meeting.id),
        sequence: meeting.calendar_sequence,
        method: 'CANCEL',
        organizerName: organizer?.display_name || 'REASON',
        organizerEmail: organizer?.email || undefined,
        attendees: people.filter((p) => p.email).map((p) => ({ name: p.display_name || undefined, email: p.email! })),
      });
      void sendMeetingCancelledEmail(me.email, me.display_name || 'there', {
        partnerName: other?.display_name || 'your match',
        cancellerName: actorName,
        cancelledByMe: recipientId === actorId,
        startAt: meeting.start_at,
        durationMin: meeting.duration_min,
        kind: meeting.kind,
        recipientTimezone: me.timezone,
        threadUrl: `${config.clientUrl}/messages/${conversationId}`,
        icsContent: ics,
      }).catch((err) => logger.warn({ err, recipientId }, 'meeting-cancelled email failed (non-fatal)'));
    }
  } catch (err) {
    logger.warn({ err, meetingId: meeting.id }, 'meeting-cancelled email dispatch failed (non-fatal)');
  }
}

/**
 * One side entered the meeting's room inside its window (the call service decides the window).
 * Stamped once, on the caller's transaction; true only the first time, so the screens are told once.
 */
export async function stampAttendance(client: PoolClient, meetingId: string, side: 'a' | 'b'): Promise<boolean> {
  const column = side === 'a' ? 'joined_a_at' : 'joined_b_at';
  const stamped = await client.query(
    `UPDATE meetings SET ${column} = NOW() WHERE id = $1 AND ${column} IS NULL AND status = 'scheduled' RETURNING id`,
    [meetingId],
  );
  return stamped.rows.length > 0;
}
