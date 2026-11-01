// ─── The pair's conversation, made when a call needs one (1 Nov 2026) ───────────────────────────────
//
// The profile's Video call knows a person, not a conversation. Two people who met at an event are
// connected but may never have written, so the call opens their conversation on the same pair key every
// message uses (dm.service.ts insertDirectMessageOn), empty: no message, nothing un-hidden, no time stamped.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findOrCreateConversation } from '../../../services/dm/dm.service';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

beforeEach(() => mockQuery.mockReset().mockResolvedValue({ rows: [{ id: 'conv-1' }] }));

describe('findOrCreateConversation', () => {
  it('uses the pair key in its sorted order whichever of the two asks, and answers the conversation id', async () => {
    await expect(findOrCreateConversation(B, A)).resolves.toBe('conv-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params.slice(1)).toEqual([A, B]);
    expect(String(sql).replace(/\s+/g, ' ').trim()).toBe(
      'INSERT INTO dm_conversations (id, user_a_id, user_b_id) VALUES ($1, $2, $3) ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET user_a_id = EXCLUDED.user_a_id RETURNING id',
    );
  });

  it('an existing conversation is found as it is: its last message time and each side\'s hidden thread are left alone', async () => {
    await findOrCreateConversation(A, B);
    expect(String(mockQuery.mock.calls[0][0])).not.toMatch(/last_message_at|deleted_at/);
  });
});
