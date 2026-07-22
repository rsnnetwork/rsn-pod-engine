// ─── Meeting Windows (REASON v1 Phase 2, 19 Jul 2026) ────────────────────────
//
// "Setup availability to be introduced": each side of a conversation picks
// time windows, overlap is computed, either side confirms an overlap window.
// Confirming writes the conversation columns, drops a message in the thread,
// and bell-notifies the partner.

const mockQuery = jest.fn();
const mockSendMessage = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/dm/dm.service', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  __esModule: true,
}));
jest.mock('../../../index', () => ({
  io: { to: () => ({ emit: () => {} }) },
  __esModule: true,
}));

import {
  isValidWindowKey, windowLabel, getScheduling, setAvailability, confirmWindow,
  HORIZON_DAYS,
} from '../../../services/dm/meeting-windows.service';

const NOW = new Date('2026-07-19T12:00:00Z');
const key = (offsetDays: number, part = 'morning') => {
  const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${part}`;
};

// Service tests validate against the real clock, not the injected NOW. Compute dates dynamically.
const futureKey = (daysAhead: number, part: 'morning' | 'afternoon' | 'evening' = 'morning') => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.toISOString().slice(0, 10)}:${part}`;
};

const CONV = {
  id: 'conv-1', user_a_id: 'u-a', user_b_id: 'u-b',
  meeting_confirmed_window: null, meeting_confirmed_by: null, meeting_confirmed_at: null,
};

function armConv(availRows: Array<{ user_id: string; window_key: string }>, conv: any = CONV) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
    if (/FROM meeting_availability/.test(sql)) return Promise.resolve({ rows: availRows });
    return Promise.resolve({ rows: [{ id: 'n1', created_at: NOW }] });
  });
}

beforeEach(() => { mockQuery.mockReset(); mockSendMessage.mockReset(); });

describe('isValidWindowKey', () => {
  it('accepts today through the horizon, all dayparts', () => {
    expect(isValidWindowKey(key(0), NOW)).toBe(true);
    expect(isValidWindowKey(key(7, 'evening'), NOW)).toBe(true);
    expect(isValidWindowKey(key(HORIZON_DAYS, 'afternoon'), NOW)).toBe(true);
  });
  it('rejects the past, beyond-horizon, bad formats, and impossible dates', () => {
    expect(isValidWindowKey(key(-1), NOW)).toBe(false);
    expect(isValidWindowKey(key(HORIZON_DAYS + 1), NOW)).toBe(false);
    expect(isValidWindowKey('2026-07-20:night', NOW)).toBe(false);
    expect(isValidWindowKey('2026-02-31:morning', NOW)).toBe(false);
    expect(isValidWindowKey('garbage', NOW)).toBe(false);
  });
});

describe('windowLabel', () => {
  it('renders a human label', () => {
    expect(windowLabel('2026-07-22:evening')).toBe('Wed 22 Jul, evening');
  });
});

