// ─── Invite Service Tests ────────────────────────────────────────────────────
import { InviteStatus, InviteType } from '@rsn/shared';

const mockQuery = jest.fn();

jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../config', () => ({
  default: {
    clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
  },
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import * as inviteService from '../../services/invite/invite.service';

const mockInvite = {
  id: 'invite-123',
  code: 'ABC123XYZ',
  type: InviteType.POD,
  inviterId: 'user-host',
  inviteeEmail: 'guest@example.com',
  podId: 'pod-123',
  sessionId: null,
  status: InviteStatus.PENDING,
  maxUses: 1,
  useCount: 0,
  expiresAt: new Date(Date.now() + 86400000),
  acceptedByUserId: null,
  acceptedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Invite Service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('getInviteByCode', () => {
    it('should return invite when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });

      const invite = await inviteService.getInviteByCode('ABC123XYZ');
      expect(invite).toEqual(mockInvite);
    });

    it('should throw NotFoundError when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(inviteService.getInviteByCode('MISSING'))
        .rejects.toThrow('not found');
    });
  });

  describe('createInvite', () => {
    it('should create a pod invite', async () => {
      // podService.getPodById — SELECT pods (validates pod exists)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 });
      // INSERT invite RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });

      const invite = await inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeEmail: 'guest@example.com',
      });

      expect(invite).toEqual(mockInvite);
    });
  });

  describe('listInvitesByUser', () => {
    it('should return invites for a user', async () => {
      // COUNT query first
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      // Data query second
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });

      const result = await inviteService.listInvitesByUser('user-host', {});
      expect(result.invites).toHaveLength(1);
    });

    it('should return empty when no invites', async () => {
      // COUNT query first
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // Data query second
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await inviteService.listInvitesByUser('user-host', {});
      expect(result.invites).toHaveLength(0);
    });
  });
});
