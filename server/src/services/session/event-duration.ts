// ─── How long an event lasts, read from its row (26 Oct 2026, H2b item 12) ─────────────────────────────────
//
// The invite email's calendar entry, a reminder's and the calendar feed each need the event's length. It is the shared
// eventDurationMinutes of the event's format (a meeting's set length, or the rounds estimate), and the format is the
// row's column when the row has one, else what the config implies (an older event). Written once here; it used to be
// the same two calls in three files. An in-person event's place is read here too (eventPlaceOf).

import { eventDurationMinutes, liveKindOf, resolveEventFormat, type SessionConfig } from '@rsn/shared';

/** A session row as the services read it: the format column (an older row may lack it) and the config (JSON or text). */
export interface EventRowForDuration {
  event_format?: string | null;
  config: unknown;
}

/** The row's config as an object: parsed when stored as text, the format's defaults when it is not an object. */
function configOf(stored: unknown): SessionConfig {
  let value = stored;
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored);
    } catch {
      value = null;
    }
  }
  return (value && typeof value === 'object' ? value : {}) as SessionConfig;
}

/** Minutes the event lasts, from its row. */
export function eventDurationOf(row: EventRowForDuration): number {
  const config = configOf(row.config);
  return eventDurationMinutes(resolveEventFormat({ format: row.event_format, config }), config);
}

/**
 * Where the event happens, from its row: an in-person event's place (30 Oct 2026), else undefined (an event online,
 * whose calendar entry and emails point at its page instead).
 */
export function eventPlaceOf(row: EventRowForDuration): string | undefined {
  const config = configOf(row.config);
  if (liveKindOf(resolveEventFormat({ format: row.event_format, config })) !== 'none') return undefined;
  const place = typeof config.location === 'string' ? config.location.trim() : '';
  return place || undefined;
}
