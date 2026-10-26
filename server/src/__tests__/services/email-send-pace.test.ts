// ─── One pace for every email (26 Oct 2026, H2b item 7) ─────────────────────────────────────────────────────
//
// The mail provider takes two sends a second. A bulk invite, Remind all's one-at-a-time sends, a job's burst and a
// member's single email all reach the provider through one process-wide gate that releases a provider call every
// SEND_GAP_MS at most, retries included. A single email is released ahead of a burst waiting in the bulk lane, so the
// answer to a member's press waits for one slot at most, never for the burst ahead of it. Nothing is dropped: a waiter
// is released in its turn whatever happened to the one before.
//
// The real email service runs on a virtual clock. The sending library, the config, the logger and the database are
// replaced.

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

const anInvite = { inviterName: 'Stefan', type: 'platform' as const, inviteUrl: 'https://app.rsn.network/invite/ABC123' };
const PASSING = { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. You can only make 2 requests per second.' };

/** A clock that moves only when someone pauses on it, and only once everything already released has run. */
let now = 0;
const clock = { now: () => now, pause: (ms: number) => new Promise<void>((r) => setImmediate(() => { now += ms; r(); })) };
/** What reached the provider: the address and the moment, in order. */
let reached: Array<{ to: string; at: number }> = [];

beforeEach(() => {
  jest.clearAllMocks();
  now = 0;
  reached = [];
  emailService.__setSendPaceForTests(clock);
  mockSend.mockImplementation(async (payload: { to: string[] }) => {
    reached.push({ to: payload.to[0], at: now });
    return { data: { id: 'sent' }, error: null };
  });
});

afterAll(() => emailService.__setSendPaceForTests(null));

const send = (to: string) => emailService.sendInviteEmail(to, anInvite);

describe('emails asked for at once', () => {
  it('reach the provider one every SEND_GAP_MS, every one of them', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => send(`${n}@getjacksapp.com`)));
    expect(results.every((r) => r.sent)).toBe(true);
    expect(reached.map((r) => r.at)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(emailService.SEND_GAP_MS).toBe(500);
  });

  it('are not lost when the provider throws for one of them', async () => {
    mockSend.mockImplementationOnce(async () => { throw new Error('socket hang up'); });
    const [first, second] = await Promise.all([
      send('first@getjacksapp.com').catch(() => ({ sent: false, threw: true })),
      send('second@getjacksapp.com'),
    ]);
    expect(first).toMatchObject({ sent: false });
    expect(second).toEqual({ sent: true });
    expect(reached.map((r) => r.to)).toEqual(['second@getjacksapp.com']);
  });
});

describe('a retry', () => {
  it('waits its turn like a new email: the second attempt comes after the backoff and a full gap', async () => {
    mockSend
      .mockImplementationOnce(async (payload: { to: string[] }) => { reached.push({ to: payload.to[0], at: now }); return { data: null, error: PASSING }; });
    await expect(send('retry@getjacksapp.com')).resolves.toEqual({ sent: true });
    expect(reached).toHaveLength(2);
    expect(reached[1].at - reached[0].at).toBeGreaterThanOrEqual(1000);
    expect(reached[1].at - reached[0].at).toBeGreaterThanOrEqual(emailService.SEND_GAP_MS);
  });
});

describe('a single email and a burst', () => {
  it('the single email is released ahead of the burst waiting in the bulk lane', async () => {
    const burst = ['bulk-1', 'bulk-2', 'bulk-3'].map((n) =>
      emailService.asBulkEmail(() => send(`${n}@getjacksapp.com`)));
    const single = send('single@getjacksapp.com');
    await Promise.all([...burst, single]);
    expect(reached.map((r) => r.to)).toEqual([
      'bulk-1@getjacksapp.com', 'single@getjacksapp.com', 'bulk-2@getjacksapp.com', 'bulk-3@getjacksapp.com',
    ]);
    expect(reached.map((r) => r.at)).toEqual([0, 500, 1000, 1500]);
  });

  it('inside the bulk lane every email the callback sends is a bulk one, and the callback\'s answer comes back', async () => {
    const answer = await emailService.asBulkEmail(async () => {
      await send('inside@getjacksapp.com');
      return 'done';
    });
    expect(answer).toBe('done');
    expect(reached.map((r) => r.to)).toEqual(['inside@getjacksapp.com']);
  });
});
