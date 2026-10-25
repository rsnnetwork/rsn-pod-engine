// ─── Calendar Service ────────────────────────────────────────────────────────
// Generates .ics (iCalendar) content for event invites.
// Works with Google Calendar, Outlook, Apple Calendar — no API keys needed.

import { v4 as uuid } from 'uuid';
import { eventDurationMinutes, resolveEventFormat } from '@rsn/shared';
import { query } from '../../db';

interface CalendarEventData {
  title: string;
  description?: string;
  startTime: Date;
  durationMinutes: number;
  organizerName?: string;
  organizerEmail?: string;
  location?: string;
  /** Invitees — emitting ATTENDEE lines makes Gmail/Outlook render this as a
   *  real invite with RSVP, not just an "add to calendar" file. */
  attendees?: Array<{ name?: string; email: string }>;
  /** Stable identity for this meeting across every copy of the file (both
   *  emails and the in-app download). A random UID per generation made each
   *  copy a NEW event, so accepting the invite and then pressing "Add to
   *  calendar" left two entries, and a later reschedule could never update
   *  the first. Pass something derived from the meeting itself. */
  uid?: string;
}

/**
 * Generate a .ics file content string for a calendar event.
 */
export function generateIcsContent(data: CalendarEventData): string {
  const start = formatIcsDate(data.startTime);
  const end = formatIcsDate(new Date(data.startTime.getTime() + data.durationMinutes * 60 * 1000));
  const now = formatIcsDate(new Date());
  const uid = `${data.uid ?? uuid()}@rsn.network`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RSN//Pod Engine//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(data.title)}`,
  ];

  if (data.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(data.description)}`);
  }

  if (data.location) {
    lines.push(`LOCATION:${escapeIcsText(data.location)}`);
  }

  if (data.organizerName && data.organizerEmail) {
    lines.push(`ORGANIZER;CN=${escapeIcsText(data.organizerName)}:mailto:${data.organizerEmail}`);
  }

  for (const a of data.attendees ?? []) {
    if (!a.email) continue;
    const cn = a.name ? `;CN=${escapeIcsText(a.name)}` : '';
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`);
  }

  lines.push(
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Event starting in 15 minutes',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  );

  // RFC 5545 §3.1: lines longer than 75 octets must be folded (CRLF + space).
  // Outlook/Apple reject or truncate an unfolded long DESCRIPTION.
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function foldIcsLine(line: string): string {
  const MAX = 75;
  if (Buffer.byteLength(line, 'utf8') <= MAX) return line;
  const out: string[] = [];
  let current = '';
  for (const ch of line) {
    // Fold before the octet limit; continuation lines start with a space and
    // count that space against the limit.
    const limit = out.length === 0 ? MAX : MAX - 1;
    if (Buffer.byteLength(current + ch, 'utf8') > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

export interface SessionCalendarEvent {
  title: string;
  description?: string;
  startTime: Date;
  durationMinutes: number;
  organizerName?: string;
  organizerEmail?: string;
  sessionId?: string;
}

/**
 * Estimate a speed-networking event's wall-clock duration in minutes from its round config:
 * rounds × (round + rating) + (rounds − 1) transitions + closing lobby. Since 26 Oct 2026 this is the
 * speed-networking case of the shared eventDurationMinutes, the one formula every calendar entry, invite
 * email and LiveKit token lifetime uses.
 */
export function computeSessionDurationMinutes(cfg: object | null | undefined): number {
  return eventDurationMinutes('speed_networking', cfg);
}

/**
 * Build a calendar-event payload for a scheduled session (title, start time,
 * estimated duration, organizer = host). Returns undefined when the session has
 * no scheduled time (nothing to put on a calendar) or does not exist. Used by
 * the self-registration confirmation email.
 */
export async function buildSessionCalendarEvent(sessionId: string): Promise<SessionCalendarEvent | undefined> {
  const r = await query<{ title: string; scheduled_at: string | null; host_user_id: string; config: any; event_format?: string | null }>(
    'SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions WHERE id = $1',
    [sessionId],
  );
  const session = r.rows[0];
  if (!session || !session.scheduled_at) return undefined;

  const host = (await query<{ display_name: string; email: string }>(
    'SELECT display_name, email FROM users WHERE id = $1',
    [session.host_user_id],
  )).rows[0];

  return {
    title: session.title,
    description: `REASON event — ${session.title}`,
    startTime: new Date(session.scheduled_at),
    durationMinutes: eventDurationMinutes(resolveEventFormat({ format: session.event_format, config: session.config }), session.config),
    organizerName: host?.display_name || 'REASON',
    organizerEmail: host?.email,
    sessionId,
  };
}

/**
 * An "Add to Google Calendar" template URL — no OAuth, opens a prefilled event
 * the recipient can save in one click. Times are UTC (the Z-suffixed compact
 * form Google expects); Google renders them in the viewer's own timezone.
 */
export function buildGoogleCalendarUrl(data: {
  title: string;
  startTime: Date;
  durationMinutes: number;
  description?: string;
  location?: string;
}): string {
  const start = formatIcsDate(data.startTime);
  const end = formatIcsDate(new Date(data.startTime.getTime() + data.durationMinutes * 60 * 1000));
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: data.title,
    dates: `${start}/${end}`,
  });
  if (data.description) params.set('details', data.description);
  if (data.location) params.set('location', data.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
