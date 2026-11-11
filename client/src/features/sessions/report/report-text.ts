// ─── The organisers' event report in plain words (10 Nov 2026 spec, Part 3 Task 9; plan K4) ─────────────────────────
// Pure (no React, axios, store or router), so server/src/__tests__/client/p3-event-report.test.ts runs it. It turns
// GET /sessions/:id/report (shared EventReport) into what the card and the page say: the summary tiles, the attendance
// filter, one card per round with its rooms and byes, and the mutual pairs. Every time is on the event's own clock
// with its zone named (shared formatEventTime). There is no score a named person gave or received anywhere: the
// server sends none, and a rating figure resting on too few ratings arrives as null with `ratingFiguresWithheld`,
// which reads "Too few ratings to show", never 0.

import type {
  EventReport, EventReportMeeting, EventReportMutualMatch, EventReportOutcome, EventReportPerson, EventReportSection,
  EventReportSummary,
} from '@rsn/shared';
import { formatEventTime, utcToZonedWallTime } from '@rsn/shared';

export const REPORT_COPY = {
  cardTitle: 'Event report',
  cardHint: 'Who came, who met whom and how the meetings went. Only the people running this event see this.',
  pageTitle: 'Event report',
  open: 'Open the full report',
  back: 'Event details',
  loading: 'Loading the report',
  error: 'The report could not be read just now.',
  downloadFailed: "We couldn't download that. Try again.",
  downloadedTooOften: 'You have downloaded this report a lot just now. Try again in a few minutes.',
  notAvailable: 'This report is only for the people running this event.',
  notFound: 'This event could not be found.',
  emptyPeople: 'Nobody registered for this event.',
  emptyMeetings: 'No meetings took place.',
  emptyMutual: 'No mutual matches yet.',
  emptyFilter: 'Nobody here.',
  withheld: 'Too few ratings to show',
  noRatings: 'No ratings yet',
  attendance: 'Attendance',
  rounds: 'Rounds',
  mutual: 'Mutual matches',
  howItWent: 'How the meetings went',
  downloads: 'Spreadsheets',
  formerMember: 'Former member',
} as const;

// ─── Summary tiles ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ReportTile { key: string; label: string; value: number; note?: string }

/** The six figures on the card and at the top of the page, in this order. */
export function reportTiles(s: EventReportSummary): ReportTile[] {
  return [
    { key: 'registered', label: 'Registered', value: s.registered },
    { key: 'came', label: 'Came', value: s.attended },
    { key: 'didnt-come', label: "Didn't come", value: s.noShows },
    { key: 'meetings', label: 'Meetings held', value: s.meetings },
    { key: 'ratings', label: 'Ratings given', value: s.ratingsSubmitted, note: s.ratingsExpected > 0 ? `of ${s.ratingsExpected}` : undefined },
    { key: 'mutual', label: 'Both said meet again', value: s.mutualMatches },
  ];
}

// ─── Rating figures (aggregates only; withheld under RATING_FIGURE_MIN) ────────────────────────────────────────────

/** "4.2 out of 5"; "Too few ratings to show" when the server held it back; "No ratings yet" when there were none. */
export function averageText(avg: number | null, withheld: boolean, submitted: number): string {
  if (avg !== null) return `${avg.toFixed(1)} out of 5`;
  if (withheld) return REPORT_COPY.withheld;
  return submitted > 0 ? REPORT_COPY.withheld : REPORT_COPY.noRatings;
}

/** "60%"; the same words as averageText when there is no share to show. */
export function shareText(rate: number | null, withheld: boolean, submitted: number): string {
  if (rate !== null) return `${Math.round(rate * 100)}%`;
  return averageText(null, withheld, submitted);
}

export interface FigureLine { label: string; value: string }

/** The page's "How the meetings went" lines. Counts are always shown; figures follow the server's withholding. */
export function ratingLines(s: EventReportSummary): FigureLine[] {
  return [
    { label: 'Average score', value: averageText(s.avgQuality, s.ratingFiguresWithheld, s.ratingsSubmitted) },
    { label: 'Said they would meet again', value: shareText(s.meetAgainRate, s.ratingFiguresWithheld, s.ratingsSubmitted) },
    { label: "Marked \"didn't work\"", value: String(s.didntWork) },
    { label: 'Different pairs who met', value: String(s.uniquePairsMet) },
    { label: 'Wrote feedback about the event', value: String(s.feedbackCount) },
  ];
}

// ─── Attendance ─────────────────────────────────────────────────────────────────────────────────────────────────

export const OUTCOME_WORDS: Record<EventReportOutcome, string> = {
  stayed: 'Stayed to the end',
  left_early: 'Left early',
  could_not_join: 'Came but met nobody',
  no_show: "Didn't come",
  removed: 'Removed by an organiser',
};

