// ─── Test addresses never reach the email provider (26 Oct 2026) ─────────────────────────────────────
//
// 26 Oct 2026, production: the mail provider's daily sending quota ran out at 06:51 UTC and every email after it
// was refused, the sign-in links and meeting confirmations of real members with it. What had used it up was the
// platform's own end-to-end runs and production smokes: their throwaway members sit on addresses reserved for
// testing (…@rsn-e2e.invalid, …@example.com) and the server handed every email to them to the provider, one
// request-and-accept smoke alone making about 240 in three minutes.
//
// example.com, example.net and example.org and their subdomains, and anything under .example, .invalid, .test and
// .localhost, are reserved for documentation and testing (RFC 2606, RFC 6761): nobody has a mailbox there.
// sendEmail, the one door to the provider, no longer opens it for them. It answers as a delivered email is
// answered ({ sent: true }, marked `skipped`), so a reminder keeps its hour, a batch counts the email as sent and
// nothing is tried again. Real addresses, the provider's own test sink (delivered+label@resend.dev) included, go
// exactly as before.
//
// The real email service runs. Only the sending library, the config, the logger and the database are replaced.

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

import config from '../../config';
import logger from '../../config/logger';
import * as emailService from '../../services/email/email.service';
import { isReservedTestAddress, maskAddress } from '../../services/identity/reserved-address';

const anInvite = {
  inviterName: 'Stefan', type: 'platform' as const, inviteUrl: 'https://app.rsn.network/invite/ABC123',
};
const withProvider = (key: string) => { (config as { resendApiKey: string }).resendApiKey = key; };
const debugLines = () => (logger.debug as jest.Mock).mock.calls;

/** Every form of a reserved address the platform's own runs use or could use: [what it is, the recipient]. */
const RESERVED: Array<[string, string]> = [
  ['example.com', 'ana@example.com'],
  ['example.net', 'ana@example.net'],
  ['example.org', 'ana@example.org'],
  ['a subdomain of example.org', 'ana@sub.example.org'],
  ['a deeper subdomain of example.com', 'ana@mail.eu.example.com'],
  ['the end-to-end throwaways (.invalid)', 'e2etest-ob2li-1729500000000@rsn-e2e.invalid'],
  ['the load-test accounts (.invalid)', 'loadtest_7@rsn-test.invalid'],
  ['.invalid', 'ana@a.invalid'],
  ['.test', 'ana@x.test'],
  ['.localhost', 'ana@y.localhost'],
  ['.example', 'ana@z.example'],
  ['a bare reserved name', 'ana@localhost'],
  ['upper case', 'ANA@EXAMPLE.COM'],
  ['mixed case on a throwaway domain', 'Ana@Rsn-E2E.Invalid'],
  ['a trailing dot on the domain', 'ana@example.com.'],
  ['spaces around it', '  ana@rsn-e2e.invalid  '],
  ['a quoted display name', '"Ana" <ana@x.invalid>'],
  ['a display name without quotes', 'Ana Lopez <ana@example.org>'],
  ['a display name with an @ in it', '"ana@gmail.com" <ana@x.invalid>'],
  ['the address in angle brackets alone', '<ana@x.test>'],
  ['a display name and a trailing dot', '"Ana" <ana@x.invalid.>'],
];

/** Addresses that can be a person's, or the provider's own sink: [what it is, the recipient]. */
const REAL: Array<[string, string]> = [
  ['an ordinary address', 'ana@gmail.com'],
  ['a company address', 'ali@getjacksapp.com'],
  ['the provider\'s own test sink with a label', 'delivered+m1api-1729500000000-a@resend.dev'],
  ['the provider\'s own test sink', 'delivered@resend.dev'],
  ['a name that only starts like a reserved one', 'ana@notexample.com'],
  ['example as a second-level name under a real top level', 'ana@example.co'],
  ['example.com followed by a real top level', 'ana@example.com.au'],
  ['invalid as a second-level name', 'ana@invalid.com'],
  ['test as a second-level name', 'ana@test.com'],
  ['a reserved name in the local part only', 'example.com@gmail.com'],
  ['a hyphenated look-alike', 'ana@my-example.org'],
  ['a display name on a real address', '"Ana" <ana@gmail.com>'],
  ['a reserved address in the display name only', '"ana@x.invalid" <ana@gmail.com>'],
];

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  withProvider('test-key');
});

