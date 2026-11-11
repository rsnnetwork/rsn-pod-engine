// server/src/__tests__/client/t7-add-to-calendar.test.ts
// Add to calendar that works (1 Nov 2026, T7, 30 Oct review 5b; L10). Stefan: "Add to calendar doesn't work. Users
// can't add the meeting to their own calendar (e.g. Google Calendar)." Every button downloaded a .ics (9 Sep: "calendar
// could be anything"), which Google Calendar's apps cannot open, and the download was revoked on the same tick as the
// click, which WebKit can drop. Now one shared component offers Google Calendar, Outlook.com and the file, on the
// meeting page, the thread's "Meeting confirmed" card, the scheduler and the event page.
// calendar-links.ts is pure and runs here; the component and its call sites are read from source.

jest.mock('../../db', () => ({ query: jest.fn(), __esModule: true }));

import * as fs from 'fs';
import * as path from 'path';
import {
  calendarLinks, eventEntry, icsFile, meetingEntry,
} from '../../../../client/src/components/calendar/calendar-links';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

const JOIN = 'https://preview.rsn.network/meet/c1?scheduled=1&kind=video';

describe('the links', () => {
  const entry = meetingEntry({ partnerName: 'Bo', kind: 'video', startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, joinUrl: JOIN });

  it('a meeting is "Meeting with {name} on REASON", with "{Video|Audio} call on REASON. Join: {url}"', () => {
    expect(entry.title).toBe('Meeting with Bo on REASON');
    expect(entry.details).toBe(`Video call on REASON. Join: ${JOIN}`);
    expect(entry.location).toBe(JOIN);
    expect(meetingEntry({ partnerName: 'Ana', kind: 'audio', startAt: '2026-11-05T17:00:00Z', durationMin: 45, joinUrl: JOIN }).details)
      .toBe(`Audio call on REASON. Join: ${JOIN}`);
  });

  it('Google Calendar: the title, the UTC dates, details with the join link, and where', () => {
    const url = new URL(calendarLinks(entry).google);
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Meeting with Bo on REASON');
    expect(url.searchParams.get('dates')).toBe('20261105T170000Z/20261105T173000Z');
    expect(url.searchParams.get('details')).toBe(`Video call on REASON. Join: ${JOIN}`);
    expect(url.searchParams.get('location')).toBe(JOIN);
  });

  it('Outlook.com: the same entry, the times as UTC instants', () => {
    const url = new URL(calendarLinks(entry).outlook);
    expect(`${url.origin}${url.pathname}`).toBe('https://outlook.live.com/calendar/0/deeplink/compose');
    expect(url.searchParams.get('path')).toBe('/calendar/action/compose');
    expect(url.searchParams.get('rru')).toBe('addevent');
    expect(url.searchParams.get('subject')).toBe('Meeting with Bo on REASON');
    expect(url.searchParams.get('startdt')).toBe('2026-11-05T17:00:00Z');
    expect(url.searchParams.get('enddt')).toBe('2026-11-05T17:30:00Z');
    expect(url.searchParams.get('body')).toBe(`Video call on REASON. Join: ${JOIN}`);
    expect(url.searchParams.get('location')).toBe(JOIN);
  });

  it('the email builds no links of its own any more (11 Nov 2026, RSN 09): its attached invitation is the way in', () => {
    const server = fs.readFileSync(path.join(__dirname, '../../services/calendar/calendar.service.ts'), 'utf8');
    expect(server).not.toContain('meetingCalendarLinks');
    const dispatch = fs.readFileSync(path.join(__dirname, '../../services/dm/meeting-windows.service.ts'), 'utf8');
    expect(dispatch).not.toMatch(/googleCalendarUrl|outlookCalendarUrl/);
  });

  it('an event: "{title} on REASON", its length, the event page as the way in, or its place when held in person', () => {
    const online = eventEntry({ title: 'Founders breakfast', startAt: '2026-11-07T08:00:00Z', durationMin: 90, pageUrl: 'https://preview.rsn.network/sessions/s1' });
    expect(online.title).toBe('Founders breakfast on REASON');
    expect(online.end.toISOString()).toBe('2026-11-07T09:30:00.000Z');
    expect(online.details).toBe('An event on REASON. Join: https://preview.rsn.network/sessions/s1');
    expect(online.location).toBe('https://preview.rsn.network/sessions/s1');
    const inPerson = eventEntry({ title: 'Founders breakfast', startAt: '2026-11-07T08:00:00Z', durationMin: 90, pageUrl: 'https://x/sessions/s1', place: ' Café Nord, Copenhagen ' });
    expect(new URL(calendarLinks(inPerson).google).searchParams.get('location')).toBe('Café Nord, Copenhagen');
  });

  it('an event\'s file: a PUBLISH with a stable UID, UTC times, folded lines, CRLF to the end', () => {
    const entryForFile = eventEntry({ title: 'Founders, investors; and friends', startAt: '2026-11-07T08:00:00Z', durationMin: 90, pageUrl: 'https://preview.rsn.network/sessions/0123456789abcdef-0123-4567-89ab-cdef01234567' });
    const ics = icsFile(entryForFile, 'event-s1', new Date('2026-11-01T10:00:00Z'));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('\r\nMETHOD:PUBLISH\r\n');
    expect(ics).toContain('\r\nUID:event-s1@rsn.network\r\n');
    expect(ics).toContain('\r\nDTSTART:20261107T080000Z\r\n');
    expect(ics).toContain('\r\nDTEND:20261107T093000Z\r\n');
    expect(unfold(ics)).toContain('SUMMARY:Founders\\, investors\\; and friends on REASON');
    expect(unfold(ics)).toContain('DESCRIPTION:An event on REASON. Join: https://preview.rsn.network/sessions/0123456789abcdef-0123-4567-89ab-cdef01234567');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(ics).not.toMatch(/\bRSN\b/);
  });
});

