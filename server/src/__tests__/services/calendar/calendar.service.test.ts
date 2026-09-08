// ─── Universal .ics (Stefan, 9 Sep 2026) ────────────────────────────────────
//
// The invite must open as a real event in Google, Outlook AND Apple. Outlook
// and Apple are strict about RFC 5545: lines over 75 octets must be folded,
// a SEQUENCE is expected, and the file ends with CRLF.

jest.mock('../../../db', () => ({ query: jest.fn(), __esModule: true }));

import { generateIcsContent } from '../../../services/calendar/calendar.service';

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
