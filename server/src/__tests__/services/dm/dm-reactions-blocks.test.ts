// ─── Reactions respect blocks, both ways, over REST and the socket (11 Nov 2026, S5 fix round 1, I-1) ─────
//
// Shirley blocks Ben. Ben's own thread looks as it always did, so before this fix he could keep reacting to her messages
// (REST or the socket's dm:react), and each reaction landed live in her read-only thread; she could still react to his.
// "Blocks always win": dm.service's addReaction and removeReaction now refuse across a block in either direction, which
// covers REST (routes/dm.ts) and the socket (dm-handlers.ts) together, and the socket answers with an error and tells
// nobody.

const mockQuery = jest.fn();
const mockAreBlocked = jest.fn();
jest.mock('../../../db', () => ({ __esModule: true, query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn() }));
jest.mock('../../../config/logger', () => ({
  __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/block/block.service', () => ({
  __esModule: true, areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
}));
const mockEmitEntities = jest.fn((..._a: unknown[]) => Promise.resolve(undefined));
jest.mock('../../../realtime/emit', () => ({ __esModule: true, emitEntities: (...a: unknown[]) => mockEmitEntities(...a) }));

import { addReaction, removeReaction } from '../../../services/dm/dm.service';
import { handleDmReact, handleDmUnreact } from '../../../services/orchestration/handlers/dm-handlers';

const SHIRLEY = 'u-shirley';
const BEN = 'u-ben';

beforeEach(() => {
  mockQuery.mockReset().mockImplementation((sql: string) => {
    if (/FROM direct_messages m\s+JOIN dm_conversations c/.test(sql)) {
      return Promise.resolve({ rows: [{ conversation_id: 'conv-1', user_a_id: BEN, user_b_id: SHIRLEY }] });
    }
    return Promise.resolve({ rows: [] });
  });
  mockAreBlocked.mockReset().mockResolvedValue(false);
  mockEmitEntities.mockClear();
});

const writes = () => mockQuery.mock.calls.filter((c) => /dm_message_reactions/.test(String(c[0])));

describe.each([
  ['adding', addReaction],
  ['taking back', removeReaction],
] as const)('%s a reaction', (_label, act) => {
  it('works between two people on speaking terms', async () => {
    await expect(act('m-1', BEN, 'heart')).resolves.toEqual({ conversationId: 'conv-1', otherUserId: SHIRLEY });
    expect(mockAreBlocked).toHaveBeenCalledWith(BEN, SHIRLEY);
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ['the blocked person, on the blocker\'s message', BEN],
    ['the blocker, on the blocked person\'s message', SHIRLEY],
  ])('is refused across a block for %s, and nothing is written', async (_who, actor) => {
    mockAreBlocked.mockResolvedValue(true);
    await expect(act('m-1', actor, 'heart')).rejects.toMatchObject({ statusCode: 403 });
    expect(writes()).toHaveLength(0);
  });
});

describe('the socket (dm:react / dm:unreact)', () => {
  const rooms: Array<{ room: string; event: string }> = [];
  const io = { to: (room: string) => ({ emit: (event: string) => { rooms.push({ room, event }); } }) };
  const socket = (userId: string) => {
    const said: Array<{ event: string; payload: unknown }> = [];
    return { data: { userId }, emit: (event: string, payload: unknown) => { said.push({ event, payload }); }, said };
  };

  beforeEach(() => { rooms.length = 0; });

  it.each([['dm:react', handleDmReact], ['dm:unreact', handleDmUnreact]] as const)(
    '%s across a block answers the sender with an error and reaches nobody',
    async (_event, handler) => {
      mockAreBlocked.mockResolvedValue(true);
      const s = socket(BEN);
      await handler(io as never, s as never, { messageId: 'm-1', emoji: 'heart' });
      expect(s.said).toEqual([{ event: 'error', payload: expect.objectContaining({ message: 'You can no longer message this user' }) }]);
      expect(rooms).toEqual([]);
      expect(mockEmitEntities).not.toHaveBeenCalled();
    },
  );

  it('dm:react between two people on speaking terms still reaches both', async () => {
    const s = socket(BEN);
    await handleDmReact(io as never, s as never, { messageId: 'm-1', emoji: 'heart' });
    expect(rooms.map((r) => r.event)).toEqual(['dm:reaction_added', 'dm:reaction_added']);
  });
});
