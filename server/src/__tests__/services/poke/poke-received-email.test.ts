// The email a member gets when someone asks to meet them. 30 Oct 2026 (Stefan: "It looks like the
// sender wrote it"): the quote holds only what the member wrote, and REASON's line is its own plain
// paragraph under "Why REASON suggested this", outside the quote, and outside the quotation marks in
// the text part. Everything here is the real email service; only the sending library, the config,
// the logger and the database are replaced.
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

import { sendPokeReceivedEmail, __setSendPaceForTests } from '../../../services/email/email.service';

// These tests are about the words, not the pace: the provider's gate (two sends a second) is run on an instant clock.
beforeAll(() => __setSendPaceForTests({ now: () => Date.now(), pause: async () => {} }));

const QUOTE = 'border-left:3px solid #DE322E';
const LINE = 'Fatima is looking to meet investors, and Iqbal is an Angel Investor.';

/** Sends the email for a note and a line and returns what went out. */
async function send(note: string | null, reasonLine: string | null = null): Promise<{ html: string; text: string }> {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ error: null });
  await sendPokeReceivedEmail('delivered+them@resend.dev', 'Iqbal', {
    senderName: 'Fatima',
    note,
    reasonLine,
    messagesUrl: 'https://app.rsn.network/messages',
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0] as { html: string; text: string };
}

/** The quote block of the HTML, or null when there is none. */
const quoteOf = (html: string) => {
  const at = html.indexOf(QUOTE);
  return at < 0 ? null : html.slice(at, html.indexOf('</div>', at));
};

describe('the meeting request email keeps the note and REASON\'s line apart', () => {
  it('quotes only the note, and puts the line in its own paragraph under its heading, after the quote', async () => {
    const { html } = await send('I would value your view on our seed round.', LINE);
    const quote = quoteOf(html)!;
    expect(quote).toContain('I would value your view on our seed round.');
    expect(quote).not.toContain('Why REASON');
    expect(quote).not.toContain('Angel Investor');
    const heading = html.indexOf('>Why REASON suggested this</p>');
    expect(heading).toBeGreaterThan(html.indexOf(QUOTE));
    expect(html.indexOf(LINE)).toBeGreaterThan(heading);
  });

  it('a line with no note: no quote at all, only REASON\'s paragraph', async () => {
    const { html } = await send(null, LINE);
    expect(html).not.toContain(QUOTE);
    expect(html).toContain('>Why REASON suggested this</p>');
    expect(html).toContain(LINE);
  });

  it('a note with no line: the quote and no heading', async () => {
    const { html } = await send('Hello there');
    expect(quoteOf(html)).toContain('Hello there');
    expect(html).not.toContain('Why REASON suggested this');
  });

  it('neither: no quote and no heading', async () => {
    const { html } = await send(null);
    expect(html).not.toContain(QUOTE);
    expect(html).not.toContain('Why REASON suggested this');
  });

  it('turns every line break in the note into one, whether it was written as \\n or \\r\\n', async () => {
    const { html } = await send('one\ntwo\r\nthree');
    expect(html).toContain('one<br>two<br>three');
    expect(html).not.toContain('\r<br>');
  });

  it('still escapes HTML in the note and in the line, including a break the sender typed themselves', async () => {
    const { html } = await send('Hi <b>there</b>\n<script>alert(1)</script> and a<br>b', 'A <i>line</i>.');
    expect(html).toContain('Hi &lt;b&gt;there&lt;/b&gt;<br>&lt;script&gt;alert(1)&lt;/script&gt; and a&lt;br&gt;b');
    expect(html).toContain('A &lt;i&gt;line&lt;/i&gt;.');
    expect(html).not.toContain('<b>there</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('a<br>b');
  });

  it('the plain-text version: the note in quotation marks, then the heading and the line outside them', async () => {
    const { text } = await send('A note.\n\nSecond paragraph.', LINE);
    expect(text).toContain(`"A note.\n\nSecond paragraph."\n\nWhy REASON suggested this\n${LINE}\n\nView it:`);
    const none = await send(null, LINE);
    expect(none.text).not.toContain('"');
    expect(none.text).toContain(`Fatima wants to meet you on REASON.\n\nWhy REASON suggested this\n${LINE}`);
  });
});
