// A voice message only ever lands in a conversation its sender is part of (Shirley Palmer, 11 Nov 2026, RSN 01).
//
// The client fix keeps an unsent voice note in the conversation it was recorded in. This pins the server's side of the
// same promise: POST /dm/messages names a recipient, never a conversation, and the conversation the message is
// written to is the pair (sender, recipient), so a sender cannot put a voice message into someone else's thread; and a
// voice message to someone the sender has no tie with is refused before anything is written.

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockTransaction = jest.fn(async (fn: (c: { query: typeof mockClientQuery }) => unknown) => fn({ query: mockClientQuery }));
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (fn: never) => mockTransaction(fn),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockAreBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
  __esModule: true,
}));

import { sendMessage } from '../../../services/dm/dm.service';

const SENDER = 'a0000000-0000-4000-8000-00000000000a';
const STRANGER = 'c0000000-0000-4000-8000-00000000000c';
const FRIEND = 'b0000000-0000-4000-8000-00000000000b';
const VOICE = { url: 'https://res.cloudinary.com/demo/video/upload/v1/voice.webm', type: 'audio' as const, meta: { durationSec: 12 } };
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

/** The stand-in database: a member with no thread, no encounter and no shared meeting with the stranger; an existing thread with the friend. */
function db() {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = flat(sql);
    if (/FROM users WHERE id/.test(text)) return { rows: [{ role: 'member', recipient_active: true, sender_kind: 'member', recipient_kind: 'member' }] };
    if (/FROM dm_conversations c JOIN direct_messages/.test(text)) {
      const pair = params as string[];
      return { rows: [{ msg_count: pair.includes(FRIEND) ? '3' : '0' }] };
    }
    return { rows: [] };
  });
  mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = flat(sql);
    if (/INSERT INTO dm_conversations/.test(text)) return { rows: [{ id: 'conv-of-the-pair' }] };
    if (/INSERT INTO direct_messages/.test(text)) {
      return { rows: [{
        id: 'm1', conversation_id: params[1], from_user_id: params[2], content: params[3], read_at: null, created_at: new Date(),
        attachment_url: params[4], attachment_type: params[5], attachment_meta: params[6], kind: 'user', system_meta: null,
      }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockTransaction.mockClear();
  mockAreBlocked.mockReset();
  mockAreBlocked.mockResolvedValue(false);
  db();
});

describe('a voice message and the conversation it lands in', () => {
  it('to someone the sender has no conversation, match or meeting with: refused (403), and nothing is written', async () => {
    await expect(sendMessage(SENDER, STRANGER, '', VOICE)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('to someone the sender has blocked, or who blocked the sender: refused, nothing written', async () => {
    mockAreBlocked.mockResolvedValue(true);
    await expect(sendMessage(SENDER, FRIEND, '', VOICE)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('to the sender themself: refused', async () => {
    await expect(sendMessage(SENDER, SENDER, '', VOICE)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('to a friend: written to the conversation of exactly that pair (sender and recipient), and nowhere else', async () => {
    const result = await sendMessage(SENDER, FRIEND, '', VOICE);
    const conv = mockClientQuery.mock.calls.find((c) => /INSERT INTO dm_conversations/.test(flat(c[0])))!;
    const pair = (conv[1] as string[]).slice(1, 3);
    expect([...pair].sort()).toEqual([SENDER, FRIEND].sort());
    const insert = mockClientQuery.mock.calls.find((c) => /INSERT INTO direct_messages/.test(flat(c[0])))!;
    expect(insert[1][1]).toBe('conv-of-the-pair');
    expect(insert[1][2]).toBe(SENDER);
    expect(insert[1][5]).toBe('audio');
    expect(result.conversationId).toBe('conv-of-the-pair');
  });

  it('a voice message hosted anywhere but Cloudinary is refused before the gate', async () => {
    await expect(sendMessage(SENDER, FRIEND, '', { ...VOICE, url: 'https://evil.example/voice.webm' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
