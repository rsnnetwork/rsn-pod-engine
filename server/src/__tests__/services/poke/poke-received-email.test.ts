// The email a member gets when someone asks to meet them. It carries the sender's message,
// which is a note and a reason on separate lines. Everything here is the real email
// service; only the sending library, the config, the logger and the database are replaced.
const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })),
}));
jest.mock('../../../config', () => ({
  __esModule: true,
  default: { resendApiKey: 'test-key', emailFrom: 'noreply@rsn.network', clientUrl: 'https://app.rsn.network' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../db', () => ({ query: jest.fn(), transaction: jest.fn() }));

import { sendPokeReceivedEmail } from '../../../services/email/email.service';

/** Sends the email for a message and returns what went out. */
async function send(introMessage: string | null): Promise<{ html: string; text: string }> {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ error: null });
  await sendPokeReceivedEmail('them@example.com', 'Iqbal', {
    senderName: 'Fatima',
    introMessage,
    messagesUrl: 'https://app.rsn.network/messages',
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0] as { html: string; text: string };
}

describe('the meeting request email shows the message the way it was written', () => {
  it('keeps the note and the reason on separate lines', async () => {
    const { html } = await send(
      "I would value your view on our seed round.\n\nWhy REASON suggested this: Fatima is looking to meet investors — you're an Angel Investor.",
    );
    // A blank line between the two paragraphs, inside the one message block.
    expect(html).toContain(
      "I would value your view on our seed round.<br><br>Why REASON suggested this: Fatima is looking to meet investors — you&#39;re an Angel Investor.",
    );
  });

  it('turns every line break into one, whether it was written as \\n or \\r\\n', async () => {
    const { html } = await send('one\ntwo\r\nthree');
    expect(html).toContain('one<br>two<br>three');
    expect(html).not.toContain('\r<br>');
  });

  it('still escapes HTML in the message, including a break the sender typed themselves', async () => {
    const { html } = await send('Hi <b>there</b>\n<script>alert(1)</script> and a<br>b');
    expect(html).toContain('Hi &lt;b&gt;there&lt;/b&gt;<br>&lt;script&gt;alert(1)&lt;/script&gt; and a&lt;br&gt;b');
    expect(html).not.toContain('<b>there</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('a<br>b');
  });

  it('a one-line message has no break in it, and no message has no message block', async () => {
    const one = await send('Hello there');
    expect(one.html).toContain('Hello there');
    expect(one.html).not.toContain('<br>');

    const none = await send(null);
    expect(none.html).not.toContain('border-left:3px solid #DE322E');
    expect(none.html).not.toContain('<br>');
  });

  it('the plain-text version keeps the line breaks as they are', async () => {
    const { text } = await send('A note.\n\nWhy REASON suggested this: a reason.');
    expect(text).toContain('"A note.\n\nWhy REASON suggested this: a reason."');
  });
});
