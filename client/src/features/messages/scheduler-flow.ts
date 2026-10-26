// client/src/features/messages/scheduler-flow.ts
// The scheduler's rules (26 Oct 2026). Pure on purpose (no React, axios, store, router or alias), so a test can run
// them: server/src/__tests__/client/scheduler-flow.test.ts.
//
// Every time is a 30-minute slot stored as a UTC instant ("2026-10-25T12:00:00Z"), so two people in different zones
// land on the same moment. A person sees that instant on their own clock, 24-hour, in the form the emails and bells
// use ("Sun 25 Oct, 13:00"), with the zone named on screen.

import { MEETING_GRACE_MIN } from '@rsn/shared';
import { CONNECTION_LOST, memberSentence } from '../reason/errors';

export const SLOT_MINUTES = 30;
const SLOT_MS = SLOT_MINUTES * 60_000;
const HOUR_MS = 3_600_000;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Written out, not asked of Intl: en-GB writes September as "Sept" in newer runtimes and not in older ones.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- words -------------------------------------------------------------------------------------------------------

export const SAVE_SENT = 'Sent. They can see when you are free.';
export const SAVE_OVERLAP = 'You can both meet. Confirm a time.';
export const ASK_SEND = 'Send your times?';
export const NOT_SHARED = 'That time is no longer free for both of you.';

// ---- slots -------------------------------------------------------------------------------------------------------

/** A concrete 30-minute slot, as opposed to a legacy day part ("2026-10-25:evening"). */
export function isSlotKey(key: string): boolean {
  return SLOT_RE.test(key);
}

function slotKey(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** The zone the browser is in, or UTC when the runtime cannot say. */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A zone this runtime can draw a clock in (a saved profile zone might not be one). */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const clocks = new Map<string, Intl.DateTimeFormat>();
function clockFor(zone: string): Intl.DateTimeFormat {
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    clocks.set(zone, clock);
  }
  return clock;
}

