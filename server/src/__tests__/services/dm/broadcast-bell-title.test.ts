// ─── broadcastDmMessage: a caller may name the bell entry (26 Oct 2026) ───────────────────────────────
//
// "Message all participants" v2 sends the organiser's own words as an ordinary DM, so the thread, the
// reply path and the offline email all stay as they are. Only the bell changes: a bare "Claus sent you a
// message" says nothing about why a stranger wrote, whereas "Claus messaged everyone from ‘test’" does.
// The type stays direct_message, so notifications_type_check is untouched.

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../config', () => ({ default: { clientUrl: 'http://localhost:5173' }, __esModule: true }));
jest.mock('../../../services/dm/dm.service', () => ({ __esModule: true }));
jest.mock('../../../services/email/email.service', () => ({ sendDmNotificationEmail: jest.fn(), __esModule: true }));
jest.mock('../../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendEmail: jest.fn(async () => false),
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
const mockEmitEntities = jest.fn<any>(async () => undefined);
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
  __esModule: true,
}));

import { broadcastDmMessage } from '../../../services/orchestration/handlers/dm-handlers';

const emitted: Array<{ room: string; event: string; payload: any }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
  in: () => ({ fetchSockets: async () => [{}] }), // the recipient is online, so no offline email
} as any;

const message = {
  id: 'msg-1',
  conversationId: 'conv-1',
  fromUserId: 'organiser',
  content: 'Thank you all for coming, the recording is on its way.',
  readAt: null,
  createdAt: new Date('2026-10-26T10:00:00Z'),
};

/** The bell insert: the notifications row the recipient is shown, as [sql, params]. */
function bellInsert(): [string, string[]] | undefined {
  return mockQuery.mock.calls.find((c) => /INSERT INTO notifications/.test(String(c[0]))) as [string, string[]] | undefined;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockEmitEntities.mockClear();
  emitted.length = 0;
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (/SELECT display_name FROM users/.test(String(sql))) return { rows: [{ display_name: 'Claus Test' }] };
    if (/INSERT INTO notifications/.test(String(sql))) return { rows: [{ id: 'n-1', created_at: new Date('2026-10-26T10:00:01Z') }] };
    return { rows: [] };
  });
});

describe('broadcastDmMessage bellTitle', () => {
  it('uses the title it is given for the bell, with the message as the body and the thread as the link', async () => {
    await broadcastDmMessage(io, 'organiser', 'recipient', 'conv-1', message, {
      bellTitle: 'Claus messaged everyone from ‘test’',
    });

    const insert = bellInsert()!;
    expect(String(insert[0])).toMatch(/'direct_message'/);
    expect(insert[1][1]).toBe('recipient');
    expect(insert[1][2]).toBe('Claus messaged everyone from ‘test’');
    expect(insert[1][3]).toBe(message.content);
    expect(insert[1][4]).toBe('/messages/conv-1');

    const live = emitted.find((e) => e.event === 'notification:new' && e.room === 'user:recipient')!;
    expect(live.payload).toMatchObject({ type: 'direct_message', title: 'Claus messaged everyone from ‘test’' });
  });

  it('does not look the sender up when the title is already written', async () => {
    await broadcastDmMessage(io, 'organiser', 'recipient', 'conv-1', message, { bellTitle: 'Anything' });
    expect(mockQuery.mock.calls.some((c) => /SELECT display_name FROM users/.test(String(c[0])))).toBe(false);
  });

  it('keeps "<name> sent you a message" when no title is given', async () => {
    await broadcastDmMessage(io, 'organiser', 'recipient', 'conv-1', message);
    expect(bellInsert()![1][2]).toBe('Claus Test sent you a message');
  });

  it('keeps "<name> sent you a message" when options carry only other settings', async () => {
    await broadcastDmMessage(io, 'organiser', 'recipient', 'conv-1', message, {});
    expect(bellInsert()![1][2]).toBe('Claus Test sent you a message');
  });

  it('notify:false still means no bell at all, even with a title', async () => {
    await broadcastDmMessage(io, 'organiser', 'recipient', 'conv-1', message, { notify: false, bellTitle: 'Ignored' });
    expect(bellInsert()).toBeUndefined();
    expect(emitted.some((e) => e.event === 'notification:new')).toBe(false);
  });

  it('still tells both people\'s open tabs about the new message and refreshes the recipient\'s bell', async () => {
    await broadcastDmMessage(io, 'organiser', 'recipient', 'conv-1', message, { bellTitle: 'Claus messaged everyone from ‘test’' });
    const rooms = emitted.filter((e) => e.event === 'dm:message').map((e) => e.room).sort();
    expect(rooms).toEqual(['user:organiser', 'user:recipient']);
    expect(mockEmitEntities).toHaveBeenCalledWith(io, ['recipient'], expect.arrayContaining(['user:recipient:notifications']));
  });
});
