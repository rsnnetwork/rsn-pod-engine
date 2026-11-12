// ─── Universal .ics (Stefan, 9 Sep 2026) ────────────────────────────────────
//
// The invite must open as a real event in Google, Outlook AND Apple. Outlook
// and Apple are strict about RFC 5545: lines over 75 octets must be folded,
// a SEQUENCE is expected, and the file ends with CRLF.

jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));

import {
  buildCalendarLinks, buildGoogleCalendarUrl, generateIcsContent, meetingCalendarUid,
} from '../../../services/calendar/calendar.service';

const base = {
  title: 'RSN meeting',
  startTime: new Date('2026-09-10T13:30:00Z'),
  durationMinutes: 30,
  attendees: [{ name: 'Ana', email: 'ana@example.com' }, { name: 'Bo', email: 'bo@example.com' }],
};

// Long lines (e.g. ATTENDEE) are folded per RFC 5545; unfold before asserting
// on their content, the way a calendar client does.
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

it('is a METHOD:REQUEST invite with both attendees and an RSVP', () => {
  const ics = generateIcsContent(base);
  expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
  expect(ics).toMatch(/METHOD:REQUEST/);
  expect(ics).toMatch(/DTSTART:20260910T133000Z/);
  expect(ics).toMatch(/DTEND:20260910T140000Z/);
  const flat = unfold(ics);
  expect(flat).toMatch(/ATTENDEE;CN=Ana;.*RSVP=TRUE:mailto:ana@example\.com/);
  expect(flat).toMatch(/ATTENDEE;CN=Bo;.*RSVP=TRUE:mailto:bo@example\.com/);
  expect(ics).toMatch(/SEQUENCE:0/);
});

it('ends with CRLF so strict parsers accept the last line', () => {
  expect(generateIcsContent(base).endsWith('END:VCALENDAR\r\n')).toBe(true);
});

it('folds lines longer than 75 octets (RFC 5545) so a long description survives Outlook/Apple', () => {
  const description = 'A 1:1 video call on RSN with someone. Join: https://app.rsn.network/meet/0123456789abcdef-0123-4567-89ab-cdef01234567?scheduled=1&kind=video';
  const ics = generateIcsContent({ ...base, description });
  for (const line of ics.split('\r\n')) {
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  }
  // Continuation lines start with a single space, and unfolding restores the text.
  const unfolded = ics.replace(/\r\n /g, '');
  expect(unfolded).toContain(`DESCRIPTION:${description.replace(/,/g, '\\,')}`);
});

it('leaves short lines unfolded', () => {
  const ics = generateIcsContent(base);
  expect(ics).toContain('\r\nSUMMARY:RSN meeting\r\n');
});

