// ─── Quoted replies, one-to-one and in groups (30 Oct 2026 review, item 4.3) ─────────────────────────────────────────
//
// Stefan: "In messages ... you can't reply." A message may now answer one earlier message, and only one of the same
// conversation (one-to-one) or the same group, that the writer may see: anything else is a 400 in a member's words and
// nothing is kept. Each message carries `replyTo`, the original as the reader may see it: its sender ("Former member"
// once their account is closed), its first 140 characters, its kind (a reply to a REASON card is allowed), and
// `deleted` when it no longer exists. In a group, an original the reader may not see (from someone blocked with them
// either way, or from before they joined) is `hidden`, with nothing of it sent. Rows from before migration 121 have no
// reply and read `replyTo: null`.
//
// The database is a stand-in that answers by what the SQL asks: statements inside a transaction go to `tx`, reads
// outside one to `pool`. The SQL itself is run against a real Postgres in message-replies.sql.test.ts.

type Rows = Array<Record<string, unknown>>;
type Rule = [RegExp, Rows | ((params: unknown[]) => Rows)];

const mockPool = jest.fn();
const mockTx = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockPool(...a),
  transaction: (cb: (client: unknown) => Promise<unknown>) => cb({ query: (...a: unknown[]) => mockTx(...a) }),
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
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn(),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import { listMessages, sendMessage } from '../../../services/dm/dm.service';
import { listGroupMessages, sendGroupMessage } from '../../../services/dm/group.service';
import { REPLY_COPY, REPLY_EXCERPT_MAX } from '../../../services/dm/reply-quote';
import { ErrorCodes } from '@rsn/shared';

const ME = 'a0000000-0000-4000-8000-00000000000a';
const THEM = 'b0000000-0000-4000-8000-00000000000b';
const CONV = 'c0000000-0000-4000-8000-000000000001';
const GROUP = '90000000-0000-4000-8000-000000000001';
const ORIGINAL = '70000000-0000-4000-8000-000000000001';
const NEW_MSG = '70000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-01T10:00:00.000Z');

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
function answerWith(mock: jest.Mock, rules: Rule[]) {
  mock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const rule = rules.find(([re]) => re.test(flat(sql)));
    const rows = !rule ? [] : typeof rule[1] === 'function' ? rule[1](params) : rule[1];
    return { rows, rowCount: rows.length };
  });
}
const callTo = (mock: jest.Mock, re: RegExp) => mock.mock.calls.find((c) => re.test(flat(c[0])));
const ran = (mock: jest.Mock, re: RegExp) => mock.mock.calls.some((c) => re.test(flat(c[0])));

type Caught = Error & { statusCode?: number; code?: string };
const caught = (p: Promise<unknown>) => p.then(() => null, (e: Caught) => e);
const refusal = (e: Caught | null) => (e ? { status: e.statusCode, code: e.code, message: e.message } : null);

// ─── One-to-one ─────────────────────────────────────────────────────────────

