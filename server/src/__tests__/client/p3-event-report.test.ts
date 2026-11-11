// server/src/__tests__/client/p3-event-report.test.ts
// Part 3 Task 9 (10 Nov 2026 spec 03 "Reporting"; plan K4): the screens of Task 4's organiser event report.
//
// 1. The report follows the event, its places, its ratings and its groups (meta.entities), and a 403/404 is not retried.
// 2. The card is for the people running the event, once it is done, after the after-event tools; it draws nothing on a
//    403. The page lives at /sessions/:sessionId/report, loaded lazily.
// 3. The downloads go through lib/api.ts as a blob (the sign-in travels with them), never window.open; a failure is a
//    toast in plain words.
// 4. The words: six tiles, the attendance filter, "Room {n}: {names}", "{name} had no partner", "{A} and {B} · round
//    {r}", the three empty states, and a withheld rating figure reads "Too few ratings to show", never 0. No score of a
//    named person anywhere.
// 5. The recap no longer builds a CSV or a JSON file in the browser: organisers get "See the event report".
// 6. Every button and link the card and page draw is at least 44px tall.
import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EventReport, EventReportMeeting, EventReportPerson, EventReportSummary } from '@rsn/shared';
import { historySentence, type HistoryEntry } from '../../../../client/src/features/sessions/history/history-text';
import {
  REPORT_COPY, averageText, eventAverageText, filterCounts, filterPeople, mutualLine, nameLookup, personCounts, presenceLine,
  ratingLines, reportFileName, reportTiles, roomLine, roundCards, downloadFailedSentence,
} from '../../../../client/src/features/sessions/report/report-text';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const read = readClientSource;
const REPORT_DIR = 'features/sessions/report';
const REPORT_FILES = ['EventReportCard.tsx', 'EventReportPage.tsx', 'ReportSections.tsx', 'report-parts.tsx', 'report-text.ts', 'useEventReport.ts', 'download-report.ts']
  .map((f) => `${REPORT_DIR}/${f}`);

// ─── A report to draw ──────────────────────────────────────────────────────────────────────────────────────────────

const ZONE = 'Europe/Copenhagen';

function summary(over: Partial<EventReportSummary> = {}): EventReportSummary {
  return {
    registered: 0, attended: 0, noShows: 0, removed: 0, stayed: 0, leftEarly: 0, couldNotJoin: 0, guests: 0,
    attendanceRate: null, roundsPlanned: null, roundsRun: 0, meetings: 0, manualRooms: 0, uniquePairsMet: 0,
    ratingsExpected: 0, ratingsSubmitted: 0, ratingCompletion: null, avgQuality: null, qualityDistribution: null,
    didntWork: 0, meetAgainRate: null, ratingFiguresWithheld: false, mutualMatches: 0, feedbackCount: 0,
    scheduleVersionsPublished: 0, ...over,
  };
}

function person(id: string, name: string, over: Partial<EventReportPerson> = {}): EventReportPerson {
  return {
    userId: id, displayName: name, email: null, accountKind: 'member', formerMember: false, role: 'participant',
    registeredAt: '2026-12-01T12:00:00.000Z', admittedVia: 'open', groups: [], joinedAt: null, leftAt: null,
    outcome: 'no_show', missedAMeeting: false, roundsCompleted: 0, meetings: 0, peopleMet: 0, ratingsGiven: 0,
    ratingsExpected: 0, mutualMatches: 0, ...over,
  };
}

function meeting(id: string, round: number, room: number, userIds: string[], over: Partial<EventReportMeeting> = {}): EventReportMeeting {
  return {
    matchId: id, round, room, userIds, departedUserIds: [], status: 'completed', how: 'matched', scheduleVersion: null,
    startedAt: null, endedAt: null, ratingsExpected: 0, ratingsSubmitted: 0, mutualPairs: 0, ...over,
  };
}

function report(over: Partial<EventReport> = {}): EventReport {
  return {
    event: {
      id: 'e1', title: 'Copenhagen evening', status: 'completed', timezone: ZONE,
      scheduledAt: '2026-12-01T17:00:00.000Z', startedAt: '2026-12-01T17:02:00.000Z', endedAt: '2026-12-01T18:30:00.000Z',
    },
    generatedAt: '2026-12-01T19:00:00.000Z',
    summary: summary(),
    people: [],
    rounds: [],
    meetings: [],
    mutualMatches: [],
    ...over,
  };
}