export const ROLE_WORDS: Record<EventReportPerson['role'], string | null> = { host: 'Host', co_host: 'Co-host', participant: null };

export type AttendanceFilter = 'all' | 'came' | 'left_early' | 'could_not_join' | 'no_show' | 'removed';

/**
 * The chips over the list. "Came" is everyone who came at all (the "Came" tile: stayed, left early, or came but met
 * nobody); the next two narrow it. The rest are one outcome each.
 */
export const ATTENDANCE_FILTERS: ReadonlyArray<{ key: AttendanceFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'came', label: 'Came' },
  { key: 'left_early', label: 'Left early' },
  { key: 'could_not_join', label: "Couldn't join" },
  { key: 'no_show', label: "Didn't come" },
  { key: 'removed', label: 'Removed' },
];

function inFilter(p: EventReportPerson, filter: AttendanceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'came') return p.outcome !== 'removed' && p.outcome !== 'no_show';
  return p.outcome === filter;
}

export function filterPeople(people: EventReportPerson[], filter: AttendanceFilter): EventReportPerson[] {
  return people.filter((p) => inFilter(p, filter));
}

export function filterCounts(people: EventReportPerson[]): Record<AttendanceFilter, number> {
  const counts = { all: 0, came: 0, left_early: 0, could_not_join: 0, no_show: 0, removed: 0 } as Record<AttendanceFilter, number>;
  for (const f of ATTENDANCE_FILTERS) counts[f.key] = filterPeople(people, f.key).length;
  return counts;
}

/** The small labels beside a name: Host / Co-host, Guest, Former member. */
export function personBadges(p: EventReportPerson): string[] {
  const badges: string[] = [];
  const role = ROLE_WORDS[p.role];
  if (role) badges.push(role);
  if (p.formerMember) badges.push(REPORT_COPY.formerMember);
  else if (p.accountKind === 'event_guest') badges.push('Guest');
  return badges;
}

