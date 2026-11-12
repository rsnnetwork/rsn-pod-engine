// ─── Calendar Service ────────────────────────────────────────────────────────
// Generates .ics (iCalendar) content for event invites.
// Works with Google Calendar, Outlook, Apple Calendar — no API keys needed.

import { v4 as uuid } from 'uuid';
import { eventDurationMinutes } from '@rsn/shared';
import { eventDurationOf, eventPlaceOf } from '../session/event-duration';
import { query } from '../../db';
import { eventImageColumns, eventImageUrlOf } from '../session/event-image-url';

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
  /** RFC 5545 SEQUENCE: a calendar applies a file for an entry it holds only when this is higher (26 Oct
   *  2026). A meeting starts at 0 and goes one up on each move and on cancel. Default 0. */
  sequence?: number;
  /** REQUEST (the default) adds or updates the entry; CANCEL removes the entry with the same UID. */
  method?: 'REQUEST' | 'CANCEL';
}

/**
 * One meeting's calendar identity, the same in every copy of its file: both emails, every move, the
 * cancellation and the in-app "Add to calendar". Built from the meeting's own id, never its time, so a
 * moved meeting updates the entry already in each calendar instead of adding a second one (26 Oct 2026).
 * generateIcsContent adds the @rsn.network.
 */
export function meetingCalendarUid(meetingId: string): string {
  return `meeting-${meetingId}`;
}

/**
 * Generate a .ics file content string for a calendar event.
 */
export function generateIcsContent(data: CalendarEventData): string {
  const start = formatIcsDate(data.startTime);
  const end = formatIcsDate(new Date(data.startTime.getTime() + data.durationMinutes * 60 * 1000));
  const now = formatIcsDate(new Date());
  const uid = `${data.uid ?? uuid()}@rsn.network`;
  const cancelling = data.method === 'CANCEL';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RSN//Pod Engine//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelling ? 'CANCEL' : 'REQUEST'}`,
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
    // A cancellation asks nobody for an answer.
    const answer = cancelling ? '' : ';PARTSTAT=NEEDS-ACTION;RSVP=TRUE';
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT${answer}:mailto:${a.email}`);
  }

  lines.push(`SEQUENCE:${data.sequence ?? 0}`);
  if (cancelling) {
    lines.push('STATUS:CANCELLED', 'TRANSP:TRANSPARENT');
  } else {
    lines.push(
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Event starting in 15 minutes',
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');

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
  /** Where an in-person event happens (30 Oct 2026); absent for an event online. */
  place?: string;
  /**
   * The event's own zone (Part 3 Task 1, K1): the emails write its time on this clock, named. The calendar file and
   * links stay UTC instants, which every calendar shows in its own zone.
   */
  timezone?: string | null;
  /** The event's image (Part 3 Task 1), for the head of its emails; null when it has none. */
  imageUrl?: string | null;
}

/**
 * What an event's emailed calendar file and its calendar links say (30 Oct 2026). An in-person event's place is
 * where it is (LOCATION, and the links' location), and its page goes into the description. An event online keeps
 * its page as where, exactly as before, and gets no links here (its emails stay as they were).
 */
export function eventCalendarEntry(
  event: SessionCalendarEvent,
  clientUrl: string,
): { description: string; location?: string; links?: CalendarLinks } {
  const page = event.sessionId ? `${clientUrl}/sessions/${event.sessionId}` : undefined;
  const base = event.description || `REASON event — ${event.title}`;
  if (!event.place) return { description: base, location: page };
  const description = page ? `${base}. Event page: ${page}` : base;
  const links = buildCalendarLinks({
    title: event.title,
    start: event.startTime,
    end: new Date(event.startTime.getTime() + event.durationMinutes * 60 * 1000),
    details: description,
    location: event.place,
  });
  return { description, location: event.place, links };
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
  const r = await query<{
    title: string; scheduled_at: string | null; host_user_id: string; config: any; event_format?: string | null;
    timezone: string | null; has_image: boolean | null; image_updated_at: Date | null;
  }>(
    `SELECT title, scheduled_at, host_user_id, config, event_format, timezone, ${eventImageColumns('sessions')}
       FROM sessions WHERE id = $1`,
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
    durationMinutes: eventDurationOf(session),
    organizerName: host?.display_name || 'REASON',
    organizerEmail: host?.email,
    sessionId,
    place: eventPlaceOf(session),
    timezone: session.timezone,
    imageUrl: eventImageUrlOf(sessionId, session),
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
  return googleTemplateUrl({
    title: data.title,
    start: data.startTime,
    end: new Date(data.startTime.getTime() + data.durationMinutes * 60 * 1000),
    details: data.description,
    location: data.location,
  });
}

/**
 * What an "Add to calendar" link carries (1 Nov 2026, L10): the entry's title, its start and end (written in UTC),
 * the details (with the join link), and where: the join link for a call, the place for an in-person event.
 */
export interface CalendarLinkInput {
  title: string;
  start: Date;
  end: Date;
  details?: string;
  location?: string;
}

/** The two template links REASON offers beside the .ics file. */
export interface CalendarLinks {
  google: string;
  outlook: string;
}

/**
 * Google Calendar's and Outlook.com's "new entry" pages, filled in. No sign-in or API key: the person saves the entry
 * in their own calendar. A template link carries no UID, so a move or a cancel does not reach the entry it makes;
 * the emailed invite and the file do.
 */
export function buildCalendarLinks(input: CalendarLinkInput): CalendarLinks {
  return { google: googleTemplateUrl(input), outlook: outlookComposeUrl(input) };
}

/** Times in the compact UTC form Google expects; Google shows them in the viewer's own zone. */
function googleTemplateUrl(input: CalendarLinkInput): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.title,
    dates: `${formatIcsDate(input.start)}/${formatIcsDate(input.end)}`,
  });
  if (input.details) params.set('details', input.details);
  if (input.location) params.set('location', input.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook.com (personal accounts). Times as UTC ISO instants, which Outlook shows in the viewer's own zone. */
function outlookComposeUrl(input: CalendarLinkInput): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: input.title,
    startdt: formatIsoInstant(input.start),
    enddt: formatIsoInstant(input.end),
  });
  if (input.details) params.set('body', input.details);
  if (input.location) params.set('location', input.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function formatIsoInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
