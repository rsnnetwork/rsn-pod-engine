// ─── The event report as CSV (10 Nov 2026 spec, Part 3 Task 4) ───────────────────────────────────────────────────
//
// eventReportCsv on a built EventReport: a UTF-8 BOM and CRLF, every cell through csvCell (a name that starts like a
// formula is written as text; a comma, quote or line break stays inside its cell), times on the event's own clock with
// the zone in the header, a bye's empty seat, and a 2,000-person file built without a regex over the file. And the
// shared lib/csv.ts the admin exports now use too.

import * as fs from 'fs';
import * as path from 'path';
import type { EventReport, EventReportMeeting, EventReportPerson } from '@rsn/shared';
import { utcToZonedWallTime } from '@rsn/shared';
import { CSV_BOM, csvCell, csvDocumentWithBom, csvRow } from '../../../lib/csv';
import { csvCell as feedbackCsvCell } from '../../../services/meetings/meeting-feedback.service';
import { NO_PARTNER, eventReportCsv, eventReportCsvRowCount } from '../../../services/session/event-report-csv';

const ZONE = 'Europe/Copenhagen';

function person(userId: string, over: Partial<EventReportPerson> = {}): EventReportPerson {
  return {
    userId, displayName: userId, email: `${userId}@example.com`, accountKind: 'member', formerMember: false,
    role: 'participant', registeredAt: '2026-11-01T09:00:00.000Z', admittedVia: 'open', groups: [],
    joinedAt: '2026-11-10T17:01:00.000Z', leftAt: '2026-11-10T20:00:00.000Z', outcome: 'stayed', missedAMeeting: false,
    roundsCompleted: 2, meetings: 2, peopleMet: 2, ratingsGiven: 1, ratingsExpected: 2, mutualMatches: 0, ...over,
  };
}

function meeting(matchId: string, userIds: string[], over: Partial<EventReportMeeting> = {}): EventReportMeeting {
  return {
    matchId, round: 1, room: 1, userIds, departedUserIds: [], status: 'completed', how: 'matched', scheduleVersion: null,
    startedAt: '2026-11-10T17:10:00.000Z', endedAt: '2026-11-10T17:18:00.000Z', ratingsExpected: 2, ratingsSubmitted: 1,
    mutualPairs: 0, ...over,
  };
}

function report(over: Partial<EventReport> = {}): EventReport {
  return {
    event: {
      id: 'e-1', title: 'A "title", with =risk', status: 'completed', timezone: ZONE,
      scheduledAt: '2026-11-10T23:30:00.000Z', startedAt: '2026-11-10T23:31:00.000Z', endedAt: null,
    },
    generatedAt: '2026-11-11T08:00:00.000Z',
    summary: {} as EventReport['summary'],
    people: [],
    rounds: [],
    meetings: [],
    mutualMatches: [],
    ...over,
  };
}

/** The file's rows of cells, read the RFC 4180 way (a quoted cell may hold commas, quotes and line breaks). */
function parse(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const bodyOf = (r: EventReport, section: Parameters<typeof eventReportCsv>[1]) => {
  const { body } = eventReportCsv(r, section);
  expect(body.startsWith(CSV_BOM)).toBe(true);
  return body.slice(1);
};

describe('lib/csv', () => {
  it('a cell a spreadsheet would run as a formula is written as text', () => {
    expect(csvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('=SUM(1,2)')).toBe(`"'=SUM(1,2)"`);
  });

  it('quotes a comma, a quote or a line break, and leaves plain text, numbers and nothing alone', () => {
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
    expect(csvCell('Søren')).toBe('Søren');
    expect(csvCell(3)).toBe('3');
    // A number is never a formula: a negative count or rate is written as the number it is.
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvRow(['a', 1, null, '=x'])).toBe("a,1,,'=x");
  });

  it('a document is the BOM, then rows ending CRLF', () => {
    expect(csvDocumentWithBom([['a', 'b'], ['c', 'd']])).toBe('﻿a,b\r\nc,d\r\n');
  });

  it('the meeting-feedback CSV writes cells with the same function', () => {
    expect(feedbackCsvCell).toBe(csvCell);
  });

  it('no server CSV keeps a formula guard of its own any more', () => {
    const admin = fs.readFileSync(path.join(__dirname, '../../../routes/admin.ts'), 'utf8');
    expect(admin).toContain("from '../lib/csv'");
    expect(admin).not.toMatch(/const asText/);
    const feedback = fs.readFileSync(path.join(__dirname, '../../../services/meetings/meeting-feedback.service.ts'), 'utf8');
    expect(feedback).not.toMatch(/function csvCell/);
  });
});