const empty = () => report({
  summary: summary({ registered: 2, noShows: 2 }),
  people: [person('h', 'Hana Host', { role: 'host', outcome: 'stayed', joinedAt: '2026-12-01T17:00:00.000Z' }), person('a', 'Ana'), person('b', 'Ben')],
});

const full = () => report({
  summary: summary({
    registered: 5, attended: 4, noShows: 1, stayed: 3, leftEarly: 1, meetings: 3, roundsRun: 2, uniquePairsMet: 4,
    ratingsExpected: 10, ratingsSubmitted: 8, avgQuality: null, qualityDistribution: null, meetAgainRate: 0.625,
    ratingFiguresWithheld: true, didntWork: 4, mutualMatches: 1,
  }),
  people: [
    person('a', 'Ana', { outcome: 'stayed', joinedAt: '2026-12-01T17:02:00.000Z', leftAt: '2026-12-01T18:30:00.000Z', peopleMet: 2, ratingsGiven: 2, ratingsExpected: 2, mutualMatches: 1, email: 'ana@example.test' }),
    person('b', 'Ben', { outcome: 'stayed', joinedAt: '2026-12-01T17:03:00.000Z', peopleMet: 1, ratingsGiven: 1, ratingsExpected: 1 }),
    person('c', 'Cy', { outcome: 'left_early', joinedAt: '2026-12-01T17:04:00.000Z', leftAt: '2026-12-01T17:40:00.000Z' }),
    person('d', 'Dee', { outcome: 'stayed', accountKind: 'event_guest', joinedAt: '2026-12-01T17:05:00.000Z' }),
    person('n', 'Nia'),
  ],
  rounds: [
    { round: 1, rooms: 2, seated: 4, byes: 1, completed: 2, noShow: 0, cancelled: 0, reassigned: 0, ratingsExpected: 6, ratingsSubmitted: 5, avgQuality: 4.2, meetAgainRate: 0.6, ratingFiguresWithheld: false, mutualPairs: 1 },
    { round: 2, rooms: 1, seated: 2, byes: 0, completed: 1, noShow: 0, cancelled: 0, reassigned: 0, ratingsExpected: 4, ratingsSubmitted: 3, avgQuality: null, meetAgainRate: null, ratingFiguresWithheld: true, mutualPairs: 0 },
  ],
  meetings: [
    meeting('m2', 1, 2, ['d']),
    meeting('m1', 1, 1, ['a', 'b'], { departedUserIds: ['c'] }),
    meeting('m3', 2, 1, ['a', 'd'], { how: 'manual_room' }),
  ],
  mutualMatches: [{ userIds: ['a', 'b'], rounds: [1] }],
});

// ─── 1. Real time ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('the report follows the event without a refresh', () => {
  const hook = read(`${REPORT_DIR}/useEventReport.ts`);

  it('its query declares session:<id>, its participants, its ratings (and its groups)', () => {
    expect(hook).toContain("queryKey: ['event-report', sessionId]");
    expect(hook).toMatch(/meta: \{ entities: \[E\.session\(sessionId\), E\.sessionParticipants\(sessionId\), E\.sessionRatings\(sessionId\)(, E\.sessionGroups\(sessionId\))?\] \}/);
    expect(hook).toContain('api.get(`/sessions/${sessionId}/report`');
  });

  it('a 403 or 404 is not retried', () => {
    expect(hook).toContain('retry: (count, err: unknown) => !notForThisViewer(err) && count < 2');
  });

  it('nothing in the report screens writes into a cached answer', () => {
    for (const rel of REPORT_FILES) expect({ rel, sets: read(rel).includes('setQueryData') }).toEqual({ rel, sets: false });
  });

  it('every query in the report screens and the recap declares its tags', () => {
    for (const rel of [...REPORT_FILES, 'features/sessions/RecapPage.tsx']) {
      const src = read(rel);
      let at = src.indexOf('useQuery({');
      while (at !== -1) {
        const block = src.slice(at, src.indexOf('});', at));
        expect({ rel, tagged: /meta: \{\s*entities: /.test(block) }).toEqual({ rel, tagged: true });
        at = src.indexOf('useQuery({', at + 1);
      }
    }
  });
});

