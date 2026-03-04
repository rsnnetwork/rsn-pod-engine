// ─── Rating Service Tests ────────────────────────────────────────────────────
const mockQuery = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => mockTransaction(cb),
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import * as ratingService from '../../services/rating/rating.service';

const mockMatch = {
  id: 'match-1',
  sessionId: 'session-1',
  roundNumber: 1,
  participantAId: 'user-a',
  participantBId: 'user-b',
  status: 'completed',
  createdAt: new Date(),
};

const mockRating = {
  id: 'rating-1',
  matchId: 'match-1',
  fromUserId: 'user-a',
  toUserId: 'user-b',
  qualityScore: 4,
  meetAgain: true,
  feedback: 'Great conversation',
  createdAt: new Date(),
};

describe('Rating Service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  describe('submitRating', () => {
    it('should submit a rating for a completed match', async () => {
      // Get match
      mockQuery.mockResolvedValueOnce({ rows: [mockMatch], rowCount: 1 });
      // Check existing rating — none found
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // Mock transaction — INSERT rating + upsertEncounterHistory
      mockTransaction.mockImplementation(async (cb: Function) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [mockRating], rowCount: 1 })  // INSERT rating
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })           // SELECT encounter_history
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }),          // INSERT encounter_history
        };
        return cb(client);
      });

      const rating = await ratingService.submitRating('user-a', {
        matchId: 'match-1',
        qualityScore: 4,
        meetAgain: true,
        feedback: 'Great conversation',
      });

      expect(rating).toBeDefined();
      expect(rating.matchId).toBe('match-1');
    });

    it('should throw when match not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        ratingService.submitRating('user-a', {
          matchId: 'missing-match',
          qualityScore: 4,
          meetAgain: true,
        })
      ).rejects.toThrow('not found');
    });

    it('should throw when user is not a participant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockMatch], rowCount: 1 });

      await expect(
        ratingService.submitRating('user-c', {
          matchId: 'match-1',
          qualityScore: 4,
          meetAgain: true,
        })
      ).rejects.toThrow('not a participant');
    });

    it('should throw when match is not in a ratable state', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...mockMatch, status: 'scheduled' }],
        rowCount: 1,
      });

      await expect(
        ratingService.submitRating('user-a', {
          matchId: 'match-1',
          qualityScore: 4,
          meetAgain: true,
        })
      ).rejects.toThrow('ratable');
    });

    it('should throw when quality score is out of range', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockMatch], rowCount: 1 });

      await expect(
        ratingService.submitRating('user-a', {
          matchId: 'match-1',
          qualityScore: 6,
          meetAgain: true,
        })
      ).rejects.toThrow('Quality score');
    });

    it('should throw ConflictError when already rated', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockMatch], rowCount: 1 });
      // existing rating found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-rating' }], rowCount: 1 });

      await expect(
        ratingService.submitRating('user-a', {
          matchId: 'match-1',
          qualityScore: 4,
          meetAgain: true,
        })
      ).rejects.toThrow('already rated');
    });
  });
});