describe('an email to an address reserved for testing', () => {
  it.each(RESERVED)('%s: the provider is never asked, and the answer is the one a delivered email gets', async (_what, to) => {
    const answer = await emailService.sendInviteEmail(to, anInvite);

    expect(answer).toEqual({ sent: true, skipped: 'reserved-test-address' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is logged once, at debug level, with the subject and the masked address, and nothing louder', async () => {
    await emailService.sendInviteEmail('e2etest-ob2li-1729500000000@example.com', anInvite);

    expect(debugLines()).toEqual([[
      { subject: emailService.buildInviteEmail(anInvite).subject, to: 'e•••@example.com' },
      'email to a reserved test address not sent',
    ]]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('is logged with the address inside a display name masked, and no more of it', async () => {
    await emailService.sendInviteEmail('"Ana Lopez" <ana.lopez@x.invalid>', anInvite);

    const [fields] = debugLines()[0];
    expect(fields.to).toBe('a•••@x.invalid');
    expect(JSON.stringify(debugLines())).not.toMatch(/ana\.lopez|Ana Lopez/);
  });

  it('is not tried again, whatever the provider would have said', async () => {
    mockSend.mockResolvedValue({ data: null, error: { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' } });

    await expect(emailService.sendInviteEmail('ana@rsn-e2e.invalid', anInvite)).resolves.toMatchObject({ sent: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a whole batch of them is counted as sent and costs the provider nothing', async () => {
    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, i) => emailService.sendInviteEmail(`e2etest-${i}@rsn-e2e.invalid`, anInvite)),
    );

    expect(answers.filter((answer) => answer.sent)).toHaveLength(60);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is skipped with its attachment too: the calendar file is built and goes nowhere', async () => {
    await expect(emailService.sendMeetingConfirmedEmail('bo@rsn-e2e.invalid', 'Bo', {
      partnerName: 'Ana', startAt: new Date('2026-11-05T17:00:00Z'), durationMin: 30, recipientTimezone: 'UTC',
      threadUrl: 'https://app.rsn.network/messages/c1', googleCalendarUrl: 'https://calendar.google.com/calendar/render',
      icsContent: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    })).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('an email to any other address', () => {
  it.each(REAL)('%s: goes to the provider as before, and is not marked skipped', async (_what, to) => {
    const answer = await emailService.sendInviteEmail(to, anInvite);

    expect(answer).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toEqual([to]);
    expect(debugLines()).toEqual([]);
  });

  it('is still answered as not sent when the provider refuses it', async () => {
    mockSend.mockResolvedValue({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' } });

    await expect(emailService.sendInviteEmail('ana@gmail.com', anInvite)).resolves.toEqual({ sent: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('the callers see an email that went', () => {
  const TEST_ADDRESS = 'e2etest-1@rsn-e2e.invalid';

  it('a reminder reads `sent` from the invite email: true, so it keeps its hour', async () => {
    const { sent } = await emailService.sendInviteEmail(TEST_ADDRESS, anInvite);
    expect(sent).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the balance alert reads `sent` too: true', async () => {
    const answer = await emailService.sendLlmBalanceAlertEmail({ to: TEST_ADDRESS, where: 'onboarding chat', at: '2026-11-05T17:00:00Z' });
    expect(answer.sent).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the sign-in link does not throw, which it does for an email that did not go', async () => {
    await expect(emailService.sendMagicLinkEmail(TEST_ADDRESS, 'https://app.rsn.network/auth/verify?token=abc')).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the sign-in link still throws for a real address the provider refuses', async () => {
    mockSend.mockResolvedValue({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' } });

    await expect(emailService.sendMagicLinkEmail('ana@gmail.com', 'https://app.rsn.network/auth/verify?token=abc')).rejects.toThrow('Email send failed');
  });
});

describe('with no mail provider configured, nothing goes and nothing claims to have gone', () => {
  it('a reserved address is answered as not sent, as every address is, and says nothing of skipping', async () => {
    withProvider('');

    await expect(emailService.sendLlmBalanceAlertEmail({ to: 'ana@example.com', where: 'onboarding chat', at: '2026-11-05T17:00:00Z' }))
      .resolves.toEqual({ sent: false });
    expect(mockSend).not.toHaveBeenCalled();
    expect(debugLines()).toEqual([]);
  });
});

describe('isReservedTestAddress reads the address inside a display name', () => {
  it.each(RESERVED.map(([, recipient]) => recipient))('%s is reserved', (recipient) => {
    expect(isReservedTestAddress(recipient)).toBe(true);
  });

  it.each(REAL.map(([, recipient]) => recipient))('%s is not', (recipient) => {
    expect(isReservedTestAddress(recipient)).toBe(false);
  });

  it.each(['', '   ', '<>', 'Ana <>', 'no-at-sign', '@', '<ana>', null, undefined])('%p is not an address, so not a reserved one', (recipient) => {
    expect(isReservedTestAddress(recipient)).toBe(false);
  });
});

describe('maskAddress shows the first letter and the domain, nothing else', () => {
  it.each([
    ['ana@example.com', 'a•••@example.com'],
    ['  Ana@Rsn-E2E.Invalid ', 'A•••@Rsn-E2E.Invalid'],
    ['"Ana Lopez" <ana.lopez@x.invalid>', 'a•••@x.invalid'],
    ['<ana@x.test>', 'a•••@x.test'],
    ['not an address', '•••'],
    ['@example.com', '•••'],
    ['', '•••'],
  ])('%s -> %s', (recipient, masked) => {
    expect(maskAddress(recipient)).toBe(masked);
  });
});
