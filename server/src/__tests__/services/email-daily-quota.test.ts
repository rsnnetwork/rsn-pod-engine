// ─── A daily-quota refusal is not tried again (26 Oct 2026, H2b item 8b) ──────────────────────────────────
//
// When the provider's daily sending quota is used up it answers 429 `daily_quota_exceeded`. sendEmail treated every
// 429 as a passing rate limit and tried three more times with a 1, 2, 4 s backoff: four requests and about seven
// seconds per email that could not go until the quota reset, and a burst of fifty invites made two hundred refused
// requests and logged each one as an error. Now a daily-quota refusal answers `sent: false` at once, and a burst of
// them is logged as an error once (the rest at debug) — while a passing rate limit ("Too many requests",
// `rate_limit_exceeded`) keeps its backoff and retry.
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

import logger from '../../config/logger';
import * as emailService from '../../services/email/email.service';

const anInvite = {
  inviterName: 'Stefan', type: 'platform' as const, inviteUrl: 'https://app.rsn.network/invite/ABC123',
};
const DAILY = { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' };
const PASSING = { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. You can only make 2 requests per second.' };
const errorLines = () => (logger.error as jest.Mock).mock.calls.map((c) => String(c[1]));
const debugLines = () => (logger.debug as jest.Mock).mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  jest.clearAllMocks();
  emailService.__resetDailyQuotaNoticeForTests();
  // The provider's gate starts each test with no email just released, so the waits here are the backoff alone.
  emailService.__setSendPaceForTests(null);
});

describe('a daily-quota refusal', () => {
  it('is answered as not sent at once: one request, no retry, no wait', async () => {
    mockSend.mockResolvedValue({ data: null, error: DAILY });
    const before = Date.now();
    await expect(emailService.sendInviteEmail('claus@getjacksapp.com', anInvite)).resolves.toEqual({ sent: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(Date.now() - before).toBeLessThan(500);
  });

  it('is logged as an error once for a burst, and at debug for the emails after it', async () => {
    mockSend.mockResolvedValue({ data: null, error: DAILY });
    for (const to of ['a@getjacksapp.com', 'b@getjacksapp.com', 'c@getjacksapp.com']) {
      await emailService.sendInviteEmail(to, anInvite);
    }
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(errorLines().filter((l) => /daily/i.test(l))).toHaveLength(1);
    expect(debugLines().filter((l) => /daily/i.test(l))).toHaveLength(2);
  });
});

describe('a passing rate limit', () => {
  it('is tried again after the backoff and goes through', async () => {
    jest.useFakeTimers();
    try {
      mockSend.mockResolvedValueOnce({ data: null, error: PASSING }).mockResolvedValueOnce({ data: { id: 'em_1' }, error: null });
      const sending = emailService.sendInviteEmail('claus@getjacksapp.com', anInvite);
      await jest.advanceTimersByTimeAsync(1000);
      await expect(sending).resolves.toEqual({ sent: true });
      expect(mockSend).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
