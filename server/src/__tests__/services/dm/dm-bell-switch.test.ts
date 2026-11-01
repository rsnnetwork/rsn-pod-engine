// ─── The "Direct messages" switches in Settings are kept (1 Nov 2026, audit 02 side finding S1) ──────────────────────
//
// Settings offers a Bell and an Email switch for direct messages, and the server stores both (notification_prefs
// dm_bell, dm_email). The email has always asked its switch; the bell never did: broadcastDmMessage wrote the
// "<name> sent you a message" row and pushed it live whatever the member had chosen. Now a member whose message bell is
// off gets no bell row, no live bell and no notifications tag, while the message itself still arrives live in both
// people's threads; and a member whose message email is off gets no email (the plan's pin, kept).

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../config', () => ({ default: { clientUrl: 'http://localhost:5173' }, __esModule: true }));
jest.mock('../../../services/dm/dm.service', () => ({ __esModule: true }));
const mockSendEmail = jest.fn<any>(async () => undefined);
jest.mock('../../../services/email/email.service', () => ({
  sendDmNotificationEmail: (...a: unknown[]) => mockSendEmail(...a),
  __esModule: true,
}));
const prefs = { dm_bell: true, dm_email: true };
jest.mock('../../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendBell: jest.fn(async () => prefs.dm_bell),
  shouldSendEmail: jest.fn(async () => prefs.dm_email),
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
const mockEmitEntities = jest.fn<any>(async () => undefined);
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
  __esModule: true,
}));

import { broadcastDmMessage } from '../../../services/orchestration/handlers/dm-handlers';
import * as prefsService from '../../../services/notification-prefs/notification-prefs.service';

const emitted: Array<{ room: string; event: string }> = [];
let online = true;
const io = {
  to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }),
  in: () => ({ fetchSockets: async () => (online ? [{}] : []) }),
} as any;

const message = {
  id: 'msg-1', conversationId: 'conv-1', fromUserId: 'ana', content: 'Hello Ben', readAt: null,
  createdAt: new Date('2026-11-01T10:00:00Z'),
};

const bellInserts = () => mockQuery.mock.calls.filter((c) => /INSERT INTO notifications/.test(String(c[0])));
/** The fire-and-forget email runs after broadcastDmMessage returns. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockQuery.mockReset();
  mockSendEmail.mockClear();
  mockEmitEntities.mockClear();
  emitted.length = 0;
  online = true;
  prefs.dm_bell = true;
  prefs.dm_email = true;
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (/SELECT display_name FROM users/.test(s)) return { rows: [{ display_name: 'Ana Lopez' }] };
    if (/INSERT INTO notifications/.test(s)) return { rows: [{ id: 'n-1', created_at: new Date() }] };
    if (/SELECT id, email, display_name FROM users/.test(s)) {
      return { rows: [{ id: 'ana', email: 'ana@rsn-e2e.invalid', display_name: 'Ana' }, { id: 'ben', email: 'ben@rsn-e2e.invalid', display_name: 'Ben' }] };
    }
    return { rows: [] };
  });
});

describe('the Direct messages bell switch', () => {
  it('on: the recipient gets the bell row, the live bell and their notifications tag', async () => {
    await broadcastDmMessage(io, 'ana', 'ben', 'conv-1', message);
    expect(prefsService.shouldSendBell).toHaveBeenCalledWith('ben', 'dm');
    expect(bellInserts()).toHaveLength(1);
    expect(emitted).toContainEqual({ room: 'user:ben', event: 'notification:new' });
    expect(mockEmitEntities).toHaveBeenCalledWith(io, ['ben'], expect.arrayContaining(['user:ben:notifications']));
  });

  it('off: no bell row, no live bell, no notifications tag, while the message still reaches both threads live', async () => {
    prefs.dm_bell = false;
    await broadcastDmMessage(io, 'ana', 'ben', 'conv-1', message);
    expect(bellInserts()).toHaveLength(0);
    expect(emitted).not.toContainEqual({ room: 'user:ben', event: 'notification:new' });
    expect(mockEmitEntities.mock.calls.some((c) => (c[2] as string[]).includes('user:ben:notifications'))).toBe(false);
    expect(emitted).toEqual(expect.arrayContaining([
      { room: 'user:ana', event: 'dm:message' }, { room: 'user:ben', event: 'dm:message' },
    ]));
    expect(mockEmitEntities).toHaveBeenCalledWith(io, ['ana', 'ben'], ['dm-conversation:conv-1', 'user:ana:dms', 'user:ben:dms']);
  });

  it('off: the offline email still goes, by its own switch', async () => {
    prefs.dm_bell = false;
    online = false;
    await broadcastDmMessage(io, 'ana', 'ben', 'conv-1', message);
    await settle();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('the Direct messages email switch', () => {
  it('a message to someone offline with the switch off sends no email', async () => {
    prefs.dm_email = false;
    online = false;
    await broadcastDmMessage(io, 'ana', 'ben', 'conv-1', message);
    await settle();
    expect(prefsService.shouldSendEmail).toHaveBeenCalledWith('ben', 'dm');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('with the switch on, someone offline is emailed', async () => {
    online = false;
    await broadcastDmMessage(io, 'ana', 'ben', 'conv-1', message);
    await settle();
    expect(mockSendEmail).toHaveBeenCalledWith('ben@rsn-e2e.invalid', 'Ben', expect.objectContaining({ senderName: 'Ana' }));
  });
});

describe('a reply arrives quoted', () => {
  it('the live dm:message carries replyTo, and null for a message that answers nothing', async () => {
    const payloads: unknown[] = [];
    const spy = {
      to: () => ({ emit: (event: string, p: unknown) => { if (event === 'dm:message') payloads.push(p); } }),
      in: () => ({ fetchSockets: async () => [{}] }),
    } as any;
    const replyTo = { id: 'msg-0', senderName: 'Ben', content: 'Tuesday?', kind: 'user' as const, deleted: false };
    await broadcastDmMessage(spy, 'ana', 'ben', 'conv-1', { ...message, replyTo });
    await broadcastDmMessage(spy, 'ana', 'ben', 'conv-1', message);
    expect(payloads[0]).toMatchObject({ replyTo });
    expect(payloads[2]).toMatchObject({ replyTo: null });
  });
});
