// ─── Every email says REASON, and its header is white (21 Oct 2026) ──────────
//
// The client's 19 Oct feedback: "Call it REASON everywhere" and "the whole email
// header should be white". Every email the service can send is rendered here with
// sample data and read back: the subject, the HTML, the plain text and any calendar
// file. Nothing says RSN (the address rsn.network and file names such as rsn-logo.png
// are not words anyone reads, so they are fine), the header band is white, the lockup
// is the REASON one, and the card is closed exactly once with nothing left open.
//
// The real email service runs. Only the sending library, the config, the logger and the
// database are replaced, so nothing is sent: the library's send() keeps what would have gone out.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })),
}));
jest.mock('../../config', () => ({
  __esModule: true,
  default: {
    resendApiKey: 'test-key',
    emailFrom: 'noreply@rsn.network',
    clientUrl: 'https://app.rsn.network',
    magicLinkExpiryMinutes: 15,
  },
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn() }));

import * as emailService from '../../services/email/email.service';

interface Sent {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string; contentType?: string }[];
}

/** Sends one email and returns what went out. */
async function sendAndCapture(run: () => Promise<unknown>): Promise<Sent> {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ error: null });
  await run();
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0] as Sent;
}

const MEET = 'REASON — Meet people you have a reason to know.';
const FAST = 'REASON — Fast, focused, and human.';
const STARTS = new Date('2026-11-05T17:00:00Z');
// No description, so the fallback description is the one that gets written.
const aCalendarEvent = { title: 'Founders Evening', startTime: STARTS, durationMinutes: 60, organizerEmail: 'host@example.com' };
const aStubCalendarFile = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

interface EmailCase {
  /** The exported function this exercises. */
  fn: keyof typeof emailService;
  label: string;
  subject: string;
  run: () => Promise<unknown>;
  /** The one email that does not use the shared card. */
  shell?: false;
  /** The brand line the plain text ends with. */
  brandLine?: string;
  /** ...and the HTML carries the same line under the card. */
  brandLineInHtml?: boolean;
  /** A line that sits under the card, not inside it. */
  underCard?: string;
  /** Words that must be in the HTML and in the plain text. */
  says?: string[];
}

const adminReview = (applicantLinkedinUrl: string | null) => ({
  adminDisplayName: 'Ada',
  applicantName: 'Sam Applicant',
  applicantEmail: 'sam@example.com',
  applicantLinkedinUrl,
  applicantReason: 'I run a studio and want to meet other founders.',
  approveUrl: 'https://app.rsn.network/admin/jr/aaaa',
  rejectUrl: 'https://app.rsn.network/admin/jr/bbbb',
  dashboardUrl: 'https://app.rsn.network/admin/join-requests',
  expiresInHours: 48,
});

const meetingConfirmed = (extra: Record<string, unknown> = {}) => ({
  partnerName: 'Bo',
  startAt: STARTS,
  durationMin: 30,
  recipientTimezone: 'Europe/Berlin',
  threadUrl: 'https://app.rsn.network/messages/c1',
  googleCalendarUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE',
  icsContent: aStubCalendarFile,
  ...extra,
});

