// server/src/__tests__/services/poke/poke-decline-final.test.ts
// 29 Sep 2026: after someone declines, the sender could ask again from search
// or a profile as often as they liked, each time with a bell and an email.
const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: async () => false, __esModule: true }));

import { sendPoke } from '../../../services/poke/poke.service';

// The world these tests run in: u-a asked u-b once, and u-b declined. The decline
// check gets an answer only when it asks about u-a → u-b. A check that honoured
// declines in both directions (an OR) would find the same row for the pair asked
// the other way round, so the mock answers that shape the way a database would.
function declineRows(sql: string, params: unknown[]) {
  const [sender, recipient] = params;
  const sameWay = sender === 'u-a' && recipient === 'u-b';
  const bothWays = /\bOR\b/i.test(sql) && sender === 'u-b' && recipient === 'u-a';
  return sameWay || bothWays ? [{ id: 'p-old' }] : [];
}

function arm(opts: { met?: boolean } = {}) {
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/status = 'declined'/.test(sql)) return Promise.resolve({ rows: declineRows(sql, params) });
    if (/FROM encounter_history/.test(sql)) return Promise.resolve({ rows: opts.met ? [{ id: 'enc-1' }] : [] });
    if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [{ id: params[0] }] });
    if (/INSERT INTO user_pokes/.test(sql)) {
      return Promise.resolve({
        rows: [{
          id: params[0], sender_id: params[1], recipient_id: params[2], status: 'pending',
          message: params[3], responded_at: null, created_at: new Date('2026-09-29T10:00:00Z'),
        }],
      });
    }
    if (/INSERT INTO notifications/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'n-1', created_at: new Date('2026-09-29T10:00:01Z') }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const pokeInserts = () => mockQuery.mock.calls.map(c => String(c[0])).filter(s => /INSERT INTO user_pokes/.test(s));

describe('a declined request is final for the sender', () => {
  beforeEach(() => mockQuery.mockReset());

  it('refuses a new request after the recipient declined one, and inserts nothing', async () => {
    arm();
    await expect(sendPoke('u-a', 'u-b', 'hello again')).rejects.toMatchObject({
      statusCode: 403,
      message: 'They declined your earlier request, so you cannot send another one.',
    });
    expect(pokeInserts()).toHaveLength(0);
  });

  it('lets the person who declined ask the other way: it resolves and inserts exactly once', async () => {
    arm();
    await expect(sendPoke('u-b', 'u-a', 'my turn')).resolves.toMatchObject({
      senderId: 'u-b', recipientId: 'u-a', status: 'pending',
    });
    expect(pokeInserts()).toHaveLength(1);
  });

  it('tells a pair who have already met that they can message, not that a request was declined', async () => {
    arm({ met: true });
    await expect(sendPoke('u-a', 'u-b', 'hello again')).rejects.toMatchObject({
      statusCode: 400,
      message: 'You can already message them.',
    });
    expect(pokeInserts()).toHaveLength(0);
  });
});