// ── A meeting's calendar identity (26 Oct 2026, CON-04/05) ────────────────────
// Every copy of one meeting's file carries the same UID, from the meeting's own id: both emails, every
// move and the in-app "Add to calendar". Before, the UID held the start time, so a move made a NEW entry
// and the old time stayed in everyone's calendar, and SEQUENCE was always 0, so no update could win.
describe('a meeting\'s calendar identity', () => {
  it('is meeting-<id>@rsn.network, the same for the same meeting whatever its time', () => {
    expect(meetingCalendarUid('2f6c1d9e-0d6e-4c1b-9a4f-6f0b1c2d3e4f')).toBe('meeting-2f6c1d9e-0d6e-4c1b-9a4f-6f0b1c2d3e4f');
    const first = generateIcsContent({ ...base, uid: meetingCalendarUid('m-1') });
    const moved = generateIcsContent({ ...base, startTime: new Date('2026-09-11T09:00:00Z'), uid: meetingCalendarUid('m-1'), sequence: 1 });
    expect(first).toContain('\r\nUID:meeting-m-1@rsn.network\r\n');
    expect(moved).toContain('\r\nUID:meeting-m-1@rsn.network\r\n');
  });

  it('carries the SEQUENCE it is given, so a moved meeting\'s file updates the entry already in the calendar', () => {
    expect(generateIcsContent({ ...base, uid: 'meeting-m-1', sequence: 2 })).toContain('\r\nSEQUENCE:2\r\n');
    expect(generateIcsContent({ ...base, uid: 'meeting-m-1', sequence: 2 })).not.toContain('SEQUENCE:0');
  });

  it('is still a REQUEST at SEQUENCE 0 when nothing says otherwise (event invites are unchanged)', () => {
    const ics = generateIcsContent(base);
    expect(ics).toContain('\r\nMETHOD:REQUEST\r\n');
    expect(ics).toContain('\r\nSEQUENCE:0\r\n');
    expect(ics).toContain('\r\nSTATUS:CONFIRMED\r\n');
    expect(ics).toContain('\r\nBEGIN:VALARM\r\n');
  });

  it('a cancellation is METHOD:CANCEL with STATUS:CANCELLED, the same UID, its SEQUENCE, both attendees and no alarm', () => {
    const ics = generateIcsContent({
      ...base, uid: meetingCalendarUid('m-1'), sequence: 3, method: 'CANCEL',
      organizerName: 'Ana', organizerEmail: 'ana@example.com',
    });
    const flat = unfold(ics);
    expect(ics).toContain('\r\nMETHOD:CANCEL\r\n');
    expect(ics).not.toContain('METHOD:REQUEST');
    expect(ics).toContain('\r\nUID:meeting-m-1@rsn.network\r\n');
    expect(ics).toContain('\r\nSEQUENCE:3\r\n');
    expect(ics).toContain('\r\nSTATUS:CANCELLED\r\n');
    expect(ics).not.toContain('STATUS:CONFIRMED');
    expect(ics).not.toContain('VALARM');
    expect(flat).toContain('ORGANIZER;CN=Ana:mailto:ana@example.com');
    // Nobody is asked to answer a cancellation.
    expect(flat).toMatch(/ATTENDEE;CN=Ana;ROLE=REQ-PARTICIPANT:mailto:ana@example\.com/);
    expect(flat).toMatch(/ATTENDEE;CN=Bo;ROLE=REQ-PARTICIPANT:mailto:bo@example\.com/);
    expect(flat).not.toMatch(/RSVP=TRUE/);
    expect(ics).toContain('DTSTART:20260910T133000Z');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});

// ── Add to calendar by link (1 Nov 2026, 30 Oct review 5b; L10) ──────────────────
// Google's template link and Outlook.com's compose link, from one builder: a title, the UTC start and end,
// details that carry the join link, and where (the join link for a call, the place for an in-person event).
// A template link cannot carry a UID, so these make an entry of their own; the file and the emailed invite
// are the ones a move or a cancel updates.
describe('the calendar template links', () => {
  const entry = {
    title: 'Meeting with Bo on REASON',
    start: new Date('2026-11-05T17:00:00.000Z'),
    end: new Date('2026-11-05T17:30:00.000Z'),
    details: 'Video call on REASON. Join: https://app.rsn.network/meet/c1?scheduled=1&kind=video',
    location: 'https://app.rsn.network/meet/c1?scheduled=1&kind=video',
  };

  it('Google: the title, the UTC dates in the compact form, details with the join link, and where', () => {
    const url = new URL(buildCalendarLinks(entry).google);
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Meeting with Bo on REASON');
    expect(url.searchParams.get('dates')).toBe('20261105T170000Z/20261105T173000Z');
    expect(url.searchParams.get('details')).toBe(entry.details);
    expect(url.searchParams.get('location')).toBe(entry.location);
  });

  it('Outlook.com: the same entry on its compose page, the times in UTC ISO form', () => {
    const url = new URL(buildCalendarLinks(entry).outlook);
    expect(`${url.origin}${url.pathname}`).toBe('https://outlook.live.com/calendar/0/deeplink/compose');
    expect(url.searchParams.get('path')).toBe('/calendar/action/compose');
    expect(url.searchParams.get('rru')).toBe('addevent');
    expect(url.searchParams.get('subject')).toBe('Meeting with Bo on REASON');
    expect(url.searchParams.get('startdt')).toBe('2026-11-05T17:00:00Z');
    expect(url.searchParams.get('enddt')).toBe('2026-11-05T17:30:00Z');
    expect(url.searchParams.get('body')).toBe(entry.details);
    expect(url.searchParams.get('location')).toBe(entry.location);
  });

  it('an in-person place goes in as it is written, & and spaces included', () => {
    const links = buildCalendarLinks({ ...entry, location: 'Café Nord, Østergade 1 & 2, Copenhagen' });
    expect(new URL(links.google).searchParams.get('location')).toBe('Café Nord, Østergade 1 & 2, Copenhagen');
    expect(new URL(links.outlook).searchParams.get('location')).toBe('Café Nord, Østergade 1 & 2, Copenhagen');
  });

  it('with no place, neither link has a location', () => {
    const { location: _unused, ...noPlace } = entry;
    const links = buildCalendarLinks(noPlace);
    expect(new URL(links.google).searchParams.has('location')).toBe(false);
    expect(new URL(links.outlook).searchParams.has('location')).toBe(false);
  });

  it('the older Google builder (title, start, length, description) still answers the same link', () => {
    expect(buildGoogleCalendarUrl({ title: 'REASON meeting', startTime: entry.start, durationMinutes: 30, description: 'x' }))
      .toBe('https://calendar.google.com/calendar/render?action=TEMPLATE&text=REASON+meeting&dates=20261105T170000Z%2F20261105T173000Z&details=x');
  });
});
