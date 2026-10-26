// ─── Event chat: who reads it, how it is stored, paged, reacted to and taken down (26 Oct 2026) ──
//
// The database is a stand-in: each case gives it the rows Postgres would return and checks what the service
// decides, returns and sends to it. The SQL itself is proved against a real database in the task's local run
// (task-S5-report.md): constraints, the audience and block predicates, and paging with many messages in one
// millisecond.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: (...a: unknown[]) => mockQuery(...a) })),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { ErrorCodes } from '@rsn/shared';
import { AppError } from '../../../middleware/errors';
import {
  canReadEventChat, listEventChat, listLiveChatHistory, persistEventChatMessage, toggleEventChatReaction,
  deleteEventChatMessage, chatBlockedUserIds, createSendLimiter,
} from '../../../services/event-chat/event-chat.service';

const EVENT = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const THIRD = '44444444-4444-4444-8444-444444444444';
const MSG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MSG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** The facts canReadEventChat reads in its one query. */
function facts(over: Partial<{ status: string; is_host: boolean; is_cohost: boolean; participant_status: string | null; joined: boolean }> = {}) {
  return { status: 'completed', is_host: false, is_cohost: false, participant_status: null, joined: false, ...over };
}

/** A stored message as the read query returns it (newest first). */
function row(id: string, at: string, over: Record<string, unknown> = {}) {
  return {
    id, sender_id: OTHER, sender_name: 'Stefan', sender_is_host: false, scope: 'lobby', room_id: null,
    content: `message ${id.slice(0, 1)}`, created_at: new Date(at), sender_status: 'active', reactions: {},
    ...over,
  };
}

const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ');
const paramsOf = (call: unknown[]) => call[1] as unknown[];
/** The page size a read asked the database for: its last parameter, bound to LIMIT (never written into the SQL). */
function limitOf(call: unknown[]): unknown {
  const params = paramsOf(call);
  expect(sqlOf(call)).toMatch(new RegExp(`LIMIT \\$${params.length}\\s*$`));
  return params[params.length - 1];
}
const callsMatching = (re: RegExp) => mockQuery.mock.calls.filter((c) => re.test(sqlOf(c)));

async function expectAppError(p: Promise<unknown>, status: number, code: string, message?: string) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(status);
  expect((err as AppError).code).toBe(code);
  if (message !== undefined) expect((err as AppError).message).toBe(message);
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ── Who may read ─────────────────────────────────────────────────────────────