describe('attendance', () => {
  it('a header naming the zone, a row per person, every would-be formula written as text', () => {
    const r = report({
      people: [
        person('u-a', { displayName: '=SUM(1,2)', groups: ['Founders', 'Funders'], admittedVia: 'code' }),
        person('u-b', { displayName: '+1', email: '-1@example.com', outcome: 'no_show', joinedAt: null, leftAt: null }),
        person('u-c', { displayName: '@x', role: 'host' }),
        person('u-d', { displayName: 'Former member', email: null, formerMember: true, outcome: 'removed', missedAMeeting: true }),
        person('u-e', { displayName: 'Guest', accountKind: 'event_guest', admittedVia: null }),
      ],
    });
    const [header, a, b, c, d, e, ...rest] = parse(bodyOf(r, 'attendance'));
    expect(rest).toEqual([]);
    expect(header).toEqual([
      'Name', 'Email', 'Account', 'Role', 'Groups', 'Registered at (Europe/Copenhagen)', 'How admitted',
      'Joined at (Europe/Copenhagen)', 'Left at (Europe/Copenhagen)', 'Outcome', 'Missed a meeting', 'Rounds completed',
      'People met', 'Ratings given', 'Ratings expected', 'Mutual matches',
    ]);
    // 17:01Z and 20:00Z are 18:01 and 21:00 in Copenhagen in November (CET, UTC+1).
    expect(a).toEqual([
      "'=SUM(1,2)", 'u-a@example.com', 'Member', 'Participant', 'Founders; Funders', '2026-11-01 10:00', 'Admission code',
      '2026-11-10 18:01', '2026-11-10 21:00', 'Stayed to the end', 'No', '2', '2', '1', '2', '0',
    ]);
    expect(b.slice(0, 2)).toEqual(["'+1", "'-1@example.com"]);
    expect(b.slice(7, 10)).toEqual(['', '', 'Did not come']);
    expect(c.slice(0, 4)).toEqual(["'@x", 'u-c@example.com', 'Member', 'Host']);
    expect(d.slice(0, 3)).toEqual(['Former member', '', 'Former member']);
    expect(d.slice(9, 11)).toEqual(['Removed by an organiser', 'Yes']);
    expect(e.slice(2, 3)).toEqual(['Guest']);
    expect(e[6]).toBe('');
  });

  it('a comma, a quote and a line break inside a name stay inside one cell', () => {
    const r = report({ people: [person('u-a', { displayName: 'Lee, "the" \r\nboss' })] });
    const rows = parse(bodyOf(r, 'attendance'));
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('Lee, "the" \r\nboss');
    expect(rows[1]).toHaveLength(16);
  });

  it('a time in summer is on summer time (CEST), and the header names the zone, not an offset', () => {
    const r = report({ people: [person('u-a', { joinedAt: '2026-07-01T12:00:00.000Z' })] });
    expect(parse(bodyOf(r, 'attendance'))[1][7]).toBe('2026-07-01 14:00');
  });

  it('every time is the wall clock the shared utcToZonedWallTime gives, across both 2026 clock changes and in other zones', () => {
    const instants: string[] = [];
    // Every 10 minutes around Europe's 29 Mar and 25 Oct changes, and a spread through the year.
    for (const start of ['2026-03-29T00:00:00.000Z', '2026-10-25T00:00:00.000Z']) {
      for (let i = 0; i < 24; i++) instants.push(new Date(Date.parse(start) + i * 10 * 60_000).toISOString());
    }
    for (let d = 0; d < 365; d += 17) instants.push(new Date(Date.parse('2026-01-01T23:59:00.000Z') + d * 86_400_000).toISOString());
    for (const zone of [ZONE, 'Asia/Kathmandu', 'America/St_Johns', 'UTC', 'Not/AZone']) {
      const r = report({ event: { ...report().event, timezone: zone }, people: instants.map((t, i) => person(`u-${i}`, { joinedAt: t })) });
      const cells = parse(bodyOf(r, 'attendance')).slice(1).map((row) => row[7]);
      expect(cells).toEqual(instants.map((t) => utcToZonedWallTime(t, zone).replace('T', ' ')));
    }
  });

  it('2,000 people build in one pass, without a regex over the file', () => {
    const people = Array.from({ length: 2000 }, (_, i) => person(`u-${i}`, { displayName: i % 2 ? `Name ${i}` : `=Name, ${i}` }));
    const spy = jest.spyOn(RegExp.prototype, 'test');
    const started = Date.now();
    const { body } = eventReportCsv(report({ people }), 'attendance');
    const elapsed = Date.now() - started;
    // Every regex the build ran saw one cell, never the assembled file.
    const longest = Math.max(0, ...spy.mock.calls.map(([s]) => String(s).length));
    spy.mockRestore();
    expect(longest).toBeLessThan(200);
    expect(elapsed).toBeLessThan(2000);
    expect(body.split('\r\n')).toHaveLength(2002); // header, 2,000 rows, and the empty string after the last CRLF
  });
});

