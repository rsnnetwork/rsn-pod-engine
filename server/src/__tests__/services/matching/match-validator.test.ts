// T0-1 — Central match validator
//
// The four manual-write paths (`handleHostCreateBreakout`,
// `handleHostCreateBreakoutBulk`, `handleHostSwapMatch`,
// `handleHostExcludeFromRound`) all need the same structural and
// conflict-aware validation before they touch the matches table. Today
// each handler reinvents the wheel (or skips it). This validator gives
// every write site a single audited gatekeeper.
//
// The validator never throws — it returns `{ valid, errors, conflictingUserIds }`
// so callers can emit a structured socket error like
// `{ code: 'INVALID_MATCH_ASSIGNMENT', message: errors.join('; ') }`.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { validateMatchAssignment } from '../../../services/matching/match-validator.service';

describe('T0-1 — match-validator.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no DB conflicts — caller-controlled tests override per case.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('structural validation (no DB roundtrip)', () => {
    it('accepts a valid pair', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        participantCId: null,
        skipConflictCheck: true,
      });
      expect(result).toEqual({ valid: true, errors: [], conflictingUserIds: [] });
    });

    it('accepts a valid trio', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        participantCId: 'user-c',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts a single-participant placeholder room', async () => {
      // handleHostCreateBreakout supports 1+ participants — solo "holder"
      // rooms exist for hosts to fill later. Don't break that.
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: null,
        participantCId: null,
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(true);
    });

    it('rejects when participantAId is missing', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: '',
        participantBId: 'user-b',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join('|')).toMatch(/participantAId.*required/i);
    });

    it('rejects when A and B are the same user', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-a',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join('|')).toMatch(/duplicate|distinct|unique/i);
    });

    it('rejects when A and C are the same user', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        participantCId: 'user-a',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join('|')).toMatch(/duplicate|distinct|unique/i);
    });

    it('rejects when B and C are the same user', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        participantCId: 'user-b',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join('|')).toMatch(/duplicate|distinct|unique/i);
    });

    it('enforces minParticipants when caller asks for it', async () => {
      // Algorithm matches require 2+ — caller passes minParticipants:2 to enforce.
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: null,
        minParticipants: 2,
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join('|')).toMatch(/at least 2|minimum/i);
    });
  });

  describe('cross-match conflict check (DB-aware)', () => {
    it('rejects when participant A is in another active match in the same round', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ user_id: 'user-a', match_id: 'match-existing' }],
        rowCount: 1,
      });

      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
      });

      expect(result.valid).toBe(false);
      expect(result.conflictingUserIds).toContain('user-a');
      expect(result.errors.join('|')).toMatch(/another active match/i);
    });

    it('exclude same match on UPDATE (excludeMatchId)', async () => {
      // Caller is updating match-X — the conflict query should skip match-X
      // so we don't flag the user as conflicting with themselves.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        excludeMatchId: 'match-X',
      });

      expect(result.valid).toBe(true);
      // The SQL must reference m.id (the column being excluded). The exact
      // wrapper around the param ($3 vs COALESCE($3, …)) is implementation
      // detail; what matters is that excludeMatchId reaches the query
      // parameters and the WHERE clause filters on m.id.
      const call = mockQuery.mock.calls[0];
      const sqlText = call[0] as string;
      const sqlParams = call[1] as unknown[];
      expect(sqlText).toMatch(/m\.id\s*!=/i);
      expect(sqlParams).toContain('match-X');
    });

    it('skipConflictCheck bypasses the DB query entirely', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('default conflictingStatuses is [active] only', async () => {
      // Preview-phase swaps want to also catch 'scheduled' conflicts;
      // active-phase manual breakouts just need 'active' rows.
      // Default = ['active'].
      await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
      });
      const sql = mockQuery.mock.calls[0][0] as string;
      // 'active' must appear in the WHERE clause; 'scheduled' must not when default
      expect(sql).toMatch(/'active'/);
      expect(sql).not.toMatch(/'scheduled'/);
    });

    it('caller can opt into checking scheduled matches too (preview-phase swaps)', async () => {
      await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        conflictingStatuses: ['active', 'scheduled'],
      });
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toMatch(/'active'/);
      expect(sql).toMatch(/'scheduled'/);
    });

    it('passes participant IDs as a single ANY($N) parameter', async () => {
      await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        participantCId: 'user-c',
      });
      const params = mockQuery.mock.calls[0][1] as unknown[];
      const userListParam = params.find((p: unknown) => Array.isArray(p));
      expect(userListParam).toEqual(['user-a', 'user-b', 'user-c']);
    });

    it('does NOT include null participant IDs in the conflict query', async () => {
      await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        participantCId: null,
      });
      const params = mockQuery.mock.calls[0][1] as unknown[];
      const userListParam = params.find((p: unknown) => Array.isArray(p));
      expect(userListParam).toEqual(['user-a', 'user-b']);
    });
  });

  describe('error messaging', () => {
    it('aggregates multiple errors into one result', async () => {
      // Both structural failure (duplicate) AND a missing participantA
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: '',
        participantBId: 'user-x',
        participantCId: 'user-x',
        skipConflictCheck: true,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('returns conflictingUserIds when DB conflicts exist', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { user_id: 'user-a', match_id: 'match-existing-1' },
          { user_id: 'user-b', match_id: 'match-existing-2' },
        ],
        rowCount: 2,
      });

      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
      });

      expect(result.valid).toBe(false);
      expect(result.conflictingUserIds).toEqual(expect.arrayContaining(['user-a', 'user-b']));
    });

    it('returns empty conflictingUserIds when valid', async () => {
      const result = await validateMatchAssignment({
        sessionId: 'sess-1',
        roundNumber: 1,
        participantAId: 'user-a',
        participantBId: 'user-b',
        skipConflictCheck: true,
      });
      expect(result.conflictingUserIds).toEqual([]);
    });
  });
});