describe('canReadEventChat', () => {
  const read = (f: ReturnType<typeof facts> | null, role = 'member', opts?: { inSessionRoom?: boolean }) => {
    mockQuery.mockResolvedValueOnce({ rows: f ? [f] : [] });
    return canReadEventChat(ME, role, EVENT, opts);
  };

  it('asks the database once, with the event and the viewer as parameters', async () => {
    await read(facts({ joined: true, participant_status: 'left' }));
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(paramsOf(mockQuery.mock.calls[0])).toEqual([EVENT, ME]);
  });

  it.each([
    ['someone who took part and left early', facts({ joined: true, participant_status: 'left' }), 'all'],
    ['someone who joined and was later marked a no-show', facts({ joined: true, participant_status: 'no_show' }), 'all'],
    ['someone in the room right now', facts({ status: 'lobby_open', joined: true, participant_status: 'in_lobby' }), 'all'],
    ['the event host, with no participant row', facts({ is_host: true }), 'all'],
    ['a co-host, with no participant row', facts({ is_cohost: true }), 'all'],
  ])('lets %s read everything they were sent', async (_who, f, want) => {
    expect(await read(f)).toBe(want);
  });

  it.each([
    ['registered but never joined', facts({ participant_status: 'registered', joined: false })],
    ['marked a no-show without joining', facts({ participant_status: 'no_show', joined: false })],
    ['removed by the host after joining', facts({ participant_status: 'removed', joined: true })],
    ['a pod member who never registered', facts()],
  ])('refuses someone %s', async (_who, f) => {
    expect(await read(f)).toBeNull();
  });

  it('lets a platform admin read lobby messages only, and a super_admin the same', async () => {
    expect(await read(facts(), 'admin')).toBe('lobby');
    expect(await read(facts(), 'super_admin')).toBe('lobby');
  });

  it('an admin who took part reads what they were sent, like anyone who took part', async () => {
    expect(await read(facts({ joined: true, participant_status: 'left' }), 'admin')).toBe('all');
  });

  it('a removed admin keeps lobby moderation only', async () => {
    expect(await read(facts({ participant_status: 'removed', joined: true }), 'admin')).toBe('lobby');
  });

  it('the host is never refused, whatever their participant row says', async () => {
    expect(await read(facts({ is_host: true, participant_status: 'removed', joined: true }))).toBe('all');
  });

  it('a removed co-host is out, as a kick is final', async () => {
    expect(await read(facts({ is_cohost: true, participant_status: 'removed', joined: true }))).toBeNull();
  });

  it('a socket in the room of an event still open reads it (the pre-event lobby, before anyone has joined_at)', async () => {
    expect(await read(facts({ status: 'scheduled', participant_status: 'registered' }), 'member', { inSessionRoom: true })).toBe('all');
    expect(await read(facts({ status: 'round_active' }), 'member', { inSessionRoom: true })).toBe('all');
  });

  it('once the event is over, being in its socket room admits nobody who did not take part', async () => {
    expect(await read(facts({ status: 'completed' }), 'member', { inSessionRoom: true })).toBeNull();
    expect(await read(facts({ status: 'cancelled' }), 'member', { inSessionRoom: true })).toBeNull();
  });

  it('a removed member in the room of a live event is still refused', async () => {
    expect(await read(facts({ status: 'lobby_open', participant_status: 'removed', joined: true }), 'member', { inSessionRoom: true })).toBeNull();
  });

  it('an event that does not exist is a 404, not a refusal', async () => {
    await expectAppError(read(null), 404, 'SESSION_NOT_FOUND');
  });
});

// ── The chat page (REST) ─────────────────────────────────────────────────────