/** "Joined 18:02 CET · Left 19:10 CET", on the event's clock; null for someone who never came. */
export function presenceLine(p: EventReportPerson, zone: string): string | null {
  if (!p.joinedAt) return null;
  const parts = [`Joined ${formatEventTime(p.joinedAt, zone, 'clock')}`];
  if (p.leftAt) parts.push(`Left ${formatEventTime(p.leftAt, zone, 'clock')}`);
  return parts.join(' · ');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Met 3 people · 2 of 3 ratings given · 1 mutual match": counts only, never a score. */
export function personCounts(p: EventReportPerson): string {
  const parts = [`Met ${plural(p.peopleMet, 'person', 'people')}`];
  if (p.ratingsExpected > 0) parts.push(`${p.ratingsGiven} of ${p.ratingsExpected} ratings given`);
  if (p.mutualMatches > 0) parts.push(plural(p.mutualMatches, 'mutual match', 'mutual matches'));
  return parts.join(' · ');
}

// ─── Rounds ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A name for an id, "Former member" for one the report does not list. */
export function nameLookup(people: EventReportPerson[]): (id: string) => string {
  const names = new Map(people.map((p) => [p.userId, p.displayName]));
  return (id) => names.get(id) ?? REPORT_COPY.formerMember;
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy". */
export function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const ROOM_NOTES: Partial<Record<EventReportMeeting['status'], string>> = {
  active: 'In progress',
  reassigned: 'Partner changed',
  no_show: 'Someone did not come',
  cancelled: 'Cancelled',
};

export interface RoomLine { key: string; text: string; notes: string[] }
export interface RoundCard {
  round: number;
  /** "4 rooms · 7 of 8 ratings given · 1 mutual pair" */
  counts: string;
  /** The round's average and "meet again" share, or why they are not shown; null when the round had no ratings. */
  figures: string | null;
  rooms: RoomLine[];
  /** "Ana had no partner" */
  byes: string[];
}

/** A bye: one seat, nobody who left it. */
const isBye = (m: EventReportMeeting) => m.userIds.length === 1 && m.departedUserIds.length === 0;

/** "Room 2: Ana, Ben and Cy", with notes for a breakout room, someone who left, or a room that did not run. */
export function roomLine(m: EventReportMeeting, nameOf: (id: string) => string): RoomLine {
  const names = [...m.userIds, ...m.departedUserIds].map(nameOf);
  const notes: string[] = [];
  if (m.how === 'manual_room') notes.push('Breakout room');
  const status = ROOM_NOTES[m.status];
  if (status) notes.push(status);
  if (m.departedUserIds.length > 0) notes.push(`${namesList(m.departedUserIds.map(nameOf))} left the room`);
  return { key: m.matchId, text: `Room ${m.room}: ${namesList(names)}`, notes };
}

export const byeLine = (name: string) => `${name} had no partner`;

/** One card per round, rooms in the order they were made, byes after them. */
export function roundCards(report: EventReport): RoundCard[] {
  const nameOf = nameLookup(report.people);
  const byRound = new Map<number, EventReportMeeting[]>();
  for (const m of report.meetings) {
    const list = byRound.get(m.round) ?? [];
    list.push(m);
    byRound.set(m.round, list);
  }
  const stats = new Map(report.rounds.map((r) => [r.round, r]));
  const numbers = [...new Set([...stats.keys(), ...byRound.keys()])].sort((a, b) => a - b);
  return numbers.map((round) => {
    const meetings = (byRound.get(round) ?? []).slice().sort((a, b) => a.room - b.room);
    const r = stats.get(round);
    const rooms = meetings.filter((m) => !isBye(m)).map((m) => roomLine(m, nameOf));
    const byes = meetings.filter((m) => isBye(m) && m.status !== 'cancelled').map((m) => byeLine(nameOf(m.userIds[0])));
    const counts = [plural(r?.rooms ?? rooms.length, 'room', 'rooms')];
    if (r && r.ratingsExpected > 0) counts.push(`${r.ratingsSubmitted} of ${r.ratingsExpected} ratings given`);
    if (r && r.mutualPairs > 0) counts.push(plural(r.mutualPairs, 'mutual pair', 'mutual pairs'));
    let figures: string | null = null;
    if (r && r.ratingsSubmitted > 0) {
      figures = r.avgQuality === null && r.meetAgainRate === null
        ? REPORT_COPY.withheld
        : `Average ${averageText(r.avgQuality, r.ratingFiguresWithheld, r.ratingsSubmitted)} · Meet again ${shareText(r.meetAgainRate, r.ratingFiguresWithheld, r.ratingsSubmitted)}`;
    }
    return { round, counts: counts.join(' · '), figures, rooms, byes };
  });
}

// ─── Mutual matches ─────────────────────────────────────────────────────────────────────────────────────────────

/** "Ana and Ben · round 1", "Ana and Ben · rounds 1 and 3". */
export function mutualLine(pair: EventReportMutualMatch, nameOf: (id: string) => string): string {
  const [a, b] = pair.userIds;
  const rounds = pair.rounds.length === 1 ? `round ${pair.rounds[0]}` : `rounds ${namesList(pair.rounds.map(String))}`;
  return `${nameOf(a)} and ${nameOf(b)} · ${rounds}`;
}

// ─── The event line and the files ───────────────────────────────────────────────────────────────────────────────

/** "Tuesday 17 November, 18:00 (CET)" for when the event was planned, else started; null with neither. */
export function reportWhen(report: EventReport): string | null {
  const at = report.event.scheduledAt ?? report.event.startedAt;
  return at ? formatEventTime(at, report.event.timezone, 'long') || null : null;
}

export const DOWNLOADS: ReadonlyArray<{ section: EventReportSection; label: string }> = [
  { section: 'attendance', label: 'Download attendance' },
  { section: 'meetings', label: 'Download meetings' },
  { section: 'mutual-matches', label: 'Download mutual matches' },
];

/**
 * The file's name: the server's (Content-Disposition) when the browser may read it, else the same name built here
 * ("rsn-event-2026-11-17-attendance.csv", the event's day on its own clock). The API is on another origin and does not
 * expose the header, so the second is the usual case. The header is one short line, never a file body.
 */
export function reportFileName(
  section: EventReportSection,
  report: Pick<EventReport, 'event' | 'generatedAt'> | null | undefined,
  disposition?: string | null,
): string {
  const marker = 'filename="';
  const at = disposition ? disposition.indexOf(marker) : -1;
  if (disposition && at !== -1) {
    const end = disposition.indexOf('"', at + marker.length);
    const name = end === -1 ? '' : disposition.slice(at + marker.length, end);
    if (name.startsWith('rsn-event-') && name.endsWith('.csv') && !name.includes('/') && !name.includes('\\')) return name;
  }
  const when = report ? report.event.scheduledAt ?? report.event.startedAt ?? report.generatedAt : null;
  const day = when && report ? utcToZonedWallTime(when, report.event.timezone).slice(0, 10) : '';
  return day ? `rsn-event-${day}-${section}.csv` : `rsn-event-${section}.csv`;
}

interface FailedDownload { response?: { status?: number } }

/** The toast for a failed download: the rate limit in the server's words, anything else the one sentence. */
export function downloadFailedSentence(err: unknown): string {
  const status = typeof err === 'object' && err !== null ? (err as FailedDownload).response?.status : undefined;
  return status === 429 ? REPORT_COPY.downloadedTooOften : REPORT_COPY.downloadFailed;
}