/** What a clock in the zone reads at an instant. */
function wallClock(ms: number, zone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of clockFor(zone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const instant = (at: number | string) => (typeof at === 'string' ? Date.parse(at) : at);

/** The calendar day an instant falls on in a zone, as 'YYYY-MM-DD'. */
export function dayKeyOf(at: number | string, zone: string): string {
  const w = wallClock(instant(at), zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** A calendar day `n` days on: calendar arithmetic, the same in every zone. */
export function addDays(dayKey: string, n: number): string {
  const m = DAY_KEY_RE.exec(dayKey);
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Every half hour of one calendar day in a zone, as slot keys, earliest first.
 *
 * A day is not always 48 half hours. On 29 March 2026 the clocks in Europe went forward and the day had 23 hours; on
 * 25 October 2026 they went back and it had 25, with 02:00 and 02:30 happening twice. Building each time from the
 * wall clock (new Date(y, m, d, h, mm)) gave the spring day two cells for one instant, so one tap toggled both, and
 * left the autumn day's second 02:00 out. So this walks the half-hour instants (on UTC's half hours, the only ones
 * the server stores) and keeps those that fall on this day in the zone: every instant of the day, each once.
 */
export function daySlots(dayKey: string, zone: string): string[] {
  const m = DAY_KEY_RE.exec(dayKey);
  if (!m || addDays(dayKey, 0) !== dayKey) return [];
  const midnightUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Clocks run from 12 hours behind UTC to 14 ahead, so the day lies inside this window wherever it is.
  const out: string[] = [];
  for (let t = midnightUtc - 14 * HOUR_MS; t < midnightUtc + 36 * HOUR_MS; t += SLOT_MS) {
    if (dayKeyOf(t, zone) === dayKey) out.push(slotKey(t));
  }
  return out;
}

/** A slot is past once it has started: it can no longer be picked or confirmed. */
export function hasStarted(key: string, now: number): boolean {
  return Date.parse(key) <= now;
}

/** The next `count` days in the zone that still have a time to offer, starting today (late at night, tomorrow). */
export function upcomingDays(now: number, zone: string, count: number): string[] {
  const out: string[] = [];
  for (let day = dayKeyOf(now, zone); out.length < count; day = addDays(day, 1)) {
    if (daySlots(day, zone).some((k) => !hasStarted(k, now))) out.push(day);
  }
  return out;
}

// ---- words for times ---------------------------------------------------------------------------------------------

/** A slot's time on the zone's clock, 24-hour: "13:00". */
export function slotTime(at: string, zone: string): string {
  const w = wallClock(Date.parse(at), zone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** An instant's day and time on the zone's clock: "Sun 25 Oct, 13:00". */
export function slotLabel(at: string, zone: string): string {
  const w = wallClock(Date.parse(at), zone);
  return `${WEEKDAYS[w.weekday]} ${w.day} ${MONTHS[w.month - 1]}, ${pad(w.hour)}:${pad(w.minute)}`;
}

/** The zone's short name at an instant: "CET", "CEST", "GMT+5". Empty when the runtime has none. */
function shortZone(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** "Sun 25 Oct, 13:00 CET": a meeting's time where no line around it names the zone. */
export function whenWithZone(at: string, zone: string): string {
  return `${slotLabel(at, zone)} ${shortZone(Date.parse(at), zone)}`.trim();
}

/** A calendar day on the day strip: "Sun" over "25 Oct". */
export function dayParts(dayKey: string): { weekday: string; date: string } {
  const m = DAY_KEY_RE.exec(dayKey);
  if (!m) return { weekday: '', date: dayKey };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return { weekday: WEEKDAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` };
}

/** A calendar day in a sentence: "Sun 25 Oct". */
export function dayLabel(dayKey: string): string {
  const { weekday, date } = dayParts(dayKey);
  return `${weekday} ${date}`.trim();
}

/**
 * The words on each cell of a day, in order. A time that happens twice (02:00 and 02:30 on the night the clocks go
 * back) carries its zone, so the two read "02:00 CEST" and "02:00 CET".
 */
export function cellLabels(slots: readonly string[], zone: string): string[] {
  const plain = slots.map((k) => slotTime(k, zone));
  const count = new Map<string, number>();
  for (const t of plain) count.set(t, (count.get(t) ?? 0) + 1);
  return plain.map((t, i) => ((count.get(t) ?? 0) > 1 ? `${t} ${shortZone(Date.parse(slots[i]), zone)}`.trim() : t));
}

/** The zone, named the way a person would: "Central European Time (CET)". */
export function zoneName(zone: string, at: number): string {
  const named = (style: 'longGeneric' | 'long'): string | null => {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: style })
        .formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? null;
    } catch {
      return null; // a runtime without generic names (Safari before 15.4) refuses the option
    }
  };
  const generic = named('longGeneric');
  // A zone with no generic name is given one like "GMT+00:00"; its long name says more ("Coordinated Universal Time").
  const long = generic && !/^GMT/.test(generic) ? generic : named('long');
  const short = shortZone(at, zone);
  if (!long) return short || zone;
  return short && short !== long ? `${long} (${short})` : long;
}

/** The line over the times. */
export function zoneLine(zone: string, at: number): string {
  return `Times in your time zone: ${zoneName(zone, at)}`;
}

/**
 * A time typed into "Another time" ("13:00", "9:30") as the slot it means on that day, or null when it is not a time.
 * The nearest half hour on that day's clock wins (13:14 is 13:00, a tie such as 13:15 goes to the later, 13:30); a
 * time the clocks skip that night goes to the nearest that exists, and one that happens twice to the first.
 */
export function typedSlot(dayKey: string, typed: string, zone: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typed.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const wanted = hour * 60 + minute;
  let best: string | null = null;
  let bestGap = Infinity;
  let bestMinutes = -1;
  for (const key of daySlots(dayKey, zone)) {
    const w = wallClock(Date.parse(key), zone);
    const minutes = w.hour * 60 + w.minute;
    const gap = Math.abs(minutes - wanted);
    if (gap < bestGap || (gap === bestGap && gap > 0 && minutes > bestMinutes)) {
      best = key;
      bestGap = gap;
      bestMinutes = minutes;
    }
  }
  return best;
}

// ---- meetings ----------------------------------------------------------------------------------------------------

/** The part of the scheduling answer these rules read. */
export interface ConfirmedLike { window: string; startAt: string | null; durationMin: number | null }
export interface SchedulingLike { overlap: string[]; confirmed: ConfirmedLike | null }

/** Times that can still be confirmed: shared, a real slot, starting after now (the server refuses any other). */
export function confirmable(overlap: readonly string[], now: number): string[] {
  return overlap.filter((k) => isSlotKey(k) && !hasStarted(k, now)).sort();
}

/** A meeting with a time is over 30 minutes after its end (the room stays open that long for overruns). */
export function isMeetingOver(startAt: string | null | undefined, durationMin: number | null | undefined, now = Date.now()): boolean {
  if (!startAt) return false;
  return now > Date.parse(startAt) + ((durationMin ?? 30) + MEETING_GRACE_MIN) * 60_000;
}

/** A meeting stands until it is over. One agreed as a day part has no time, so it stands. */
export function meetingStands(confirmed: ConfirmedLike | null | undefined, now: number): boolean {
  return !!confirmed && !isMeetingOver(confirmed.startAt, confirmed.durationMin, now);
}

/** "Meeting confirmed: Sun 25 Oct, 13:00", or "Meeting moved: …" for a meeting that already stood. */
export function confirmedMessage(at: string, zone: string, moved: boolean): string {
  return `${moved ? 'Meeting moved' : 'Meeting confirmed'}: ${slotLabel(at, zone)}`;
}

export type SaveOutcome =
  | { kind: 'confirmed'; startAt: string }
  | { kind: 'move'; to: string }
  | { kind: 'overlap' }
  | { kind: 'sent' };

/**
 * What a Save did, read from the scheduling the save itself answered with, against what the panel held before it.
 * Since 25 Oct 2026 a save that leaves exactly one shared time books it, so the answer can carry a meeting that was
 * not there before: that is "confirmed". With no meeting standing and times both can still confirm, it is "overlap"
 * and the confirm step stays in front of the person. Anything else only sent their times.
 *
 * A meeting that already stood is not news. Moving it (Reschedule, 26 Oct 2026) is agreed the way it was booked:
 * the save that makes exactly ONE more time shared by both is "move", and the panel moves the meeting there; two or
 * more new shared times leave the choice to the person ("overlap", with the move step open).
 */
export function saveOutcome(before: SchedulingLike | undefined, after: SchedulingLike, now: number): SaveOutcome {
  const meeting = after.confirmed;
  if (meeting?.startAt && meetingStands(meeting, now)) {
    const prior = before?.confirmed;
    const already = !!prior && meetingStands(prior, now) && prior.window === meeting.window;
    if (!already) return { kind: 'confirmed', startAt: meeting.startAt };
    const others = (s: SchedulingLike | undefined) => confirmable(s?.overlap ?? [], now).filter((k) => k !== meeting.window);
    const was = new Set(others(before));
    const fresh = others(after).filter((k) => !was.has(k));
    if (fresh.length === 1) return { kind: 'move', to: fresh[0] };
    return fresh.length > 1 ? { kind: 'overlap' } : { kind: 'sent' };
  }
  if (!meetingStands(meeting, now) && confirmable(after.overlap, now).length > 0) return { kind: 'overlap' };
  return { kind: 'sent' };
}

/** The toast after a Save (for "move", once the meeting has moved). */
export function saveMessage(outcome: SaveOutcome, zone: string): string {
  switch (outcome.kind) {
    case 'confirmed': return confirmedMessage(outcome.startAt, zone, false);
    case 'move': return confirmedMessage(outcome.to, zone, true);
    case 'overlap': return SAVE_OVERLAP;
    default: return SAVE_SENT;
  }
}

// ---- cells -------------------------------------------------------------------------------------------------------

/**
 * What a cell is. "agreed" (green) is a time BOTH people have saved: tapping it opens the confirm card. Their time that
 * I tapped but have not sent is "unsent-both": still my pick until I send it, so a second tap takes it back, exactly
 * like any other pick of mine. On 25 Oct the green cell was a toggle, and tapping "the green" removed the pick that
 * had made it green.
 */
export type CellState = 'free' | 'mine' | 'theirs' | 'unsent-both' | 'agreed' | 'booked';

export function cellState(c: {
  key: string; mine: ReadonlySet<string>; saved: ReadonlySet<string>; theirs: ReadonlySet<string>; booked: string | null;
}): CellState {
  if (c.booked === c.key) return 'booked';
  const minePicked = c.mine.has(c.key);
  const theirs = c.theirs.has(c.key);
  if (minePicked && theirs) return c.saved.has(c.key) ? 'agreed' : 'unsent-both';
  if (minePicked) return 'mine';
  return theirs ? 'theirs' : 'free';
}

const CELL_TEXT: Record<CellState, string> = {
  free: '', mine: 'You', theirs: 'They can', 'unsent-both': 'Both can', agreed: 'Both can', booked: 'Booked',
};

/** The small word under a cell's time. */
export function cellText(state: CellState): string {
  return CELL_TEXT[state];
}

/** What a screen reader says for a cell: the green one names what a tap does. */
export function cellAriaLabel(state: CellState, time: string): string {
  switch (state) {
    case 'agreed': return `Confirm ${time}, you both can`;
    case 'unsent-both': return `${time}, you both can, not sent yet`;
    case 'booked': return `${time}, your meeting`;
    case 'mine': return `${time}, you can`;
    case 'theirs': return `${time}, they can`;
    default: return time;
  }
}

// ---- failures ----------------------------------------------------------------------------------------------------

interface FailedRequest {
  isAxiosError?: unknown;
  request?: unknown;
  response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown } } };
}

/** The 409 a confirm gets when the time stopped being free for both while the card was open. */
export function isTimeNotShared(err: unknown): boolean {
  const failed = (err ?? {}) as FailedRequest;
  return failed.response?.status === 409 && failed.response.data?.error?.code === 'MEETING_TIME_NOT_SHARED';
}

/** One sentence for a failed save or confirm: the server's own when it is fit to show, else the caller's. */
export function schedulerError(err: unknown, fallback: string): string {
  const failed = (err ?? {}) as FailedRequest;
  const response = failed.response;
  if (!response) return failed.isAxiosError === true || failed.request != null ? CONNECTION_LOST : fallback;
  if (response.status === 400 || response.status === 403 || response.status === 409) {
    return memberSentence(response.data?.error?.message) ?? fallback;
  }
  return fallback;
}
