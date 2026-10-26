// ─── An invite email says whether it went (26 Oct 2026, S7 fix round 4) ─────────────────────────────
//
// A reminder may keep an invite's hour and use up the member's allowance only for an email that went. The mail
// provider's library never throws for a refusal: a bad address, its rate limit after the retries, an outage and the
// network all come back as an answer ({ error }), which sendEmail turns into { sent: false }. sendInviteEmail used to
// drop that answer (it returned nothing), so a refused reminder read as sent. It now passes the answer on.
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
import { sendInviteEmail } from '../../services/email/email.service';

const anInvite = {
  inviterName: 'Stefan', type: 'session' as const, targetName: 'Founders Evening', inviteUrl: 'https://app.rsn.network/invite/ABC123',
};
const withProvider = (key: string) => { (config as { resendApiKey: string }).resendApiKey = key; };

beforeEach(() => {
  mockSend.mockReset();
  withProvider('test-key');
});

describe('sendInviteEmail says whether the email went', () => {
  it('the provider takes it: sent', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    await expect(sendInviteEmail('delivered+guest@resend.dev', anInvite)).resolves.toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['refuses the address (422)', { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }],
    ['cannot be reached: the library answers, it does not throw', { statusCode: null, name: 'application_error', message: 'Unable to fetch data. The request could not be resolved.' }],
  ])('the provider %s: not sent, and not tried again', async (_what, error) => {
    mockSend.mockResolvedValue({ data: null, error });
    await expect(sendInviteEmail('delivered+guest@resend.dev', anInvite)).resolves.toEqual({ sent: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each([[429], [503]])('the provider says %i and still does after the three retries: not sent', async (statusCode) => {
    jest.useFakeTimers();
    try {
      mockSend.mockResolvedValue({ data: null, error: { statusCode, name: 'application_error', message: 'Try again later' } });
      const answer = sendInviteEmail('delivered+guest@resend.dev', anInvite);
      // The waits between the tries: 1 s, 2 s, 4 s.
      await jest.advanceTimersByTimeAsync(1000 + 2000 + 4000);
      await expect(answer).resolves.toEqual({ sent: false });
      expect(mockSend).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('no email provider at all: not sent, and nothing is asked of the library', async () => {
    withProvider('');
    await expect(sendInviteEmail('delivered+guest@resend.dev', anInvite)).resolves.toEqual({ sent: false });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