describe('meetings', () => {
  const people = [person('u-a', { displayName: 'Ana' }), person('u-b', { displayName: 'Ben' }), person('u-c', { displayName: 'Cy' })];

  it('one row per room: a trio with a leaver, a bye reading "(no partner)", a breakout room, in plain words', () => {
    const r = report({
      people,
      meetings: [
        meeting('m-1', ['u-a', 'u-b'], { departedUserIds: ['u-c'], ratingsExpected: 6, ratingsSubmitted: 3, mutualPairs: 1 }),
        meeting('m-2', ['u-c'], { room: 2, status: 'completed' }),
        meeting('m-3', ['u-a', 'u-b', 'u-gone'], { round: 2, how: 'manual_room', status: 'cancelled', startedAt: null, endedAt: null }),
      ],
    });
    const [header, trio, bye, manual] = parse(bodyOf(r, 'meetings'));
    expect(header).toEqual([
      'Round', 'Room', 'Status', 'How', 'Person 1', 'Person 2', 'Person 3', 'Left the room', 'Ratings given',
      'Ratings expected', 'Mutual pairs', 'Started (Europe/Copenhagen)', 'Ended (Europe/Copenhagen)',
    ]);
    expect(trio).toEqual(['1', '1', 'Took place', 'Matched', 'Ana', 'Ben', '', 'Cy', '3', '6', '1', '2026-11-10 18:10', '2026-11-10 18:18']);
    expect(bye.slice(4, 7)).toEqual(['Cy', NO_PARTNER, '']);
    expect(NO_PARTNER).toBe('(no partner)');
    // Someone not among the people (an account since closed) reads "Former member", never an id.
    expect(manual.slice(0, 7)).toEqual(['2', '1', 'Cancelled', 'Breakout room', 'Ana', 'Ben', 'Former member']);
    expect(manual.slice(11)).toEqual(['', '']);
  });
});

describe('mutual matches', () => {
  it('one row per pair with both names, emails where the report has them, and the rounds', () => {
    const r = report({
      people: [person('u-a', { displayName: 'Ana' }), person('u-b', { displayName: '=Ben', email: null })],
      mutualMatches: [{ userIds: ['u-a', 'u-b'], rounds: [1, 3] }],
    });
    expect(parse(bodyOf(r, 'mutual-matches'))).toEqual([
      ['Person A', 'Email A', 'Person B', 'Email B', 'Rounds'],
      ['Ana', 'u-a@example.com', "'=Ben", '', '1; 3'],
    ]);
  });

  it('an empty part is the header row alone', () => {
    expect(parse(bodyOf(report(), 'mutual-matches'))).toEqual([['Person A', 'Email A', 'Person B', 'Email B', 'Rounds']]);
    expect(eventReportCsvRowCount(report(), 'mutual-matches')).toBe(0);
  });
});

describe('the file name', () => {
  it('is the event\'s day on its own clock and the part, never the title', () => {
    // 23:30Z on 10 Nov is 00:30 on 11 Nov in Copenhagen.
    const r = report();
    expect(eventReportCsv(r, 'attendance').filename).toBe('rsn-event-2026-11-11-attendance.csv');
    expect(eventReportCsv(r, 'meetings').filename).toBe('rsn-event-2026-11-11-meetings.csv');
    expect(eventReportCsv(r, 'mutual-matches').filename).toBe('rsn-event-2026-11-11-mutual-matches.csv');
    const undated = report({ event: { ...r.event, scheduledAt: null, startedAt: null } });
    expect(eventReportCsv(undated, 'attendance').filename).toBe('rsn-event-2026-11-11-attendance.csv');
  });

  it('counts the rows of each part', () => {
    const r = report({ people: [person('u-a'), person('u-b')], meetings: [meeting('m-1', ['u-a', 'u-b'])] });
    expect(eventReportCsvRowCount(r, 'attendance')).toBe(2);
    expect(eventReportCsvRowCount(r, 'meetings')).toBe(1);
  });
});
