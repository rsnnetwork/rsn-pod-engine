// ─── The meeting emails say when, in the reader's own zone (26 Oct 2026) ─────
//
// Stefan wants an email confirmation to both when they agree a time, and the meeting under Events.
// The subject now carries the time and names the zone it is written in: the recipient's own zone
// when REASON knows it, otherwise UTC, said out loud (Review Focus 1: 25 Oct 2026 was a clock-change
// day, and "12:00" with no zone read as the wrong hour). A moved meeting says it moved, a cancelled
// one is cancelled in every calendar, and 10 minutes before the start both people are reminded.
//
// The real email service runs; only the sending library, the config, the logger and the database are
// stand-ins, so nothing is sent.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })),
}));
jest.mock('../../../config', () => ({
  __esModule: true,
  default: { resendApiKey: 'test-key', emailFrom: 'noreply@rsn.network', clientUrl: 'https://app.rsn.network', magicLinkExpiryMinutes: 15 },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../db', () => ({ query: jest.fn(), transaction: jest.fn() }));

import { sendMeetingConfirmedEmail, sendMeetingCancelledEmail, sendMeetingReminderEmail } from '../../../services/email/email.service';

interface Sent {
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

async function sent(run: () => Promise<unknown>): Promise<Sent> {
  mockSend.mockReset().mockResolvedValue({ error: null });
  await run();
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0] as Sent;
}

const WALKTHROUGH = new Date('2026-10-25T12:00:00Z'); // Stefan and Claus's 13:00 in Copenhagen
const APP = 'https://app.rsn.network';
const confirmed = (extra: Record<string, unknown> = {}) => ({
  partnerName: 'Stefan',
  startAt: WALKTHROUGH,
  durationMin: 30,
  recipientTimezone: 'Europe/Copenhagen' as string | null,
  threadUrl: `${APP}/messages/c1`,
  eventsUrl: `${APP}/sessions`,
  googleCalendarUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE',
  icsContent: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  joinUrl: `${APP}/meet/c1?scheduled=1&kind=video`,
  kind: 'video' as const,
  ...extra,
});

describe('the confirmation email', () => {
  it('subject: Meeting confirmed: {partner} on {Sun 25 Oct, 13:00} ({zone}), in the recipient\'s users.timezone', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed()));
    expect(mail.subject).toMatch(/^Meeting confirmed: Stefan on Sun 25 Oct, 13:00 \((CET|GMT\+1)\)$/);
  });

  it('with no time zone on file, the subject is in UTC and says UTC', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed({ recipientTimezone: null })));
    expect(mail.subject).toBe('Meeting confirmed: Stefan on Sun 25 Oct, 12:00 (UTC)');
  });

  it('a time zone no calendar knows reads as UTC, named, and the email still goes out', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed({ recipientTimezone: 'Mars/Olympus' })));
    expect(mail.subject).toBe('Meeting confirmed: Stefan on Sun 25 Oct, 12:00 (UTC)');
  });

  it('the day before the clock change, the same 12:00 UTC is 14:00 summer time in Copenhagen', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed({ startAt: new Date('2026-10-24T12:00:00Z') })));
    expect(mail.subject).toMatch(/^Meeting confirmed: Stefan on Sat 24 Oct, 14:00 \((CEST|GMT\+2)\)$/);
  });

  it('the body gives the day and time in full with the same zone', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed({ recipientTimezone: 'UTC' })));
    expect(mail.html).toContain('<strong>Sunday 25 October, 12:00 (UTC)</strong>');
    expect(mail.text).toContain('Sunday 25 October, 12:00 (UTC)');
  });

  it('links Events, where the meeting is listed: "See it in Events"', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed()));
    expect(mail.html).toMatch(/<a href="https:\/\/app\.rsn\.network\/sessions"[^>]*>See it in Events<\/a>/);
    expect(mail.text).toContain('See it in Events: https://app.rsn.network/sessions');
  });

  it('a moved meeting says it moved, in the subject and the first line', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed({ moved: true, recipientTimezone: 'UTC' })));
    expect(mail.subject).toBe('Meeting moved: Stefan on Sun 25 Oct, 12:00 (UTC)');
    expect(mail.html).toContain('Your meeting with <strong>Stefan</strong> has moved.');
    expect(mail.text).toContain('Your meeting with Stefan has moved.');
    expect(mail.html).not.toContain('is confirmed.');
  });

  it('still carries the invite as a calendar REQUEST', async () => {
    const mail = await sent(() => sendMeetingConfirmedEmail('delivered+claus@resend.dev', 'Claus', confirmed()));
    expect(mail.attachments?.[0]).toMatchObject({ filename: 'meeting.ics', contentType: 'text/calendar; charset=utf-8; method=REQUEST' });
  });
});

