// ─── An event's time, in the event's own zone (10 Nov 2026 spec, Part 3 item 1; plan K1) ─────────────────────────
//
// Every event has one IANA time zone (sessions.timezone). Every time an event shows, on a screen, in a bell or in an
// email, is written on that zone's clock and names the zone, so an organiser in Karachi who sets up a Copenhagen
// evening, a member reading it in New York and an email to someone whose own zone differs all read "14:00 (CET)".
// One module, used by the server and the client, so they never disagree.
//
// Pure: no DOM, no clock read unless a caller asks for one. Nothing here throws for a bad zone or a bad date: a zone
// Intl refuses reads as UTC (and says UTC), a date that is not one formats as ''.
//
// Zones are checked by the runtime itself (Intl.DateTimeFormat accepts them), never by membership of a list: Node's
// list omits "UTC" and "Asia/Kolkata" and lists "Asia/Calcutta", and browsers differ again. Two zones are never
// compared as strings for the same reason.

export const FALLBACK_TIME_ZONE = 'UTC';

const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const ZONE_MAX_LEN = 50;

let listed: readonly string[] | null = null;
function listedZones(): readonly string[] {
  if (!listed) {
    try {
      listed = Intl.supportedValuesOf('timeZone');
    } catch {
      // A runtime without the list still validates through DateTimeFormat.
      listed = [];
    }
  }
  return listed;
}

const canonicalCache = new Map<string, string | null>();
const CANONICAL_CACHE_MAX = 1000;

/**
 * The zone, spelled as the runtime spells it (its zone list, else Intl's own resolved name when that differs only in
 * case, else as given); null when it is not a real zone. Offsets ("+05:45") are refused even where the runtime
 * accepts them: they are not zones and do not follow summer time. Both spellings of a renamed zone
 * ("Asia/Kathmandu", "Asia/Katmandu") are real.
 */
export function canonicalTimeZone(input: string | null | undefined): string | null {
  const tz = (input ?? '').trim();
  // Every formatter asks this once per call, so the answer for a name is kept (fix round 1, M3): a list of events
  // formats in a handful of zones. Bounded: a stream of invented names cannot grow it without limit.
  const cached = canonicalCache.get(tz);
  if (cached !== undefined) return cached;
  const answer = canonicalTimeZoneUncached(tz);
  if (canonicalCache.size >= CANONICAL_CACHE_MAX) canonicalCache.clear();
  canonicalCache.set(tz, answer);
  return answer;
}

