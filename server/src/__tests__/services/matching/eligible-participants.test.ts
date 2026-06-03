// Tests for matching.service.getEligibleParticipants — the single source of
// truth used by both the algorithm guard (handleHostGenerateMatches) and the
// host dashboard's eligibleMainRoomCount.
//
// Critical invariant: a user currently in any active match (manual breakout
// OR algorithm round) must NOT appear in the eligible pool — preventing the
// algorithm from double-pairing them in the next round.

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery, transaction: jest.fn() }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: jest.fn(),
}));

describe('matching.service.getEligibleParticipants', () => {
  beforeEach(() => mockQuery.mockReset());

  it('is exported from matching.service', async () => {
    const mod: any = await import('../../../services/matching/matching.service');
    expect(typeof mod.getEligibleParticipants).toBe('function');
  });

  it('returns user IDs from session_participants minus the host/co-host exclusion list', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }],
    });

    const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
    const result = await getEligibleParticipants('sess-1', ['HOST']);

    expect(result.sort()).toEqual(['A', 'B', 'C']);
    // Verify the SQL uses NOT EXISTS to filter out users in active matches
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/m\.status\s*=\s*'active'/);
    // And the host is excluded
    expect(sql).toMatch(/sp\.user_id\s*!=\s*ALL/);
  });

  it('without exclude list, still uses NOT EXISTS clause to skip in-match users', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'B' }] });

    const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
    const result = await getEligibleParticipants('sess-1');

    expect(result).toEqual(['A', 'B']);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/m\.status\s*=\s*'active'/);
    // No exclude-array binding when list is empty
    expect(sql).not.toMatch(/!=\s*ALL/);
  });

  it('returns empty array when no eligible participants', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
    const result = await getEligibleParticipants('sess-1', ['HOST']);

    expect(result).toEqual([]);
  });

  it('NOT EXISTS subquery checks all 3 participant slots (a, b, c — trio support)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
    await getEligibleParticipants('sess-1');

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/participant_a_id\s*=\s*sp\.user_id/);
    expect(sql).toMatch(/participant_b_id\s*=\s*sp\.user_id/);
    expect(sql).toMatch(/participant_c_id\s*=\s*sp\.user_id/);
  });

  // ─── 27 May — presence gate (only people in the main room are eligible) ─────
  describe('presence gate (presentUserIds)', () => {
    it('intersects DB-eligible with the present set — absent users excluded', async () => {
      // DB says A,B,C are status-eligible; but only A and B are in the main room.
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }] });

      const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
      const result = await getEligibleParticipants('sess-1', ['HOST'], new Set(['A', 'B']));

      expect(result.sort()).toEqual(['A', 'B']); // C (registered-but-absent) gated out
    });

    it('fail-open: undefined present set → DB-eligible unchanged', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }] });

      const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
      const result = await getEligibleParticipants('sess-1', ['HOST']); // no present set

      expect(result.sort()).toEqual(['A', 'B', 'C']);
    });

    it('fail-open: empty present set → DB-eligible unchanged (never match nobody)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'B' }] });

      const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
      const result = await getEligibleParticipants('sess-1', ['HOST'], new Set<string>());

      expect(result.sort()).toEqual(['A', 'B']);
    });

    it('fail-open: non-empty present set with ZERO overlap → DB-eligible unchanged', async () => {
      // Present set is stale/wrong (none of the DB-eligible users appear) — rather
      // than match nobody, fall back to the DB-eligible list.
      mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'B' }] });

      const { getEligibleParticipants } = await import('../../../services/matching/matching.service');
      const result = await getEligibleParticipants('sess-1', ['HOST'], new Set(['X', 'Y', 'Z']));

      expect(result.sort()).toEqual(['A', 'B']);
    });
  });
});
