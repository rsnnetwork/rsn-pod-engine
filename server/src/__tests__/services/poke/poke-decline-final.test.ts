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

function arm(opts: { declined: boolean }) {
  mockQuery.mockImplementation((sql: string) => {
    if (/status = 'declined'/.test(sql)) return Promise.resolve({ rows: opts.declined ? [{ id: 'p-old' }] : [] });
    if (/FROM encounter_history/.test(sql)) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [{ id: 'u-b' }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('a declined request is final for the sender', () => {
  beforeEach(() => mockQuery.mockReset());

  it('refuses a new request after the recipient declined one, and inserts nothing', async () => {
    arm({ declined: true });
    await expect(sendPoke('u-a', 'u-b', 'hello again')).rejects.toMatchObject({
      statusCode: 403,
      message: 'They declined your earlier request, so you cannot send another one.',
    });
    const inserts = mockQuery.mock.calls.map(c => String(c[0])).filter(s => /INSERT INTO user_pokes/.test(s));
    expect(inserts).toHaveLength(0);
  });

  it('only looks at declines FROM this sender TO this recipient (the decliner can still ask)', async () => {
    arm({ declined: false });
    await sendPoke('u-b', 'u-a', 'my turn').catch(() => undefined);
    const declineCheck = mockQuery.mock.calls.find(c => /status = 'declined'/.test(String(c[0])))!;
    expect(String(declineCheck[0])).toMatch(/sender_id = \$1 AND recipient_id = \$2/);
    expect(declineCheck[1]).toEqual(['u-b', 'u-a']);
  });
});
