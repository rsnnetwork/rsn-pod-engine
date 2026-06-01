// ─── Calendar Service ────────────────────────────────────────────────────────
// Generates .ics (iCalendar) content for event invites.
// Works with Google Calendar, Outlook, Apple Calendar — no API keys needed.

import { v4 as uuid } from 'uuid';

interface CalendarEventData {
  title: string;
  description?: string;
  startTime: Date;
  durationMinutes: number;
  organizerName?: string;
  organizerEmail?: string;
  location?: string;
}

/**
 * Generate a .ics file content string for a calendar event.
 */
export function generateIcsContent(data: CalendarEventData): string {
  const start = formatIcsDate(data.startTime);
  const end = formatIcsDate(new Date(data.startTime.getTime() + data.durationMinutes * 60 * 1000));
  const now = formatIcsDate(new Date());
  const uid = `${uuid()}@rsn.network`;

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

  lines.push(
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

  return lines.join('\r\n');
}

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