describe('listEventChat', () => {
  const viewer = { id: ME, role: 'member' };

  /** First query: canReadEventChat's facts. Second: the page. */
  function givenPage(f: ReturnType<typeof facts>, rows: unknown[]) {
    mockQuery.mockResolvedValueOnce({ rows: [f] }).mockResolvedValueOnce({ rows });
  }

  it('refuses someone who did not take part with the sentence the page shows, and reads no messages', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [facts({ participant_status: 'registered' })] });
    await expectAppError(listEventChat(EVENT, viewer), 403, ErrorCodes.AUTH_FORBIDDEN,
      'Only people who took part in this event can read its chat.');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('reads lobby messages and the room messages the viewer was sent, never deleted ones, never a blocked author either way', async () => {
    givenPage(facts({ joined: true, participant_status: 'left' }), []);
    await listEventChat(EVENT, viewer);
    const [sql, params] = [sqlOf(mockQuery.mock.calls[1]), paramsOf(mockQuery.mock.calls[1])];
    expect(sql).toMatch(/m\.session_id = \$1/);
    expect(sql).toMatch(/m\.deleted_at IS NULL/);
    expect(sql).toMatch(/\(m\.scope = 'lobby' OR \(\$3::boolean AND m\.audience_ids @> ARRAY\[\$2::uuid\]\)\)/);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = m\.sender_id/);
    expect(sql).toMatch(/b\.blocker_id = m\.sender_id AND b\.blocked_id = \$2/);
    expect(sql).toMatch(/ORDER BY m\.created_at DESC, m\.id DESC/);
    expect(params.slice(0, 3)).toEqual([EVENT, ME, true]);
  });

  it('gives a platform admin lobby messages only: room messages are private to the room', async () => {
    givenPage(facts(), []);
    await listEventChat(EVENT, { id: ME, role: 'admin' });
    expect(paramsOf(mockQuery.mock.calls[1])[2]).toBe(false);
  });

  it('returns the page oldest to newest, with names, scopes, times and reaction counts', async () => {
    givenPage(facts({ is_host: true }), [
      row(MSG_C, '2026-10-25T11:54:03.250Z', { scope: 'room', room_id: 'room-1', content: 'see you', reactions: { heart: [ME, THIRD] } }),
      row(MSG_B, '2026-10-25T11:53:00.000Z', { sender_id: ME, sender_name: 'Claus', sender_is_host: true }),
      row(MSG_A, '2026-10-25T11:52:00.000Z', { reactions: { clap: [ME], thumbs_up: [OTHER] } }),
    ]);
    const page = await listEventChat(EVENT, viewer);
    expect(page).toEqual({
      messages: [
        { id: MSG_A, senderId: OTHER, senderName: 'Stefan', senderIsHost: false, scope: 'lobby', content: 'message a', createdAt: '2026-10-25T11:52:00.000Z', reactions: { clap: 1, thumbs_up: 1 } },
        { id: MSG_B, senderId: ME, senderName: 'Claus', senderIsHost: true, scope: 'lobby', content: 'message b', createdAt: '2026-10-25T11:53:00.000Z', reactions: {} },
        { id: MSG_C, senderId: OTHER, senderName: 'Stefan', senderIsHost: false, scope: 'room', content: 'see you', createdAt: '2026-10-25T11:54:03.250Z', reactions: { heart: 2 } },
      ],
      nextCursor: null,
    });
  });

  it.each([
    ['a closed account', { sender_status: 'deactivated' }],
    ['a suspended account', { sender_status: 'suspended' }],
    ['an account that was deleted (no sender id left)', { sender_id: null, sender_status: null }],
  ])('names the author of %s "Former member", with no id to link to', async (_what, over) => {
    givenPage(facts({ joined: true, participant_status: 'left' }), [row(MSG_A, '2026-10-25T11:52:00.000Z', over)]);
    const page = await listEventChat(EVENT, viewer);
    expect(page.messages[0]).toMatchObject({ senderId: null, senderName: 'Former member' });
  });

  it('asks for one row more than the page, and when there is more, the cursor points at the oldest message shown', async () => {
    givenPage(facts({ joined: true, participant_status: 'left' }), [
      row(MSG_C, '2026-10-25T11:54:00.007Z'),
      row(MSG_B, '2026-10-25T11:54:00.007Z'), // the same millisecond: the id breaks the tie
      row(MSG_A, '2026-10-25T11:52:00.000Z'),
    ]);
    const page = await listEventChat(EVENT, viewer, { limit: 2 });
    expect(limitOf(mockQuery.mock.calls[1])).toBe(3);
    expect(page.messages.map((m) => m.id)).toEqual([MSG_B, MSG_C]);
    expect(page.nextCursor).toBe(`${Date.parse('2026-10-25T11:54:00.007Z')}_${MSG_B}`);
  });

  it('a cursor reads strictly older messages by time, then by id, with the exact millisecond it carries', async () => {
    givenPage(facts({ joined: true, participant_status: 'left' }), []);
    await listEventChat(EVENT, viewer, { cursor: `1761393240007_${MSG_B}`, limit: 2 });
    const [sql, params] = [sqlOf(mockQuery.mock.calls[1]), paramsOf(mockQuery.mock.calls[1])];
    expect(sql).toMatch(/AND \(m\.created_at, m\.id\) < \(\$4, \$5::uuid\)/);
    expect((params[3] as Date).getTime()).toBe(1761393240007);
    expect(params[4]).toBe(MSG_B);
  });

  it('pages 50 at a time by default and never more than 100', async () => {
    givenPage(facts({ joined: true, participant_status: 'left' }), []);
    await listEventChat(EVENT, viewer);
    expect(limitOf(mockQuery.mock.calls[1])).toBe(51);
    mockQuery.mockReset();
    givenPage(facts({ joined: true, participant_status: 'left' }), []);
    await listEventChat(EVENT, viewer, { limit: 5000 });
    expect(limitOf(mockQuery.mock.calls[1])).toBe(101);
  });

  it('a cursor it cannot read is a 400 and reads nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [facts({ joined: true, participant_status: 'left' })] });
    await expectAppError(listEventChat(EVENT, viewer, { cursor: 'yesterday' }), 400, ErrorCodes.VALIDATION_ERROR);
    expect(callsMatching(/FROM event_chat_messages/)).toHaveLength(0);
  });
});