const cases: EmailCase[] = [
  {
    fn: 'sendMagicLinkEmail', label: 'the sign-in link', subject: 'Sign in to REASON',
    underCard: "If you didn't request this email, you can safely ignore it.",
    run: () => emailService.sendMagicLinkEmail('delivered+ana@resend.dev', 'https://app.rsn.network/auth/verify?token=abc'),
  },
  {
    fn: 'sendSessionRecapEmail', label: 'the event recap', subject: 'Your REASON Recap — Founders Evening',
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendSessionRecapEmail('delivered+ana@resend.dev', 'Ana', {
      sessionTitle: 'Founders Evening', peopleMet: 5, mutualConnections: 2, avgRating: 4.2, recapUrl: 'https://app.rsn.network/sessions/1/recap',
    }),
  },
  {
    fn: 'sendDmNotificationEmail', label: 'a new message', subject: 'Fatima sent you a message on REASON',
    brandLine: MEET, underCard: "You're receiving this because someone messaged you on REASON.",
    says: ['sent you a message on REASON'],
    run: () => emailService.sendDmNotificationEmail('delivered+ana@resend.dev', 'Ana', {
      senderName: 'Fatima', snippet: 'Are you free on Thursday?', threadUrl: 'https://app.rsn.network/messages/c1',
    }),
  },
  {
    fn: 'sendHostRecapEmail', label: 'the host recap', subject: 'Host Recap — Founders Evening',
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendHostRecapEmail('delivered+host@resend.dev', 'Host', {
      sessionTitle: 'Founders Evening', totalParticipants: 12, totalRounds: 5, totalMatches: 20, matchesCreated: 24,
      avgEventRating: 4.1, mutualConnectionsCount: 8, recapUrl: 'https://app.rsn.network/sessions/1/recap',
    }),
  },
  {
    fn: 'sendInviteEmail', label: 'a platform invite', subject: 'Stefan invited you to REASON',
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendInviteEmail('delivered+guest@resend.dev', { inviterName: 'Stefan', type: 'platform', inviteUrl: 'https://app.rsn.network/invite/ABC123' }),
  },
  {
    fn: 'sendInviteEmail', label: 'a pod invite', subject: 'Stefan invited you to Founding Pod',
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendInviteEmail('delivered+guest@resend.dev', { inviterName: 'Stefan', type: 'pod', targetName: 'Founding Pod', inviteUrl: 'https://app.rsn.network/invite/ABC123' }),
  },
  {
    fn: 'sendInviteEmail', label: 'a circle invite', subject: 'Claus invited you to Nordic Founders',
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendInviteEmail('delivered+guest@resend.dev', { inviterName: 'Claus', type: 'circle', targetName: 'Nordic Founders', inviteUrl: 'https://app.rsn.network/invite/ABC123' }),
  },
  {
    fn: 'sendInviteEmail', label: 'an event invite with a calendar file', subject: 'Stefan invited you to Founders Evening',
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendInviteEmail('delivered+guest@resend.dev', {
      inviterName: 'Stefan', type: 'session', targetName: 'Founders Evening', inviteUrl: 'https://app.rsn.network/invite/ABC123',
      calendarEvent: { ...aCalendarEvent, sessionId: 's-1' },
    }),
  },
  {
    fn: 'sendSessionRegistrationConfirmationEmail', label: 'the event registration', subject: "You're registered — Founders Evening",
    brandLine: MEET, brandLineInHtml: true,
    run: () => emailService.sendSessionRegistrationConfirmationEmail('delivered+ana@resend.dev', {
      recipientName: 'Ana', sessionTitle: 'Founders Evening', sessionUrl: 'https://app.rsn.network/sessions/s-1',
      calendarEvent: { ...aCalendarEvent, sessionId: 's-1' },
    }),
  },
  {
    fn: 'sendJoinRequestConfirmationEmail', label: 'the request received', subject: 'REASON — We received your request',
    brandLine: FAST, brandLineInHtml: true,
    says: [
      'Thank you for requesting to join REASON.',
      // 25 Oct review: REASON is for everyone, not only founders.
      'REASON is an invite-only community for professionals of every kind, from founders to employees, investors and advisors, who value honesty over hype.',
    ],
    run: () => emailService.sendJoinRequestConfirmationEmail('delivered+sam@resend.dev', 'Sam'),
  },
  {
    fn: 'sendJoinRequestWelcomeEmail', label: 'the welcome after approval', subject: "Welcome to REASON — You're in!",
    brandLine: FAST, brandLineInHtml: true,
    says: [
      'your request to join REASON has been',
      'Sign In to REASON',
      "You're now part of a community of professionals of every kind, from founders to employees, investors and advisors, who connect with honesty and purpose.",
    ],
    run: () => emailService.sendJoinRequestWelcomeEmail('delivered+sam@resend.dev', 'Sam', 'https://app.rsn.network/auth/verify?token=abc'),
  },
  {
    fn: 'sendJoinRequestDeclineEmail', label: 'the decline', subject: 'REASON — Update on your request',
    brandLine: FAST, brandLineInHtml: true,
    says: ['Thank you for your interest in REASON.', 'REASON is a curated community'],
    run: () => emailService.sendJoinRequestDeclineEmail('delivered+sam@resend.dev', 'Sam'),
  },
  {
    fn: 'sendJoinRequestReminderEmail', label: 'the first reminder', subject: "REASON — Don't forget to complete your signup!",
    brandLine: FAST, brandLineInHtml: true,
    says: ['You were approved to join REASON!'],
    run: () => emailService.sendJoinRequestReminderEmail('delivered+sam@resend.dev', 'Sam', 'https://app.rsn.network/login', 1),
  },
  {
    fn: 'sendJoinRequestReminderEmail', label: 'the second reminder', subject: 'REASON — Your spot is still waiting',
    brandLine: FAST, brandLineInHtml: true,
    says: ['Your approved spot at REASON is still reserved'],
    run: () => emailService.sendJoinRequestReminderEmail('delivered+sam@resend.dev', 'Sam', 'https://app.rsn.network/login', 2),
  },
  {
    fn: 'sendGenericEmail', label: 'a message from an admin', subject: 'A note from the team',
    brandLine: FAST, brandLineInHtml: true,
    run: () => emailService.sendGenericEmail('delivered+sam@resend.dev', 'Sam', { subject: 'A note from the team', body: 'Thanks for your patience.' }),
  },
  {
    fn: 'sendJoinRequestAdminReviewEmail', label: 'the admin review (with a LinkedIn link)', subject: 'New REASON join request — Sam Applicant',
    brandLine: FAST, brandLineInHtml: true,
    says: ['A new request to join REASON just came in.', 'Why REASON'],
    run: () => emailService.sendJoinRequestAdminReviewEmail('delivered+ada@resend.dev', adminReview('https://www.linkedin.com/in/sam-applicant')),
  },
  {
    fn: 'sendJoinRequestAdminReviewEmail', label: 'the admin review (no LinkedIn address)', subject: 'New REASON join request — Sam Applicant',
    brandLine: FAST, brandLineInHtml: true,
    says: ['A new request to join REASON just came in.', 'Why REASON'],
    run: () => emailService.sendJoinRequestAdminReviewEmail('delivered+ada@resend.dev', adminReview(null)),
  },
  {
    fn: 'sendPokeReceivedEmail', label: 'a meeting request with a note', subject: 'Fatima wants to meet you on REASON',
    brandLine: MEET, underCard: "You're receiving this because someone wants to meet you on REASON.",
    says: ['wants to meet you on REASON.'],
    run: () => emailService.sendPokeReceivedEmail('delivered+ana@resend.dev', 'Ana', {
      senderName: 'Fatima', introMessage: 'I would value your view on our seed round.', messagesUrl: 'https://app.rsn.network/messages',
    }),
  },
  {
    fn: 'sendPokeReceivedEmail', label: 'a meeting request without a note', subject: 'Fatima wants to meet you on REASON',
    brandLine: MEET, underCard: "You're receiving this because someone wants to meet you on REASON.",
    says: ['wants to meet you on REASON.'],
    run: () => emailService.sendPokeReceivedEmail('delivered+ana@resend.dev', 'Ana', { senderName: 'Fatima', introMessage: null, messagesUrl: 'https://app.rsn.network/messages' }),
  },
  {
    fn: 'sendPokeAcceptedEmail', label: 'a meeting request accepted', subject: 'Bo accepted your meeting request',
    brandLine: MEET, underCard: "You're receiving this because your meeting request was accepted on REASON.",
    run: () => emailService.sendPokeAcceptedEmail('delivered+ana@resend.dev', 'Ana', { accepterName: 'Bo', messagesUrl: 'https://app.rsn.network/messages' }),
  },
  {
    fn: 'sendLlmBalanceAlertEmail', label: 'the balance alert', subject: 'REASON: Anthropic balance is empty, onboarding chat and LinkedIn fill are down',
    shell: false,
    run: () => emailService.sendLlmBalanceAlertEmail({ to: 'delivered+ops@resend.dev', where: 'onboarding chat', at: '2026-11-05T17:00:00Z' }),
  },
  // 26 Oct 2026: the subject carries the time, in the recipient's zone (Berlin here), with the zone named.
  {
    fn: 'sendMeetingConfirmedEmail', label: 'a confirmed meeting with a join link', subject: 'Meeting confirmed: Bo on Thu 5 Nov, 18:00 (CET)',
    brandLine: MEET,
    run: () => emailService.sendMeetingConfirmedEmail('delivered+ana@resend.dev', 'Ana', meetingConfirmed({
      joinUrl: 'https://app.rsn.network/meet/c1?scheduled=1&kind=video', kind: 'video', eventsUrl: 'https://app.rsn.network/sessions',
    })),
  },
  {
    fn: 'sendMeetingConfirmedEmail', label: 'a confirmed meeting without a join link', subject: 'Meeting confirmed: Bo on Thu 5 Nov, 18:00 (CET)',
    brandLine: MEET,
    run: () => emailService.sendMeetingConfirmedEmail('delivered+ana@resend.dev', 'Ana', meetingConfirmed()),
  },
  {
    fn: 'sendMeetingConfirmedEmail', label: 'a moved meeting', subject: 'Meeting moved: Bo on Thu 5 Nov, 18:00 (CET)',
    brandLine: MEET,
    run: () => emailService.sendMeetingConfirmedEmail('delivered+ana@resend.dev', 'Ana', meetingConfirmed({ moved: true })),
  },
  {
    fn: 'sendMeetingCancelledEmail', label: 'a cancelled meeting', subject: 'Meeting cancelled: Bo on Thu 5 Nov, 18:00 (CET)',
    brandLine: MEET,
    run: () => emailService.sendMeetingCancelledEmail('delivered+ana@resend.dev', 'Ana', {
      partnerName: 'Bo', cancellerName: 'Bo', cancelledByMe: false, startAt: STARTS, durationMin: 30, kind: 'video',
      recipientTimezone: 'Europe/Berlin', threadUrl: 'https://app.rsn.network/messages/c1', icsContent: aStubCalendarFile,
    }),
  },
  {
    fn: 'sendMeetingReminderEmail', label: 'a meeting reminder', subject: 'Your meeting with Bo starts in 10 minutes',
    brandLine: MEET,
    run: () => emailService.sendMeetingReminderEmail('delivered+ana@resend.dev', 'Ana', {
      partnerName: 'Bo', startAt: STARTS, durationMin: 30, kind: 'video', recipientTimezone: 'Europe/Berlin', minutesToGo: 10,
      joinUrl: 'https://app.rsn.network/meet/c1?scheduled=1&kind=video', eventsUrl: 'https://app.rsn.network/sessions',
    }),
  },
];