// ─── 2. Who sees it, where ─────────────────────────────────────────────────────────────────────────────────────────

describe('the card is for the people running the event, once it is over', () => {
  const detail = read('features/sessions/SessionDetailPage.tsx');

  it('it is drawn only under showAfterEventTools (done and mayRunEvent), after the after-event tools', () => {
    expect(detail).toContain("const showAfterEventTools = phase === 'done' && mayRunEvent;");
    expect(detail).toMatch(/\{showAfterEventTools && sessionId && \(\s*<div className="animate-fade-in-up stagger-1">\s*<EventReportCard sessionId=\{sessionId\} \/>/);
    expect(detail.indexOf('<EventReportCard')).toBeGreaterThan(detail.indexOf('data-testid="after-event-tools"'));
    expect(detail.match(/<EventReportCard/g)).toHaveLength(1);
  });

  const card = (state: Record<string, unknown>) => {
    const mod = loadClientModule(`${REPORT_DIR}/EventReportCard.tsx`, {
      'lucide-react': iconStandIns,
      'react-router-dom': { Link: ({ children, to, className, ...rest }: Record<string, unknown>) => createElement('a', { href: to, className, ...rest }, children as never) },
      './useEventReport': {
        useEventReport: () => ({ isLoading: false, isError: false, error: null, data: undefined, refetch: () => undefined, ...state }),
        useReportDownloads: () => ({ download: () => undefined, busy: null }),
      },
    });
    return renderToStaticMarkup(createElement(mod.default as never, { sessionId: 'e1' }));
  };

  it('a 403 (a member) or a 404 draws nothing at all', () => {
    expect(card({ isError: true, error: { response: { status: 403 } } })).toBe('');
    expect(card({ isError: true, error: { response: { status: 404 } } })).toBe('');
  });

  it('another failure says so with Try again; loading is a skeleton', () => {
    expect(card({ isError: true, error: { response: { status: 500 } } })).toContain(REPORT_COPY.error);
    expect(card({ isLoading: true })).toContain('aria-busy="true"');
  });

  it('the host sees the six tiles, the three downloads and "Open the full report"', () => {
    const html = card({ data: empty() });
    for (const label of ['Registered', 'Came', "Didn&#x27;t come", 'Meetings held', 'Ratings given', 'Both said meet again']) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/data-testid="report-tile-registered"[^]*?>2</);
    expect(html).toMatch(/data-testid="report-tile-didnt-come"[^]*?>2</);
    for (const label of ['Download attendance', 'Download meetings', 'Download mutual matches', 'Open the full report']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('href="/sessions/e1/report"');
  });

  it('nobody registered: the card says so', () => {
    expect(card({ data: report() })).toContain('Nobody registered for this event.');
  });

  it('the page is a lazy route at /sessions/:sessionId/report', () => {
    const app = read('App.tsx');
    expect(app).toContain("const EventReportPage = lazy(() => import('@/features/sessions/report/EventReportPage'));");
    expect(app).toContain('<Route path="/sessions/:sessionId/report" element={<Suspense fallback={<PageLoader />}><EventReportPage /></Suspense>} />');
    expect(app).not.toMatch(/import EventReportPage from/);
  });

  it('the page tells anyone refused that it is not for them, and draws no figure for them', () => {
    const page = read(`${REPORT_DIR}/EventReportPage.tsx`);
    expect(page).toContain("refused === 403 ? REPORT_COPY.notAvailable : REPORT_COPY.notFound");
    expect(page).toContain('{data && (');
    expect(REPORT_COPY.notAvailable).toBe('This report is only for the people running this event.');
  });
});

// ─── 3. Downloads ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('the downloads: a blob through lib/api.ts, never window.open', () => {
  it('no report screen and not the recap opens a window', () => {
    for (const rel of [...REPORT_FILES, 'features/sessions/RecapPage.tsx']) {
      expect({ rel, opens: read(rel).includes('window.open') }).toEqual({ rel, opens: false });
    }
  });

  it('asks GET /sessions/:id/report?format=csv&section=… as a blob, and saves it under the event-day name', async () => {
    const get = jest.fn().mockResolvedValue({ data: new Blob(['﻿Name,Email\r\n'], { type: 'text/csv' }), headers: {} });
    const clicked: Array<{ href: string; download: string }> = [];
    const anchor = { href: '', download: '', click() { clicked.push({ href: this.href, download: this.download }); }, remove: jest.fn() };
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { document: g.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    g.document = { createElement: () => anchor, body: { appendChild: jest.fn() } };
    URL.createObjectURL = jest.fn(() => 'blob:report');
    URL.revokeObjectURL = jest.fn();
    jest.useFakeTimers();
    try {
      const mod = loadClientModule(`${REPORT_DIR}/download-report.ts`, { '@/lib/api': { __esModule: true, default: { get } } });
      await (mod.downloadReportSection as (id: string, s: string, r: EventReport) => Promise<void>)('e1', 'attendance', report());
      expect(get).toHaveBeenCalledWith('/sessions/e1/report', { params: { format: 'csv', section: 'attendance' }, responseType: 'blob' });
      expect(clicked).toEqual([{ href: 'blob:report', download: 'rsn-event-2026-12-01-attendance.csv' }]);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report');
    } finally {
      jest.useRealTimers();
      g.document = saved.document;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    }
  });

  it('the file name: the server\'s when readable, else the event\'s day on its own clock', () => {
    expect(reportFileName('meetings', report(), 'attachment; filename="rsn-event-2026-12-01-meetings.csv"')).toBe('rsn-event-2026-12-01-meetings.csv');
    expect(reportFileName('meetings', report(), 'attachment; filename="../evil.exe"')).toBe('rsn-event-2026-12-01-meetings.csv');
    // 23:30 UTC on 30 Nov is already 1 Dec in Copenhagen.
    const late = report({ event: { ...report().event, scheduledAt: '2026-11-30T23:30:00.000Z' } });
    expect(reportFileName('mutual-matches', late, null)).toBe('rsn-event-2026-12-01-mutual-matches.csv');
    expect(reportFileName('attendance', null)).toBe('rsn-event-attendance.csv');
  });

  it('a failure is a toast in plain words; too many downloads says when to come back', () => {
    expect(downloadFailedSentence({ response: { status: 500 } })).toBe("We couldn't download that. Try again.");
    expect(downloadFailedSentence(new Error('Network Error'))).toBe("We couldn't download that. Try again.");
    expect(downloadFailedSentence({ response: { status: 429 } })).toBe('You have downloaded this report a lot just now. Try again in a few minutes.');
    const hook = read(`${REPORT_DIR}/useEventReport.ts`);
    expect(hook).toContain("addToast(downloadFailedSentence(err), 'error')");
  });

  it('two taps in one frame start one download: the guard is a ref, set before anything awaits', () => {
    const hook = read(`${REPORT_DIR}/useEventReport.ts`);
    expect(hook).toContain('const running = useRef(false);');
    const body = hook.slice(hook.indexOf('const download = async'), hook.indexOf('return { download, busy };'));
    const guard = body.indexOf('if (running.current) return;');
    const set = body.indexOf('running.current = true;');
    expect(guard).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(guard);
    expect(set).toBeLessThan(body.indexOf('await '));
    expect(body).toMatch(/finally \{\s*running\.current = false;/);
    expect(body).not.toContain('if (busy) return;');
  });
});

// ─── 4. The words ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('what the report says', () => {
  it('the six tiles, in order', () => {
    expect(reportTiles(full().summary).map((t) => [t.label, t.value, t.note ?? null])).toEqual([
      ['Registered', 5, null], ['Came', 4, null], ["Didn't come", 1, null], ['Meetings held', 3, null],
      ['Ratings given', 8, 'of 10'], ['Both said meet again', 1, null],
    ]);
  });

  it('a withheld figure reads "Too few ratings to show", never 0; no ratings reads "No ratings yet"', () => {
    const lines = ratingLines(full().summary);
    expect(lines[0]).toEqual({ label: 'Average score', value: 'Too few ratings to show' });
    expect(lines[1]).toEqual({ label: 'Said they would meet again', value: '63%' });
    expect(averageText(null, true, 3)).toBe('Too few ratings to show');
    expect(averageText(null, false, 0)).toBe('No ratings yet');
    expect(averageText(4.25, false, 9)).toBe('4.3 out of 5');
    for (const l of ratingLines(summary({ ratingsSubmitted: 3, ratingFiguresWithheld: true })).slice(0, 2)) {
      expect(l.value).toBe('Too few ratings to show');
    }
  });

  it('the attendance filter: All / Came / Left early / Couldn\'t join / Didn\'t come / Removed', () => {
    const page = read(`${REPORT_DIR}/report-text.ts`);
    expect(page).toContain("{ key: 'all', label: 'All' }");
    expect(page).toContain("{ key: 'came', label: 'Came' }");
    expect(page).toContain("{ key: 'left_early', label: 'Left early' }");
    expect(page).toContain("{ key: 'could_not_join', label: \"Couldn't join\" }");
    expect(page).toContain("{ key: 'no_show', label: \"Didn't come\" }");
    expect(page).toContain("{ key: 'removed', label: 'Removed' }");
    const people = full().people;
    expect(filterCounts(people)).toEqual({ all: 5, came: 4, left_early: 1, could_not_join: 0, no_show: 1, removed: 0 });
    expect(filterPeople(people, 'no_show').map((p) => p.displayName)).toEqual(['Nia']);
  });

  it('a person: times on the event\'s clock with the zone, counts only', () => {
    const [ana] = full().people;
    expect(presenceLine(ana, ZONE)).toBe('Joined 18:02 CET · Left 19:30 CET');
    expect(presenceLine(person('x', 'X'), ZONE)).toBeNull();
    expect(personCounts(ana)).toBe('Met 2 people · 2 of 2 ratings given · 1 mutual match');
  });

  it('rounds: "Room {n}: {names}", someone who left, a breakout room, "{name} had no partner"', () => {
    const cards = roundCards(full());
    expect(cards.map((c) => c.round)).toEqual([1, 2]);
    expect(cards[0].rooms.map((r) => r.text)).toEqual(['Room 1: Ana, Ben and Cy']);
    expect(cards[0].rooms[0].notes).toEqual(['Cy left the room']);
    expect(cards[0].byes).toEqual(['Dee had no partner']);
    expect(cards[0].counts).toBe('2 rooms · 5 of 6 ratings given · 1 mutual pair');
    expect(cards[0].figures).toBe('Average 4.2 out of 5 · Meet again 60%');
    expect(cards[1].rooms[0]).toMatchObject({ text: 'Room 1: Ana and Dee', notes: ['Breakout room'] });
    expect(cards[1].figures).toBe('Too few ratings to show');
    const nameOf = nameLookup(full().people);
    expect(roomLine(meeting('z', 3, 4, ['a', 'gone'], { status: 'cancelled' }), nameOf)).toEqual({ key: 'z', text: 'Room 4: Ana and Former member', notes: ['Cancelled'] });
  });

  it('mutual matches: "{A} and {B} · round {r}"', () => {
    const nameOf = nameLookup(full().people);
    expect(mutualLine({ userIds: ['a', 'b'], rounds: [1] }, nameOf)).toBe('Ana and Ben · round 1');
    expect(mutualLine({ userIds: ['a', 'd'], rounds: [1, 3] }, nameOf)).toBe('Ana and Dee · rounds 1 and 3');
  });

  const sections = () => loadClientModule(`${REPORT_DIR}/ReportSections.tsx`, { 'lucide-react': iconStandIns });
  const draw = (name: string, r: EventReport) => renderToStaticMarkup(createElement(sections()[name] as never, { report: r }));

  it('the empty states: nobody registered, no meetings, no mutual matches', () => {
    const nobody = draw('AttendanceSection', report({ people: [person('h', 'Hana Host', { role: 'host', outcome: 'stayed' })] }));
    expect(nobody).toContain('Nobody registered for this event.');
    // Only the sentence: no filter chips and no rows (not even the host's own).
    expect(nobody).not.toContain('report-attendance-filter');
    expect(nobody).not.toContain('<button');
    expect(nobody).not.toContain('report-person');
    expect(draw('AttendanceSection', empty())).toContain('report-attendance-filter');
    expect(draw('RoundsSection', empty())).toContain('No meetings took place.');
    expect(draw('MutualSection', empty())).toContain('No mutual matches yet.');
    expect(REPORT_COPY).toMatchObject({
      emptyPeople: 'Nobody registered for this event.', emptyMeetings: 'No meetings took place.', emptyMutual: 'No mutual matches yet.',
    });
  });

  it('the sections draw the rooms, byes and pairs, and the attendance filter', () => {
    const r = full();
    const att = draw('AttendanceSection', r);
    expect(att).toContain('data-testid="report-attendance-filter"');
    expect(att).toContain('aria-pressed="true"');
    expect(att).toContain('ana@example.test');
    expect(att).toContain('Joined 18:02 CET');
    expect(draw('RoundsSection', r)).toContain('Dee had no partner');
    expect(draw('MutualSection', r)).toContain('Ana and Ben · round 1');
  });

  it('no score of a named person is drawn or read anywhere in the report screens', () => {
    for (const rel of REPORT_FILES) {
      const src = read(rel);
      expect({ rel, score: /qualityScore|quality_score|theirMeetAgain|meetAgainSelf|ratingGiven\b/.test(src) }).toEqual({ rel, score: false });
    }
  });

  it('the event\'s history says who downloaded which part of the report', () => {
    const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
      id: '1', at: '', actor: { id: 'h', displayName: 'Ana Host' }, automatic: false, action: 'report.downloaded',
      round: null, scheduleVersion: null, subjects: [], reason: null, ...over,
    });
    expect(historySentence(entry({ reportSection: 'attendance' }))).toBe('Ana Host downloaded the attendance report');
    expect(historySentence(entry({ reportSection: 'meetings' }))).toBe('Ana Host downloaded the meetings report');
    expect(historySentence(entry({ reportSection: 'mutual-matches' }))).toBe('Ana Host downloaded the mutual matches report');
    expect(historySentence(entry({ reportSection: null }))).toBe('Ana Host downloaded the event report');
    expect(historySentence(entry({}))).toBe('Ana Host downloaded the event report');
    // A section only counts on a report.downloaded row.
    expect(historySentence(entry({ action: 'event.published', reportSection: 'attendance' }))).toBe('Ana Host published the event');
    // The field the client reads is the one the server sends (listEventAudit, Part 3 Task 4).
    const audit = fs.readFileSync(path.join(__dirname, '../../services/audit/event-audit.ts'), 'utf8');
    expect(audit).toContain('reportSection?: EventReportSection | null;');
    expect(audit).toContain("...(row.action === 'report.downloaded' ? { reportSection: reportSectionOf(d.after) } : {}),");
    expect(read('features/sessions/history/history-text.ts')).toContain('reportSection?: EventReportSection | null;');
  });
});

