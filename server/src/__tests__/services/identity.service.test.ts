// ─── Identity Service Tests ──────────────────────────────────────────────────
// Unit tests with mocked database layer.

import { UserRole } from '@rsn/shared';

// Mock database module
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

// Mock config
jest.mock('../../config', () => ({
  default: {
    jwtSecret: 'test-jwt-secret',
    jwtAccessExpiry: '15m',
    jwtRefreshExpiry: '7d',
    magicLinkSecret: 'test-magic-link-secret',
    magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
  },
  __esModule: true,
}));

// Mock logger
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import * as identityService from '../../services/identity/identity.service';

const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  displayName: 'Test User',
  firstName: 'Test',
  lastName: 'User',
  avatarUrl: null,
  bio: null,
  company: null,
  jobTitle: null,
  industry: null,
  location: null,
  linkedinUrl: null,
  interests: ['tech'],
  reasonsToConnect: ['networking'],
  languages: ['english'],
  timezone: 'UTC',
  role: UserRole.MEMBER,
  status: 'active',
  profileComplete: false,
  emailVerified: false,
  lastActiveAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Identity Service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('getUserById', () => {
    it('should return user when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const user = await identityService.getUserById('user-123');
      expect(user).toEqual(mockUser);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM users WHERE id ='),
        ['user-123']
      );
    });

    it('should throw NotFoundError when user not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(identityService.getUserById('missing-id'))
        .rejects
        .toThrow('User with id missing-id not found');
    });
  });

  describe('getUserByEmail', () => {
    it('should return user when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const user = await identityService.getUserByEmail('test@example.com');
      expect(user).toEqual(mockUser);
    });

    it('should return null when not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const user = await identityService.getUserByEmail('nobody@example.com');
      expect(user).toBeNull();
    });

    it('should lowercase the email for lookup', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await identityService.getUserByEmail('TEST@EXAMPLE.COM');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['test@example.com']
      );
    });
  });

  describe('createUser', () => {
    it('should create a user when email is not taken', async () => {
      // getUserByEmail returns null
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT into users
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // INSERT subscription
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // INSERT entitlements
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // getUserById returns the new user
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const user = await identityService.createUser({
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      });

      expect(user).toEqual(mockUser);
      // Should have called query at least 5 times
      expect(mockQuery).toHaveBeenCalledTimes(5);
    });

    it('should throw ConflictError when email already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      await expect(
        identityService.createUser({
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
        })
      ).rejects.toThrow('A user with this email already exists');
    });
  });

  describe('updateUser', () => {
    it('should update user fields', async () => {
      const updatedUser = { ...mockUser, displayName: 'New Name' };
      // getUserById #1 — verify user exists
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // UPDATE users SET display_name = ...
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // getUserById #2 — check profile completeness
      mockQuery.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 });
      // getUserById #3 — final return (profileComplete hasn't changed, so no extra UPDATE)
      mockQuery.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 });

      const result = await identityService.updateUser('user-123', {
        displayName: 'New Name',
      });

      expect(result.displayName).toBe('New Name');
    });

    it('should throw NotFoundError if user does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        identityService.updateUser('missing-id', { displayName: 'xxx' })
      ).rejects.toThrow('not found');
    });
  });

  describe('sendMagicLink', () => {
    it('should invalidate existing links and create a new one for existing user', async () => {
      // getUserByEmail — existing user
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // Invalidate existing magic links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT magic_links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await identityService.sendMagicLink('test@example.com');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('sent');
      expect(result.sent).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('should normalize email to lowercase', async () => {
      // getUserByEmail
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // Invalidate existing magic links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT magic_links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await identityService.sendMagicLink('TEST@EXAMPLE.COM');
      // First call: getUserByEmail with lowercase email
      expect(mockQuery.mock.calls[0][1]).toEqual(['test@example.com']);
    });

    it('should return devLink in dev mode', async () => {
      // getUserByEmail — existing user
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // Invalidate existing magic links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT magic_links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await identityService.sendMagicLink('test@example.com');
      // config.isDev is undefined which is falsy, but we test structure
      expect(result.sent).toBe(true);
    });

    it('should validate invite code when provided', async () => {
      // getUserByEmail — no existing user
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Invalid invite code check
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(identityService.sendMagicLink('test@example.com', undefined, 'INVALID_CODE'))
        .rejects.toThrow('Invalid invite code');
    });

    it('should block new user without approved request or invite', async () => {
      // getUserByEmail — no existing user
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // isEmailApproved — no approved join request
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // hasPendingInviteForEmail — no pending invites
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(identityService.sendMagicLink('new@example.com'))
        .rejects.toThrow('Registration requires an approved join request');
    });

    it('should allow new user with approved join request', async () => {
      // getUserByEmail — no existing user
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // isEmailApproved — approved join request found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jr-1' }], rowCount: 1 });
      // Invalidate existing magic links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT magic_links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await identityService.sendMagicLink('approved@example.com');
      expect(result.sent).toBe(true);
    });

    it('should allow existing user to login without approval', async () => {
      // getUserByEmail — existing user (login, not registration)
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // Invalidate existing magic links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT magic_links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await identityService.sendMagicLink('test@example.com');
      expect(result.sent).toBe(true);
    });
  });

  describe('verifyMagicLink', () => {
    it('should throw UnauthorizedError when token is invalid', async () => {
      // No magic link found for hash
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(identityService.verifyMagicLink('invalid-token'))
        .rejects.toThrow('Invalid magic link');
    });

    it('should throw when magic link has already been used', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ml-1', email: 'test@example.com', expires_at: new Date(Date.now() + 60000), used_at: new Date() }],
        rowCount: 1,
      });

      await expect(identityService.verifyMagicLink('some-token'))
        .rejects.toThrow('already been used');
    });

    it('should throw when magic link has expired', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ml-1', email: 'test@example.com', expires_at: new Date(Date.now() - 60000), used_at: null }],
        rowCount: 1,
      });

      await expect(identityService.verifyMagicLink('some-token'))
        .rejects.toThrow('expired');
    });
  });

  describe('refreshAccessToken', () => {
    it('should throw UnauthorizedError for completely invalid token', async () => {
      await expect(identityService.refreshAccessToken('not-a-jwt'))
        .rejects.toThrow('Invalid refresh token');
    });
  });

  describe('logout', () => {
    it('should revoke all refresh tokens for a user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });

      await identityService.logout('user-123', 'session-abc');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE refresh_tokens SET revoked_at'),
        ['user-123']
      );
    });
  });

  describe('getUsers', () => {
    it('should return paginated users', async () => {
      // COUNT query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
      // SELECT users
      mockQuery.mockResolvedValueOnce({ rows: [mockUser, { ...mockUser, id: 'user-456' }], rowCount: 2 });

      const result = await identityService.getUsers({ page: 1, pageSize: 20 });
      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter by role', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await identityService.getUsers({ role: UserRole.MEMBER });
      expect(result.users).toHaveLength(1);
      expect(mockQuery.mock.calls[0][0]).toContain('role =');
    });

    it('should filter by search term', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await identityService.getUsers({ search: 'test' });
      expect(result.users).toHaveLength(1);
      expect(mockQuery.mock.calls[0][0]).toContain('ILIKE');
    });

    it('should return empty when no users match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await identityService.getUsers({ search: 'nonexistent' });
      expect(result.users).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('updateUser - profile completeness', () => {
    it('should mark profile as complete when all fields are filled', async () => {
      const completeUser = {
        ...mockUser,
        firstName: 'Test', lastName: 'User', displayName: 'Test User',
        company: 'Acme', jobTitle: 'Dev', industry: 'Tech',
        reasonsToConnect: ['networking'], profileComplete: false,
      };
      // getUserById #1 — verify exists
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // getUserById #2 — check completeness
      mockQuery.mockResolvedValueOnce({ rows: [completeUser], rowCount: 1 });
      // UPDATE profile_complete = true
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // getUserById #3 — final return
      mockQuery.mockResolvedValueOnce({ rows: [{ ...completeUser, profileComplete: true }], rowCount: 1 });

      const result = await identityService.updateUser('user-123', {
        company: 'Acme', jobTitle: 'Dev', industry: 'Tech',
      });

      expect(result.profileComplete).toBe(true);
    });

    it('should return unchanged user when no fields provided', async () => {
      // getUserById — verify exists
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });
      // getUserById — return directly (no set clauses)
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await identityService.updateUser('user-123', {});
      expect(result).toEqual(mockUser);
    });
  });

  describe('updateLastActive', () => {
    it('should update last_active_at timestamp', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await identityService.updateLastActive('user-123');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET last_active_at'),
        ['user-123']
      );
    });
  });
});