function canonicalTimeZoneUncached(tz: string): string | null {
  if (!tz || tz.length > ZONE_MAX_LEN || !IANA_SHAPE.test(tz)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  const lower = tz.toLowerCase();
  const onList = listedZones().find((z) => z.toLowerCase() === lower);
  if (onList) return onList;
  return resolved && resolved.toLowerCase() === lower ? resolved : tz;
}

/** The zone an event's times are written in: its own when real, else UTC. Every formatter goes through this. */
export function eventZone(zone: string | null | undefined): string {
  return canonicalTimeZone(zone) ?? FALLBACK_TIME_ZONE;
}

export type EventTimeStyle = 'long' | 'short' | 'day' | 'clock';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface WallClock {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function toDate(at: Date | string | number): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The wall clock of `zone` (already checked) at `at`. */
function wallClock(at: Date, zone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}

/** The zone's own short name at `at`: "CET", "CEST", "GMT+5", "UTC". */
function zoneName(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

/** How far `zone`'s clock is ahead of UTC at `at`, in milliseconds. */
function offsetMs(at: Date, zone: string): number {
  const w = wallClock(at, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * An event's time in its zone, named:
 *   'long'  "Tuesday 17 November, 14:00 (CET)"   emails, bells, the event page
 *   'short' "Tue 17 Nov, 14:00 CET"               cards, lists, the call landing
 *   'day'   "Tue 17 Nov 2026"                      date-only rows (a day has no clock, so no zone name)
 *   'clock' "14:00 CET"                            round starts
 * 24-hour, British order. `withZone: false` drops the zone name. A zone Intl refuses reads as UTC; '' for a date that
 * is not one.
 */
export function formatEventTime(
  at: Date | string, zone: string | null | undefined, style: EventTimeStyle = 'long', opts?: { withZone?: boolean },
): string {
  const date = toDate(at);
  if (!date) return '';
  const tz = eventZone(zone);
  const w = wallClock(date, tz);
  const withZone = opts?.withZone !== false;
  const name = withZone ? zoneName(date, tz) : '';
  // The weekday of the zone's calendar day, read from the day itself (never the runtime's own zone).
  const weekday = WEEKDAYS[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()];
  const clock = `${two(w.hour)}:${two(w.minute)}`;
  switch (style) {
    case 'short':
      return `${weekday.slice(0, 3)} ${w.day} ${MONTHS_SHORT[w.month - 1]}, ${clock}${withZone ? ` ${name}` : ''}`;
    case 'day':
      return `${weekday.slice(0, 3)} ${w.day} ${MONTHS_SHORT[w.month - 1]} ${w.year}`;
    case 'clock':
      return `${clock}${withZone ? ` ${name}` : ''}`;
    case 'long':
    default:
      return `${weekday} ${w.day} ${MONTHS_LONG[w.month - 1]}, ${clock}${withZone ? ` (${name})` : ''}`;
  }
}

/**
 * When an event starts, from `now`: "in 12 minutes", "in 1 hour", "in 3 hours", "today at 18:00 (CET)",
 * "tomorrow at 09:00 (CET)", else the long form. Today and tomorrow are the event zone's days, and the clock is the
 * event zone's. "now" once it has started.
 */
export function relativeEventTime(at: Date | string, now: Date | number, zone: string | null | undefined): string {
  const start = toDate(at);
  const from = toDate(now);
  if (!start || !from) return '';
  const minutes = Math.ceil((start.getTime() - from.getTime()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes <= 59) return minutes === 1 ? 'in 1 minute' : `in ${minutes} minutes`;
  if (minutes < 6 * 60) {
    const hours = Math.max(1, Math.round(minutes / 60));
    return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  }
  const tz = eventZone(zone);
  const s = wallClock(start, tz);
  const t = wallClock(from, tz);
  const dayGap = Math.round((Date.UTC(s.year, s.month - 1, s.day) - Date.UTC(t.year, t.month - 1, t.day)) / 86_400_000);
  const clock = `${two(s.hour)}:${two(s.minute)} (${zoneName(start, tz)})`;
  if (dayGap === 0) return `today at ${clock}`;
  if (dayGap === 1) return `tomorrow at ${clock}`;
  return formatEventTime(start, tz, 'long');
}

/**
 * A wall-clock time on `zone`'s clock ("2026-11-17T14:00", as a datetime-local input holds it; seconds allowed) as
 * an ISO UTC instant. A time the clocks skip (the spring-forward gap) is read with the offset before the change, so
 * it lands that much later on the new clock (02:30 reads as 03:30); a time that happens twice (the autumn overlap)
 * is the first of the two. null for a malformed time or a zone Intl refuses.
 */
export function zonedWallTimeToUtc(local: string, zone: string): string | null {
  const tz = canonicalTimeZone(zone);
  if (!tz) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((local ?? '').trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  const DAY = 86_400_000;
  const before = offsetMs(new Date(wall - DAY), tz);
  const after = offsetMs(new Date(wall + DAY), tz);
  const candidates = [wall - before, wall - after]
    .filter((t, i, all) => all.indexOf(t) === i)
    .filter((t) => offsetMs(new Date(t), tz) === wall - t)
    .sort((a, b) => a - b);
  // One candidate: an ordinary time. Two: the overlap, the earlier. None: the gap, read with the offset before it.
  const instant = candidates.length > 0 ? candidates[0] : wall - before;
  return new Date(instant).toISOString();
}

/** An instant as "YYYY-MM-DDTHH:mm" on `zone`'s clock (UTC for a zone Intl refuses), for a datetime-local input. '' for a date that is not one. */
export function utcToZonedWallTime(at: Date | string, zone: string): string {
  const date = toDate(at);
  if (!date) return '';
  const w = wallClock(date, eventZone(zone));
  return `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}`;
}

/** "GMT+1", "GMT+5:45", "GMT-3:30", "GMT". */
function gmtOffsetName(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total === 0) return 'GMT';
  const sign = total > 0 ? '+' : '-';
  const abs = Math.abs(total);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `GMT${sign}${hours}${minutes ? `:${two(minutes)}` : ''}`;
}

/**
 * A zone as the event form names it: "Europe/Copenhagen (CET, GMT+1)", "Asia/Karachi (GMT+5)", "UTC (GMT)". The
 * short name and the offset are those at `at` (now by default), so summer time shows as summer time.
 */
export function timeZoneLabel(zone: string, at: Date = new Date()): string {
  const tz = eventZone(zone);
  const when = toDate(at) ?? new Date();
  const names = [zoneName(when, tz), gmtOffsetName(offsetMs(when, tz))]
    .filter((n, i, all) => n !== tz && all.indexOf(n) === i);
  return names.length > 0 ? `${tz} (${names.join(', ')})` : tz;
}