const count = (haystack: string, pattern: RegExp) => (haystack.match(pattern) ?? []).length;

/** How many <div>s are open where the text first appears: 0 outside everything, 1 inside the page, 2 inside the card. */
function divDepthAt(html: string, needle: string): number {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" is not in the email`);
  const before = html.slice(0, at);
  return count(before, /<div\b/g) - count(before, /<\/div>/g);
}

/** The lines that still say RSN as a word, so a failure shows what to change. */
const rsnLines = (s: string) => s.split(/\r?\n/).filter((line) => /\bRSN\b/.test(line)).map((line) => line.trim());

/** The calendar files that went out, unfolded the way a calendar client reads them. */
const calendarFiles = (sent: Sent) => (sent.attachments ?? [])
  .filter((a) => a.filename.endsWith('.ics'))
  .map((a) => Buffer.from(a.content, 'base64').toString('utf8').replace(/\r\n[ \t]/g, ''));

const labelled = cases.map((c) => [c.label, c] as const);
const shelled = labelled.filter(([, c]) => c.shell !== false);

describe('every email says REASON, never RSN', () => {
  it('covers every function the email service exports for sending', () => {
    const exported = Object.keys(emailService).filter((name) => /^send\w*Email$/.test(name)).sort();
    expect([...new Set(cases.map((c) => c.fn))].sort()).toEqual(exported);
  });

  it.each(labelled)('%s: no subject, HTML, plain text or calendar file says RSN', async (_label, c) => {
    const sent = await sendAndCapture(c.run);
    expect(rsnLines(sent.subject)).toEqual([]);
    expect(rsnLines(sent.html)).toEqual([]);
    expect(rsnLines(sent.text)).toEqual([]);
    for (const file of calendarFiles(sent)) {
      // The PRODID line names the program that wrote the file; no calendar shows it to a person.
      expect(rsnLines(file.split('\r\n').filter((line) => !line.startsWith('PRODID:')).join('\r\n'))).toEqual([]);
    }
  });

  // The tagline under the logo, "Connect with Reason", is the brand line and stays as it is. Everywhere
  // else the product is REASON: a subject, a sentence, the plain text.
  it.each(labelled)('%s: names the product REASON, and "Reason" only in the tagline', async (_label, c) => {
    const sent = await sendAndCapture(c.run);
    const sayingReason = (s: string) => s.split(/\r?\n/)
      .filter((line) => /\bReason\b/.test(line.replace('Connect with Reason', '')))
      .map((line) => line.trim());
    expect(sayingReason(sent.subject)).toEqual([]);
    expect(sayingReason(sent.html)).toEqual([]);
    expect(sayingReason(sent.text)).toEqual([]);
  });

  it.each(labelled)('%s: comes from REASON, with the subject the brief gives', async (_label, c) => {
    const sent = await sendAndCapture(c.run);
    expect(sent.from).toBe('REASON <noreply@rsn.network>');
    expect(sent.subject).toBe(c.subject);
  });

  it.each(labelled.filter(([, c]) => c.says))('%s: the words that named the product now name REASON', async (_label, c) => {
    const sent = await sendAndCapture(c.run);
    for (const words of c.says!) {
      expect(sent.html).toContain(words);
      expect(sent.text).toContain(words);
    }
  });

  it.each(labelled.filter(([, c]) => c.brandLine))('%s: the footer line is the brand line, in the plain text and under the card', async (_label, c) => {
    const sent = await sendAndCapture(c.run);
    expect(sent.text.trimEnd().split('\n').pop()).toBe(c.brandLine);
    if (c.brandLineInHtml) expect(divDepthAt(sent.html, c.brandLine!)).toBe(1);
  });

  // The 25 Oct review (ONB-02): Claus, an employee, read that REASON was for "founders, leaders, and company
  // owners". No email says that any more.
  it.each(labelled)('%s: never says REASON is only for founders, leaders and company owners', async (_label, c) => {
    const sent = await sendAndCapture(c.run);
    for (const part of [sent.subject, sent.html, sent.text]) expect(part).not.toMatch(/founders, leaders,? and company owners/i);
  });

  it('the join-request review email says "Why REASON" in its label and in its plain text', async () => {
    const sent = await sendAndCapture(cases.find((c) => c.label === 'the admin review (with a LinkedIn link)')!.run);
    expect(sent.html).toMatch(/>Why REASON<\/td>/);
    expect(sent.text).toContain('Why REASON: I run a studio and want to meet other founders.');
  });

  it('the meeting emails and the registration email write REASON into the calendar file they attach', async () => {
    const invite = await sendAndCapture(cases.find((c) => c.label === 'an event invite with a calendar file')!.run);
    const registered = await sendAndCapture(cases.find((c) => c.label === 'the event registration')!.run);
    for (const sent of [invite, registered]) {
      const [file] = calendarFiles(sent);
      expect(file).toContain('DESCRIPTION:REASON event — Founders Evening');
    }
  });

  it('the join link line in the confirmed-meeting email names REASON', async () => {
    const sent = await sendAndCapture(cases.find((c) => c.label === 'a confirmed meeting with a join link')!.run);
    expect(sent.html).toContain('The Join link opens the call on REASON at meeting time.');
  });

  it('the meeting-accepted email tells the sender they are connected on REASON', async () => {
    const sent = await sendAndCapture(cases.find((c) => c.label === 'a meeting request accepted')!.run);
    expect(sent.text).toContain('accepted your meeting request on REASON.');
  });
});

