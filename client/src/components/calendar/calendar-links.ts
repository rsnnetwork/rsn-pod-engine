// What "Add to calendar" offers (1 Nov 2026, T7, L10): Google Calendar and Outlook.com template links, and a .ics
// file for Apple Calendar or any other. Pure on purpose (no axios, store or router), so a test can run it:
// server/src/__tests__/client/t7-add-to-calendar.test.ts. The links are built from the page's own data and this
// site's address, so an entry made on the preview joins on the preview.

/** One calendar entry: a title, its start and end (written in UTC), details with the join link, and where. */
export interface CalendarEntry {
  title: string;
  start: Date;
  end: Date;
  details: string;
  /** The join link for a call, the place for an event held in person. */
  location?: string;
}

export interface CalendarLinks {
  google: string;
  outlook: string;
}

const MINUTE = 60_000;

/** A 1:1 meeting: "Meeting with {name} on REASON", "{Video|Audio} call on REASON. Join: {url}", the join link as where. */
export function meetingEntry(meeting: {
  partnerName: string;
  kind: 'audio' | 'video';
  startAt: string;
  durationMin: number;
  joinUrl: string;
}): CalendarEntry {
  const start = new Date(meeting.startAt);
  return {
    title: `Meeting with ${meeting.partnerName} on REASON`,
    start,
    end: new Date(start.getTime() + meeting.durationMin * MINUTE),
    details: `${meeting.kind === 'audio' ? 'Audio' : 'Video'} call on REASON. Join: ${meeting.joinUrl}`,
    location: meeting.joinUrl,
  };
}

/** An event: its title on REASON, its length, and the event page to join from. `place` is set for an in-person event. */
export function eventEntry(event: {
  title: string;
  startAt: string;
  durationMin: number;
  pageUrl: string;
  place?: string | null;
}): CalendarEntry {
  const start = new Date(event.startAt);
  return {
    title: `${event.title} on REASON`,
    start,
    end: new Date(start.getTime() + event.durationMin * MINUTE),
    details: `An event on REASON. Join: ${event.pageUrl}`,
    location: event.place?.trim() || event.pageUrl,
  };
}

/** "20261105T170000Z": the compact UTC form Google and calendar files use. */
export function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** "2026-11-05T17:00:00Z": the UTC instant Outlook.com takes. */
function isoUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function calendarLinks(entry: CalendarEntry): CalendarLinks {
  const google = new URLSearchParams({
    action: 'TEMPLATE',
    text: entry.title,
    dates: `${compactUtc(entry.start)}/${compactUtc(entry.end)}`,
    details: entry.details,
  });
  const outlook = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: entry.title,
    startdt: isoUtc(entry.start),
    enddt: isoUtc(entry.end),
    body: entry.details,
  });
  if (entry.location) {
    google.set('location', entry.location);
    outlook.set('location', entry.location);
  }
  return {
    google: `https://calendar.google.com/calendar/render?${google.toString()}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${outlook.toString()}`,
  };
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545: a line over 75 octets is folded (CRLF and a space), counted in UTF-8 bytes. */
function fold(line: string): string {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(line) <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74;
    if (bytes(current + ch) > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * A calendar file for an entry the app builds itself (an event: no route hands its file out in the app). It is a
 * PUBLISH with a stable UID, so adding it twice updates one entry; it names no organizer or guests, so a calendar
 * offers to add it rather than to answer it.
 */
export function icsFile(entry: CalendarEntry, uid: string, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//REASON//Add to calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@rsn.network`,
    `DTSTAMP:${compactUtc(now)}`,
    `DTSTART:${compactUtc(entry.start)}`,
    `DTEND:${compactUtc(entry.end)}`,
    `SUMMARY:${escapeText(entry.title)}`,
    `DESCRIPTION:${escapeText(entry.details)}`,
    ...(entry.location ? [`LOCATION:${escapeText(entry.location)}`] : []),
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
