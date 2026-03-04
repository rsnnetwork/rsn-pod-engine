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
  });
});
