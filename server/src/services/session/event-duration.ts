// ─── How long an event lasts, read from its row (26 Oct 2026, H2b item 12) ─────────────────────────────────
//
// The invite email's calendar entry, a reminder's and the calendar feed each need the event's length. It is the shared
// eventDurationMinutes of the event's format (a meeting's set length, or the rounds estimate), and the format is the
// row's column when the row has one, else what the config implies (an older event). Written once here; it used to be
// the same two calls in three files.

import { eventDurationMinutes, resolveEventFormat, type SessionConfig } from '@rsn/shared';

/** A session row as the services read it: the format column (an older row may lack it) and the config (JSON or text). */
export interface EventRowForDuration {
  event_format?: string | null;
  config: unknown;
}

/** Minutes the event lasts, from its row. */
export function eventDurationOf(row: EventRowForDuration): number {
  const config = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config ?? {}) as SessionConfig;
  return eventDurationMinutes(resolveEventFormat({ format: row.event_format, config }), config);
}
