// ─── An in-person event's place reaches people (30 Oct 2026, T12) ────────────────────────────────
//
// People invited to an event created on the preview often open it on production's client, which draws no place, so
// the emails say it: the invite and the registration confirmation read "In person, at {place}.", their Google
// Calendar and Outlook.com links (T7's buildCalendarLinks) carry the place, and the attached .ics has it as
// LOCATION with the event's page in the description. An event online is mailed exactly as before.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })),
}));
jest.mock('../../config', () => ({
  __esModule: true,
  default: { resendApiKey: 'test-key', emailFrom: 'noreply@rsn.network', clientUrl: 'https://app.rsn.network', magicLinkExpiryMinutes: 15 },
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn() }));

import * as emailService from '../../services/email/email.service';
import { buildSessionCalendarEvent, eventCalendarEntry } from '../../services/calendar/calendar.service';

beforeAll(() => emailService.__setSendPaceForTests({ now: () => Date.now(), pause: async () => {} }));
beforeEach(() => { mockSend.mockReset(); mockSend.mockResolvedValue({ data: { id: 'x' }, error: null }); mockQuery.mockReset(); });

const START = new Date('2026-11-20T19:00:00.000Z');
const PLACE = 'The Ivy, 1-5 West St, London';
const inPerson = {
  title: 'Founders dinner', description: 'REASON event — Founders dinner', startTime: START, durationMinutes: 180,
  organizerName: 'Host', organizerEmail: 'host@example.com', sessionId: 's-1', place: PLACE,
};
const online = { ...inPerson, place: undefined };

const sent = () => mockSend.mock.calls[0][0] as { html: string; text: string; attachments?: Array<{ filename: string; content: string }> };
/** The attached .ics, decoded (the email service sends attachments base64), with folded lines joined. */
const ics = () => Buffer.from(sent().attachments!.find((a) => a.filename === 'event.ics')!.content, 'base64')
  .toString('utf8').replace(/\r\n /g, '');

describe('the calendar entry of an event', () => {
  it('an in-person event: the place is where, the page goes in the details, and the links carry both', () => {
    const entry = eventCalendarEntry(inPerson, 'https://app.rsn.network');
    expect(entry.location).toBe(PLACE);
    expect(entry.description).toBe('REASON event — Founders dinner. Event page: https://app.rsn.network/sessions/s-1');
    const google = new URL(entry.links!.google);
    expect(google.searchParams.get('location')).toBe(PLACE);
    expect(google.searchParams.get('dates')).toBe('20261120T190000Z/20261120T220000Z');
    expect(new URL(entry.links!.outlook).searchParams.get('location')).toBe(PLACE);
  });

  it('an event online keeps its page as where, and no links', () => {
    expect(eventCalendarEntry(online, 'https://app.rsn.network')).toEqual({
      description: 'REASON event — Founders dinner', location: 'https://app.rsn.network/sessions/s-1',
    });
  });

  it('buildSessionCalendarEvent reads the place from an in-person row, and none from a meeting', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Dinner', scheduled_at: START.toISOString(), host_user_id: 'h', event_format: 'physical_event', config: { location: ` ${PLACE} `, durationMinutes: 180 } }] })
      .mockResolvedValueOnce({ rows: [{ display_name: 'Host', email: 'host@example.com' }] })
      .mockResolvedValueOnce({ rows: [{ title: 'Call', scheduled_at: START.toISOString(), host_user_id: 'h', event_format: 'video_meeting', config: { location: 'nowhere', durationMinutes: 60 } }] })
      .mockResolvedValueOnce({ rows: [{ display_name: 'Host', email: 'host@example.com' }] });
    expect(await buildSessionCalendarEvent('s-1')).toMatchObject({ place: PLACE, durationMinutes: 180 });
    expect((await buildSessionCalendarEvent('s-2'))!.place).toBeUndefined();
  });
});

describe('the invite email', () => {
  const invite = { inviterName: 'Stefan', type: 'session' as const, targetName: 'Founders dinner', inviteUrl: 'https://app.rsn.network/invite/ABC' };

  it('says where, with links that carry the place, and the .ics has it as LOCATION', async () => {
    await emailService.sendInviteEmail('delivered+guest@resend.dev', { ...invite, calendarEvent: inPerson });
    expect(sent().html).toContain(`In person, at <strong>${PLACE}</strong>.`);
    expect(sent().text).toContain(`In person, at ${PLACE}.`);
    expect(sent().text).toMatch(/Add to Google Calendar: https:\/\/calendar\.google\.com\/calendar\/render\?.*location=The\+Ivy/);
    expect(sent().text).toMatch(/Add to Outlook\.com: https:\/\/outlook\.live\.com\/.*location=The\+Ivy/);
    expect(ics()).toContain('LOCATION:The Ivy\\, 1-5 West St\\, London');
    expect(ics()).toContain('DESCRIPTION:REASON event — Founders dinner. Event page: https://app.rsn.network/sessions/s-1');
  });

  it('an online event\'s invite is as before: no place line, no links, its page as LOCATION', async () => {
    await emailService.sendInviteEmail('delivered+guest@resend.dev', { ...invite, calendarEvent: online });
    expect(sent().html).not.toContain('In person');
    expect(sent().html).not.toContain('Add to Google Calendar');
    expect(ics()).toContain('LOCATION:https://app.rsn.network/sessions/s-1');
    expect(ics()).toContain('DESCRIPTION:REASON event — Founders dinner\r\n');
  });
});

describe('the registration confirmation', () => {
  it('says where, and the .ics has the place', async () => {
    await emailService.sendSessionRegistrationConfirmationEmail('delivered+ana@resend.dev', {
      recipientName: 'Ana', sessionTitle: 'Founders dinner', sessionUrl: 'https://app.rsn.network/sessions/s-1', calendarEvent: inPerson,
    });
    expect(sent().html).toContain(`In person, at <strong>${PLACE}</strong>.`);
    expect(sent().text).toContain(`In person, at ${PLACE}.`);
    expect(ics()).toContain('LOCATION:The Ivy\\, 1-5 West St\\, London');
  });

  it('an online event is as before', async () => {
    await emailService.sendSessionRegistrationConfirmationEmail('delivered+ana@resend.dev', {
      recipientName: 'Ana', sessionTitle: 'Founders dinner', sessionUrl: 'https://app.rsn.network/sessions/s-1', calendarEvent: online,
    });
    expect(sent().html).not.toContain('In person');
    expect(sent().text).toBe("You're registered for Founders dinner. A calendar invite is attached.\n\nView event: https://app.rsn.network/sessions/s-1\n\nREASON — Meet people you have a reason to know.");
    expect(ics()).toContain('LOCATION:https://app.rsn.network/sessions/s-1');
  });
});
