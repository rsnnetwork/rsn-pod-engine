// ─── Session Service Tests ───────────────────────────────────────────────────
import { SessionStatus, DEFAULT_SESSION_CONFIG, ParticipantStatus } from '@rsn/shared';

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

import * as sessionService from '../../services/session/session.service';

const mockSession = {
  id: 'session-123',
  podId: 'pod-123',
  title: 'Test Session',
  description: null,
  scheduledAt: new Date('2025-01-15T18:00:00Z'),
  startedAt: null,
  endedAt: null,
  status: SessionStatus.SCHEDULED,
  currentRound: 0,
  config: DEFAULT_SESSION_CONFIG,
  hostUserId: 'user-host',
  lobbyRoomId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Session Service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  describe('getSessionById', () => {
    it('should return session when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });

      const session = await sessionService.getSessionById('session-123');
      expect(session).toEqual(mockSession);
    });

    it('should throw NotFoundError when session not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(sessionService.getSessionById('missing'))
        .rejects.toThrow('not found');
    });
  });

  describe('listSessions', () => {
    it('should return sessions for a pod', async () => {
      // COUNT query first
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      // Data query second
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });

      const result = await sessionService.listSessions({ podId: 'pod-123' });
      expect(result.sessions).toHaveLength(1);
    });
  });

  describe('createSession', () => {
    it('should create a session with default config', async () => {
      // podService.getPodById — SELECT pods
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active', maxMembers: 50, createdBy: 'user-host' }], rowCount: 1 });
      // podService.getMemberRole — SELECT pod_members
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // INSERT INTO sessions RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });

      const session = await sessionService.createSession('user-host', {
        podId: 'pod-123',
        title: 'Test Session',
        scheduledAt: '2025-01-15T18:00:00Z',
      });

      expect(session).toEqual(mockSession);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions'),
        expect.any(Array),
      );
    });
  });

  describe('registerParticipant', () => {
    it('should register a participant for a session', async () => {
      // getSessionById — SELECT sessions
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockSession, status: SessionStatus.LOBBY_OPEN }], rowCount: 1 });
      // COUNT participants (capacity check)
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 });
      // Check existing registration — none found
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT session_participants
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sp-1', sessionId: 'session-123', userId: 'user-new', status: 'registered' }], rowCount: 1 });

      const participant = await sessionService.registerParticipant('session-123', 'user-new');
      expect(participant).toBeDefined();
    });
  });

  describe('updateSessionStatus', () => {
    it('should update session status', async () => {
      // Single UPDATE ... RETURNING query
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockSession, status: SessionStatus.LOBBY_OPEN }], rowCount: 1 });

      const session = await sessionService.updateSessionStatus(
        'session-123',
        SessionStatus.LOBBY_OPEN,
      );

      expect(session.status).toBe(SessionStatus.LOBBY_OPEN);
    });
  });

  describe('getSessionParticipants', () => {
    it('should return participants for a session', async () => {
      const mockParticipant = {
        id: 'sp-1',
        sessionId: 'session-123',
        userId: 'user-1',
        status: ParticipantStatus.REGISTERED,
        joinedAt: null,
        leftAt: null,
        currentRoomId: null,
        isNoShow: false,
        roundsCompleted: 0,
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockParticipant], rowCount: 1 });

      const participants = await sessionService.getSessionParticipants('session-123');
      expect(participants).toHaveLength(1);
      expect(participants[0].userId).toBe('user-1');
    });

    it('should filter participants by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await sessionService.getSessionParticipants('session-123', ParticipantStatus.IN_LOBBY);
      expect(result).toHaveLength(0);
      expect(mockQuery.mock.calls[0][0]).toContain('status = $2');
    });
  });

  describe('registerParticipant - edge cases', () => {
    it('should throw when session is not open for registration', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...mockSession, status: SessionStatus.ROUND_ACTIVE }],
        rowCount: 1,
      });

      await expect(sessionService.registerParticipant('session-123', 'user-new'))
        .rejects.toThrow('not open for registration');
    });

    it('should throw ConflictError when already registered', async () => {
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockSession, status: SessionStatus.LOBBY_OPEN }], rowCount: 1 });
      // COUNT participants (capacity check)
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      // Check existing — already registered
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sp-1', status: 'registered' }], rowCount: 1 });

      await expect(sessionService.registerParticipant('session-123', 'user-existing'))
        .rejects.toThrow('already registered');
    });

    it('should re-register a previously left participant', async () => {
      const reregistered = { id: 'sp-1', sessionId: 'session-123', userId: 'user-left', status: 'registered' };
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockSession, status: SessionStatus.LOBBY_OPEN }], rowCount: 1 });
      // COUNT participants
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      // Check existing — left status
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sp-1', status: 'left' }], rowCount: 1 });
      // UPDATE session_participants RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [reregistered], rowCount: 1 });

      const result = await sessionService.registerParticipant('session-123', 'user-left');
      expect(result.status).toBe('registered');
    });
  });

  describe('unregisterParticipant', () => {
    it('should unregister a participant from a scheduled session', async () => {
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });
      // UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await expect(sessionService.unregisterParticipant('session-123', 'user-1'))
        .resolves.toBeUndefined();
    });

    it('should throw when session is not scheduled', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...mockSession, status: SessionStatus.ROUND_ACTIVE }],
        rowCount: 1,
      });

      await expect(sessionService.unregisterParticipant('session-123', 'user-1'))
        .rejects.toThrow('Cannot unregister');
    });

    it('should throw NotFoundError when registration not found', async () => {
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });
      // UPDATE rowCount = 0
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(sessionService.unregisterParticipant('session-123', 'user-ghost'))
        .rejects.toThrow('not found');
    });
  });

  describe('updateSession', () => {
    it('should update session fields when user is host', async () => {
      const updatedSession = { ...mockSession, title: 'Updated Title' };
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });
      // UPDATE sessions RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 });

      const result = await sessionService.updateSession('session-123', 'user-host', { title: 'Updated Title' });
      expect(result.title).toBe('Updated Title');
    });

    it('should throw ForbiddenError when user is not the host', async () => {
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });

      await expect(sessionService.updateSession('session-123', 'user-other', { title: 'X' }))
        .rejects.toThrow('Only the session host');
    });

    it('should throw when session is already started', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...mockSession, status: SessionStatus.ROUND_ACTIVE }],
        rowCount: 1,
      });

      await expect(sessionService.updateSession('session-123', 'user-host', { title: 'X' }))
        .rejects.toThrow('already started');
    });

    it('should return unchanged session when no fields provided', async () => {
      // getSessionById
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });

      const result = await sessionService.updateSession('session-123', 'user-host', {});
      expect(result).toEqual(mockSession);
    });
  });

  describe('listSessions - with filters', () => {
    it('should filter by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await sessionService.listSessions({ status: SessionStatus.COMPLETED });
      expect(result.total).toBe(0);
      expect(mockQuery.mock.calls[0][0]).toContain('status =');
    });

    it('should paginate results', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '50' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [mockSession], rowCount: 1 });

      const result = await sessionService.listSessions({ page: 3, pageSize: 10 });
      expect(result.total).toBe(50);
    });
  });

  describe('getParticipantCount', () => {
    it('should return count of active participants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '8' }], rowCount: 1 });

      const count = await sessionService.getParticipantCount('session-123');
      expect(count).toBe(8);
    });
  });

  describe('updateParticipantStatus', () => {
    it('should update participant status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await sessionService.updateParticipantStatus('session-123', 'user-1', ParticipantStatus.IN_LOBBY);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE session_participants'),
        expect.any(Array)
      );
    });

    it('should set is_no_show when marking as no-show', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await sessionService.updateParticipantStatus('session-123', 'user-1', ParticipantStatus.NO_SHOW);
      expect(mockQuery.mock.calls[0][0]).toContain('is_no_show = TRUE');
    });

    it('should set left_at when marking as left', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await sessionService.updateParticipantStatus('session-123', 'user-1', ParticipantStatus.LEFT);
      expect(mockQuery.mock.calls[0][0]).toContain('left_at = NOW()');
    });
  });

  describe('incrementRoundsCompleted', () => {
    it('should increment rounds for a participant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await sessionService.incrementRoundsCompleted('session-123', 'user-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('rounds_completed = rounds_completed + 1'),
        ['session-123', 'user-1']
      );
    });
  });

  describe('updateSessionStatus - with extra updates', () => {
    it('should update status with currentRound', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockSession, status: SessionStatus.ROUND_ACTIVE, currentRound: 2 }], rowCount: 1 });

      const result = await sessionService.updateSessionStatus('session-123', SessionStatus.ROUND_ACTIVE, { currentRound: 2 });
      expect(result.status).toBe(SessionStatus.ROUND_ACTIVE);
      expect(mockQuery.mock.calls[0][0]).toContain('current_round');
    });

    it('should update status with startedAt', async () => {
      const now = new Date();
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockSession, status: SessionStatus.ROUND_ACTIVE }], rowCount: 1 });

      await sessionService.updateSessionStatus('session-123', SessionStatus.ROUND_ACTIVE, { startedAt: now });
      expect(mockQuery.mock.calls[0][0]).toContain('started_at');
    });
  });
});
