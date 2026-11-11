// ─── The event report as CSV (10 Nov 2026 spec, Part 3 Task 4) ───────────────────────────────────────────────────
//
// Three files an organiser can open in a spreadsheet: attendance (one row per person), meetings (one row per room)
// and mutual matches (one row per pair who both said they'd meet again). Built from the same EventReport the screen
// reads, so the file never says more than the report: no scores by name, no private notes, and emails only where the
// report carries them.
//
// Every cell goes through csvCell (lib/csv.ts): RFC 4180 quoting, and a name such as =HYPERLINK(...) is written as
// text. The file has a UTF-8 BOM for Excel and CRLF line ends, and is assembled by joining strings: no regex ever runs
// over the file. Every time is on the event's own clock, "YYYY-MM-DD HH:mm", with the zone named in the column header.

import type { EventReport, EventReportMeeting, EventReportOutcome, EventReportPerson, EventReportSection } from '@rsn/shared';
import { eventZone, utcToZonedWallTime } from '@rsn/shared';
import { csvDocumentWithBom } from '../../lib/csv';
import type { CsvValue } from '../../lib/csv';
import { FORMER_MEMBER_NAME } from '../users/active-member';

/** Who a bye's empty second seat reads as. */
export const NO_PARTNER = '(no partner)';

const OUTCOME_WORDS: Record<EventReportOutcome, string> = {
  stayed: 'Stayed to the end',
  left_early: 'Left early',
  could_not_join: 'Came but met nobody',
  no_show: 'Did not come',
  removed: 'Removed by an organiser',
};

const ROLE_WORDS: Record<EventReportPerson['role'], string> = { host: 'Host', co_host: 'Co-host', participant: 'Participant' };

const ADMITTED_WORDS: Record<string, string> = {
  open: 'Open registration',
  approval: 'Approved by an organiser',
  invite: 'Invited',
  allow_list: 'On the guest list',
  code: 'Admission code',
  audience: 'Audience',
  admin: 'Added by an admin',
};

const STATUS_WORDS: Record<EventReportMeeting['status'], string> = {
  scheduled: 'Not started',
  active: 'In progress',
  completed: 'Took place',
  reassigned: 'Took place (partner changed)',
  no_show: 'Someone did not come',
  cancelled: 'Cancelled',
};

const HOW_WORDS: Record<EventReportMeeting['how'], string> = {
  matched: 'Matched',
  host_edited: 'Changed by the host',
  manual_room: 'Breakout room',
  board_manual: 'Placed on the matching board',
  board_repair: 'Repaired on the matching board',
};

function accountWords(p: EventReportPerson): string {
  if (p.formerMember) return 'Former member';
  return p.accountKind === 'event_guest' ? 'Guest' : 'Member';
}

type WallTime = (at: string | null) => string;

/**
 * "2026-11-17 14:00" on the event's clock ('' for no time), the same wall clock as the shared utcToZonedWallTime.
 * One Intl formatter per file: building one per cell (as utcToZonedWallTime does) cost about 0.12 ms a time, three
 * quarters of a second for a 3,000-room event's meetings, all of it blocking the server.
 */
function wallTimeIn(zone: string): WallTime {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: eventZone(zone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (at) => {
    if (!at) return '';
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '';
    const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const p of format.formatToParts(date)) part[p.type] = p.value;
    return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
  };
}

function attendanceRows(report: EventReport): CsvValue[][] {
  const tz = report.event.timezone;
  const wallTime = wallTimeIn(tz);
  const header = [
    'Name', 'Email', 'Account', 'Role', 'Groups', `Registered at (${tz})`, 'How admitted', `Joined at (${tz})`,
    `Left at (${tz})`, 'Outcome', 'Missed a meeting', 'Rounds completed', 'People met', 'Ratings given',
    'Ratings expected', 'Mutual matches',
  ];
  const rows: CsvValue[][] = [header];
  for (const p of report.people) {
    rows.push([
      p.displayName, p.email, accountWords(p), ROLE_WORDS[p.role], p.groups.join('; '), wallTime(p.registeredAt),
      p.admittedVia ? ADMITTED_WORDS[p.admittedVia] ?? p.admittedVia : '', wallTime(p.joinedAt),
      wallTime(p.leftAt), OUTCOME_WORDS[p.outcome], p.missedAMeeting ? 'Yes' : 'No', p.roundsCompleted,
      p.peopleMet, p.ratingsGiven, p.ratingsExpected, p.mutualMatches,
    ]);
  }
  return rows;
}

function meetingRows(report: EventReport, nameOf: (id: string) => string): CsvValue[][] {
  const tz = report.event.timezone;
  const wallTime = wallTimeIn(tz);
  const header = [
    'Round', 'Room', 'Status', 'How', 'Person 1', 'Person 2', 'Person 3', 'Left the room', 'Ratings given',
    'Ratings expected', 'Mutual pairs', `Started (${tz})`, `Ended (${tz})`,
  ];
  const rows: CsvValue[][] = [header];
  for (const m of report.meetings) {
    const [first, second, third] = m.userIds;
    const alone = m.userIds.length === 1;
    rows.push([
      m.round, m.room, STATUS_WORDS[m.status], HOW_WORDS[m.how],
      first ? nameOf(first) : '', alone ? NO_PARTNER : second ? nameOf(second) : '', third ? nameOf(third) : '',
      m.departedUserIds.map(nameOf).join('; '), m.ratingsSubmitted, m.ratingsExpected, m.mutualPairs,
      wallTime(m.startedAt), wallTime(m.endedAt),
    ]);
  }
  return rows;
}

function mutualRows(report: EventReport, nameOf: (id: string) => string, emailOf: (id: string) => string | null): CsvValue[][] {
  const rows: CsvValue[][] = [['Person A', 'Email A', 'Person B', 'Email B', 'Rounds']];
  for (const pair of report.mutualMatches) {
    const [a, b] = pair.userIds;
    rows.push([nameOf(a), emailOf(a), nameOf(b), emailOf(b), pair.rounds.join('; ')]);
  }
  return rows;
}

/** How many data rows (the header aside) a section's file holds, for the download's audit row. */
export function eventReportCsvRowCount(report: EventReport, section: EventReportSection): number {
  if (section === 'attendance') return report.people.length;
  if (section === 'meetings') return report.meetings.length;
  return report.mutualMatches.length;
}

/** The event's day on its own clock ("2026-11-17"), from when it was planned, else started, else now. */
function eventDay(report: EventReport): string {
  const at = report.event.scheduledAt ?? report.event.startedAt ?? report.generatedAt;
  return utcToZonedWallTime(at, report.event.timezone).slice(0, 10) || report.generatedAt.slice(0, 10);
}

/**
 * One part of the report as a CSV file. The name is built from the event's day and the section only, never from the
 * title, so nothing an organiser typed reaches the Content-Disposition header.
 */
export function eventReportCsv(report: EventReport, section: EventReportSection): { filename: string; body: string } {
  const people = new Map(report.people.map((p) => [p.userId, p]));
  const nameOf = (id: string) => people.get(id)?.displayName ?? FORMER_MEMBER_NAME;
  const emailOf = (id: string) => people.get(id)?.email ?? null;
  const rows = section === 'attendance'
    ? attendanceRows(report)
    : section === 'meetings'
      ? meetingRows(report, nameOf)
      : mutualRows(report, nameOf, emailOf);
  return { filename: `rsn-event-${eventDay(report)}-${section}.csv`, body: csvDocumentWithBom(rows) };
}
