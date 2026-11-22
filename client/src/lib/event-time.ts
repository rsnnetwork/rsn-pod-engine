// client/src/lib/event-time.ts
// An event's time on screen (10 Nov 2026 spec, Part 3 item 1; plan K1). Every event has one IANA zone
// (`session.timezone`), and every place the client shows an event's time writes it on that zone's clock and names the
// zone, through the one shared module the server's bells and emails use (shared/src/events/event-time.ts). So an
// organiser in Karachi who sets up a Copenhagen evening, and a member reading it in New York, both read "14:00 (CET)".
//
// Thin wrappers only: what the screens need beyond the shared functions (the zone a new event starts on, a date tile,
// the form's zone). Pure (no React, store or router), so a server test runs it:
// server/src/__tests__/client/p3-event-time-image.test.ts.
//
// Not event times, and so still on the viewer's own clock: audit-history entries, chat times, invite created and
// expiry dates, 1:1 meetings.

import {
  FALLBACK_TIME_ZONE, canonicalTimeZone, eventZone, formatEventTime, utcToZonedWallTime, type EventTimeStyle,
} from '@rsn/shared';
import { browserTimeZone, currentZoneName } from '../features/onboarding/flow';

export {
  FALLBACK_TIME_ZONE, canonicalTimeZone, eventZone, formatEventTime, relativeEventTime, timeZoneLabel,
  utcToZonedWallTime, zonedWallTimeToUtc,
} from '@rsn/shared';
export type { EventTimeStyle } from '@rsn/shared';

/**
 * The zone a form holds for an event: the event's own when real (by today's name, so the zone list marks it), else
 * UTC, as every screen reads it.
 */
export function formZone(zone: string | null | undefined): string {
  return currentZoneName(eventZone(zone));
}

/** The zone a new event starts on: the organiser's own profile zone when real, else the browser's, else UTC. */
export function defaultEventZone(profileZone: string | null | undefined): string {
  const own = canonicalTimeZone(profileZone);
  if (own) return currentZoneName(own);
  return browserTimeZone() ?? FALLBACK_TIME_ZONE;
}

/**
 * An event's time as one line, on the event's clock with its zone named, or null when it has no date (or not a real
 * one). 'short' "Tue 1 Dec, 14:00 CET" for lists and cards; 'long' "Tuesday 1 December, 14:00 (CET)" for one event.
 */
export function eventWhen(at: string | Date | null | undefined, zone: string | null | undefined, style: EventTimeStyle = 'short'): string | null {
  if (!at) return null;
  const text = formatEventTime(at, zone, style);
  return text || null;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A calendar tile's month and day ("DEC", "01") on the event's clock: the event zone's day, never the viewer's. */
export function eventDateTile(at: string | Date, zone: string | null | undefined): { month: string; day: string } | null {
  const wall = utcToZonedWallTime(at, eventZone(zone));
  if (!wall) return null;
  return { month: MONTHS[Number(wall.slice(5, 7)) - 1] ?? '', day: wall.slice(8, 10) };
}