// canMessage's one read of the sender's role and whether the other account is still active (T2).
const ROLE = /SELECT role, \(SELECT .* AS recipient_active FROM users WHERE id = \$1/;
const UPSERT_CONV = /INSERT INTO dm_conversations/;
const DM_ORIGINAL = /FROM direct_messages o JOIN users ou ON ou\.id = o\.from_user_id WHERE o\.id = \$1 AND o\.conversation_id = \$2/;
const INSERT_DM = /INSERT INTO direct_messages \( id, conversation_id, from_user_id, content, attachment_url, attachment_type, attachment_meta, kind, system_meta, reply_to_id \)/;

const insertedRow = (params: unknown[]) => [{
  id: NEW_MSG, conversation_id: params[1], from_user_id: params[2], content: params[3], read_at: null, created_at: NOW,
  attachment_url: null, attachment_type: null, attachment_meta: null, kind: params[7], system_meta: null, reply_to_id: params[9],
}];

const original = (over: Record<string, unknown> = {}) => ({
  id: ORIGINAL, content: 'Shall we meet on Tuesday?', kind: 'user', attachment_type: null,
  display_name: 'Shradha Adhikari', status: 'active', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAreBlocked.mockResolvedValue(false);
  // An admin may message anyone (canMessage's step 3), so the gate is passed and the tests are about the reply.
  answerWith(mockPool, [[ROLE, [{ role: 'admin', recipient_active: true }]]]);
});

describe('sendMessage with a reply (one-to-one)', () => {
  const sends = (originalRows: Rows) => answerWith(mockTx, [
    [UPSERT_CONV, [{ id: CONV }]],
    [DM_ORIGINAL, originalRows],
    [INSERT_DM, insertedRow],
  ]);

  it('keeps the reply with the message it answers, and sends the quote back with it', async () => {
    sends([original()]);
    const out = await sendMessage(ME, THEM, 'Yes, Tuesday works', null, ORIGINAL);
    expect(callTo(mockTx, DM_ORIGINAL)![1]).toEqual([ORIGINAL, CONV]);
    expect(callTo(mockTx, INSERT_DM)![1][9]).toBe(ORIGINAL);
    expect(out.message.replyTo).toEqual({
      id: ORIGINAL, senderName: 'Shradha Adhikari', content: 'Shall we meet on Tuesday?', kind: 'user', deleted: false,
    });
  });

  it('refuses a reply to a message of another conversation, in a member\'s words, and keeps nothing', async () => {
    sends([]);
    const e = await caught(sendMessage(ME, THEM, 'Yes', null, ORIGINAL));
    expect(refusal(e)).toEqual({ status: 400, code: ErrorCodes.VALIDATION_ERROR, message: REPLY_COPY.notInConversation });
    expect(REPLY_COPY.notInConversation).toBe('You can only reply to a message in this conversation.');
    expect(ran(mockTx, INSERT_DM)).toBe(false);
  });

  it('a reply across a block is refused before anything else, as every message is', async () => {
    mockAreBlocked.mockResolvedValue(true);
    sends([original()]);
    const e = await caught(sendMessage(ME, THEM, 'Yes', null, ORIGINAL));
    expect(refusal(e)).toEqual({ status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: 'You can no longer message this user' });
    expect(ran(mockTx, DM_ORIGINAL)).toBe(false);
    expect(ran(mockTx, INSERT_DM)).toBe(false);
  });

  it('a reply to someone whose account is closed is refused before anything else (T2\'s rule), and nothing is kept', async () => {
    answerWith(mockPool, [[ROLE, [{ role: 'member', recipient_active: false }]]]);
    sends([original()]);
    const e = await caught(sendMessage(ME, THEM, 'Yes', null, ORIGINAL));
    expect(e?.statusCode).toBe(403);
    expect(ran(mockTx, DM_ORIGINAL)).toBe(false);
    expect(ran(mockTx, INSERT_DM)).toBe(false);
  });

  it('may answer a card REASON wrote, quoting the card', async () => {
    sends([original({ kind: 'system', content: 'Meeting confirmed: Tue 4 Nov, 10:00' })]);
    const out = await sendMessage(ME, THEM, 'See you then', null, ORIGINAL);
    expect(out.message.replyTo).toMatchObject({ kind: 'system', content: 'Meeting confirmed: Tue 4 Nov, 10:00' });
  });

  it('quotes the first 140 characters, counting a whole emoji as one', async () => {
    const long = '🙂'.repeat(10) + 'x'.repeat(300);
    sends([original({ content: long })]);
    const out = await sendMessage(ME, THEM, 'ok', null, ORIGINAL);
    expect(REPLY_EXCERPT_MAX).toBe(140);
    expect(Array.from(out.message.replyTo!.content)).toHaveLength(140);
    expect(out.message.replyTo!.content.startsWith('🙂'.repeat(10))).toBe(true);
  });

  it('an original that is only a photo or a voice message is quoted as one', async () => {
    sends([original({ content: null, attachment_type: 'image' })]);
    expect((await sendMessage(ME, THEM, 'Nice', null, ORIGINAL)).message.replyTo!.content).toBe('📷 Photo');
    sends([original({ content: null, attachment_type: 'audio' })]);
    expect((await sendMessage(ME, THEM, 'Heard it', null, ORIGINAL)).message.replyTo!.content).toBe('🎤 Voice message');
  });

  it('an original whose writer\'s account is closed is quoted under "Former member"', async () => {
    sends([original({ status: 'deactivated' })]);
    const out = await sendMessage(ME, THEM, 'ok', null, ORIGINAL);
    expect(out.message.replyTo!.senderName).toBe('Former member');
  });

  it('a message that answers nothing is kept as before: no lookup, no reply, replyTo null', async () => {
    sends([original()]);
    const out = await sendMessage(ME, THEM, 'Hello');
    expect(ran(mockTx, DM_ORIGINAL)).toBe(false);
    expect(callTo(mockTx, INSERT_DM)![1][9]).toBeNull();
    expect(out.message.replyTo).toBeNull();
  });
});

describe('listMessages carries each reply\'s quote (one-to-one)', () => {
  const THREAD = /FROM direct_messages m LEFT JOIN direct_messages o ON o\.id = m\.reply_to_id LEFT JOIN users ou ON ou\.id = o\.from_user_id/;
  const row = (over: Record<string, unknown>) => ({
    id: NEW_MSG, conversation_id: CONV, from_user_id: THEM, content: 'Reply', read_at: null, created_at: NOW,
    reactions: {}, attachment_url: null, attachment_type: null, attachment_meta: null, kind: 'user', system_meta: null,
    reply_to_id: null, reply_id: null, reply_content: null, reply_kind: null, reply_attachment_type: null,
    reply_name: null, reply_status: null, ...over,
  });
  const reads = (rows: Rows) => answerWith(mockPool, [
    [/FROM dm_conversations WHERE id = \$1/, [{ user_a_id: ME, user_b_id: THEM, user_a_deleted_at: null, user_b_deleted_at: null }]],
    [/SELECT COUNT\(\*\)::text AS count FROM direct_messages/, [{ count: String(rows.length) }]],
    [THREAD, rows],
  ]);

  it('a message from before replies existed (no reply_to_id) has no quote', async () => {
    reads([row({})]);
    const { messages } = await listMessages(CONV, ME);
    expect(messages[0].replyTo).toBeNull();
  });

  it('a reply carries its original: sender, the first 140 characters and kind', async () => {
    reads([row({ reply_to_id: ORIGINAL, reply_id: ORIGINAL, reply_content: 'Shall we meet?', reply_kind: 'user', reply_name: 'Ana Lopez', reply_status: 'active' })]);
    const { messages } = await listMessages(CONV, ME);
    expect(messages[0].replyTo).toEqual({ id: ORIGINAL, senderName: 'Ana Lopez', content: 'Shall we meet?', kind: 'user', deleted: false });
    // LEFT(…, 140) in the database counts characters the way the quote does.
    expect(flat(callTo(mockPool, THREAD)![0])).toMatch(/LEFT\(o\.content, 140\) AS reply_content/);
  });

  it('a reply whose original no longer exists says so: deleted, with nothing of it', async () => {
    reads([row({ reply_to_id: ORIGINAL, reply_id: null })]);
    const { messages } = await listMessages(CONV, ME);
    expect(messages[0].replyTo).toEqual({ id: ORIGINAL, senderName: '', content: '', kind: 'user', deleted: true });
  });

  it('an original whose writer\'s account is closed reads "Former member"', async () => {
    reads([row({ reply_to_id: ORIGINAL, reply_id: ORIGINAL, reply_content: 'hi', reply_kind: 'user', reply_name: 'Gone', reply_status: 'suspended' })]);
    const { messages } = await listMessages(CONV, ME);
    expect(messages[0].replyTo!.senderName).toBe('Former member');
  });
});

// ─── Groups ─────────────────────────────────────────────────────────────────

const LOCK = /FROM dm_groups WHERE id = \$1 FOR UPDATE/;
const SENDER = /FROM dm_group_members m JOIN users u ON u\.id = m\.user_id WHERE m\.group_id = \$1 AND m\.user_id = \$2/;
const GROUP_ORIGINAL = /FROM direct_messages o JOIN users ou ON ou\.id = o\.from_user_id JOIN dm_group_members me ON me\.group_id = o\.group_id AND me\.user_id = \$3 WHERE o\.id = \$1 AND o\.group_id = \$2/;
const INSERT_GROUP_MSG = /INSERT INTO direct_messages \(group_id, from_user_id, content, reply_to_id\)/;
const BELLS = /INSERT INTO notifications/;

describe('sendGroupMessage with a reply', () => {
  const sends = (originalRows: Rows) => answerWith(mockTx, [
    [LOCK, [{ id: GROUP, name: 'Follow-up crew', type: 'event', session_id: null }]],
    [SENDER, [{ display_name: 'Claus Meyer', avatar_url: null }]],
    [GROUP_ORIGINAL, originalRows],
    [INSERT_GROUP_MSG, [{ id: NEW_MSG, created_at: NOW }]],
    [BELLS, []],
  ]);

  it('keeps the reply with the message it answers, and returns the quote', async () => {
    sends([original({ display_name: 'Ana Lopez' })]);
    const out = await sendGroupMessage(GROUP, ME, 'Agreed', ORIGINAL);
    expect(callTo(mockTx, GROUP_ORIGINAL)![1]).toEqual([ORIGINAL, GROUP, ME]);
    expect(callTo(mockTx, INSERT_GROUP_MSG)![1]).toEqual([GROUP, ME, 'Agreed', ORIGINAL]);
    expect(out.message.replyTo).toEqual({ id: ORIGINAL, senderName: 'Ana Lopez', content: 'Shall we meet on Tuesday?', kind: 'user', deleted: false });
  });

  it('only a message of this group the writer may see can be answered: never one from someone blocked either way, nor from before they joined', async () => {
    sends([original()]);
    await sendGroupMessage(GROUP, ME, 'Agreed', ORIGINAL);
    const sql = flat(callTo(mockTx, GROUP_ORIGINAL)![0]);
    expect(sql).toMatch(/AND o\.created_at >= me\.joined_at/);
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$3 AND b\.blocked_id = o\.from_user_id\) OR \(b\.blocker_id = o\.from_user_id AND b\.blocked_id = \$3\)\)/);
  });

  it('refuses a reply to a message it may not answer, in a member\'s words, and keeps nothing and rings nobody', async () => {
    sends([]);
    const e = await caught(sendGroupMessage(GROUP, ME, 'Agreed', ORIGINAL));
    expect(refusal(e)).toEqual({ status: 400, code: ErrorCodes.VALIDATION_ERROR, message: REPLY_COPY.notInGroup });
    expect(REPLY_COPY.notInGroup).toBe('You can only reply to a message in this group.');
    expect(ran(mockTx, INSERT_GROUP_MSG)).toBe(false);
    expect(ran(mockTx, BELLS)).toBe(false);
  });

  it('a message that answers nothing is kept as before, with replyTo null', async () => {
    sends([original()]);
    const out = await sendGroupMessage(GROUP, ME, 'Hello all');
    expect(ran(mockTx, GROUP_ORIGINAL)).toBe(false);
    expect(callTo(mockTx, INSERT_GROUP_MSG)![1]).toEqual([GROUP, ME, 'Hello all', null]);
    expect(out.message.replyTo).toBeNull();
  });
});