// ── The live history (socket) ────────────────────────────────────────────────

describe('listLiveChatHistory', () => {
  it('reads the last 200 messages the viewer may see and returns them oldest first in the socket shape', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row(MSG_B, '2026-10-25T11:53:00.000Z', { scope: 'room', room_id: 'room-1', reactions: { heart: [ME] } }),
      row(MSG_A, '2026-10-25T11:52:00.000Z', { sender_status: 'deactivated' }),
    ] });
    const messages = await listLiveChatHistory(EVENT, ME, 'all');
    expect(limitOf(mockQuery.mock.calls[0])).toBe(200);
    expect(paramsOf(mockQuery.mock.calls[0]).slice(0, 3)).toEqual([EVENT, ME, true]);
    expect(messages).toEqual([
      { id: MSG_A, userId: OTHER, displayName: 'Former member', message: 'message a', timestamp: '2026-10-25T11:52:00.000Z', scope: 'lobby', isHost: false, reactions: {} },
      { id: MSG_B, userId: OTHER, displayName: 'Stefan', message: 'message b', timestamp: '2026-10-25T11:53:00.000Z', scope: 'room', isHost: false, roomId: 'room-1', reactions: { heart: [ME] } },
    ]);
  });

  it('gives lobby-only access lobby messages only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listLiveChatHistory(EVENT, ME, 'lobby');
    expect(paramsOf(mockQuery.mock.calls[0])[2]).toBe(false);
  });
});

// ── Storing a message as it is sent ──────────────────────────────────────────

describe('persistEventChatMessage', () => {
  const lobby = {
    sessionId: EVENT, senderId: ME, senderName: 'Claus', senderIsHost: true, scope: 'lobby' as const, content: 'Welcome all',
  };

  it('stores a lobby message and returns it in the socket shape, with the row id and the stored time', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: MSG_A, created_at: new Date('2026-10-25T11:52:00.123Z') }] });
    const out = await persistEventChatMessage(lobby);
    const [sql, params] = [sqlOf(mockQuery.mock.calls[0]), paramsOf(mockQuery.mock.calls[0])];
    expect(sql).toMatch(/INSERT INTO event_chat_messages/);
    expect(sql).toMatch(/s\.status NOT IN \('completed', 'cancelled'\)/);
    expect(params).toEqual([EVENT, ME, 'Claus', true, 'lobby', null, null, null, 'Welcome all', null]);
    expect(out).toEqual({
      created: true,
      message: { id: MSG_A, userId: ME, displayName: 'Claus', message: 'Welcome all', timestamp: '2026-10-25T11:52:00.123Z', scope: 'lobby', isHost: true, reactions: {} },
    });
  });

  it('stores a room message with its room, its match and everyone it reached, the sender once', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: MSG_B, created_at: new Date('2026-10-25T11:53:00.000Z') }] });
    const out = await persistEventChatMessage({
      ...lobby, senderIsHost: false, scope: 'room', roomId: 'room-7', matchId: MSG_C, audienceIds: [OTHER, ME, OTHER],
    });
    expect(paramsOf(mockQuery.mock.calls[0])).toEqual([EVENT, ME, 'Claus', false, 'room', 'room-7', MSG_C, [ME, OTHER], 'Welcome all', null]);
    expect(out.message).toMatchObject({ id: MSG_B, scope: 'room', roomId: 'room-7' });
  });

  it('a room message with no room (the sender was in none the server tracks) is kept for its sender alone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: MSG_B, created_at: new Date('2026-10-25T11:53:00.000Z') }] });
    const out = await persistEventChatMessage({ ...lobby, scope: 'room', audienceIds: [] });
    expect(paramsOf(mockQuery.mock.calls[0]).slice(5, 8)).toEqual([null, null, [ME]]);
    expect(out.message).not.toHaveProperty('roomId');
  });

  it('a match id that is not a uuid (a client can name any room) is stored as none', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: MSG_B, created_at: new Date() }] });
    await persistEventChatMessage({ ...lobby, scope: 'room', roomId: 'room-7', matchId: 'not-a-match', audienceIds: [ME] });
    expect(paramsOf(mockQuery.mock.calls[0])[6]).toBeNull();
  });

  it('refuses once the event has ended: nothing was stored, and the sender is told the chat is closed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expectAppError(persistEventChatMessage(lobby), 409, ErrorCodes.EVENT_ENDED,
      'This event has ended, so its chat is closed.');
  });

  it('a clientId already stored returns that message and stores nothing new', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row(MSG_A, '2026-10-25T11:52:00.000Z', { sender_id: ME, sender_name: 'Claus', content: 'Welcome all' })] });
    const out = await persistEventChatMessage({ ...lobby, clientId: KEY });
    expect(paramsOf(mockQuery.mock.calls[0])[9]).toBe(KEY);
    expect(paramsOf(mockQuery.mock.calls[1])).toEqual([EVENT, ME, KEY]);
    expect(out).toEqual({
      created: false,
      message: { id: MSG_A, userId: ME, displayName: 'Claus', message: 'Welcome all', timestamp: '2026-10-25T11:52:00.000Z', scope: 'lobby', isHost: false, reactions: {} },
    });
  });

  it('a clientId with no stored message behind it means the event has ended', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expectAppError(persistEventChatMessage({ ...lobby, clientId: KEY }), 409, ErrorCodes.EVENT_ENDED);
  });

  it('a database failure is not swallowed (the handler tells the sender)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(persistEventChatMessage(lobby)).rejects.toThrow('connection terminated');
  });
});