// ─── 5. The recap ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('the recap no longer builds files in the browser', () => {
  const recap = read('features/sessions/RecapPage.tsx');

  it('no CSV, no JSON export, no Blob, no legacy export route', () => {
    expect(recap).not.toContain('new Blob');
    expect(recap).not.toContain('createObjectURL');
    expect(recap).not.toContain('text/csv');
    expect(recap).not.toContain('application/json');
    expect(recap).not.toContain('/export`');
    expect(recap).not.toContain('HostRecapSection');
    expect(recap).not.toContain('Export CSV');
  });

  it('organisers get "See the event report" (44px); members\' own recap is unchanged', () => {
    expect(recap).toContain("const isOrganiser = isHost || isAdmin || pod?.memberRole === 'director' || pod?.memberRole === 'host';");
    expect(recap).toMatch(/\{isOrganiser && \(\s*<Link\s+to=\{`\/sessions\/\$\{sessionId\}\/report`\}/);
    const link = recap.slice(recap.indexOf('data-testid="recap-report-link"'), recap.indexOf('See the event report'));
    expect(link).toContain('min-h-[44px]');
    expect(recap).toContain('See the event report');
    expect(recap).toContain('api.get(`/ratings/sessions/${sessionId}/people-met`)');
  });
});

describe('the recap shows no event-wide rating figure under five ratings, to anyone', () => {
  const recap = read('features/sessions/RecapPage.tsx');

  it('the host and co-hosts get no event grid: no "Mutual Matches (all)", no "Total Ratings", no host branch', () => {
    expect(recap).not.toContain('Mutual Matches (all)');
    expect(recap).not.toContain('Total Ratings');
    expect(recap).toContain('{stats && !isHost && (');
    expect(recap).not.toMatch(/isHost \? \(/);
  });

  it('GET /ratings/sessions/:id/stats is the EVENT\'s average over every rating in it, for whoever reads it (an admin too)', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../services/rating/rating.service.ts'), 'utf8').replace(/\r\n/g, '\n');
    const fn = service.slice(service.indexOf('export async function getSessionRatingStats'), service.indexOf('// ─── Export Session Data'));
    expect(fn).toContain('COALESCE(AVG(quality_score) FILTER (WHERE NOT excluded_from_quality_stats), 0)');
    expect(fn).toContain('WHERE m.session_id = $1`');
    expect(fn).not.toMatch(/rater_id|ratee_id|\$2/);
    // It also says how many scores the average rests on, the count the recap gates on.
    expect(fn).toContain('scoredRatingCount: number;');
    expect(fn).toContain(`COUNT(*) FILTER (WHERE NOT r.excluded_from_quality_stats AND m.status IN ('completed', 'reassigned'))::text AS "scoredRatingCount"`);
  });

  it('the recap gates on the scores, not every rating: five ratings with four marked "didn\'t work" are withheld', () => {
    const stats = { totalRatings: 5, scoredRatingCount: 1, avgQualityScore: 2 };
    expect(eventAverageText(stats.scoredRatingCount ?? stats.totalRatings, stats.avgQualityScore).text).toBe('Too few ratings to show');
    // An older server without the field: today's rule on totalRatings.
    const older: { totalRatings: number; scoredRatingCount?: number; avgQualityScore: number } = { totalRatings: 6, avgQualityScore: 4.5 };
    expect(eventAverageText(older.scoredRatingCount ?? older.totalRatings, older.avgQualityScore).text).toBe('4.5');
    expect(eventAverageText(0, 0).text).toBe('No ratings yet');
  });

  it('so the one avgQualityScore the recap draws goes through eventAverageText, never toFixed on its own', () => {
    // Once in the Stats type, once in the tile.
    expect(recap.split('avgQualityScore').length - 1).toBe(2);
    expect(recap).toContain('eventAverageText(stats.scoredRatingCount ?? stats.totalRatings, stats.avgQualityScore)');
    expect(recap).toContain('scoredRatingCount?: number;');
    expect(recap).not.toMatch(/avgQualityScore\.toFixed|avgQuality\)\.toFixed/);
  });

  it('eventAverageText: none reads "No ratings yet", 1-4 "Too few ratings to show", 5 and up the average', () => {
    expect(eventAverageText(0, 0)).toEqual({ text: 'No ratings yet', figure: false });
    expect(eventAverageText(1, 4)).toEqual({ text: 'Too few ratings to show', figure: false });
    expect(eventAverageText(4, 3.75)).toEqual({ text: 'Too few ratings to show', figure: false });
    expect(eventAverageText(5, 4)).toEqual({ text: '4.0', figure: true });
    expect(eventAverageText(12, 4.25)).toEqual({ text: '4.3', figure: true });
  });
});