describe('the shared component', () => {
  const src = () => read('components/calendar/AddToCalendar.tsx');

  it('one button, "Add to calendar" ("Add manually" once the invitation was emailed), opening the file FIRST, then Google Calendar and Outlook.com (11 Nov 2026, RSN 09)', () => {
    const s = src();
    expect(s).toContain('const label = emailed ? ADD_MANUALLY : ADD_TO_CALENDAR;');
    expect(s).toMatch(/\} \{label\}\s*<\/button>/);
    const ics = s.indexOf('data-testid="calendar-ics"');
    const google = s.indexOf('data-testid="calendar-google"');
    const outlook = s.indexOf('data-testid="calendar-outlook"');
    expect(ics).toBeGreaterThan(0);
    expect(ics).toBeLessThan(google);
    expect(google).toBeLessThan(outlook);
    expect(s).toContain('{saving ? \'Preparing the file…\' : ICS_OPTION}');
    expect(s).toContain('{GOOGLE_NOTE}');
    expect(s).toContain('{OUTLOOK_NOTE}');
    expect(s).toContain('{emailed ? EMAILED_NOTE : NOT_EMAILED_NOTE}');
  });

  it('the links open from the press itself, in a new tab, so a popup blocker lets them through', () => {
    const s = src();
    expect(s).toMatch(/<a[\s\S]{0,200}href=\{links\.google\}[\s\S]{0,200}target="_blank"[\s\S]{0,60}rel="noopener"/);
    expect(s).toMatch(/<a[\s\S]{0,200}href=\{links\.outlook\}[\s\S]{0,200}target="_blank"[\s\S]{0,60}rel="noopener"/);
    expect(s).not.toMatch(/window\.open\(/);
  });

  it('the file downloads through an object URL that is kept about a minute, so WebKit finishes the download', () => {
    const s = src();
    expect(s).toContain("fileName = 'reason-meeting.ics'");
    expect(s).toContain('a.download = fileName;');
    expect(s).toMatch(/setTimeout\(\(\) => URL\.revokeObjectURL\(url\), KEEP_FILE_MS\)/);
    expect(s).toMatch(/const KEEP_FILE_MS = 60_000;/);
  });

  it('is a REASON Sheet on a phone and a menu beside the button from 768px; every option is 44px', () => {
    const s = src();
    expect(s).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet'/);
    expect(s).toMatch(/matchMedia\('\(min-width: 768px\)'\)/);
    expect(s).toMatch(/createPortal\(/);
    expect(s).toMatch(/const OPTION = '[^']*min-h-\[44px\]/);
  });

  it('a refused file says so in words', () => {
    expect(src()).toContain("errorMessage(err, 'We could not make the calendar file. Try again in a moment.')");
  });
});

describe('every place that offered a .ics now offers the menu', () => {
  it('the meeting page, from the meeting\'s own file, while it stands, with the join link on this site', () => {
    const s = read('features/meetings/MeetingDetailPage.tsx');
    expect(s).toMatch(/<AddToCalendar\b/);
    expect(s).toContain('meetingFile(meeting.id)');
    expect(s).toContain('window.location.origin + meeting.joinPath');
    expect(s).toMatch(/\{standing && \(\s*<AddToCalendar/);
    expect(s).not.toContain('URL.revokeObjectURL');
  });

  it('the thread\'s Meeting confirmed card: its own meeting\'s file, or the conversation\'s for a card older than meeting ids', () => {
    const card = read('features/messages/SystemMessageCard.tsx');
    expect(card).toMatch(/<AddToCalendar\b/);
    expect(card).toContain('meta.meetingId ? meetingFile(meta.meetingId) : conversationMeetingFile(calendar.conversationId)');
    expect(card).toContain('window.location.origin + meta.joinPath');
    expect(card).toMatch(/\{calendar && !settled && \(/);
    const page = read('features/messages/MessagesPage.tsx');
    expect(page).not.toContain('downloadMeetingIcs');
    expect(page).not.toContain('URL.revokeObjectURL(url)');
  });

  it('the scheduler\'s meeting', () => {
    const summary = read('features/messages/SchedulerMeetingSummary.tsx');
    expect(summary).toMatch(/<AddToCalendar\b/);
    expect(summary).toContain('meeting.meetingId ? meetingFile(meeting.meetingId) : conversationMeetingFile(conversationId)');
    expect(read('features/messages/useSchedulerActions.ts')).not.toContain('downloadIcs');
  });

  it('the event page, for a scheduled event with a time, from a file the page builds', () => {
    const s = read('features/sessions/SessionDetailPage.tsx');
    expect(s).toMatch(/<AddToCalendar\b/);
    expect(s).toMatch(/session\.status === 'scheduled' && session\.scheduledAt/);
    expect(s).toContain("fileName=\"reason-event.ics\"");
  });

  it('the files come from GET /meetings/:id/calendar.ics, or GET /dm/conversations/:id/meeting.ics for an old card', () => {
    const s = read('components/calendar/calendar-files.ts');
    expect(s).toContain("api.get(`/meetings/${encodeURIComponent(meetingId)}/calendar.ics`, { responseType: 'blob' })");
    expect(s).toContain("api.get(`/dm/conversations/${encodeURIComponent(conversationId)}/meeting.ics`, { responseType: 'blob' })");
  });
});