describe('getScheduling', () => {
  it('splits mine/theirs and computes the overlap', async () => {
    armConv([
      { user_id: 'u-a', window_key: key(1) },
      { user_id: 'u-a', window_key: key(2, 'evening') },
      { user_id: 'u-b', window_key: key(2, 'evening') },
      { user_id: 'u-b', window_key: key(3) },
    ]);
    const s = await getScheduling('conv-1', 'u-a');
    expect(s.partnerId).toBe('u-b');
    expect(s.mine).toEqual([key(1), key(2, 'evening')].sort());
    expect(s.theirs).toEqual([key(2, 'evening'), key(3)].sort());
    expect(s.overlap).toEqual([key(2, 'evening')]);
    expect(s.confirmed).toBeNull();
  });

  it('a stranger to the conversation is rejected', async () => {
    armConv([]);
    await expect(getScheduling('conv-1', 'u-intruder')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('setAvailability', () => {
  it('replaces my selection: DELETE mine then INSERT each window', async () => {
    armConv([]);
    await setAvailability('conv-1', 'u-a', [futureKey(1), futureKey(2, 'evening')]);
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /DELETE FROM meeting_availability/.test(s))).toBe(true);
    expect(sqls.filter(s => /INSERT INTO meeting_availability/.test(s)).length).toBe(2);
  });

  it('rejects an out-of-range window with a 400', async () => {
    armConv([]);
    await expect(setAvailability('conv-1', 'u-a', [futureKey(-1)]))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('confirmWindow', () => {
  it('rejects a window only ONE side selected', async () => {
    const windowKey = futureKey(2);
    armConv([{ user_id: 'u-a', window_key: windowKey }]); // partner never picked it
    await expect(confirmWindow('conv-1', 'u-a', windowKey))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('confirms an overlap window: updates the conversation, drops a thread message, notifies the partner', async () => {
    const windowKey = futureKey(2, 'evening');
    armConv([
      { user_id: 'u-a', window_key: windowKey },
      { user_id: 'u-b', window_key: windowKey },
    ]);
    mockSendMessage.mockResolvedValue({ message: { id: 'm1' }, conversationId: 'conv-1' });

    await confirmWindow('conv-1', 'u-a', windowKey);

    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(s))).toBe(true);
    // Thread message goes to the PARTNER from the confirmer.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [from, to, content] = mockSendMessage.mock.calls[0] as string[];
    expect(from).toBe('u-a');
    expect(to).toBe('u-b');
    expect(content).toMatch(/Meeting confirmed/);
    // Bell notification for the partner.
    const notif = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect(notif[0]).toMatch(/'meeting_confirmed'/);
    expect((notif[1] as unknown[])[0]).toBe('u-b');
  });

  it('a failed thread message does not lose the confirmation itself', async () => {
    const windowKey = futureKey(2);
    armConv([
      { user_id: 'u-a', window_key: windowKey },
      { user_id: 'u-b', window_key: windowKey },
    ]);
    mockSendMessage.mockRejectedValue(new Error('dm down'));
    await expect(confirmWindow('conv-1', 'u-a', windowKey)).resolves.toBeTruthy();
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(s))).toBe(true);
  });
});

// ── acceptPoke seeds the introduction into the new thread ────────────────────
// (REASON Phase 2 — "we introduce them to each other". The poke's message
// becomes the first DM instead of dying with the accepted poke.)

describe('acceptPoke intro seeding', () => {
  const mockBlocked = jest.fn(async (..._a: unknown[]) => false);
  jest.mock('../../../services/block/block.service', () => ({
    areBlocked: (...a: unknown[]) => mockBlocked(...a),
    __esModule: true,
  }));

  function armAccept(message: string | null) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM user_pokes WHERE id/.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 'poke-1', sender_id: 'u-send', recipient_id: 'u-recv',
            status: 'pending', message, responded_at: null, created_at: new Date(),
          }],
        });
      }
      if (/UPDATE user_pokes/.test(sql)) return Promise.resolve({ rows: [{ responded_at: new Date() }] });
      if (/INSERT INTO dm_conversations/.test(sql)) return Promise.resolve({ rows: [{ id: 'conv-9' }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('a poke WITH a message seeds it as the first thread message from the sender', async () => {
    const pokeService = await import('../../../services/poke/poke.service');
    armAccept('You fit what they want. We think you two should meet.');
    await pokeService.acceptPoke('poke-1', 'u-recv');
    const dmInsert = mockQuery.mock.calls.find(c => /INSERT INTO direct_messages/.test(c[0] as string));
    expect(dmInsert).toBeTruthy(); // the intro must land in the thread
    const params = dmInsert![1] as string[];
    expect(params[1]).toBe('conv-9');            // conversation
    expect(params[2]).toBe('u-send');            // authored by the sender
    expect(params[3]).toMatch(/should meet/);
  });

  it('a message-less poke seeds nothing', async () => {
    const pokeService = await import('../../../services/poke/poke.service');
    armAccept(null);
    await pokeService.acceptPoke('poke-1', 'u-recv');
    expect(mockQuery.mock.calls.some(c => /INSERT INTO direct_messages/.test(c[0] as string))).toBe(false);
  });
});
