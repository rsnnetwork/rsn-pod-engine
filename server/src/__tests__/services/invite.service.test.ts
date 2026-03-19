// ─── Invite Service Tests ────────────────────────────────────────────────────
import { InviteStatus, InviteType } from '@rsn/shared';

const mockQuery = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => mockTransaction(cb),
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

jest.mock('../../services/email/email.service', () => ({
  sendInviteEmail: jest.fn().mockResolvedValue(undefined),
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
    mockTransaction.mockReset();
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
      // 1. Rate limit: get user entitlements
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      // 2. Rate limit: count invites in past 24h
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // 3. Self-invite check — SELECT email FROM users
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      // 5. podService.getPodById — SELECT pods (validates pod exists + archived check)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 });
      // 6. podService.getMemberRole — SELECT role FROM pod_members (role check)
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // 7. Check existing member — SELECT u.id FROM users JOIN pod_members
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 8. Duplicate pending invite check — SELECT id FROM invites
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 9. INSERT invite RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });
      // 10. Inviter display name lookup (for email)
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 });
      // 11. Pod name lookup (for email)
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Test Pod' }], rowCount: 1 });
      // 12. Notification: look up invitee user id
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const invite = await inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeEmail: 'guest@example.com',
      });

      expect(invite).toEqual(mockInvite);
    });

    it('should reject self-invites', async () => {
      // 1. Rate limit: get user entitlements
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      // 2. Rate limit: count invites in past 24h
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // 3. Self-invite check — email matches caller
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 });

      await expect(inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeEmail: 'guest@example.com',
      })).rejects.toThrow('cannot invite yourself');
    });

    it('should reject duplicate pending invites', async () => {
      // 1. Rate limit: get user entitlements
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      // 2. Rate limit: count invites in past 24h
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // 3. Self-invite check — different email
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      // 5. podService.getPodById
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 });
      // 6. podService.getMemberRole
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // 7. Check existing member
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 8. Duplicate check — found existing pending invite
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-invite' }], rowCount: 1 });

      await expect(inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeEmail: 'guest@example.com',
      })).rejects.toThrow('pending invite already exists');
    });

    it('should reject invites to archived pods', async () => {
      // 1. Rate limit: get user entitlements
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      // 2. Rate limit: count invites in past 24h
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // 3. Self-invite check
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      // 5. getPodById returns archived pod
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'archived' }], rowCount: 1 });

      await expect(inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeEmail: 'guest@example.com',
      })).rejects.toThrow('archived');
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

  describe('listInvitesByUser - filters', () => {
    it('should filter by type', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });

      const result = await inviteService.listInvitesByUser('user-host', { type: InviteType.POD });
      expect(result.invites).toHaveLength(1);
      expect(mockQuery.mock.calls[0][0]).toContain('type =');
    });

    it('should filter by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await inviteService.listInvitesByUser('user-host', { status: InviteStatus.ACCEPTED });
      expect(result.total).toBe(0);
      expect(mockQuery.mock.calls[0][0]).toContain('status =');
    });
  });

  describe('acceptInvite', () => {
    it('should accept a valid invite and add user to pod', async () => {
      const acceptedInvite = { ...mockInvite, useCount: 1, status: InviteStatus.ACCEPTED, acceptedByUserId: 'user-guest', acceptedAt: new Date() };

      mockTransaction.mockImplementation(async (cb: Function) => {
        const client = {
          query: jest.fn()
            // SELECT invite FOR UPDATE
            .mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 })
            // SELECT email FROM users (inviteeEmail check)
            .mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 })
            // UPDATE invite
            .mockResolvedValueOnce({ rows: [acceptedInvite], rowCount: 1 }),
        };
        return cb(client);
      });

      // addMember calls: getPodById, COUNT capacity, check existing, INSERT
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active', maxMembers: 50 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: 'pm-1', podId: 'pod-123', userId: 'user-guest', role: 'member', status: 'active' }], rowCount: 1 });

      const result = await inviteService.acceptInvite('ABC123XYZ', 'user-guest');
      expect(result).toBeDefined();
    });

    it('should throw when invite code not found', async () => {
      mockTransaction.mockImplementation(async (cb: Function) => {
        const client = {
          query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
        };
        return cb(client);
      });

      await expect(inviteService.acceptInvite('BADCODE', 'user-guest'))
        .rejects.toThrow('not found');
    });

    it('should throw when invite is revoked', async () => {
      mockTransaction.mockImplementation(async (cb: Function) => {
        const client = {
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ ...mockInvite, status: InviteStatus.REVOKED }],
            rowCount: 1,
          }),
        };
        return cb(client);
      });

      await expect(inviteService.acceptInvite('ABC123XYZ', 'user-guest'))
        .rejects.toThrow('revoked');
    });

    it('should throw when invite has expired', async () => {
      mockTransaction.mockImplementation(async (cb: Function) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({
              rows: [{ ...mockInvite, status: InviteStatus.EXPIRED }],
              rowCount: 1,
            }),
        };
        return cb(client);
      });

      await expect(inviteService.acceptInvite('ABC123XYZ', 'user-guest'))
        .rejects.toThrow('expired');
    });

    it('should throw when max uses reached', async () => {
      mockTransaction.mockImplementation(async (cb: Function) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({
              rows: [{ ...mockInvite, useCount: 1, maxUses: 1 }],
              rowCount: 1,
            }),
        };
        return cb(client);
      });

      await expect(inviteService.acceptInvite('ABC123XYZ', 'user-guest'))
        .rejects.toThrow('maximum uses');
    });
  });

  describe('createInvite - session type', () => {
    it('should create a session invite', async () => {
      const sessionInvite = { ...mockInvite, type: InviteType.SESSION, sessionId: 'session-123', podId: null };
      // 1. Rate limit: get user entitlements
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      // 2. Rate limit: count invites in past 24h
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // (no inviteeEmail → skips role-based restriction + self-invite + platform check)
      // 3. sessionService.getSessionById — returns session
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      // (no inviteeEmail → skips existing participant check + duplicate invite check)
      // 4. INSERT invite
      mockQuery.mockResolvedValueOnce({ rows: [sessionInvite], rowCount: 1 });
      // 6. Inviter display name lookup
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 });
      // 7. Session title lookup
      mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Test Session' }], rowCount: 1 });

      const invite = await inviteService.createInvite('user-host', {
        type: InviteType.SESSION,
        sessionId: 'session-123',
      });

      expect(invite.type).toBe(InviteType.SESSION);
    });
  });
});