describe('the cancellation email', () => {
  const cancelled = (extra: Record<string, unknown> = {}) => ({
    partnerName: 'Bo',
    cancellerName: 'Ana',
    cancelledByMe: false,
    startAt: new Date('2026-11-05T17:00:00Z'),
    durationMin: 30,
    kind: 'video' as const,
    recipientTimezone: 'Europe/Berlin' as string | null,
    threadUrl: `${APP}/messages/c1`,
    icsContent: 'BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n',
    ...extra,
  });

  it('subject: Meeting cancelled: {partner} on {when} ({zone})', async () => {
    const mail = await sent(() => sendMeetingCancelledEmail('delivered+bo@resend.dev', 'Bo', cancelled({ partnerName: 'Ana' })));
    expect(mail.subject).toMatch(/^Meeting cancelled: Ana on Thu 5 Nov, 18:00 \((CET|GMT\+1)\)$/);
  });

  it('tells the other person who cancelled, and the canceller that they did', async () => {
    const toBo = await sent(() => sendMeetingCancelledEmail('delivered+bo@resend.dev', 'Bo', cancelled({ partnerName: 'Ana', cancellerName: 'Ana', cancelledByMe: false })));
    expect(toBo.html).toContain('<strong>Ana</strong> cancelled your meeting.');
    expect(toBo.text).toContain('Ana cancelled your meeting.');
    const toAna = await sent(() => sendMeetingCancelledEmail('delivered+ana@resend.dev', 'Ana', cancelled({ partnerName: 'Bo', cancellerName: 'Ana', cancelledByMe: true })));
    expect(toAna.html).toContain('You cancelled your meeting with <strong>Bo</strong>.');
    expect(toAna.text).toContain('You cancelled your meeting with Bo.');
  });

  it('attaches the METHOD:CANCEL calendar file, so the entry leaves the calendar, and links the chat to pick a new time', async () => {
    const mail = await sent(() => sendMeetingCancelledEmail('delivered+bo@resend.dev', 'Bo', cancelled()));
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments![0]).toMatchObject({ filename: 'meeting.ics', contentType: 'text/calendar; charset=utf-8; method=CANCEL' });
    expect(Buffer.from(mail.attachments![0].content, 'base64').toString('utf8')).toContain('METHOD:CANCEL');
    expect(mail.html).toMatch(/<a href="https:\/\/app\.rsn\.network\/messages\/c1"[^>]*>Open the conversation<\/a>/);
    expect(mail.text).toContain('Open the conversation to pick a new time: https://app.rsn.network/messages/c1');
  });
});

describe('the reminder email', () => {
  const reminder = (extra: Record<string, unknown> = {}) => ({
    partnerName: 'Bo',
    startAt: new Date('2026-11-05T17:00:00Z'),
    durationMin: 45,
    kind: 'audio' as const,
    recipientTimezone: 'UTC' as string | null,
    minutesToGo: 10,
    joinUrl: `${APP}/meet/c1?scheduled=1&kind=audio`,
    eventsUrl: `${APP}/sessions`,
    ...extra,
  });

  it('subject: Your meeting with {name} starts in 10 minutes', async () => {
    const mail = await sent(() => sendMeetingReminderEmail('delivered+ana@resend.dev', 'Ana', reminder()));
    expect(mail.subject).toBe('Your meeting with Bo starts in 10 minutes');
  });

  it('a late reminder says how long is really left', async () => {
    expect((await sent(() => sendMeetingReminderEmail('delivered+ana@resend.dev', 'Ana', reminder({ minutesToGo: 3 })))).subject)
      .toBe('Your meeting with Bo starts in 3 minutes');
    expect((await sent(() => sendMeetingReminderEmail('delivered+ana@resend.dev', 'Ana', reminder({ minutesToGo: 1 })))).subject)
      .toBe('Your meeting with Bo starts in 1 minute');
  });

  it('says when, what kind of call and how long, with a Join button and the Events link', async () => {
    const mail = await sent(() => sendMeetingReminderEmail('delivered+ana@resend.dev', 'Ana', reminder()));
    expect(mail.html).toContain('<strong>Thursday 5 November, 17:00 (UTC)</strong>');
    expect(mail.html).toContain('Audio call · 45 minutes');
    expect(mail.html).toMatch(/<a href="https:\/\/app\.rsn\.network\/meet\/c1\?scheduled=1&amp;kind=audio"[^>]*>Join the call<\/a>/);
    expect(mail.html).toMatch(/<a href="https:\/\/app\.rsn\.network\/sessions"[^>]*>See it in Events<\/a>/);
    expect(mail.text).toContain('Join the call: https://app.rsn.network/meet/c1?scheduled=1&kind=audio');
    expect(mail.text).toContain('Thursday 5 November, 17:00 (UTC)');
  });
});
