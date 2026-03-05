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

  describe('checkMutualMeetAgain', () => {
    it('should return true when both users want to meet again', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { fromUserId: 'user-a', meetAgain: true },
          { fromUserId: 'user-b', meetAgain: true },
        ],
        rowCount: 2,
      });

      const result = await ratingService.checkMutualMeetAgain('match-1');
      expect(result).toBe(true);
    });

    it('should return false when only one user wants to meet again', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { fromUserId: 'user-a', meetAgain: true },
          { fromUserId: 'user-b', meetAgain: false },
        ],
        rowCount: 2,
      });

      const result = await ratingService.checkMutualMeetAgain('match-1');
      expect(result).toBe(false);
    });

    it('should return false when fewer than 2 ratings exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ fromUserId: 'user-a', meetAgain: true }], rowCount: 1 });

      const result = await ratingService.checkMutualMeetAgain('match-1');
      expect(result).toBe(false);
    });
  });

  describe('getRatingsByMatch', () => {
    it('should return ratings for a match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockRating], rowCount: 1 });

      const ratings = await ratingService.getRatingsByMatch('match-1');
      expect(ratings).toHaveLength(1);
      expect(ratings[0].matchId).toBe('match-1');
    });

    it('should return empty array when no ratings', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const ratings = await ratingService.getRatingsByMatch('match-no-ratings');
      expect(ratings).toHaveLength(0);
    });
  });

  describe('getRatingsByUser', () => {
    it('should return all ratings by a user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockRating], rowCount: 1 });

      const ratings = await ratingService.getRatingsByUser('user-a');
      expect(ratings).toHaveLength(1);
    });

    it('should filter by sessionId when provided', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const ratings = await ratingService.getRatingsByUser('user-a', 'session-1');
      expect(ratings).toHaveLength(0);
      expect(mockQuery.mock.calls[0][0]).toContain('session_id');
    });
  });

  describe('getRatingsReceived', () => {
    it('should return ratings received by a user', async () => {
      const receivedRating = { ...mockRating, fromUserId: 'user-b', toUserId: 'user-a' };
      mockQuery.mockResolvedValueOnce({ rows: [receivedRating], rowCount: 1 });

      const ratings = await ratingService.getRatingsReceived('user-a');
      expect(ratings).toHaveLength(1);
    });

    it('should filter by sessionId', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await ratingService.getRatingsReceived('user-a', 'session-1');
      expect(mockQuery.mock.calls[0][0]).toContain('session_id');
    });
  });

  describe('getPeopleMet', () => {
    it('should return people met data for a session', async () => {
      // Session lookup
      mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Test Session', scheduledAt: new Date() }], rowCount: 1 });
      // Connections query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { userId: 'user-b', displayName: 'User B', avatarUrl: null, company: 'Acme', jobTitle: 'Dev', qualityScore: 4, meetAgain: true, mutualMeetAgain: true, roundNumber: 1 },
          { userId: 'user-c', displayName: 'User C', avatarUrl: null, company: 'BigCo', jobTitle: 'PM', qualityScore: 3, meetAgain: false, mutualMeetAgain: false, roundNumber: 2 },
        ],
        rowCount: 2,
      });

      const result = await ratingService.getPeopleMet('user-a', 'session-1');
      expect(result.connections).toHaveLength(2);
      expect(result.mutualConnections).toHaveLength(1);
      expect(result.sessionId).toBe('session-1');
    });

    it('should throw NotFoundError when session not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(ratingService.getPeopleMet('user-a', 'missing-session'))
        .rejects.toThrow('not found');
    });
  });

  describe('getEncounterHistory', () => {
    it('should return encounter history between two users', async () => {
      const mockEncounter = {
        id: 'enc-1', userAId: 'user-a', userBId: 'user-b',
        timesMet: 3, lastMetAt: new Date(), lastSessionId: 'session-1',
        lastQualityScore: 4, lastMeetAgainA: true, lastMeetAgainB: true,
        mutualMeetAgain: true, createdAt: new Date(), updatedAt: new Date(),
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockEncounter], rowCount: 1 });

      const result = await ratingService.getEncounterHistory('user-a', 'user-b');
      expect(result).toEqual(mockEncounter);
    });

    it('should return null when no encounter exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await ratingService.getEncounterHistory('user-a', 'user-x');
      expect(result).toBeNull();
    });

    it('should order user IDs consistently', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // user-b < user-a alphabetically → should swap
      await ratingService.getEncounterHistory('user-b', 'user-a');
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-a', 'user-b']);
    });
  });

  describe('getUserEncounters', () => {
    it('should return all encounters for a user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'enc-1' }, { id: 'enc-2' }], rowCount: 2 });

      const result = await ratingService.getUserEncounters('user-a');
      expect(result).toHaveLength(2);
    });

    it('should filter mutual-only encounters', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'enc-1' }], rowCount: 1 });

      const result = await ratingService.getUserEncounters('user-a', true);
      expect(result).toHaveLength(1);
      expect(mockQuery.mock.calls[0][0]).toContain('mutual_meet_again = TRUE');
    });
  });

  describe('getSessionRatingStats', () => {
    it('should return session rating statistics', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ totalRatings: '10', avgQualityScore: '3.5000', meetAgainCount: '6' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: '2' }],
          rowCount: 1,
        });

      const stats = await ratingService.getSessionRatingStats('session-1');
      expect(stats.totalRatings).toBe(10);
      expect(stats.avgQualityScore).toBe(3.5);
      expect(stats.meetAgainRate).toBeCloseTo(0.6);
      expect(stats.mutualMeetAgainCount).toBe(2);
    });

    it('should handle zero ratings gracefully', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ totalRatings: '0', avgQualityScore: '0', meetAgainCount: '0' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [{ count: '0' }],
          rowCount: 1,
        });

      const stats = await ratingService.getSessionRatingStats('session-1');
      expect(stats.totalRatings).toBe(0);
      expect(stats.meetAgainRate).toBe(0);
    });
  });

  describe('finalizeRoundRatings', () => {
    it('should finalize ratings for a round', async () => {
      // Get matches
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'match-1', participantAId: 'user-a', participantBId: 'user-b' },
          { id: 'match-2', participantAId: 'user-c', participantBId: 'user-d' },
        ],
        rowCount: 2,
      });
      // checkMutualMeetAgain for match-1 — 2 ratings, both meetAgain
      mockQuery.mockResolvedValueOnce({ rows: [{ fromUserId: 'user-a', meetAgain: true }, { fromUserId: 'user-b', meetAgain: true }], rowCount: 2 });
      // getRatingsByMatch for match-1
      mockQuery.mockResolvedValueOnce({ rows: [mockRating], rowCount: 1 });
      // checkMutualMeetAgain for match-2 — 0 ratings
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // getRatingsByMatch for match-2
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await ratingService.finalizeRoundRatings('session-1', 1);
      expect(result.totalMatches).toBe(2);
      expect(result.mutualConnections).toBe(1);
      expect(result.ratedMatches).toBe(1);
    });
  });
});
