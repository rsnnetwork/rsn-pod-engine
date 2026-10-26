// client/src/features/meetings/meeting-words.ts
// What a member reads about a meeting, and the moments that changes. Pure on purpose (no React, axios, store or
// router), so a test can run it: server/src/__tests__/client/meetings-ui.test.ts.
//
// The phase comes from the shared meetingPhase, the rule the server uses: Join opens 5 minutes before the start and
// stays open until 30 minutes after the end. Times are drawn in the reader's own zone, with the zone named (25 Oct
// 2026 was the day Europe left summer time, and a bare "12:00" read as the wrong hour).
import {
  MEETING_GRACE_MIN, MEETING_JOIN_EARLY_MIN, meetingPhase, type Meeting, type MeetingKind, type MeetingSummary,
} from '@rsn/shared';
import { errorMessage } from '../reason/errors';
import { statusOf } from '../reason/human/profile-text';

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

export const EMPTY_MEETINGS = 'No meetings yet. When you and someone agree a time, it appears here.';
export const NO_PAST_MEETINGS = 'No past meetings yet.';
export const NO_CANCELLED_MEETINGS = 'No cancelled meetings.';
/** The server's own words for a meeting that is not yours to see, or no longer there. */
export const MEETING_GONE = "We couldn't find that meeting.";

// en-GB writes "Sept"; our own names keep every month to three letters.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface ClockFace { weekday: string; day: number; month: number; year: number; time: string; zone: string }

/** An instant on the reader's clock: their own zone unless one is named (the tests name one). 24-hour, like the rest of Events. */
function clockFace(at: number, timeZone?: string): ClockFace {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: part('weekday'),
    // The numeric pattern pads the day ("05"), so it is read as a number.
    day: Number(part('day')),
    month: Number(part('month')) - 1,
    year: Number(part('year')),
    time: `${part('hour')}:${part('minute')}`,
    zone: part('timeZoneName'),
  };
}

const endOf = (startAt: string, durationMin: number) => Date.parse(startAt) + durationMin * MINUTE;

/** "13:00–13:30 CET" */
export function meetingTimes(startAt: string, durationMin: number, timeZone?: string): string {
  const start = clockFace(Date.parse(startAt), timeZone);
  const end = clockFace(endOf(startAt, durationMin), timeZone);
  return `${start.time}–${end.time} ${start.zone}`;
}

/** "Sun 25 Oct · 13:00–13:30 CET" */
export function meetingWhen(startAt: string, durationMin: number, timeZone?: string): string {
  const start = clockFace(Date.parse(startAt), timeZone);
  return `${start.weekday.slice(0, 3)} ${start.day} ${MONTHS_SHORT[start.month]} · ${meetingTimes(startAt, durationMin, timeZone)}`;
}

/** "Sunday 25 October" */
export function meetingDay(startAt: string, timeZone?: string): string {
  const start = clockFace(Date.parse(startAt), timeZone);
  return `${start.weekday} ${start.day} ${MONTHS_LONG[start.month]}`;
}

export const kindLabel = (kind: MeetingKind): string => (kind === 'audio' ? 'Audio' : 'Video');

/** A card's time line: "Sun 25 Oct · 13:00–13:30 CET · Video" */
export function meetingLine(meeting: Pick<Meeting, 'startAt' | 'durationMin' | 'kind'>, timeZone?: string): string {
  return `${meetingWhen(meeting.startAt, meeting.durationMin, timeZone)} · ${kindLabel(meeting.kind)}`;
}

/** The first line of the request's words that has words in it, or nothing. */
export function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null;
}

/** What the phase of a meeting is worked out from. */
export type Timed = Pick<Meeting, 'status' | 'startAt' | 'durationMin'>;

/** Join is open from 5 minutes before the start until 30 minutes after the end; never for a cancelled meeting. */
export function canJoin(meeting: Timed, now: number): boolean {
  const phase = meetingPhase(meeting, now);
  return phase === 'joinable' || phase === 'live';
}

/** Until Join opens: "Starts in 25 min", "Starts in 1 h 30 min", "Starts in 2 days". A part of a minute counts as one. */
export function startsIn(startAt: string, now: number): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(startAt) - now) / MINUTE));
  if (minutes < 60) return `Starts in ${minutes} min`;
  if (minutes < DAY_MINUTES) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `Starts in ${hours} h ${rest} min` : `Starts in ${hours} h`;
  }
  const days = Math.round(minutes / DAY_MINUTES);
  return `Starts in ${days} day${days === 1 ? '' : 's'}`;
}

export type MeetingChip = 'Today' | 'Live now' | 'Ended' | 'Cancelled';

