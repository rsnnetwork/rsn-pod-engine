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

// The invitee's bell is pushed through the live socket server; the entry point is not loaded here.
const mockIoEmit = jest.fn();
jest.mock('../../index', () => ({
  io: { to: (room: string) => ({ emit: (...args: unknown[]) => mockIoEmit(room, ...args) }) },
}));

import * as inviteService from '../../services/invite/invite.service';
import * as emailService from '../../services/email/email.service';
import logger from '../../config/logger';
import { inviteWorld } from '../fixtures/invite-world';

const flatSql = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

// What the rest of the database says while a pod (or an event) invite is made, for the tests that run the
// create path against the in-memory invites table (fixtures/invite-world.ts).
const worldAnswersForPods = (sql: string) => {
  if (/max_invites_per_day/.test(sql)) return { rows: [{ max_invites_per_day: 100 }] };
  if (/COUNT\(\*\) as count FROM invites/.test(sql)) return { rows: [{ count: '0' }] };
  if (/SELECT email FROM users WHERE id = \$1/.test(sql)) return { rows: [{ email: 'host@example.com' }] };
  if (/WHERE pods\.id = \$1/.test(sql)) return { rows: [{ id: 'pod-123', name: 'Test', status: 'active' }] };
  if (/SELECT role FROM pod_members/.test(sql)) return { rows: [{ role: 'director' }] };
  if (/display_name AS "displayName"/.test(sql)) return { rows: [{ displayName: 'Host User' }] };
  if (/SELECT name FROM pods/.test(sql)) return { rows: [{ name: 'Test Pod' }] };
  return { rows: [] };
};
const worldAnswersForEvents = (sql: string) => {
  if (/max_invites_per_day/.test(sql)) return { rows: [{ max_invites_per_day: 100 }] };
  if (/COUNT\(\*\) as count FROM invites/.test(sql)) return { rows: [{ count: '0' }] };
  if (/SELECT email FROM users WHERE id = \$1/.test(sql)) return { rows: [{ email: 'host@example.com' }] };
  if (/SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions/.test(sql)) {
    return { rows: [{ title: 'Test Session', scheduled_at: null, host_user_id: 'user-host', config: {}, event_format: 'speed_networking' }] };
  }
  if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }] };
  if (/display_name AS "displayName"/.test(sql)) return { rows: [{ displayName: 'Host User' }] };
  return { rows: [] };
};

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
    // 26 Oct 2026: the duplicate check and the insert of a personal invite run in one transaction, behind an advisory
    // lock. By default the transaction's client draws on the same answer queue as the pool, so the order the tests
    // below read is the order the code runs. Tests that look at the transaction itself replace this.
    mockTransaction.mockImplementation(async (cb: Function) => cb({ query: (...args: unknown[]) => mockQuery(...args) }));
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
      // 7b. Is the address a closed account's, or a blocked person's? No
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 8a. Advisory lock for this type, pod and address (the transaction's first statement)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
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

    // 9 Sep 2026: member lists no longer carry emails, so a pick from the
    // "met before" list arrives as inviteeUserId and the server resolves it.
    it('resolves inviteeUserId to that member\'s email before anything else', async () => {
      // 0. Resolve the invitee's address
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 });
      // 1. Rate limit: get user entitlements
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      // 2. Rate limit: count invites in past 24h
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // 3. Self-invite check — SELECT email FROM users (caller)
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      // 5. podService.getPodById
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 });
      // 6. podService.getMemberRole
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // 7. Existing member check
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 7b. Is the address a closed account's, or a blocked person's? No
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 8a. Advisory lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // 8. Duplicate pending invite check
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 9. INSERT invite RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });
      // 10-12. email + notification lookups
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Test Pod' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const invite = await inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeUserId: 'user-guest',
      });

      expect(invite).toEqual(mockInvite);
      expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT email FROM users WHERE id = \$1/);
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-guest']);
      const insert = mockQuery.mock.calls.find((c: unknown[]) => /INSERT INTO invites/.test(c[0] as string));
      expect(insert).toBeTruthy();
      expect(insert![1]).toContain('guest@example.com');
    });

    it('rejects an inviteeUserId that is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.createInvite('user-host', {
        type: InviteType.POD, podId: 'pod-123', inviteeUserId: 'user-ghost',
      })).rejects.toThrow(/not found/i);
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
      // 7b. Is the address a closed account's, or a blocked person's? No
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // 8a. Advisory lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // 8. Duplicate check — found existing pending invite
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-invite' }], rowCount: 1 });

      await expect(inviteService.createInvite('user-host', {
        type: InviteType.POD,
        podId: 'pod-123',
        inviteeEmail: 'guest@example.com',
      })).rejects.toThrow('pending invite already exists');
    });

    // ─── 13 Aug 2026: any member can invite to the platform ─────────────────
    // Stefan: "Currently only admins can send platform invitations — I want any
    // user to be able to invite." Ali's decision: direct and unlimited, the
    // same effect an admin invite has. The audit trail is what stays.
    it('a plain member can create a platform invite, and the row records who sent it', async () => {
      const platformInvite = { ...mockInvite, type: InviteType.PLATFORM, inviterId: 'user-member', podId: null };
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 }); // entitlement
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });               // sent today
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'member@example.com' }], rowCount: 1 }); // self-invite check
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // already registered?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });                             // advisory lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // duplicate pending?
      mockQuery.mockResolvedValueOnce({ rows: [platformInvite], rowCount: 1 });               // INSERT
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'A Member' }], rowCount: 1 });  // inviter name for the email
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // notification: invitee is not a user

      const invite = await inviteService.createInvite('user-member', {
        type: InviteType.PLATFORM,
        inviteeEmail: 'guest@example.com',
      }, 'member');

      expect(invite).toEqual(platformInvite);
      const insert = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO invites'));
      expect(insert).toBeDefined(); // a real row was written
      expect(insert![1][2]).toBe('user-member'); // inviter_id is the member — origin stays traceable
    });

    it('a member still cannot platform-invite someone who is already registered', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'member@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u-existing' }], rowCount: 1 }); // already registered

      await expect(inviteService.createInvite('user-member', {
        type: InviteType.PLATFORM,
        inviteeEmail: 'existing@example.com',
      }, 'member')).rejects.toMatchObject({ code: 'ALREADY_REGISTERED' });
    });

    it("a member's existing daily entitlement still applies to platform invites — the one lever left", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 5 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 });

      await expect(inviteService.createInvite('user-member', {
        type: InviteType.PLATFORM,
        inviteeEmail: 'guest@example.com',
      }, 'member')).rejects.toMatchObject({ code: 'INVITE_LIMIT_REACHED' });
    });

    // ─── 13 Aug 2026 (C3): circle-level invites ───────────────────────────────
    it('a circle member can create a circle invite, and the row carries the circle', async () => {
      const circleInvite = { ...mockInvite, type: InviteType.CIRCLE, inviterId: 'user-member', podId: null, circleId: 'circle-1' };
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 }); // entitlement
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });               // sent today
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'circle-1' }], rowCount: 1 });           // circle exists, not archived
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });            // caller is a member
      mockQuery.mockResolvedValueOnce({ rows: [circleInvite], rowCount: 1 });                 // INSERT

      const invite = await inviteService.createInvite('user-member', {
        type: InviteType.CIRCLE, circleId: 'circle-1', maxUses: 5,
      }, 'member');

      expect(invite).toEqual(circleInvite);
      const insert = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO invites'));
      expect(String(insert![0])).toMatch(/circle_id/);
      expect(insert![1]).toContain('circle-1');
    });

    it('someone who is not in the circle cannot invite to it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'circle-1' }], rowCount: 1 }); // circle exists
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // not a member

      await expect(inviteService.createInvite('user-outsider', {
        type: InviteType.CIRCLE, circleId: 'circle-1',
      }, 'member')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    });

    it('a circle invite without a circle is rejected before anything is looked up', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

      await expect(inviteService.createInvite('user-member', {
        type: InviteType.CIRCLE,
      }, 'member')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(mockQuery.mock.calls.some(c => String(c[0]).includes('FROM circles'))).toBe(false);
    });

    it('an archived or unknown circle cannot be invited to', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no live circle

      await expect(inviteService.createInvite('user-member', {
        type: InviteType.CIRCLE, circleId: 'circle-gone',
      }, 'member')).rejects.toMatchObject({ statusCode: 404 });
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

    it('Phase A short-tx: invite-row lock is released before applyInviteRegistration runs', async () => {
      // Pre-fix (incident 2026-04-28 11:00 UTC): the entire flow ran
      // inside transaction(), so the outer connection sat idle holding
      // BEGIN while applyInviteRegistration's nested transactions
      // serialized on a shared pod-row FOR UPDATE. Outer connection
      // exceeded Neon's idle-in-transaction timeout → 25P03 FATAL →
      // request 500'd after a ~22s hang. Post-fix: transaction()
      // wraps Phase A only; addMember opens its own (separate) tx
      // strictly AFTER Phase A commits.
      let phaseACommittedAt = 0;
      let phaseACommittedBeforeRegistration = false;

      mockTransaction
        // Phase A
        .mockImplementationOnce(async (cb: Function) => {
          const client = {
            query: jest.fn().mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 }),
          };
          const result = await cb(client);
          phaseACommittedAt = Date.now();
          return result;
        })
        // addMember's nested tx (Phase B)
        .mockImplementationOnce(async (cb: Function) => {
          if (phaseACommittedAt > 0) phaseACommittedBeforeRegistration = true;
          const client = {
            query: jest.fn()
              .mockResolvedValueOnce({ rows: [{ id: 'pod-123' }], rowCount: 1 })
              .mockResolvedValueOnce({ rows: [], rowCount: 0 })
              .mockResolvedValueOnce({ rows: [{ id: 'pm-1' }], rowCount: 1 }),
          };
          return cb(client);
        });

      mockQuery
        // Phase C atomic UPDATE
        .mockResolvedValueOnce({ rows: [{ ...mockInvite, useCount: 1, status: InviteStatus.ACCEPTED }], rowCount: 1 })
        // Phase D notifications
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await inviteService.acceptInvite('ABC123XYZ', 'user-guest');

      expect(phaseACommittedBeforeRegistration).toBe(true);
    });

    it('Phase C atomic UPDATE absorbs use_count race (returns success when re-read finds invite consumed)', async () => {
      // If a concurrent caller bumps use_count past max between Phase A
      // and Phase C, our UPDATE returns 0 rows. We re-read and return
      // the user-was-still-registered success path.
      mockTransaction
        .mockImplementationOnce(async (cb: Function) => {
          const client = {
            query: jest.fn().mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 }),
          };
          return cb(client);
        })
        // addMember's nested tx (Phase B)
        .mockImplementationOnce(async (cb: Function) => {
          const client = {
            query: jest.fn()
              .mockResolvedValueOnce({ rows: [{ id: 'pod-123' }], rowCount: 1 })
              .mockResolvedValueOnce({ rows: [], rowCount: 0 })
              .mockResolvedValueOnce({ rows: [{ id: 'pm-1' }], rowCount: 1 }),
          };
          return cb(client);
        });

      mockQuery
        // Phase C atomic UPDATE — returns 0 rows because race lost
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // Phase C re-read — invite was consumed by concurrent caller
        .mockResolvedValueOnce({ rows: [{ ...mockInvite, useCount: 1, acceptedByUserId: 'other-user' }], rowCount: 1 })
        // Phase D notifications
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await inviteService.acceptInvite('ABC123XYZ', 'user-guest');
      expect(result).toBeDefined();
      expect(result.invite).toBeDefined();
      const atomicUpdateCall = mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string'
          && (c[0] as string).includes('UPDATE invites')
          && (c[0] as string).includes('use_count < max_uses')
      );
      expect(atomicUpdateCall).toBeDefined();
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

  // ─── 26 Oct 2026: one pending invite per person, however many requests arrive at once ───────────
  // Check-then-insert let a double click or two tabs make two pending invites (audit 03, defect 11). The check and
  // the insert now run in one transaction behind pg_advisory_xact_lock(type, target, address): a second request for
  // the same person waits for the first to commit, then finds its invite.
  describe('createInvite - one pending invite per person', () => {
    const queueAPodInvite = (insertedRows: unknown[] = [mockInvite]) => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 }); // entitlement
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });               // sent today
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 }); // self-invite check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 }); // pod
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });         // caller's role
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // already a member?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });  // not a closed account, not blocked
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });                             // advisory lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // duplicate pending?
      mockQuery.mockResolvedValueOnce({ rows: insertedRows, rowCount: insertedRows.length }); // INSERT
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 });  // inviter name
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Test Pod' }], rowCount: 1 });         // pod name
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                             // invitee is not a member
    };

    it('takes the lock on type, pod and address first, then checks for a duplicate and inserts, all in one transaction', async () => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      queueAPodInvite();

      await inviteService.createInvite('user-host', {
        type: InviteType.POD, podId: 'pod-123', inviteeEmail: 'Guest@Example.com',
      });

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      const statements = clientQuery.mock.calls.map((call) => flatSql(call[0]));
      expect(statements).toHaveLength(3);
      expect(statements[0]).toMatch(/^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)$/);
      expect(statements[1]).toMatch(/^SELECT id FROM invites WHERE invitee_email = \$1 AND type = \$2 AND status = 'pending'/);
      expect(statements[2]).toMatch(/^INSERT INTO invites/);
      // The key names the type, the target and the address (lower case: the address is stored lower case).
      expect(clientQuery.mock.calls[0][1]).toEqual(['pod:pod-123:guest@example.com']);
    });

    it('locks per event too: an event invite is keyed by its event', async () => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // already a participant?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });  // not a closed account, not blocked
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // duplicate
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockInvite, type: InviteType.SESSION }], rowCount: 1 }); // INSERT
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 });                // inviter name
      mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Test Session', scheduled_at: null, host_user_id: 'user-host', config: {}, event_format: 'speed_networking' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                                            // invitee is not a member

      await inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123', inviteeEmail: 'guest@example.com' });

      expect(clientQuery.mock.calls[0][1]).toEqual(['session:session-123:guest@example.com']);
    });

    it('a pending invite that has expired does not block a new one', async () => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      queueAPodInvite();

      await inviteService.createInvite('user-host', { type: InviteType.POD, podId: 'pod-123', inviteeEmail: 'guest@example.com' });

      expect(flatSql(clientQuery.mock.calls[1][0])).toMatch(/AND \(expires_at IS NULL OR expires_at > NOW\(\)\)/);
    });

    it('an open link names nobody, so it needs no lock and no transaction', async () => {
      const sessionInvite = { ...mockInvite, type: InviteType.SESSION, sessionId: 'session-123', podId: null, inviteeEmail: null };
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [sessionInvite], rowCount: 1 });

      const invite = await inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123' });

      expect(invite).toEqual(sessionInvite);
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockQuery.mock.calls.some((call) => /pg_advisory_xact_lock/.test(String(call[0])))).toBe(false);
    });

    // The database stand-in (worldAnswersForPods, above): pg_advisory_xact_lock queues transactions per key, and
    // every statement yields, so two requests that are not serialised really interleave.
    const useWorld = (honourLocks: boolean) => {
      const world = inviteWorld({ honourLocks, answers: worldAnswersForPods });
      mockQuery.mockImplementation(world.query);
      mockTransaction.mockImplementation(world.transaction);
      return world;
    };
    const invitePerson = (email: string) =>
      inviteService.createInvite('user-host', { type: InviteType.POD, podId: 'pod-123', inviteeEmail: email, maxUses: 1 });

    it('two requests for the same person at the same moment make one invite, and the second is told one is pending', async () => {
      const world = useWorld(true);

      const [first, second] = await Promise.allSettled([invitePerson('guest@example.com'), invitePerson('guest@example.com')]);

      expect(world.invites).toHaveLength(1);
      const outcomes = [first, second];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(refused?.reason).toMatchObject({ code: 'DUPLICATE_INVITE', statusCode: 409 });
    });

    it('five at once still make one', async () => {
      const world = useWorld(true);
      const all = await Promise.allSettled(Array.from({ length: 5 }, () => invitePerson('guest@example.com')));
      expect(world.invites).toHaveLength(1);
      expect(all.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(all.filter((o) => o.status === 'rejected')).toHaveLength(4);
    });

    it('the harness does see the race: with the lock taken away the same two requests make two invites', async () => {
      const world = useWorld(false);
      await Promise.allSettled([invitePerson('guest@example.com'), invitePerson('guest@example.com')]);
      expect(world.invites).toHaveLength(2);
    });

    it('different people are not held up by each other: two addresses make two invites', async () => {
      const world = useWorld(true);
      const [a, b] = await Promise.allSettled([invitePerson('ann@example.com'), invitePerson('bob@example.com')]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      expect(world.invites.map((i) => i.email).sort()).toEqual(['ann@example.com', 'bob@example.com']);
    });

    it('the same address in a different pod is a different invite', async () => {
      const world = useWorld(true);
      await Promise.all([
        invitePerson('guest@example.com'),
        inviteService.createInvite('user-host', { type: InviteType.POD, podId: 'pod-456', inviteeEmail: 'guest@example.com', maxUses: 1 }),
      ]);
      expect(world.invites).toHaveLength(2);
    });

    it('a person whose earlier invite was answered or withdrawn can be invited again', async () => {
      const world = useWorld(true);
      await invitePerson('guest@example.com');
      world.invites[0].status = 'revoked';
      await invitePerson('guest@example.com');
      expect(world.invites).toHaveLength(2);
    });
  });

  // ─── 26 Oct 2026: a co-host may send event invites ───────────────────────────────────────────────
  // GET /pods/:id/members/for-invite already listed the pod's members for a co-host (audit 03, defect 9), and then
  // the invite itself was refused: only the host could send it.
  describe('createInvite - who may invite to an event', () => {
    const queueAnEventInvite = (cohostRows: unknown[] | null, { admin = false } = {}) => {
      const sessionInvite = { ...mockInvite, type: InviteType.SESSION, sessionId: 'session-123', podId: null, inviterId: 'user-cohost' };
      if (!admin) {
        mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });                 // entitlement
        mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });                              // sent today
      }
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'cohost@example.com' }], rowCount: 1 });               // self-invite check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      if (cohostRows) mockQuery.mockResolvedValueOnce({ rows: cohostRows, rowCount: cohostRows.length });      // is a co-host?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                                              // already a participant?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });  // not a closed account, not blocked
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });                                              // lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                                              // duplicate
      mockQuery.mockResolvedValueOnce({ rows: [sessionInvite], rowCount: 1 });                                 // INSERT
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Co Host' }], rowCount: 1 });                    // inviter name
      mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Test Session', scheduled_at: null, host_user_id: 'user-host', config: {}, event_format: 'speed_networking' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                                              // invitee is not a member
      return sessionInvite;
    };
    const send = (userId: string, role?: string) =>
      inviteService.createInvite(userId, { type: InviteType.SESSION, sessionId: 'session-123', inviteeEmail: 'guest@example.com', maxUses: 1 }, role);
    const askedAboutCohosts = () => mockQuery.mock.calls.some((call) => /session_cohosts/.test(String(call[0])));

    it('a co-host the host named can send an event invite, and the row records who sent it', async () => {
      const queued = queueAnEventInvite([{ '?column?': 1 }]);
      const invite = await send('user-cohost', 'member');
      expect(invite).toEqual(queued);
      const insert = mockQuery.mock.calls.find((call) => /INSERT INTO invites/.test(String(call[0])));
      expect(insert![1][2]).toBe('user-cohost');
      expect(askedAboutCohosts()).toBe(true);
    });

    it('someone who is neither the host, a co-host nor an admin is refused, and nothing is written', async () => {
      queueAnEventInvite([]);
      await expect(send('user-stranger', 'member')).rejects.toMatchObject({
        statusCode: 403, code: 'AUTH_FORBIDDEN', message: 'Only the event host or a co-host can send event invites',
      });
      expect(mockQuery.mock.calls.some((call) => /INSERT INTO invites/.test(String(call[0])))).toBe(false);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('the host is not asked about co-hosts at all', async () => {
      queueAnEventInvite(null);
      await send('user-host', 'member');
      expect(askedAboutCohosts()).toBe(false);
    });

    it('an admin is not asked about co-hosts either', async () => {
      queueAnEventInvite(null, { admin: true });
      await send('user-admin', 'admin');
      expect(askedAboutCohosts()).toBe(false);
    });
  });

  // ─── 26 Oct 2026: declined is not withdrawn ──────────────────────────────────────────────────────
  describe('declineInvite', () => {
    it('records when the invitee said no and keeps status revoked, so production\'s bell and Invites page read it as before', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ pod_id: 'pod-1', session_id: null }], rowCount: 1 }); // UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-guest' }], rowCount: 1 });                  // who
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                                      // bell read

      const declined = await inviteService.declineInvite('CODE123', 'Guest@Example.com');

      expect(declined).toEqual({ podId: 'pod-1', sessionId: null });
      const [sql, params] = mockQuery.mock.calls[0];
      expect(flatSql(sql)).toMatch(/^UPDATE invites SET status = 'revoked', declined_at = NOW\(\) WHERE code = \$1 AND invitee_email = \$2 AND status = 'pending'/);
      expect(params).toEqual(['CODE123', 'guest@example.com']);
    });

    it('an invite that is not pending (or not theirs) is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.declineInvite('CODE123', 'guest@example.com')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('an organiser withdrawing an invite is not a decline: declined_at stays empty', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ inviter_id: 'user-host', pod_id: null, session_id: 'session-1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ pod_id: null, session_id: 'session-1' }], rowCount: 1 });
      await inviteService.revokeInvite('invite-1', 'user-host');
      const sql = flatSql(mockQuery.mock.calls[1][0]);
      expect(sql).toMatch(/^UPDATE invites SET status = 'revoked' WHERE id = \$1 AND status = 'pending' RETURNING pod_id, session_id$/);
      expect(sql).not.toMatch(/declined_at/);
    });
  });

  // 26 Oct 2026 (fix round 1): co-hosts send event invites now, so on production's event page the host's Revoke on a co-host's
  // shareable link answered 404 ("Failed to revoke invite"): only the sender could withdraw. The host, the event's
  // co-hosts and admins manage every invite to their event; a pod's directors, hosts and admins every invite to
  // their pod (they could already list and remind them). Anyone else can withdraw only what they sent themselves.
  // Fix round 3: each invite is judged by its `type` (an old pod invite carrying a stray event id is the pod's), and the
  // answer says who sent it and which member it was for, so the route can tell their screens.
  describe('revokeInvite: who may withdraw an invite', () => {
    const invite = (over: Record<string, unknown> = {}) => ({
      inviter_id: 'user-sender', type: 'platform', pod_id: null, session_id: null, invitee_user_id: null, ...over,
    });
    const eventInvite = (over: Record<string, unknown> = {}) => invite({ type: 'session', session_id: 'session-1', ...over });
    const podInvite = (over: Record<string, unknown> = {}) => invite({ type: 'pod', pod_id: 'pod-1', ...over });
    /** The invite is found pending; then `relation` answers the role lookup; then the update lands. */
    const queue = (found: Record<string, unknown> | null, relation?: Record<string, unknown> | null) => {
      mockQuery.mockResolvedValueOnce({ rows: found ? [found] : [], rowCount: found ? 1 : 0 });
      if (relation !== undefined) mockQuery.mockResolvedValueOnce({ rows: relation ? [relation] : [], rowCount: relation ? 1 : 0 });
    };
    const lands = (row: Record<string, unknown>) => mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const updates = () => mockQuery.mock.calls.filter((call) => /^UPDATE invites/.test(flatSql(call[0])));
    const roleLookups = () => mockQuery.mock.calls.map((call) => flatSql(call[0])).filter((sql) => /is_host|SELECT role FROM pod_members/.test(sql));

    it('the sender withdraws their own invite, whatever it is for, with no role looked up', async () => {
      queue(eventInvite({ inviter_id: 'user-ann' }));
      lands({ pod_id: null, session_id: 'session-1' });
      await expect(inviteService.revokeInvite('invite-1', 'user-ann', 'member'))
        .resolves.toEqual({ podId: null, sessionId: 'session-1', inviterId: 'user-ann', inviteeUserId: null });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[0][1]).toEqual(['invite-1']);
    });

    it('reads the invite with the member its address belongs to, in the same question', async () => {
      queue(eventInvite({ inviter_id: 'user-ann' }));
      lands({ pod_id: null, session_id: 'session-1' });
      await inviteService.revokeInvite('invite-1', 'user-ann', 'member');
      expect(flatSql(mockQuery.mock.calls[0][0])).toBe(
        "SELECT i.inviter_id, i.type, i.pod_id, i.session_id, u.id AS invitee_user_id FROM invites i LEFT JOIN users u ON u.email = i.invitee_email WHERE i.id = $1 AND i.status = 'pending'");
    });

    it('says who sent it and which member it was for, whoever withdrew it: the screens of both are to be told', async () => {
      queue(eventInvite({ inviter_id: 'user-cohost', invitee_user_id: 'user-guest' }), { is_host: true, is_cohost: false });
      lands({ pod_id: null, session_id: 'session-1' });
      await expect(inviteService.revokeInvite('invite-1', 'user-host', 'member'))
        .resolves.toEqual({ podId: null, sessionId: 'session-1', inviterId: 'user-cohost', inviteeUserId: 'user-guest' });
    });

    it('the host withdraws the shareable link a co-host made (the case production\'s event page hit as a 404)', async () => {
      queue(eventInvite({ inviter_id: 'user-cohost' }), { is_host: true, is_cohost: false });
      lands({ pod_id: null, session_id: 'session-1' });
      await expect(inviteService.revokeInvite('invite-1', 'user-host', 'member')).resolves.toMatchObject({ podId: null, sessionId: 'session-1' });
      expect(updates()).toHaveLength(1);
      expect(updates()[0][1]).toEqual(['invite-1']);
    });

    it('a co-host withdraws an invite the host or another co-host sent', async () => {
      queue(eventInvite({ inviter_id: 'user-host' }), { is_host: false, is_cohost: true });
      lands({ pod_id: null, session_id: 'session-1' });
      await expect(inviteService.revokeInvite('invite-1', 'user-cohost', 'member')).resolves.toMatchObject({ sessionId: 'session-1' });
    });

    it('the role is looked up for the event the INVITE belongs to, so a co-host of one event holds no power over another\'s', async () => {
      queue(eventInvite({ session_id: 'event-b' }), null);
      await expect(inviteService.revokeInvite('invite-1', 'user-cohost-of-a', 'member')).rejects.toMatchObject({ statusCode: 404 });
      expect(flatSql(mockQuery.mock.calls[1][0])).toMatch(/\(s\.host_user_id = \$2\) AS is_host, EXISTS \(SELECT 1 FROM session_cohosts c WHERE c\.session_id = s\.id AND c\.user_id = \$2\) AS is_cohost FROM sessions s WHERE s\.id = \$1/);
      expect(mockQuery.mock.calls[1][1]).toEqual(['event-b', 'user-cohost-of-a']);
      expect(updates()).toHaveLength(0);
    });

    it('an ordinary participant or member cannot withdraw someone else\'s event invite: not found, and nothing is written', async () => {
      queue(eventInvite(), { is_host: false, is_cohost: false });
      await expect(inviteService.revokeInvite('invite-1', 'user-nobody', 'member')).rejects.toMatchObject({ statusCode: 404, code: 'INVITE_NOT_FOUND' });
      expect(updates()).toHaveLength(0);
    });

    it('an admin withdraws any event invite or pod invite, without a role being looked up', async () => {
      queue(eventInvite());
      lands({ pod_id: null, session_id: 'session-1' });
      await expect(inviteService.revokeInvite('invite-1', 'user-admin', 'admin')).resolves.toMatchObject({ sessionId: 'session-1' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      mockQuery.mockClear();
      queue(podInvite());
      lands({ pod_id: 'pod-1', session_id: null });
      await expect(inviteService.revokeInvite('invite-2', 'user-admin', 'super_admin')).resolves.toMatchObject({ podId: 'pod-1' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it.each(['director', 'host'])('a pod %s withdraws any invite to their pod (they could already list and remind them)', async (role) => {
      queue(podInvite({ inviter_id: 'user-member' }), { role });
      lands({ pod_id: 'pod-1', session_id: null });
      await expect(inviteService.revokeInvite('invite-1', 'user-director', 'member'))
        .resolves.toEqual({ podId: 'pod-1', sessionId: null, inviterId: 'user-member', inviteeUserId: null });
      expect(flatSql(mockQuery.mock.calls[1][0])).toBe("SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'");
      expect(mockQuery.mock.calls[1][1]).toEqual(['pod-1', 'user-director']);
    });

    it('a plain pod member (who may send invites when the pod lets them) withdraws only their own', async () => {
      queue(podInvite({ inviter_id: 'user-other-member' }), { role: 'member' });
      await expect(inviteService.revokeInvite('invite-1', 'user-member', 'member')).rejects.toMatchObject({ statusCode: 404 });
      expect(updates()).toHaveLength(0);
      mockQuery.mockClear();
      queue(podInvite({ inviter_id: 'user-member' }));
      lands({ pod_id: 'pod-1', session_id: null });
      await expect(inviteService.revokeInvite('invite-2', 'user-member', 'member')).resolves.toMatchObject({ podId: 'pod-1' });
    });

    it('someone who is not in the pod at all cannot', async () => {
      queue(podInvite(), null);
      await expect(inviteService.revokeInvite('invite-1', 'user-outsider', 'member')).rejects.toMatchObject({ statusCode: 404 });
    });

    // Fix round 2: reminding a platform or circle invite is the sender's or an admin's, and withdrawing it follows suit.
    it('a platform or circle invite is withdrawn by the person who sent it or by an admin: the rule for reminding it', async () => {
      queue(invite({ inviter_id: 'user-ann' }));
      lands({ pod_id: null, session_id: null });
      await expect(inviteService.revokeInvite('invite-1', 'user-admin', 'admin'))
        .resolves.toEqual({ podId: null, sessionId: null, inviterId: 'user-ann', inviteeUserId: null });
      expect(updates()).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      mockQuery.mockClear();
      queue(invite({ type: 'circle', inviter_id: 'user-ann' }));
      lands({ pod_id: null, session_id: null });
      await expect(inviteService.revokeInvite('invite-2', 'user-ann', 'member')).resolves.toMatchObject({ inviterId: 'user-ann' });
    });

    it('...and by nobody else: another member, even one who belongs to the circle or the pod of the same name, is told it is not found', async () => {
      queue(invite({ inviter_id: 'user-ann' }));
      await expect(inviteService.revokeInvite('invite-1', 'user-bob', 'member')).rejects.toMatchObject({ statusCode: 404, code: 'INVITE_NOT_FOUND' });
      expect(updates()).toHaveLength(0);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    // Fix round 2: rows made before a stray id was dropped at creation can carry a pod id on an event invite. The pod's
    // director had a hold on those through the pod id; an event invite is run by its event.
    it('an event invite that carries a stray pod id is run by its event alone: the pod\'s director cannot withdraw it', async () => {
      queue(eventInvite({ inviter_id: 'user-ann', pod_id: 'stray-pod' }), { is_host: false, is_cohost: false });
      await expect(inviteService.revokeInvite('invite-1', 'user-pod-director', 'member')).rejects.toMatchObject({ statusCode: 404 });
      // Found, then the event's role; the pod's role was never asked, and nothing was written.
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(updates()).toHaveLength(0);
    });

    it('...while the event\'s own host still withdraws it', async () => {
      queue(eventInvite({ inviter_id: 'user-ann', pod_id: 'stray-pod' }), { is_host: true, is_cohost: false });
      lands({ pod_id: 'stray-pod', session_id: 'session-1' });
      await expect(inviteService.revokeInvite('invite-1', 'user-host', 'member')).resolves.toMatchObject({ sessionId: 'session-1' });
    });

    // Fix round 3: the target is the one the invite's TYPE names, not whichever id happens to be set first. An old pod
    // invite that carries a stray event id is the pod's: its director runs it, and that event's host does not.
    it('a pod invite that carries a stray event id is run by its pod: the pod\'s director withdraws it, asked about the pod and not the event', async () => {
      queue(podInvite({ inviter_id: 'user-member', session_id: 'stray-event' }), { role: 'director' });
      lands({ pod_id: 'pod-1', session_id: 'stray-event' });
      await expect(inviteService.revokeInvite('invite-1', 'user-director', 'member')).resolves.toMatchObject({ podId: 'pod-1' });
      expect(roleLookups()).toEqual(["SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'"]);
    });

    it('...and that event\'s host does not: they are only asked about the pod, and it is not found', async () => {
      queue(podInvite({ inviter_id: 'user-member', session_id: 'stray-event' }), { role: 'member' });
      await expect(inviteService.revokeInvite('invite-1', 'user-event-host', 'member')).rejects.toMatchObject({ statusCode: 404 });
      expect(roleLookups()).toEqual(["SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'"]);
      expect(updates()).toHaveLength(0);
    });

    it('an invite whose type names a target it does not carry has no one who runs it but its sender and admins', async () => {
      queue(invite({ type: 'session', inviter_id: 'user-ann', pod_id: 'pod-1' }));
      await expect(inviteService.revokeInvite('invite-1', 'user-director', 'member')).rejects.toMatchObject({ statusCode: 404 });
      expect(roleLookups()).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('an invite that is not pending (answered, withdrawn, or no such invite) is not found', async () => {
      queue(null);
      await expect(inviteService.revokeInvite('invite-1', 'user-ann', 'member')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('an invite accepted or withdrawn between the check and the update is not found either: the update itself only touches a pending one', async () => {
      queue(eventInvite({ inviter_id: 'user-ann' }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.revokeInvite('invite-1', 'user-ann', 'member')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('who runs an event\'s invites, and a pod\'s', () => {
    it('an admin runs any event\'s, with no lookup', async () => {
      await expect(inviteService.eventInviteRole('session-1', 'user-admin', true)).resolves.toBe('admin');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['the host', { is_host: true, is_cohost: false }, 'host'],
      ['a co-host (either role: co_host or moderator)', { is_host: false, is_cohost: true }, 'cohost'],
      ['the host who is also a co-host', { is_host: true, is_cohost: true }, 'host'],
      ['anyone else', { is_host: false, is_cohost: false }, null],
    ])('%s', async (_who, row, expected) => {
      mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      await expect(inviteService.eventInviteRole('session-1', 'user-x', false)).resolves.toBe(expected);
      expect(mockQuery.mock.calls[0][1]).toEqual(['session-1', 'user-x']);
    });

    it('an event that does not exist is run by no one but an admin', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.eventInviteRole('gone', 'user-x', false)).resolves.toBeNull();
    });

    it('a pod\'s invites are run by its director, its host and admins', async () => {
      await expect(inviteService.mayRunPodInvites('pod-1', 'user-admin', true)).resolves.toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
      for (const [role, expected] of [['director', true], ['host', true], ['member', false]] as const) {
        mockQuery.mockResolvedValueOnce({ rows: [{ role }], rowCount: 1 });
        await expect(inviteService.mayRunPodInvites('pod-1', 'user-x', false)).resolves.toBe(expected);
      }
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.mayRunPodInvites('pod-1', 'user-x', false)).resolves.toBe(false);
    });
  });

  // ─── Fix round 1: blocked people and closed accounts are never invited or emailed ─────────────────
  // The batch already left them out. Production's own calls (a typed email, the bulk "Invite All", fed by a pod
  // member list that does not filter blocks) did not. One neutral sentence for every case, so a block is never revealed.
  describe('an address that must not be invited', () => {
    it('is looked up as one question: a closed, suspended or banned account, or a block either way with the sender', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'blocked@example.com' }], rowCount: 1 });
      const found = await inviteService.unreachableAddresses('user-host', ['Blocked@Example.com', 'fine@example.com']);
      expect([...found]).toEqual(['blocked@example.com']);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(flatSql(sql)).toBe(
        "SELECT u.email FROM users u WHERE u.email = ANY($2::text[]) AND (u.status <> 'active' OR EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1)))",
      );
      expect(params).toEqual(['user-host', ['blocked@example.com', 'fine@example.com']]);
    });

    it('asks nothing when there is no address', async () => {
      expect([...(await inviteService.unreachableAddresses('user-host', []))]).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    const POD_INVITE = { type: InviteType.POD, podId: 'pod-123', inviteeEmail: 'guest@example.com', maxUses: 1 } as const;
    /** The queue of a pod invite up to the check, then the answer of the check. */
    const queueUntilTheCheck = (unreachable: boolean) => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: unreachable ? [{ email: 'guest@example.com' }] : [], rowCount: unreachable ? 1 : 0 });
    };
    const nothingWasSent = () => {
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockQuery.mock.calls.some((call) => /INSERT INTO invites|pg_advisory/.test(String(call[0])))).toBe(false);
    };

    it('a pod invite to such an address is refused with 409 and one neutral sentence, and nothing is written or emailed', async () => {
      queueUntilTheCheck(true);
      await expect(inviteService.createInvite('user-host', POD_INVITE)).rejects.toMatchObject({
        statusCode: 409, code: 'INVITE_NOT_PERMITTED', message: "This person can't be invited.",
      });
      nothingWasSent();
    });

    it('an event invite and a circle invite are refused the same way', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 });
      await expect(inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123', inviteeEmail: 'guest@example.com' }))
        .rejects.toMatchObject({ statusCode: 409, message: "This person can't be invited." });
      nothingWasSent();

      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'member@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'circle-1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 });
      await expect(inviteService.createInvite('user-member', { type: InviteType.CIRCLE, circleId: 'circle-1', inviteeEmail: 'guest@example.com' }, 'member'))
        .rejects.toMatchObject({ statusCode: 409, message: "This person can't be invited." });
      nothingWasSent();
    });

    it('an invite by member id is refused too: the address it resolves to is the one checked', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 });
      queueUntilTheCheck(true);
      await expect(inviteService.createInvite('user-host', { type: InviteType.POD, podId: 'pod-123', inviteeUserId: 'user-guest' }))
        .rejects.toMatchObject({ statusCode: 409, message: "This person can't be invited." });
      expect(mockQuery.mock.calls.at(-1)![1]).toEqual(['user-host', ['guest@example.com']]);
    });

    it('someone who may not invite here is refused for that, first: the check never tells them anything about the invitee', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'outsider@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active', allowMemberInvites: false }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.createInvite('user-outsider', POD_INVITE, 'member')).rejects.toMatchObject({ statusCode: 403 });
      expect(mockQuery.mock.calls.some((call) => /user_blocks/.test(String(call[0])))).toBe(false);
    });

    it('a platform invite and an open link look nobody up (a registered address is already turned away, and a link names no one)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 100 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockInvite, type: InviteType.SESSION, inviteeEmail: null }], rowCount: 1 });
      await inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123' });
      expect(mockQuery.mock.calls.some((call) => /user_blocks/.test(String(call[0])))).toBe(false);
    });

    it('someone who is fine is invited as before', async () => {
      queueUntilTheCheck(false);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Test Pod' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.createInvite('user-host', POD_INVITE)).resolves.toEqual(mockInvite);
    });

    it('someone who declined an earlier invite can still be invited by this call: only the batch holds a no against them', async () => {
      const world = inviteWorld({ answers: worldAnswersForPods });
      mockQuery.mockImplementation(world.query);
      mockTransaction.mockImplementation(world.transaction);
      await inviteService.createInvite('user-host', POD_INVITE);
      world.invites[0].status = 'revoked';
      world.invites[0].declinedAt = new Date();
      await inviteService.createInvite('user-host', POD_INVITE);
      expect(world.invites).toHaveLength(2);
    });

    // Against members and blocks that exist (the in-memory stand-in answers "which of these addresses are closed, or
    // blocked either way with the sender"), so each direction of a block is its own case.
    describe('with real members and real blocks', () => {
      const SENDER = 'user-host';
      const people = [
        { id: 'p-fine', email: 'fine@example.com', status: 'active' as const },
        { id: 'p-closed', email: 'closed@example.com', status: 'deactivated' as const },
        { id: 'p-suspended', email: 'suspended@example.com', status: 'suspended' as const },
        { id: 'p-banned', email: 'banned@example.com', status: 'banned' as const },
        { id: 'p-i-blocked', email: 'iblocked@example.com', status: 'active' as const },
        { id: 'p-blocked-me', email: 'blockedme@example.com', status: 'active' as const },
        { id: 'p-others-block', email: 'third@example.com', status: 'active' as const },
      ];
      const blocks: Array<[string, string]> = [[SENDER, 'p-i-blocked'], ['p-blocked-me', SENDER], ['someone-else', 'p-others-block']];
      const refused = [
        ['someone the sender blocked', 'iblocked@example.com'],
        ['someone who blocked the sender', 'blockedme@example.com'],
        ['a closed account', 'closed@example.com'],
        ['a suspended account', 'suspended@example.com'],
        ['a banned account', 'banned@example.com'],
      ];
      const use = (answers: (sql: string) => { rows: unknown[] }) => {
        const world = inviteWorld({ answers, people, blocks });
        mockQuery.mockImplementation(world.query);
        mockTransaction.mockImplementation(world.transaction);
        return world;
      };
      const podInvite = (email: string) => inviteService.createInvite(SENDER, { type: InviteType.POD, podId: 'pod-123', inviteeEmail: email, maxUses: 1 });
      const eventInvite = (email: string) => inviteService.createInvite(SENDER, { type: InviteType.SESSION, sessionId: 'session-123', inviteeEmail: email, maxUses: 1 });

      it.each(refused)('a pod invite to %s is refused (409, one neutral sentence), and nothing is made or emailed', async (_who, email) => {
        const world = use(worldAnswersForPods);
        await expect(podInvite(email)).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_NOT_PERMITTED', message: "This person can't be invited." });
        expect(world.invites).toHaveLength(0);
        expect((emailService.sendInviteEmail as jest.Mock)).not.toHaveBeenCalled();
      });

      it.each(refused)('an event invite to %s is refused the same way (this is also the path of the bulk "Invite All")', async (_who, email) => {
        const world = use(worldAnswersForEvents);
        await expect(eventInvite(email)).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_NOT_PERMITTED', message: "This person can't be invited." });
        expect(world.invites).toHaveLength(0);
      });

      it('the sentence is the same for every reason, so a block is never told apart from a closed account', async () => {
        use(worldAnswersForPods);
        const sentences = new Set<string>();
        for (const [, email] of refused) {
          await podInvite(email).catch((err) => sentences.add(`${err.statusCode} ${err.code} ${err.message}`));
        }
        expect([...sentences]).toEqual(["409 INVITE_NOT_PERMITTED This person can't be invited."]);
      });

      it('a member in good standing, and one blocked only by somebody else, are invited as usual', async () => {
        const world = use(worldAnswersForPods);
        await podInvite('fine@example.com');
        await podInvite('third@example.com');
        expect(world.invites.map((i) => i.email)).toEqual(['fine@example.com', 'third@example.com']);
      });

      it('an address that belongs to no member is invited as usual (they may be about to join)', async () => {
        const world = use(worldAnswersForPods);
        await podInvite('nobody-yet@example.com');
        expect(world.invites).toHaveLength(1);
      });

      it('the block is read for the sender who is asking: the same person is fine for a sender they have no block with', async () => {
        const world = use(worldAnswersForPods);
        await inviteService.createInvite('user-other-director', { type: InviteType.POD, podId: 'pod-123', inviteeEmail: 'iblocked@example.com', maxUses: 1 });
        expect(world.invites).toHaveLength(1);
      });
    });
  });

  // ─── Fix round 1: the lock and the duplicate check follow the invite's own target ─────────────────
  describe('the lock key and the duplicate check use the target that matches the invite\'s type', () => {
    it('an event invite posted with a stray podId is locked and checked as the event\'s invite, not the pod\'s', async () => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // participant
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // unreachable
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // duplicate
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockInvite, type: InviteType.SESSION }], rowCount: 1 });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // the email and the bell

      await inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123', podId: 'stray-pod', inviteeEmail: 'guest@example.com' });

      expect(clientQuery.mock.calls[0][1]).toEqual(['session:session-123:guest@example.com']);
      expect(clientQuery.mock.calls[1][1]).toEqual(['guest@example.com', 'session', null, 'session-123', null]);
    });

    it('a pod invite posted with a stray sessionId is the pod\'s, and a circle invite the circle\'s', async () => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pod-123', name: 'Test', status: 'active' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // already a member?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // unreachable?
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // duplicate
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 }); // INSERT
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });     // the email and the bell
      await inviteService.createInvite('user-host', { type: InviteType.POD, podId: 'pod-123', sessionId: 'stray-session', inviteeEmail: 'guest@example.com' });
      expect(clientQuery.mock.calls[0][1]).toEqual(['pod:pod-123:guest@example.com']);
      expect(clientQuery.mock.calls[1][1]).toEqual(['guest@example.com', 'pod', 'pod-123', null, null]);
    });

    // Fix round 2: the lock and the check used the matching target already; the row itself still stored the stray one,
    // and the pod's director could then withdraw an event invite through it.
    it('an event invite posted with a stray podId is stored as the event\'s alone: no pod behind it', async () => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      mockQuery.mockResolvedValueOnce({ rows: [{ max_invites_per_day: 50 }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'host@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-123', status: 'scheduled', hostUserId: 'user-host' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // participant
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // unreachable
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // duplicate
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockInvite, type: InviteType.SESSION, podId: null, sessionId: 'session-123' }], rowCount: 1 });
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // the email and the bell

      await inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123', podId: 'stray-pod', circleId: 'stray-circle', inviteeEmail: 'guest@example.com' });

      const insert = clientQuery.mock.calls[2];
      expect(flatSql(insert[0])).toMatch(/^INSERT INTO invites \(code, type, inviter_id, invitee_email, pod_id, session_id, max_uses, expires_at, circle_id\)/);
      const values = insert[1] as unknown[];
      expect({ pod: values[4], session: values[5], circle: values[8] }).toEqual({ pod: null, session: 'session-123', circle: null });
    });

    const withEveryId = { podId: 'the-pod', sessionId: 'the-session', circleId: 'the-circle' };
    const stored = (values: unknown[]) => ({ pod: values[4], session: values[5], circle: values[8] });
    const types: Array<[InviteType, { pod: string | null; session: string | null; circle: string | null }]> = [
      [InviteType.POD, { pod: 'the-pod', session: null, circle: null }],
      [InviteType.SESSION, { pod: null, session: 'the-session', circle: null }],
      [InviteType.CIRCLE, { pod: null, session: null, circle: 'the-circle' }],
      [InviteType.PLATFORM, { pod: null, session: null, circle: null }],
    ];

    it.each(types)('a personal %s invite stores the target of its own type and no other', async (type, expected) => {
      const clientQuery = jest.fn((...args: unknown[]) => mockQuery(...args));
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: clientQuery }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // lock
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // duplicate
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });
      await inviteService.insertPendingInvite({
        code: 'C', type, inviterId: 'user-host', inviteeEmail: 'guest@example.com', ...withEveryId, maxUses: 1, expiresAt: null,
      });
      expect(stored(clientQuery.mock.calls[2][1] as unknown[])).toEqual(expected);
    });

    it.each(types)('and so does an open %s link, which is inserted without the lock', async (type, expected) => {
      mockQuery.mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 });
      await inviteService.insertPendingInvite({
        code: 'C', type, inviterId: 'user-host', inviteeEmail: null, ...withEveryId, maxUses: 5, expiresAt: null,
      });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(stored(mockQuery.mock.calls[0][1] as unknown[])).toEqual(expected);
    });

    it('so two requests for one person and one event share a lock whether or not one carries a stray podId: one invite', async () => {
      const world = inviteWorld({ answers: worldAnswersForEvents });
      mockQuery.mockImplementation(world.query);
      mockTransaction.mockImplementation(world.transaction);
      const clean = inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123', inviteeEmail: 'guest@example.com', maxUses: 1 });
      const stray = inviteService.createInvite('user-host', { type: InviteType.SESSION, sessionId: 'session-123', podId: 'stray-pod', inviteeEmail: 'guest@example.com', maxUses: 1 });
      const [a, b] = await Promise.allSettled([clean, stray]);
      expect(world.invites).toHaveLength(1);
      expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
      const refused = [a, b].find((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(refused?.reason).toMatchObject({ code: 'DUPLICATE_INVITE' });
    });
  });

  // ─── 26 Oct 2026: the organiser's lists say who declined ─────────────────────────────────────────
  describe('the invite lists an organiser reads', () => {
    it('listPodInvites returns when each was declined and which member the address belongs to', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'inv-1', code: 'c1', inviteeEmail: 'ann@example.com', inviteeName: 'Ann', inviteeUserId: 'user-ann', status: 'revoked', createdAt: '2026-10-20T10:00:00.000Z', declinedAt: '2026-10-21T08:00:00.000Z' }],
        rowCount: 1,
      });
      const rows = await inviteService.listPodInvites('pod-123', 'revoked');
      const [sql, params] = mockQuery.mock.calls[0];
      expect(flatSql(sql)).toContain('i.declined_at AS "declinedAt"');
      expect(flatSql(sql)).toContain('u.id AS "inviteeUserId"');
      expect(params).toEqual(['pod-123', 'revoked']);
      expect(rows[0]).toMatchObject({ inviteeUserId: 'user-ann', declinedAt: '2026-10-21T08:00:00.000Z' });
    });

    it('listSessionInvites returns them too, and a withdrawn invite has no declinedAt', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'inv-1', code: 'c1', inviteeEmail: 'ann@example.com', inviteeName: 'Ann', inviteeUserId: 'user-ann', status: 'revoked', createdAt: 'x', maxUses: 1, useCount: 0, expiresAt: null, declinedAt: '2026-10-21T08:00:00.000Z' },
          { id: 'inv-2', code: 'c2', inviteeEmail: 'bob@example.com', inviteeName: 'Bob', inviteeUserId: 'user-bob', status: 'revoked', createdAt: 'x', maxUses: 1, useCount: 0, expiresAt: null, declinedAt: null },
        ],
        rowCount: 2,
      });
      const rows = await inviteService.listSessionInvites('session-123');
      const sql = flatSql(mockQuery.mock.calls[0][0]);
      expect(sql).toContain('i.declined_at AS "declinedAt"');
      expect(sql).toContain('u.id AS "inviteeUserId"');
      expect(rows[0].declinedAt).toBe('2026-10-21T08:00:00.000Z');
      expect(rows[1].declinedAt).toBeNull();
    });
  });

  // ─── Fix round 1: the email and the bell are two steps ────────────────────────────────────────────
  // A batch rings the bells while it answers and sends the emails afterwards, one at a time (Resend's default limit
  // is 2 requests a second per team). createInvite still does both, the email first, exactly as before.
  describe('delivering an invite: the email and the bell', () => {
    const context = {
      type: InviteType.POD, podId: 'pod-123', sessionId: null, inviterName: 'Host User', targetName: 'Test Pod', scheduledAt: null,
    };
    const invite = { code: 'ABC123XYZ456', inviteeEmail: 'guest@example.com', inviteeUserId: 'user-guest' };
    const sendInviteEmail = emailService.sendInviteEmail as jest.Mock;

    beforeEach(() => {
      sendInviteEmail.mockReset();
      sendInviteEmail.mockResolvedValue(undefined);
      mockIoEmit.mockReset();
    });

    it('emailInvite sends the email and touches nothing else: no database, no socket', async () => {
      await inviteService.emailInvite(context, invite);
      expect(sendInviteEmail).toHaveBeenCalledTimes(1);
      expect(sendInviteEmail).toHaveBeenCalledWith('guest@example.com', expect.objectContaining({
        inviterName: 'Host User', type: 'pod', targetName: 'Test Pod', inviteUrl: 'http://localhost:5173/invite/ABC123XYZ456',
      }));
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockIoEmit).not.toHaveBeenCalled();
    });

    it('emailInvite lets a failure out, for the caller to log: the invite exists whatever happens to its email', async () => {
      sendInviteEmail.mockRejectedValueOnce(new Error('mail provider is down'));
      await expect(inviteService.emailInvite(context, invite)).rejects.toThrow('mail provider is down');
    });

    // Fix round 4: the mail provider answers a refusal (a bad address, its limit after the retries, an outage) rather than
    // throwing, and a reminder has to know whether its email went. emailInvite passes the mail service's answer on.
    it.each([[true], [false]])('emailInvite says whether the email went, as the mail service answered (sent: %s)', async (sent) => {
      sendInviteEmail.mockResolvedValueOnce({ sent });
      await expect(inviteService.emailInvite(context, invite)).resolves.toEqual({ sent });
    });

    it('notifyInvitee rings the bell of a member known by id: a row, the live push and the lists told, no email, no lookup by address', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notification-1', created_at: '2026-10-26T09:00:00.000Z' }], rowCount: 1 });
      await inviteService.notifyInvitee(context, invite);
      expect(sendInviteEmail).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-guest', 'pod_invite', 'Host User invited you to Test Pod', 'Join Test Pod — invited by Host User', '/invite/ABC123XYZ456']);
      expect(mockIoEmit).toHaveBeenCalledWith('user:user-guest', 'notification:new', expect.objectContaining({ type: 'pod_invite', podId: 'pod-123', inviteStatus: 'pending' }));
      expect(mockIoEmit).toHaveBeenCalledWith('user:user-guest', 'entity:changed', { entities: ['user:user-guest:notifications', 'user:user-guest:invites'] });
    });

    it('notifyInvitee finds a member by address when the id is not known, and does nothing for an address that is no member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await inviteService.notifyInvitee(context, { code: 'C', inviteeEmail: 'Nobody@Example.com' });
      expect(flatSql(mockQuery.mock.calls[0][0])).toBe('SELECT id FROM users WHERE email = $1');
      expect(mockQuery.mock.calls[0][1]).toEqual(['nobody@example.com']);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockIoEmit).not.toHaveBeenCalled();
    });

    it('deliverInvite does both, the email first', async () => {
      const order: string[] = [];
      sendInviteEmail.mockImplementation(async () => { order.push('email'); });
      mockQuery.mockImplementation(async (sql: string) => {
        order.push(/INSERT INTO notifications/.test(sql) ? 'bell' : 'lookup');
        return { rows: [{ id: 'notification-1', created_at: 'x' }], rowCount: 1 };
      });
      await inviteService.deliverInvite(context, invite);
      expect(order).toEqual(['email', 'bell']);
    });

    it('deliverInvite, the first invite\'s path, carries on as before when the email did not go: the bell still rings, and it throws and logs nothing', async () => {
      sendInviteEmail.mockResolvedValueOnce({ sent: false });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'notification-1', created_at: 'x' }], rowCount: 1 });
      await expect(inviteService.deliverInvite(context, invite)).resolves.toBeUndefined();
      expect(mockIoEmit).toHaveBeenCalledWith('user:user-guest', 'notification:new', expect.objectContaining({ type: 'pod_invite' }));
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // ─── Fix round 1: an expired invite is not "pending" in anyone's list ─────────────────────────────
  // A re-invited person showed twice (the dead invite and the live one), and Remind All emailed a dead link.
  // Production's pages ask for ?status=pending (PodDetailPage:177, SessionDetailPage:148) and count with the same rule
  // (getMemberStatusCounts, getSessionParticipantCounts), so the list now agrees with its own count.
  describe('the lists of pending invites', () => {
    const EXPIRY = 'AND (i.expires_at IS NULL OR i.expires_at > NOW())';

    it.each([
      ['an event\'s', () => inviteService.listSessionInvites('session-123', 'pending'), ['session-123', 'pending']],
      ['a pod\'s', () => inviteService.listPodInvites('pod-123', 'pending'), ['pod-123', 'pending']],
    ])('%s leaves out the ones whose expiry has passed', async (_which, list, params) => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await list();
      const [sql, askedWith] = mockQuery.mock.calls[0];
      expect(flatSql(sql)).toContain(EXPIRY);
      expect(askedWith).toEqual(params);
    });

    it.each([
      ['an event\'s revoked ones', () => inviteService.listSessionInvites('session-123', 'revoked')],
      ['an event\'s whole history', () => inviteService.listSessionInvites('session-123')],
      ['a pod\'s revoked ones', () => inviteService.listPodInvites('pod-123', 'revoked')],
      ['a pod\'s whole history', () => inviteService.listPodInvites('pod-123')],
    ])('%s are not filtered by expiry: history is history', async (_which, list) => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await list();
      expect(flatSql(mockQuery.mock.calls[0][0])).not.toContain('expires_at > NOW()');
    });

    it('says who sent each invite, so a co-host\'s view can show their own addresses and hide the rest', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await inviteService.listSessionInvites('session-123', 'pending');
      expect(flatSql(mockQuery.mock.calls[0][0])).toContain('i.inviter_id AS "inviterId"');
    });
  });

  // ─── Fix round 1: a co-host sees addresses only on the invites they sent ───────────────────────────
  // The platform rule is that member lists carry no emails; the host and admins see every address (they could before).
  // The label is never empty and never null: production's page reads `inviteeName || inviteeEmail || 'Shareable link'`
  // and treats a falsy inviteeEmail as an open link, so a hidden personal invite must stay truthy.
  describe('what a co-host sees in place of an address', () => {
    it.each([
      ['anna.smith@example.com', 'a•••@example.com'],
      ['Z@Example.org', 'Z•••@Example.org'],
      ['bob@mail.example.co.uk', 'b•••@mail.example.co.uk'],
    ])('masks %s as %s: the first letter and the domain, nothing else', (address, masked) => {
      expect(inviteService.maskEmail(address)).toBe(masked);
    });

    it.each(['', 'not-an-address', '@example.com'])('shows nothing of %j when it is not an address', (text) => {
      expect(inviteService.maskEmail(text)).toBe('•••');
    });

    const row = (over: Record<string, unknown>) => ({
      id: 'i', code: 'c', inviteeEmail: 'anna.smith@example.com', inviteeName: null, inviteeUserId: null, inviterId: 'user-host',
      status: 'pending', createdAt: 'x', declinedAt: null, maxUses: 1, useCount: 0, expiresAt: null, ...over,
    });

    it('keeps the address on an invite the viewer sent themselves', () => {
      const [mine] = inviteService.hideOthersAddresses([row({ inviterId: 'user-cohost' })], 'user-cohost');
      expect(mine.inviteeEmail).toBe('anna.smith@example.com');
    });

    it('shows a member as their display name, and anyone else as a masked address, on the invites others sent', () => {
      const rows = inviteService.hideOthersAddresses([
        row({ id: 'member', inviteeName: 'Anna Smith', inviteeUserId: 'user-anna' }),
        row({ id: 'guest', inviteeEmail: 'bob@example.com' }),
      ], 'user-cohost');
      expect(rows.map((r) => r.inviteeEmail)).toEqual(['Anna Smith', 'b•••@example.com']);
      // The member's own name field is untouched: a new screen can read it directly.
      expect(rows[0].inviteeName).toBe('Anna Smith');
    });

    it('never leaves a hidden personal invite empty (it would read as an open link), and never an address', () => {
      const rows = inviteService.hideOthersAddresses([
        row({ id: 'a' }), row({ id: 'b', inviteeName: 'Anna Smith' }), row({ id: 'c', inviteeEmail: 'x@y.z' }), row({ id: 'd', inviteeEmail: 'odd' }),
      ], 'user-cohost');
      for (const hidden of rows) {
        expect(typeof hidden.inviteeEmail).toBe('string');
        expect((hidden.inviteeEmail as string).length).toBeGreaterThan(0);
        expect(hidden.inviteeEmail).not.toMatch(/nna\.smith|^bob@|^x@|^odd$/);
      }
    });

    it('leaves open links alone: no address to hide, and they must stay falsy', () => {
      const [link] = inviteService.hideOthersAddresses([row({ inviteeEmail: null })], 'user-cohost');
      expect(link.inviteeEmail).toBeNull();
    });

    // Fix round 2: the code opens the invite, address and all (GET /invites/:code answers a signed-in caller with the
    // whole invite), so a row whose address is hidden must not carry it: with the code a co-host would read every
    // hidden address with one request each.
    it('takes the code away from a hidden row: whoever holds a code can open the invite, address and all', () => {
      const rows = inviteService.hideOthersAddresses([
        row({ id: 'theirs', code: 'SECRET-HOST-CODE' }),
        row({ id: 'member', code: 'SECRET-MEMBER-CODE', inviteeName: 'Anna Smith', inviteeUserId: 'user-anna' }),
        row({ id: 'guest', code: 'SECRET-GUEST-CODE', inviteeEmail: 'bob@example.com' }),
      ], 'user-cohost');
      expect(rows.map((r) => r.code)).toEqual(['', '', '']);
      expect(JSON.stringify(rows)).not.toMatch(/SECRET/);
    });

    it('keeps the code on the invites the viewer sent (their own address stays, and so does the way to resend it) and on an open link (it is the link they share)', () => {
      const rows = inviteService.hideOthersAddresses([
        row({ id: 'mine', inviterId: 'user-cohost', code: 'MY-OWN-CODE' }),
        row({ id: 'link', inviteeEmail: null, code: 'OPEN-LINK-CODE', inviterId: 'user-host' }),
      ], 'user-cohost');
      expect(rows.map((r) => [r.id, r.code, r.inviteeEmail])).toEqual([
        ['mine', 'MY-OWN-CODE', 'anna.smith@example.com'],
        ['link', 'OPEN-LINK-CODE', null],
      ]);
    });

    it('leaves on a hidden row everything the pages work by: the id (remind, withdraw), the state, and who the member is', () => {
      const [hidden] = inviteService.hideOthersAddresses([
        row({ id: 'i-9', code: 'SECRET', status: 'revoked', declinedAt: '2026-10-21T09:00:00.000Z', inviteeUserId: 'user-anna', inviteeName: 'Anna Smith' }),
      ], 'user-cohost');
      expect(hidden).toMatchObject({
        id: 'i-9', status: 'revoked', declinedAt: '2026-10-21T09:00:00.000Z', inviteeUserId: 'user-anna', inviteeName: 'Anna Smith',
        inviterId: 'user-host', maxUses: 1, useCount: 0,
      });
    });
  });

  // 18 Sep 2026 (Shradha): the live-event invite modal reuses the event's open
  // link instead of minting a code on every open, so the host's list must say
  // whether a link is still usable.
  describe('listSessionInvites', () => {
    it('returns the use budget and expiry of every invite so an open link can be reused', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'inv-1', code: 'abc123', inviteeEmail: null, inviteeName: null, status: 'pending',
          createdAt: '2026-09-18T10:00:00.000Z', maxUses: 500, useCount: 3, expiresAt: '2026-09-25T10:00:00.000Z',
        }],
        rowCount: 1,
      });

      const rows = await inviteService.listSessionInvites('session-123', 'pending');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('i.max_uses AS "maxUses"');
      expect(sql).toContain('i.use_count AS "useCount"');
      expect(sql).toContain('i.expires_at AS "expiresAt"');
      expect(params).toEqual(['session-123', 'pending']);
      expect(rows[0]).toMatchObject({ code: 'abc123', inviteeEmail: null, maxUses: 500, useCount: 3 });
    });
  });

  // ─── Fix round 2: who reads the address on an invite found by its code ─────────────────────────────────
  // GET /invites/:code answers every signed-in caller with the whole invite. The code is all it takes to ask, and a
  // co-host (who may not read the others' addresses) was shown the codes of those invites, so the address went to
  // whoever asked. Production's accept page never shows the address, so no one loses a thing on screen.
  describe('who reads the address on an invite found by its code', () => {
    const MASKED = 'a•••@example.com';
    const FULL = 'anna.smith@example.com';
    const eventInvite = (over: Record<string, unknown> = {}) => ({
      type: InviteType.SESSION, inviterId: 'user-cohost', inviteeEmail: FULL, podId: null, sessionId: 'session-1', ...over,
    });
    const podInvite = (over: Record<string, unknown> = {}) => ({
      type: InviteType.POD, inviterId: 'user-member', inviteeEmail: FULL, podId: 'pod-1', sessionId: null, ...over,
    });
    const viewer = (over: Record<string, unknown> = {}) => ({ userId: 'user-viewer', email: 'viewer@example.com', role: 'member', ...over });
    const eventRole = (row: { is_host: boolean; is_cohost: boolean } | null) =>
      mockQuery.mockResolvedValueOnce({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });

    it('an open link names nobody: nothing to show, nothing to ask', async () => {
      await expect(inviteService.inviteeAddressFor(eventInvite({ inviteeEmail: null }), viewer())).resolves.toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each([
      [FULL], ['Anna.Smith@Example.com'], ['  anna.smith@example.com '],
    ])('the invitee reads it whole, however their account\'s address is cased or padded (%j), with nothing looked up', async (accountAddress) => {
      await expect(inviteService.inviteeAddressFor(eventInvite(), viewer({ email: accountAddress }))).resolves.toBe(FULL);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('the person who sent it reads it whole', async () => {
      await expect(inviteService.inviteeAddressFor(eventInvite(), viewer({ userId: 'user-cohost' }))).resolves.toBe(FULL);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each(['admin', 'super_admin'])('a %s reads it whole', async (role) => {
      await expect(inviteService.inviteeAddressFor(podInvite(), viewer({ role }))).resolves.toBe(FULL);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('an event\'s host reads it whole, asked about the event the invite belongs to', async () => {
      eventRole({ is_host: true, is_cohost: false });
      await expect(inviteService.inviteeAddressFor(eventInvite(), viewer({ userId: 'user-host' }))).resolves.toBe(FULL);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['session-1', 'user-host']);
    });

    // The ruling of fix round 1: a co-host reads an address only on the invites they sent themselves.
    it.each([
      ['a co-host of the event, who did not send it', { is_host: false, is_cohost: true }],
      ['an ordinary participant', { is_host: false, is_cohost: false }],
      ['someone with no relation to the event', null],
    ])('%s reads it masked', async (_who, row) => {
      eventRole(row);
      await expect(inviteService.inviteeAddressFor(eventInvite(), viewer())).resolves.toBe(MASKED);
    });

    it.each(['director', 'host'])('a pod\'s %s reads the address on an invite to the pod whole', async (role) => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role }], rowCount: 1 });
      await expect(inviteService.inviteeAddressFor(podInvite(), viewer({ userId: 'user-director' }))).resolves.toBe(FULL);
      expect(mockQuery.mock.calls[0][1]).toEqual(['pod-1', 'user-director']);
    });

    it.each([
      ['an ordinary pod member', [{ role: 'member' }]],
      ['someone who is not in the pod', []],
    ])('%s reads it masked', async (_who, rows) => {
      mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
      await expect(inviteService.inviteeAddressFor(podInvite(), viewer())).resolves.toBe(MASKED);
    });

    it('a platform or circle invite is read whole by its sender, its invitee and admins, and masked by everyone else, with no lookup', async () => {
      for (const type of [InviteType.PLATFORM, InviteType.CIRCLE]) {
        const invite = { type, inviterId: 'user-ann', inviteeEmail: FULL, podId: null, sessionId: null };
        await expect(inviteService.inviteeAddressFor(invite, viewer({ userId: 'user-bob' }))).resolves.toBe(MASKED);
        await expect(inviteService.inviteeAddressFor(invite, viewer({ userId: 'user-ann' }))).resolves.toBe(FULL);
        await expect(inviteService.inviteeAddressFor(invite, viewer({ email: FULL }))).resolves.toBe(FULL);
        await expect(inviteService.inviteeAddressFor(invite, viewer({ role: 'admin' }))).resolves.toBe(FULL);
      }
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('an event invite that carries a stray pod id is judged by its event alone: the pod\'s director is not an organiser of it', async () => {
      eventRole({ is_host: false, is_cohost: false });
      await expect(inviteService.inviteeAddressFor(eventInvite({ podId: 'stray-pod' }), viewer({ userId: 'user-pod-director' }))).resolves.toBe(MASKED);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('a viewer whose own address is not known cannot be the invitee, and is masked', async () => {
      eventRole(null);
      await expect(inviteService.inviteeAddressFor(eventInvite(), viewer({ email: undefined }))).resolves.toBe(MASKED);
    });

    // Fix round 3: the target is the one the invite's TYPE names, not whichever id is set first. An old pod invite that
    // carries a stray event id is the pod's: its director reads it whole, and that event's host does not.
    it('a pod invite that carries a stray event id is judged by its pod: the pod\'s director reads it whole, asked about the pod and not the event', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      await expect(inviteService.inviteeAddressFor(podInvite({ sessionId: 'stray-event' }), viewer({ userId: 'user-director' }))).resolves.toBe(FULL);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(flatSql(mockQuery.mock.calls[0][0])).toBe("SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'");
      expect(mockQuery.mock.calls[0][1]).toEqual(['pod-1', 'user-director']);
    });

    it('...and the host of that stray event reads it masked: they are only asked about the pod', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 });
      await expect(inviteService.inviteeAddressFor(podInvite({ sessionId: 'stray-event' }), viewer({ userId: 'user-event-host' }))).resolves.toBe(MASKED);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(flatSql(mockQuery.mock.calls[0][0])).not.toMatch(/is_host/);
    });

    it('an invite whose type names a target it does not carry has no organiser: only the sender, the invitee and admins read it whole, with no lookup', async () => {
      await expect(inviteService.inviteeAddressFor(eventInvite({ sessionId: null, podId: 'pod-1' }), viewer({ userId: 'user-director' }))).resolves.toBe(MASKED);
      await expect(inviteService.inviteeAddressFor(podInvite({ podId: null, sessionId: 'session-1' }), viewer({ userId: 'user-host' }))).resolves.toBe(MASKED);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvite: signed in as another account than the one invited', () => {
    const asStranger = () => {
      mockTransaction.mockImplementation(async (cb: Function) => cb({ query: jest.fn().mockResolvedValueOnce({ rows: [mockInvite], rowCount: 1 }) }));
      return inviteService.acceptInvite('ABC123XYZ', 'user-other', 'other@example.com');
    };

    it('is refused with a 403 IDENTITY_MISMATCH', async () => {
      await expect(asStranger()).rejects.toMatchObject({ statusCode: 403, code: 'IDENTITY_MISMATCH' });
    });

    // The accept page shows this sentence as it is. Whole, it gave the address to anybody signed in who had the code:
    // the same hole as GET /invites/:code, through the other door. It still says whom the invite is for.
    it('says whom the invite is for with the address masked, and never whole', async () => {
      const refused = await asStranger().then(() => null, (err: Error) => err);
      expect(refused?.message).toBe("This invite was sent to g•••@example.com, but you're logged in as other@example.com. Sign in to the right account to accept.");
      expect(refused?.message).not.toContain('guest@example.com');
    });
  });

  // ─── Fix round 2: mark-accepted ────────────────────────────────────────────────────────────────────────
  // It checked neither who was asking nor the invite's state, so anyone signed in who knew a code could flip a withdrawn
  // or declined invite back to accepted (which the accept flow then admits again) and overwrite who accepted it. Nothing
  // in the client calls it since T0-4 dropped its recovery chain; the rules are the ones acceptInvite applies.
  describe('markInviteAccepted', () => {
    const pending = (over: Record<string, unknown> = {}) => ({ ...mockInvite, ...over });
    const found = (invite: Record<string, unknown> | null) => mockQuery.mockResolvedValueOnce({ rows: invite ? [invite] : [], rowCount: invite ? 1 : 0 });
    const writes = () => mockQuery.mock.calls.filter((call) => /^UPDATE invites/.test(flatSql(call[0])));
    // `null` is a caller whose address is not known (the default argument would turn `undefined` into the invitee's).
    const mark = (email: string | null = 'guest@example.com', userId = 'user-guest') => inviteService.markInviteAccepted('ABC123XYZ', userId, email ?? undefined);

    it('marks a pending invite accepted for the invitee, keeping the first accepter and the first time, and says which pod or event it was for', async () => {
      found(pending({ podId: 'pod-123', sessionId: null }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await expect(mark()).resolves.toEqual({ podId: 'pod-123', sessionId: null });
      expect(flatSql(mockQuery.mock.calls[0][0])).toMatch(/^SELECT id, code, type, .* FROM invites WHERE code = \$1 FOR UPDATE$/);
      expect(mockQuery.mock.calls[0][1]).toEqual(['ABC123XYZ']);
      expect(writes()).toHaveLength(1);
      expect(flatSql(writes()[0][0])).toBe(
        "UPDATE invites SET status = 'accepted', accepted_by_user_id = COALESCE(accepted_by_user_id, $1), accepted_at = COALESCE(accepted_at, NOW()) WHERE id = $2");
      expect(writes()[0][1]).toEqual(['user-guest', 'invite-123']);
    });

    it('looks the invite up and writes in ONE transaction, with the row locked, so the checks cannot go stale before the write', async () => {
      found(pending());
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await mark();
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it.each([['the same address in capitals', 'GUEST@EXAMPLE.COM'], ['with spaces round it', '  guest@example.com ']])('knows the invitee by the address of their account, %s', async (_how, address) => {
      found(pending());
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await expect(mark(address)).resolves.toBeDefined();
      expect(writes()).toHaveLength(1);
    });

    it('an open link names nobody, so any signed-in member can mark it, whatever address they have', async () => {
      found(pending({ inviteeEmail: null, maxUses: 500, useCount: 3, status: InviteStatus.ACCEPTED, acceptedByUserId: 'someone-else' }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await expect(mark('whoever@example.org', 'user-any')).resolves.toBeDefined();
    });

    it('an invite that does not exist is not found', async () => {
      found(null);
      await expect(mark()).rejects.toMatchObject({ statusCode: 404 });
      expect(writes()).toHaveLength(0);
    });

    // The state ─────────────────────────────────────────────────────────────────────────────────────
    it('refuses a withdrawn invite, or one the invitee declined (both are revoked), and does not bring it back', async () => {
      found(pending({ status: InviteStatus.REVOKED }));
      await expect(mark()).rejects.toMatchObject({ statusCode: 400, code: 'INVITE_REVOKED' });
      found(pending({ status: InviteStatus.REVOKED, declinedAt: new Date() }));
      await expect(mark()).rejects.toMatchObject({ statusCode: 400, code: 'INVITE_REVOKED' });
      expect(writes()).toHaveLength(0);
    });

    it('refuses an expired invite, by its status or because its date has passed', async () => {
      found(pending({ status: InviteStatus.EXPIRED }));
      await expect(mark()).rejects.toMatchObject({ statusCode: 400, code: 'INVITE_EXPIRED' });
      found(pending({ expiresAt: new Date(Date.now() - 60_000) }));
      await expect(mark()).rejects.toMatchObject({ statusCode: 400, code: 'INVITE_EXPIRED' });
      expect(writes()).toHaveLength(0);
    });

    it('refuses an invite someone else used up, and does not take over who accepted it', async () => {
      found(pending({ status: InviteStatus.ACCEPTED, useCount: 1, maxUses: 1, acceptedByUserId: 'user-first' }));
      await expect(mark('guest@example.com', 'user-late')).rejects.toMatchObject({ statusCode: 400, code: 'INVITE_ALREADY_USED' });
      expect(writes()).toHaveLength(0);
    });

    it('lets the person who used it up mark it again: the same answer, nothing new recorded', async () => {
      found(pending({ status: InviteStatus.ACCEPTED, useCount: 1, maxUses: 1, acceptedByUserId: 'user-guest' }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await expect(mark()).resolves.toBeDefined();
    });

    it('an accepted link with uses left is still a live invite, as it is for the accept flow', async () => {
      found(pending({ inviteeEmail: null, status: InviteStatus.ACCEPTED, useCount: 2, maxUses: 10, acceptedByUserId: 'user-first' }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await expect(mark('x@example.org', 'user-other')).resolves.toBeDefined();
    });

    // The caller ────────────────────────────────────────────────────────────────────────────────────
    it('refuses a personal invite to a caller whose account has another address: 403, the invite is named masked, nothing is written', async () => {
      found(pending());
      const refused = await mark('stranger@example.org', 'user-stranger').then(() => null, (err: Error & { statusCode?: number; code?: string }) => err);
      expect(refused).toMatchObject({ statusCode: 403, code: 'IDENTITY_MISMATCH' });
      expect(refused?.message).toContain('g•••@example.com');
      expect(refused?.message).not.toContain('guest@example.com');
      expect(writes()).toHaveLength(0);
    });

    it('fails closed when the caller\'s address is not known: a personal invite is not marked for someone who cannot be shown to be its invitee', async () => {
      found(pending());
      await expect(mark(null)).rejects.toMatchObject({ statusCode: 403, code: 'IDENTITY_MISMATCH' });
      found(pending());
      await expect(mark('')).rejects.toMatchObject({ statusCode: 403, code: 'IDENTITY_MISMATCH' });
      expect(writes()).toHaveLength(0);
    });

    it('is not stricter than the accept flow about who the invitee is: whoever acceptInvite admits, this admits', async () => {
      // acceptInvite compares the trimmed, lower-cased addresses and nothing else; so does this.
      found(pending({ inviteeEmail: 'Guest@Example.com ' }));
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await expect(mark('guest@example.com')).resolves.toBeDefined();
    });

    // Fix round 3: acceptInvite also refuses an invite to an event that has ended (400 EVENT_ENDED), after the expiry
    // checks and before the identity check. Round 2 said "the same checks, in the same order" and left this one out.
    describe('an invite to an event that has ended', () => {
      const eventInvite = (over: Record<string, unknown> = {}) => pending({ type: InviteType.SESSION, sessionId: 'session-1', podId: null, ...over });
      const eventIs = (status: string) => mockQuery.mockResolvedValueOnce({ rows: [{ status }], rowCount: 1 });

      it.each(['completed', 'cancelled'])('is refused when the event is %s (400 EVENT_ENDED), as accept refuses it, and nothing is written', async (status) => {
        found(eventInvite());
        eventIs(status);
        await expect(mark()).rejects.toMatchObject({ statusCode: 400, code: 'EVENT_ENDED', message: 'This event has already ended' });
        expect(writes()).toHaveLength(0);
        expect(flatSql(mockQuery.mock.calls[1][0])).toBe('SELECT status FROM sessions WHERE id = $1');
        expect(mockQuery.mock.calls[1][1]).toEqual(['session-1']);
      });

      it('is refused for an open link to a finished event too', async () => {
        found(eventInvite({ inviteeEmail: null }));
        eventIs('completed');
        await expect(mark('whoever@example.org', 'user-any')).rejects.toMatchObject({ code: 'EVENT_ENDED' });
        expect(writes()).toHaveLength(0);
      });

      it('is refused before the identity check, in accept\'s order: a stranger holding the code is told the event has ended, not whom it was for', async () => {
        found(eventInvite());
        eventIs('cancelled');
        await expect(mark('stranger@example.org', 'user-stranger')).rejects.toMatchObject({ statusCode: 400, code: 'EVENT_ENDED' });
      });

      it('an event that has not ended is marked as before, and the event is looked up once', async () => {
        found(eventInvite());
        eventIs('scheduled');
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await expect(mark()).resolves.toEqual({ podId: null, sessionId: 'session-1' });
        expect(mockQuery).toHaveBeenCalledTimes(3);
        expect(writes()).toHaveLength(1);
      });

      it('a pod invite asks nothing about any event: the invite and the update are the only two statements', async () => {
        found(pending({ sessionId: 'stray-event' }));
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await expect(mark()).resolves.toBeDefined();
        expect(mockQuery).toHaveBeenCalledTimes(2);
      });

      it('an invite withdrawn or expired for a finished event is told so first, as accept does (the state before the event)', async () => {
        found(eventInvite({ status: InviteStatus.REVOKED }));
        await expect(mark()).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
        expect(mockQuery).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ─── Fix round 2: an email waiting its turn is read again before it is sent ───────────────────────────
  describe('isStillEmailable: whether a batch invite still goes out as an email', () => {
    it('is true while the invite is pending and has time left, and its address is one the sender may email', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ invitee_email: 'guest@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.isStillEmailable('invite-1', 'user-host')).resolves.toBe(true);
      expect(flatSql(mockQuery.mock.calls[0][0])).toBe(
        "SELECT invitee_email FROM invites WHERE id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())");
      expect(mockQuery.mock.calls[0][1]).toEqual(['invite-1']);
      expect(mockQuery.mock.calls[1][1]).toEqual(['user-host', ['guest@example.com']]);
    });

    it('is false once the invite is not pending (withdrawn, declined, accepted or expired), without asking about the address', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(inviteService.isStillEmailable('invite-1', 'user-host')).resolves.toBe(false);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('is false once the sender and the invitee are blocked either way, or the account was closed: the question createInvite asks', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ invitee_email: 'guest@example.com' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [{ email: 'guest@example.com' }], rowCount: 1 });
      await expect(inviteService.isStillEmailable('invite-1', 'user-host')).resolves.toBe(false);
    });

    it('an invite with no address is never emailed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ invitee_email: null }], rowCount: 1 });
      await expect(inviteService.isStillEmailable('invite-1', 'user-host')).resolves.toBe(false);
    });

    it('lets a failure out (the caller decides what a question it could not answer means)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('database hiccup'));
      await expect(inviteService.isStillEmailable('invite-1', 'user-host')).rejects.toThrow('database hiccup');
    });
  });
});