// ── Reactions ────────────────────────────────────────────────────────────────

describe('toggleEventChatReaction', () => {
  const input = { sessionId: EVENT, messageId: MSG_A, userId: ME, emoji: 'heart' };

  it('adds a reaction the member has not given, and returns everyone\'s reactions with the message\'s audience', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ scope: 'room', audience_ids: [ME, OTHER] }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ emoji: 'heart', user_ids: [OTHER, ME] }, { emoji: 'clap', user_ids: [OTHER] }] });
    const out = await toggleEventChatReaction(input);
    expect(callsMatching(/INSERT INTO event_chat_reactions/)).toHaveLength(1);
    expect(paramsOf(callsMatching(/INSERT INTO event_chat_reactions/)[0])).toEqual([MSG_A, ME, 'heart']);
    expect(out).toEqual({ scope: 'room', audienceIds: [ME, OTHER], reactions: { heart: [OTHER, ME], clap: [OTHER] } });
  });

  it('takes back a reaction the member had given', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ scope: 'lobby', audience_ids: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    const out = await toggleEventChatReaction(input);
    expect(callsMatching(/INSERT INTO event_chat_reactions/)).toHaveLength(0);
    expect(out).toEqual({ scope: 'lobby', audienceIds: null, reactions: {} });
  });

  it('only touches a message the member can see, in an event whose chat is open', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await toggleEventChatReaction(input)).toBeNull();
    const check = sqlOf(mockQuery.mock.calls[0]);
    expect(check).toMatch(/m\.deleted_at IS NULL/);
    expect(check).toMatch(/s\.status NOT IN \('completed', 'cancelled'\)/);
    expect(check).toMatch(/m\.scope = 'lobby' OR m\.audience_ids @> ARRAY\[\$3::uuid\]/);
    expect(check).toMatch(/b\.blocker_id = \$3 AND b\.blocked_id = m\.sender_id/);
    expect(callsMatching(/event_chat_reactions/)).toHaveLength(0);
  });

  it('ignores a reaction the chat does not offer without asking the database', async () => {
    expect(await toggleEventChatReaction({ ...input, emoji: 'fire' })).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── Taking a message down ────────────────────────────────────────────────────

describe('deleteEventChatMessage', () => {
  const stored = (over: Record<string, unknown> = {}) => ({ sender_id: OTHER, deleted_at: null, host_user_id: THIRD, is_cohost: false, ...over });

  it.each([
    ['its author', stored({ sender_id: ME }), 'member'],
    ['the event host', stored({ host_user_id: ME }), 'member'],
    ['a co-host', stored({ is_cohost: true }), 'member'],
    ['a platform admin', stored(), 'admin'],
  ])('lets %s delete it: the message is hidden, not erased, and who did it is kept', async (_who, s, role) => {
    mockQuery.mockResolvedValueOnce({ rows: [s] }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await deleteEventChatMessage(EVENT, MSG_A, { id: ME, role })).toEqual({ deleted: true });
    const update = callsMatching(/UPDATE event_chat_messages SET deleted_at = NOW\(\), deleted_by = \$2/);
    expect(update).toHaveLength(1);
    expect(paramsOf(update[0])).toEqual([MSG_A, ME]);
  });

  it('refuses anyone else and changes nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [stored()] });
    await expectAppError(deleteEventChatMessage(EVENT, MSG_A, { id: ME, role: 'member' }), 403, ErrorCodes.AUTH_FORBIDDEN);
    expect(callsMatching(/UPDATE event_chat_messages/)).toHaveLength(0);
  });

  it('a message already deleted is a quiet success that changes nothing (a double click)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [stored({ sender_id: ME, deleted_at: new Date() })] });
    expect(await deleteEventChatMessage(EVENT, MSG_A, { id: ME, role: 'member' })).toEqual({ deleted: false });
    expect(callsMatching(/UPDATE event_chat_messages/)).toHaveLength(0);
  });

  it('a message that is not in this event is a 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expectAppError(deleteEventChatMessage(EVENT, MSG_A, { id: ME, role: 'admin' }), 404, 'MESSAGE_NOT_FOUND');
    expect(paramsOf(mockQuery.mock.calls[0]).slice(0, 2)).toEqual([MSG_A, EVENT]);
  });
});