/** Live now whenever Join is open; Today for later on the reader's own today; nothing for a later day. */
export function meetingChip(meeting: Timed, now: number, timeZone?: string): MeetingChip | null {
  const phase = meetingPhase(meeting, now);
  if (phase === 'cancelled') return 'Cancelled';
  if (phase === 'ended') return 'Ended';
  if (phase === 'joinable' || phase === 'live') return 'Live now';
  const day = clockFace(Date.parse(meeting.startAt), timeZone);
  const today = clockFace(now, timeZone);
  return day.year === today.year && day.month === today.month && day.day === today.day ? 'Today' : null;
}

/** The moments a meeting changes phase: Join opens (start − 5 min) and Join closes (the first instant after end + 30 min). */
function phaseChanges(meeting: Timed): number[] {
  if (meeting.status === 'cancelled') return [];
  const start = Date.parse(meeting.startAt);
  return [start - MEETING_JOIN_EARLY_MIN * MINUTE, endOf(meeting.startAt, meeting.durationMin) + MEETING_GRACE_MIN * MINUTE + 1];
}

/** The soonest moment after `now` at which any of these meetings changes phase, or null when none will. */
export function nextChangeAt(meetings: Timed[], now: number): number | null {
  let soonest: number | null = null;
  for (const meeting of meetings) {
    for (const at of phaseChanges(meeting)) {
      if (at > now && (soonest === null || at < soonest)) soonest = at;
    }
  }
  return soonest;
}

// A timer may fire a hair before the clock reads the moment it was set for; this lands it just after.
const SETTLE_MS = 50;
// A browser timer overflows past about 24.8 days; a longer wait wakes once a day and looks again.
const LONGEST_WAIT_MS = DAY_MINUTES * MINUTE;

/**
 * How long a screen waits before it redraws: its regular tick (none: only at a change), or the next change if that
 * comes first. A change that has already passed is not waited for. Null: nothing to wait for.
 */
export function tickDelay(now: number, every: number | null, wakeAt: number | null): number | null {
  const toWake = wakeAt !== null && wakeAt > now ? Math.min(wakeAt - now + SETTLE_MS, LONGEST_WAIT_MS) : null;
  if (every === null) return toWake;
  return toWake === null ? every : Math.min(every, toWake);
}

/** The Events link's accessible name: "Events, 1 upcoming meeting", and ", live now" while one can be joined. */
export function eventsLinkName(label: string, count: number, liveNow: boolean): string {
  if (count <= 0) return label;
  const named = `${label}, ${count} upcoming meeting${count === 1 ? '' : 's'}`;
  return liveNow ? `${named}, live now` : named;
}

export interface EventsBadge {
  /** Upcoming meetings, as the server counted them. */
  count: number;
  /** One can be joined now (the "live now" dot). */
  liveNow: boolean;
  /** When the badge next changes on its own, by the clock. */
  wakeAt: number | null;
  /** The next meeting has closed (or was cancelled) since the count was read: it needs reading again. */
  outOfDate: boolean;
}

const NO_BADGE: EventsBadge = { count: 0, liveNow: false, wakeAt: null, outOfDate: false };

/**
 * The Events count and its live dot. The count is the server's; the dot follows the clock, by the next meeting's
 * own phase once its length is known (`next`, read separately), and by its start until then.
 */
export function eventsBadge(summary: MeetingSummary | undefined, next: Meeting | undefined, now: number): EventsBadge {
  if (!summary?.next) return { ...NO_BADGE, count: summary?.upcomingCount ?? 0 };
  const count = summary.upcomingCount;
  if (next && next.id === summary.next.id) {
    const phase = meetingPhase(next, now);
    return {
      count,
      liveNow: phase === 'joinable' || phase === 'live',
      wakeAt: nextChangeAt([next], now),
      outOfDate: phase === 'ended' || phase === 'cancelled',
    };
  }
  const opens = Date.parse(summary.next.startAt) - MEETING_JOIN_EARLY_MIN * MINUTE;
  return { count, liveNow: summary.liveNow || now >= opens, wakeAt: opens > now ? opens : null, outOfDate: false };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A meeting id, in either case. Anything else (a typo, a crafted address) is no meeting, and needs no request. */
export const isMeetingId = (id: string): boolean => UUID.test(id);

/**
 * The sentence for a failed meeting request. errorMessage words a 404 as a person who is gone; here a 404 is a
 * meeting that is not yours to see (or no longer there), so it gets the server's own words for that.
 */
export function meetingError(err: unknown, fallback: string): string {
  return statusOf(err) === 404 ? MEETING_GONE : errorMessage(err, fallback);
}
