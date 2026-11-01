// ─── A 1:1 meeting as a calendar file, for "Add to calendar" in the app ──────
//
// One builder for both routes that hand the file out: production's GET /dm/conversations/:id/meeting.ics (the
// conversation's current meeting) and, since 1 Nov 2026 (T7), GET /api/meetings/:id/calendar.ics (one meeting, so
// a thread card for an earlier meeting adds that meeting). The file has the identity, SEQUENCE and organizer of the
// emailed invite (26 Oct 2026), so adding it updates the entry the email made instead of adding a second one.

import type { MeetingKind } from '@rsn/shared';
import { query } from '../../db';
import config from '../../config';
import { generateIcsContent, meetingCalendarUid } from '../calendar/calendar.service';
import { meetingJoinPath } from '../dm/meeting-windows.service';

/** The headers the file is sent with: a calendar invite, saved as reason-meeting.ics. */
export const MEETING_FILE_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8; method=REQUEST',
  'Content-Disposition': 'attachment; filename="reason-meeting.ics"',
} as const;

export interface MeetingFileInput {
  conversationId: string;
  viewerId: string;
  partnerId: string;
  kind: MeetingKind;
  startAt: Date;
  durationMin: number;
  /** The meeting's row. Null for a meeting the old server booked without one: the file then has no fixed identity. */
  meetingId: string | null;
  /** The row's SEQUENCE and booker, when the caller has read them already; otherwise they are read here. */
  booked?: { calendarSequence: number; confirmedBy: string | null };
}

export async function buildMeetingFile(input: MeetingFileInput): Promise<string> {
  const people = await query<{ id: string; display_name: string | null; email: string | null }>(
    `SELECT id, display_name, email FROM users WHERE id = ANY($1)`,
    [[input.viewerId, input.partnerId]],
  );
  const other = people.rows.find((p) => p.id === input.partnerId);
  const booked = input.booked ?? (input.meetingId ? await readBooking(input.meetingId) : undefined);
  const organizer = booked?.confirmedBy ? people.rows.find((p) => p.id === booked.confirmedBy) : undefined;
  return generateIcsContent({
    title: 'REASON meeting',
    description: `A 1:1 ${input.kind} call on REASON with ${other?.display_name || 'your match'}. Join: ${config.clientUrl}${meetingJoinPath(input.conversationId, input.kind)}`,
    startTime: input.startAt,
    durationMinutes: input.durationMin,
    ...(input.meetingId ? { uid: meetingCalendarUid(input.meetingId), sequence: booked?.calendarSequence ?? 0 } : {}),
    ...(organizer?.email ? { organizerName: organizer.display_name || 'REASON', organizerEmail: organizer.email } : {}),
    attendees: people.rows.filter((p) => p.email).map((p) => ({ name: p.display_name || undefined, email: p.email! })),
  });
}

async function readBooking(meetingId: string): Promise<{ calendarSequence: number; confirmedBy: string | null } | undefined> {
  const found = await query<{ calendar_sequence: number; confirmed_by: string | null }>(
    `SELECT calendar_sequence, confirmed_by FROM meetings WHERE id = $1`, [meetingId],
  );
  const row = found.rows[0];
  return row ? { calendarSequence: row.calendar_sequence, confirmedBy: row.confirmed_by } : undefined;
}