describe('every email opens on a white header with the REASON lockup', () => {
  it('the shell is a white band, the lockup at 160 by 35, the tagline and the red strip', () => {
    const open = emailService.emailCardOpen();
    expect(open).toContain('<div style="background:#ffffff;padding:28px 32px 22px 32px;text-align:center;">');
    expect(open).toContain('<img src="https://app.rsn.network/reason-logo.png" alt="REASON" width="160" height="35"');
    expect(open).not.toContain('height="auto"');
    expect(open).not.toContain('#f4f5f8');
    expect(open).toContain('Connect with Reason');
    expect(open).toContain('<div style="height:4px;background:#DE322E;');
  });

  it.each(shelled)('%s: the header is white and the lockup is the REASON one', async (_label, c) => {
    const { html } = await sendAndCapture(c.run);
    expect(html).toContain('<div style="background:#ffffff;padding:28px 32px 22px 32px;text-align:center;">');
    expect(html).toContain('src="https://app.rsn.network/reason-logo.png"');
    expect(html).toContain('alt="REASON"');
    expect(html).toMatch(/<img [^>]*width="160" height="35"/);
    expect(html).not.toContain('height="auto"');
    expect(html).not.toContain('/rsn-logo.png');
    expect(html).not.toContain('#f4f5f8');
    expect(html).toContain('Connect with Reason');
    expect(html).toContain('height:4px;background:#DE322E');
  });

  // The email loads the lockup from the client's own site, so the file has to be there, and the
  // old lockup has to stay for the emails that are already in people's inboxes.
  it('the lockup the email loads is in the client\'s public folder, and the old one is still there', () => {
    const fs: typeof import('fs') = require('fs');
    const path: typeof import('path') = require('path');
    const publicFolder = path.join(__dirname, '../../../../client/public');
    const present = (file: string) => ({ file, exists: fs.existsSync(path.join(publicFolder, file)) });
    expect(present('reason-logo.png')).toEqual({ file: 'reason-logo.png', exists: true });
    expect(present('rsn-logo.png')).toEqual({ file: 'rsn-logo.png', exists: true });
  });
});