// ── Blocks on the live fan-out ───────────────────────────────────────────────

describe('chatBlockedUserIds', () => {
  it('returns everyone the sender blocked or was blocked by, in one query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ other_id: OTHER }, { other_id: THIRD }] });
    const blocked = await chatBlockedUserIds(ME);
    expect([...blocked].sort()).toEqual([OTHER, THIRD].sort());
    const sql = sqlOf(mockQuery.mock.calls[0]);
    expect(sql).toMatch(/blocker_id = \$1 OR blocked_id = \$1/);
    expect(paramsOf(mockQuery.mock.calls[0])).toEqual([ME]);
  });
});

// ── The send limit ───────────────────────────────────────────────────────────

describe('createSendLimiter (10 messages in any 10 seconds)', () => {
  it('lets 10 through, refuses the 11th inside the window, and lets one through again once the first is 10 s old', () => {
    const take = createSendLimiter(10, 10_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(take('u', t0 + i * 900)).toBe(true);
    expect(take('u', t0 + 9_950)).toBe(false);
    expect(take('u', t0 + 9_999)).toBe(false);
    expect(take('u', t0 + 10_000)).toBe(true);
    expect(take('u', t0 + 10_001)).toBe(false);
  });

  it('a refused attempt does not use up a slot', () => {
    const take = createSendLimiter(2, 10_000);
    expect(take('u', 0)).toBe(true);
    expect(take('u', 1)).toBe(true);
    for (let i = 0; i < 50; i++) expect(take('u', 2 + i)).toBe(false);
    expect(take('u', 10_000)).toBe(true);
  });

  it('counts each member on their own', () => {
    const take = createSendLimiter(1, 10_000);
    expect(take('a', 0)).toBe(true);
    expect(take('a', 1)).toBe(false);
    expect(take('b', 1)).toBe(true);
  });
});
