// ─── Orchestration Service Tests ─────────────────────────────────────────────
// Tests for REST API helper functions and session state management.

import { SessionStatus, DEFAULT_SESSION_CONFIG } from '@rsn/shared';

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

// Mock session service
const mockGetSessionById = jest.fn();
const mockUpdateSessionStatus = jest.fn();
jest.mock('../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  updateSessionStatus: (...args: unknown[]) => mockUpdateSessionStatus(...args),
  updateParticipantStatus: jest.fn(),
  getSessionParticipants: jest.fn().mockResolvedValue([]),
  incrementRoundsCompleted: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/matching/matching.service', () => ({
  createMatchesForRound: jest.fn().mockResolvedValue([]),
  __esModule: true,
}));

jest.mock('../../services/rating/rating.service', () => ({
  finalizeRoundRatings: jest.fn().mockResolvedValue({ totalMatches: 0, ratedMatches: 0, mutualConnections: 0 }),
  __esModule: true,
}));

import * as orchestrationService from '../../services/orchestration/orchestration.service';

const mockSession = {
  id: 'session-1',
  podId: 'pod-1',
  title: 'Test Session',
  scheduledAt: new Date(),
  startedAt: null,
  endedAt: null,
  status: SessionStatus.SCHEDULED,
  currentRound: 0,
  config: DEFAULT_SESSION_CONFIG,
  hostUserId: 'host-user',
  lobbyRoomId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Orchestration Service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockGetSessionById.mockReset();
    mockUpdateSessionStatus.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('getActiveSessionState', () => {
    it('should return null when session is not active', () => {
      const state = orchestrationService.getActiveSessionState('non-existent');
      expect(state).toBeNull();
    });
  });

  describe('startSession', () => {
    it('should throw ForbiddenError when user is not the host', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);

      await expect(orchestrationService.startSession('session-1', 'not-host'))
        .rejects.toThrow('Only the host');
    });

    it('should throw ValidationError when session is not scheduled', async () => {
      mockGetSessionById.mockResolvedValue({ ...mockSession, status: SessionStatus.LOBBY_OPEN });

      await expect(orchestrationService.startSession('session-1', 'host-user'))
        .rejects.toThrow('scheduled state');
    });

    it('should start a session and transition to lobby', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);
      mockUpdateSessionStatus.mockResolvedValue({ ...mockSession, status: SessionStatus.LOBBY_OPEN });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE started_at

      await orchestrationService.startSession('session-1', 'host-user');

      expect(mockUpdateSessionStatus).toHaveBeenCalledWith('session-1', SessionStatus.LOBBY_OPEN);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE sessions SET started_at'),
        ['session-1']
      );
    });
  });

  describe('pauseSession', () => {
    it('should throw ForbiddenError when user is not the host', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);

      await expect(orchestrationService.pauseSession('session-1', 'not-host'))
        .rejects.toThrow('Only the host');
    });

    it('should throw ValidationError when session is not active', async () => {
      mockGetSessionById.mockResolvedValue({ ...mockSession, hostUserId: 'host-user' });
      // No active session in the map (session hasn't been started via startSession)

      await expect(orchestrationService.pauseSession('non-active', 'host-user'))
        .rejects.toThrow('cannot be paused');
    });
  });

  describe('resumeSession', () => {
    it('should throw ForbiddenError when user is not the host', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);

      await expect(orchestrationService.resumeSession('session-1', 'not-host'))
        .rejects.toThrow('Only the host');
    });

    it('should throw ValidationError when session is not paused', async () => {
      mockGetSessionById.mockResolvedValue({ ...mockSession, hostUserId: 'host-user' });

      await expect(orchestrationService.resumeSession('non-active', 'host-user'))
        .rejects.toThrow('not paused');
    });
  });

  describe('endSession', () => {
    it('should throw ForbiddenError when user is not the host', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);

      await expect(orchestrationService.endSession('session-1', 'not-host'))
        .rejects.toThrow('Only the host');
    });
  });

  describe('broadcastMessage', () => {
    it('should throw ForbiddenError when user is not the host', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);

      await expect(orchestrationService.broadcastMessage('session-1', 'not-host', 'Hello'))
        .rejects.toThrow('Only the host');
    });

    it('should succeed when user is the host', async () => {
      mockGetSessionById.mockResolvedValue(mockSession);

      // Should not throw (io is not initialized, so it just skips the emit)
      await expect(orchestrationService.broadcastMessage('session-1', 'host-user', 'Hello'))
        .resolves.toBeUndefined();
    });
  });
});
