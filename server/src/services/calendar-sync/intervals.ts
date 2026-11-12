// ─── Busy intervals: merge, clip, and all-day days on the viewer's clock (Shirley pilot S8, D7) ─────────────────────────
// Pure. Every instant is UTC milliseconds; what leaves here is ISO strings in UTC ("2026-11-12T09:00:00.000Z").
// Nothing here ever sees an event's title, attendees or place: only when.

import type { CalendarBusyInterval } from '@rsn/shared';

export interface Span { start: number; end: number }

/** At most this many intervals are ever kept for one answer (a pathological calendar cannot balloon a response). */
export const MAX_INTERVALS = 2000;

/** Spans clipped to [from, to), empty ones dropped, overlapping and touching ones merged, earliest first. */
export function mergeSpans(spans: readonly Span[], from: number, to: number): Span[] {
  const clipped = spans
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of clipped) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out.slice(0, MAX_INTERVALS);
}

export const toIntervals = (spans: readonly Span[]): CalendarBusyInterval[] =>
  spans.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));

export const fromIntervals = (intervals: readonly CalendarBusyInterval[]): Span[] =>
  intervals.map((i) => ({ start: Date.parse(i.start), end: Date.parse(i.end) }));

/** A zone this runtime can draw a clock in. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function zoneOffset(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant a calendar day (YYYY-MM-DD) begins in the zone: its midnight, or its first minute after a DST gap. */
export function zonedMidnight(day: string, zone: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(first, zone);
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * An all-day stretch as the viewer lives it: from the start of its first day to the start of the day after its last,
 * on the viewer's clock. A provider writes an all-day event as midnight to midnight, either as a floating date or
 * converted to UTC from the calendar's own zone (which can land on the evening before); the day is read as the
 * nearest date to the instant (so any offset up to twelve hours reads the right day) and its length as whole days.
 */
export function allDaySpan(startMs: number, endMs: number, zone: string): Span | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const days = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
  const firstDay = isoDay(startMs + DAY_MS / 2);
  const afterLast = isoDay(Date.parse(`${firstDay}T00:00:00Z`) + days * DAY_MS);
  return { start: zonedMidnight(firstDay, zone), end: zonedMidnight(afterLast, zone) };
}