describe('listGroupMessages carries each reply\'s quote', () => {
  const ACCESS = /FROM dm_groups g LEFT JOIN dm_group_members me ON me\.group_id = g\.id AND me\.user_id = \$2 WHERE g\.id = \$1/;
  const THREAD = /FROM direct_messages d JOIN users u ON u\.id = d\.from_user_id JOIN dm_group_members me ON me\.group_id = d\.group_id AND me\.user_id = \$2 LEFT JOIN direct_messages o ON o\.id = d\.reply_to_id LEFT JOIN users ou ON ou\.id = o\.from_user_id WHERE d\.group_id = \$1/;
  const row = (over: Record<string, unknown>) => ({
    id: NEW_MSG, from_user_id: THEM, content: 'Reply', created_at: NOW, display_name: 'Ana Lopez', avatar_url: null, status: 'active',
    reply_to_id: null, reply_id: null, reply_content: null, reply_kind: null, reply_attachment_type: null,
    reply_name: null, reply_status: null, reply_hidden: false, ...over,
  });
  const reads = (rows: Rows) => answerWith(mockPool, [[ACCESS, [{ id: GROUP, role: 'member' }]], [THREAD, rows]]);

  it('a message from before replies existed has no quote', async () => {
    reads([row({})]);
    expect((await listGroupMessages(GROUP, ME, {})).messages[0].replyTo).toBeNull();
  });

  it('a reply carries its original as the reader may see it', async () => {
    reads([row({ reply_to_id: ORIGINAL, reply_id: ORIGINAL, reply_content: 'Who is in?', reply_kind: 'user', reply_name: 'Claus Meyer', reply_status: 'active' })]);
    expect((await listGroupMessages(GROUP, ME, {})).messages[0].replyTo).toEqual({ id: ORIGINAL, senderName: 'Claus Meyer', content: 'Who is in?', kind: 'user', deleted: false });
  });

  it('an original the reader may not see (blocked either way, or from before they joined) is hidden, with nothing of it sent', async () => {
    reads([row({ reply_to_id: ORIGINAL, reply_id: ORIGINAL, reply_content: 'secret', reply_kind: 'user', reply_name: 'Blocked Person', reply_status: 'active', reply_hidden: true })]);
    const quote = (await listGroupMessages(GROUP, ME, {})).messages[0].replyTo;
    expect(quote).toEqual({ id: ORIGINAL, senderName: '', content: '', kind: 'user', deleted: false, hidden: true });
    const sql = flat(callTo(mockPool, THREAD)![0]);
    expect(sql).toMatch(/o\.created_at < me\.joined_at OR NOT \(NOT EXISTS \( SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$2 AND b\.blocked_id = o\.from_user_id\) OR \(b\.blocker_id = o\.from_user_id AND b\.blocked_id = \$2\)\)\)\)/);
  });

  it('a reply whose original no longer exists says so', async () => {
    reads([row({ reply_to_id: ORIGINAL, reply_id: null })]);
    expect((await listGroupMessages(GROUP, ME, {})).messages[0].replyTo).toEqual({ id: ORIGINAL, senderName: '', content: '', kind: 'user', deleted: true });
  });
});