// ─── 6. Tap targets ────────────────────────────────────────────────────────────────────────────────────────────────

describe('every control is 44px tall', () => {
  it('the drawn card and sections: every button and link carries min-h-[44px]', () => {
    const card = loadClientModule(`${REPORT_DIR}/EventReportCard.tsx`, {
      'lucide-react': iconStandIns,
      'react-router-dom': { Link: ({ children, to, className }: Record<string, unknown>) => createElement('a', { href: to, className }, children as never) },
      './useEventReport': {
        useEventReport: () => ({ isLoading: false, isError: false, data: full(), refetch: () => undefined }),
        useReportDownloads: () => ({ download: () => undefined, busy: null }),
      },
    });
    const sections = loadClientModule(`${REPORT_DIR}/ReportSections.tsx`, { 'lucide-react': iconStandIns });
    const html = [
      renderToStaticMarkup(createElement(card.default as never, { sessionId: 'e1' })),
      renderToStaticMarkup(createElement(sections.AttendanceSection as never, { report: full() })),
    ].join('');
    const controls = Array.from(html.matchAll(/<(button|a)\b[^>]*>/g)).map((m) => m[0]);
    expect(controls.length).toBe(3 + 1 + 6);
    for (const c of controls) expect({ c, tall: c.includes('min-h-[44px]') }).toEqual({ c, tall: true });
  });

  it('the page\'s way back is 44px', () => {
    expect(read(`${REPORT_DIR}/EventReportPage.tsx`)).toContain("const BACK_LINK = 'inline-flex min-h-[44px]");
  });
});
