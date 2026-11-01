// ─── The sign-in email says "No password needed" and shows the 6-digit code large (1 Nov 2026) ──────
//
// Stefan expected a password on 30 Oct. The email that signs a member in now says plainly that none is needed,
// and carries the 6-digit code (services/identity/sign-in-code.ts) big enough to read across a room and type
// on the waiting screen, in the HTML and in the plain text. The real email service renders it; only the sending
// library, config, the logger and the database are stand-ins, so nothing is sent.

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
    magicLinkExpiryMinutes: 60,
  },
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn() }));

import * as emailService from '../../services/email/email.service';

const LINK = 'https://app.rsn.network/auth/verify?token=abc';

async function sent(code?: string): Promise<{ html: string; text: string; subject: string }> {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ error: null });
  await emailService.sendMagicLinkEmail('delivered+ana@resend.dev', LINK, code);
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0];
}

describe('the sign-in email', () => {
  it('says no password is needed, in the HTML and the text', async () => {
    const { html, text, subject } = await sent('042517');
    expect(subject).toBe('Sign in to REASON');
    expect(html).toContain('No password needed.');
    expect(text).toContain('No password needed.');
  });

  it('shows the code large, digits kept as sent (a leading zero too), with how long it works', async () => {
    const { html, text } = await sent('042517');
    const box = html.match(/<p[^>]*data-sign-in-code[^>]*>([^<]*)<\/p>/);
    expect(box).not.toBeNull();
    expect(box![1].trim()).toBe('042517');
    const size = Number((box![0].match(/font-size:(\d+)px/) ?? [])[1]);
    expect(size).toBeGreaterThanOrEqual(32);
    expect(box![0]).toMatch(/letter-spacing:\d+px/);
    expect(html).toContain('The code works for 15 minutes.');
    expect(text).toContain('042517');
    expect(text).toContain('The code works for 15 minutes.');
  });

  it('still carries the link and its button, which work as before', async () => {
    const { html, text } = await sent('042517');
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain('This link expires in 60 minutes.');
    expect(text).toContain(LINK);
  });

  it('with no code (a caller that has none) shows no code box, and still says no password is needed', async () => {
    const { html, text } = await sent();
    expect(html).not.toContain('data-sign-in-code');
    expect(html).not.toContain('The code works for');
    expect(html).toContain('No password needed.');
    expect(text).not.toContain('The code works for');
  });
});