describe('every email closes its card once and leaves nothing open', () => {
  it.each(shelled)('%s: every <div> that opens is closed', async (_label, c) => {
    const { html } = await sendAndCapture(c.run);
    expect(count(html, /<div\b/g)).toBe(count(html, /<\/div>/g));
  });

  it.each(shelled)('%s: the link back to the app is in the footer once', async (_label, c) => {
    const { html } = await sendAndCapture(c.run);
    expect(count(html, />app\.rsn\.network<\/a>/g)).toBe(1);
  });

  it.each(shelled.filter(([, c]) => c.underCard))('%s: its closing line sits under the card like the others, not inside it', async (_label, c) => {
    const { html } = await sendAndCapture(c.run);
    expect(divDepthAt(html, c.underCard!)).toBe(1);
  });
});

describe('the join-request review email gives the LinkedIn row an answer when there is no address', () => {
  const rowAfterTheLabel = (html: string) => html.match(/>LinkedIn<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.[1].trim();

  it('links the profile when there is one', async () => {
    const sent = await sendAndCapture(() => emailService.sendJoinRequestAdminReviewEmail('delivered+ada@resend.dev', adminReview('https://www.linkedin.com/in/sam-applicant')));
    expect(rowAfterTheLabel(sent.html)).toContain('<a href="https://www.linkedin.com/in/sam-applicant"');
    expect(sent.text).toContain('LinkedIn: https://www.linkedin.com/in/sam-applicant');
  });

  // At 360 wide the value column is about 120px. A profile address has no space to break at, so
  // without this it pushed the table past the edge of the card (seen in the browser, 21 Oct 2026).
  it('lets a long LinkedIn address and a long email address wrap inside the card', async () => {
    const sent = await sendAndCapture(() => emailService.sendJoinRequestAdminReviewEmail('delivered+ada@resend.dev', adminReview('https://www.linkedin.com/in/a-very-long-profile-name-0123456789abcdef')));
    expect(sent.html).toMatch(/word-break:break-all;"><a href="https:\/\/www\.linkedin\.com\/in\/a-very-long-profile-name/);
    expect(sent.html).toMatch(/word-break:break-all;">sam@example\.com<\/td>/);
  });

  it.each([null, '', '   '])('says "Not given", with no link, for %j', async (given) => {
    const sent = await sendAndCapture(() => emailService.sendJoinRequestAdminReviewEmail('delivered+ada@resend.dev', adminReview(given)));
    expect(rowAfterTheLabel(sent.html)).toBe('Not given');
    expect(sent.html).not.toContain('linkedin.com');
    expect(sent.text).toContain('LinkedIn: Not given');
    expect(sent.text).not.toContain('linkedin.com');
  });
});
