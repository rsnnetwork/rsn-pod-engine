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
    it('should invalidate existing links and create a new one', async () => {
      // Invalidate existing magic links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT magic_links
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await identityService.sendMagicLink('test@example.com');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('sent');
      expect(result.sent).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });
});
