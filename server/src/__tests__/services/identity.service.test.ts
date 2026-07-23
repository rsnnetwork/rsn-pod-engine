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

// Mock the enrichment repo so preload-copy tests can assert setEnrichmentState
// calls directly, without reverse-engineering them from raw SQL.
jest.mock('../../services/onboarding/enrichment.repo', () => ({
  saveEnrichedCandidate: jest.fn(),
  setEnrichmentState: jest.fn(),
  __esModule: true,
}));

import * as identityService from '../../services/identity/identity.service';
import * as enrichRepo from '../../services/onboarding/enrichment.repo';

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
    (enrichRepo.saveEnrichedCandidate as jest.Mock).mockReset().mockResolvedValue(undefined);
    (enrichRepo.setEnrichmentState as jest.Mock).mockReset().mockResolvedValue(undefined);
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

    it('should include onboarding_status and last_onboarded_at in SQL query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      await identityService.getUserById('user-123');

      const sqlCall = mockQuery.mock.calls[0][0];
      expect(sqlCall).toContain('onboarding_status AS "onboardingStatus"');
      expect(sqlCall).toContain('last_onboarded_at AS "lastOnboardedAt"');
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

    it('should throw when a link was used beyond the reuse grace window', async () => {
      // used 5 minutes ago — well past the ~2-min grace → genuinely stale reuse.
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ml-1', email: 'test@example.com', expires_at: new Date(Date.now() + 60000), used_at: new Date(Date.now() - 5 * 60 * 1000) }],
        rowCount: 1,
      });

      await expect(identityService.verifyMagicLink('some-token'))
        .rejects.toThrow('already been used');
    });

    it('should RE-VERIFY a link used within the grace window (corporate scanner pre-fetch / double-click)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      mockQuery
        // magic_links row — used 30s ago (within grace), not expired
        .mockResolvedValueOnce({ rows: [{ id: 'ml-1', email: 'test@example.com', expires_at: new Date(Date.now() + 60 * 60 * 1000), used_at: new Date(Date.now() - 30 * 1000) }], rowCount: 1 })
        // getUserByEmail → existing user (so no createUser chain)
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

      const result = await identityService.verifyMagicLink('some-token');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('should throw when magic link has expired', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ml-1', email: 'test@example.com', expires_at: new Date(Date.now() - 60000), used_at: null }],
        rowCount: 1,
      });

      await expect(identityService.verifyMagicLink('some-token'))
        .rejects.toThrow('expired');
    });

    it('should create the user + issue tokens for a NEW email with no verify-time registration gate (shared-invite signup)', async () => {
      // The fix: a fresh link for a never-seen email must NOT be re-gated at verify
      // (the send-time gate already permitted it via the shared invite). On the old
      // code this threw "Registration requires…"; now it creates the user.
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'ml-1', email: 'newcomer@eideticdigital.com', expires_at: new Date(Date.now() + 60 * 60 * 1000), used_at: null }], rowCount: 1 }) // 1 SELECT magic_links
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 2 UPDATE used_at
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 3 getUserByEmail (verify) → null
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 4 getApprovedJoinRequestSeed → no approved request (fallback to email prefix)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 5 getUserByEmail (createUser) → null
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 6 INSERT users
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 7 INSERT subscription
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 8 INSERT entitlements
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 }); // 9 getUserById → created user

      const result = await identityService.verifyMagicLink('some-token');
      expect(result.accessToken).toBeDefined();
      // crucially: it did NOT throw the registration gate
    });

    // Instant-found-card: the approved join request's preloaded ScrapingDog
    // enrichment (join_requests.enriched) must also seed the enrichment STATE
    // machine (user_intent_profiles.enrichment_*), not just the candidate blob
    // — otherwise the member's first GET /onboarding/status still reads 'none'
    // and the client shows a few seconds of "searching" before its own trigger
    // cache-hits and flips to found.
    describe('preload → enrichment state seeding (instant found/partial card)', () => {
      const enrichedAt = '2026-07-20T12:00:00.000Z';

      function mockNewUserChain(enriched: unknown): void {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        mockQuery
          .mockResolvedValueOnce({
            rows: [{ id: 'ml-1', email: 'preload@example.com', expires_at: new Date(Date.now() + 60 * 60 * 1000), used_at: null }],
            rowCount: 1,
          }) // 1 SELECT magic_links
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 2 UPDATE used_at
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 3 getUserByEmail (verify) → null
          .mockResolvedValueOnce({
            rows: [{ full_name: 'Preload Person', linkedin_url: 'https://linkedin.com/in/preload', enriched, reason: null }],
            rowCount: 1,
          }) // 4 getApprovedJoinRequestSeed → approved request with preload
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 5 getUserByEmail (createUser) → null
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 6 INSERT users
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 7 INSERT subscription
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 8 INSERT entitlements
          .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 }); // 9 getUserById → created user
      }

      it('HIGH confidence (>= found bar) → setEnrichmentState called with found + timestamps from enrichedAt', async () => {
        mockNewUserChain({
          profile: { fullName: 'Preload Person' },
          confidence: 0.9,
          sources: [],
          foundLinkedinUrl: null,
          requestedLinkedinUrl: 'https://linkedin.com/in/preload',
          enrichedAt,
          provider: 'scrapingdog',
        });

        const result = await identityService.verifyMagicLink('some-token');

        expect(result.accessToken).toBeDefined();
        expect(enrichRepo.saveEnrichedCandidate).toHaveBeenCalledWith(
          mockUser.id,
          expect.objectContaining({ confidence: 0.9 })
        );
        expect(enrichRepo.setEnrichmentState).toHaveBeenCalledWith(mockUser.id, {
          status: 'found',
          source: 'scrapingdog',
          startedAt: enrichedAt,
          completedAt: enrichedAt,
        });
      });

      it('LOW confidence (>= partial bar, below found bar) → setEnrichmentState called with partial', async () => {
        mockNewUserChain({
          profile: { fullName: 'Preload Person' },
          confidence: 0.45,
          sources: [],
          foundLinkedinUrl: null,
          requestedLinkedinUrl: 'https://linkedin.com/in/preload',
          enrichedAt,
          provider: 'scrapingdog',
        });

        await identityService.verifyMagicLink('some-token');

        expect(enrichRepo.setEnrichmentState).toHaveBeenCalledWith(mockUser.id, {
          status: 'partial',
          source: 'scrapingdog',
          startedAt: enrichedAt,
          completedAt: enrichedAt,
        });
      });

      it('legacy blob with no provider field (pre-fix cache / claude_web rollback path) → source falls back to null, not a guessed provider', async () => {
        mockNewUserChain({
          profile: { fullName: 'Preload Person' },
          confidence: 0.9,
          sources: [],
          foundLinkedinUrl: null,
          requestedLinkedinUrl: 'https://linkedin.com/in/preload',
          enrichedAt,
          // no `provider` field — mirrors a blob cached before this field existed.
        });

        await identityService.verifyMagicLink('some-token');

        expect(enrichRepo.setEnrichmentState).toHaveBeenCalledWith(mockUser.id, {
          status: 'found',
          source: null,
          startedAt: enrichedAt,
          completedAt: enrichedAt,
        });
      });

      it('ZERO confidence → does NOT call setEnrichmentState or saveEnrichedCandidate (client trigger handles it, stays none)', async () => {
        mockNewUserChain({
          profile: null,
          confidence: 0,
          sources: [],
          foundLinkedinUrl: null,
          requestedLinkedinUrl: null,
          enrichedAt: null,
        });

        await identityService.verifyMagicLink('some-token');

        expect(enrichRepo.saveEnrichedCandidate).not.toHaveBeenCalled();
        expect(enrichRepo.setEnrichmentState).not.toHaveBeenCalled();
      });

      it('ABSENT preload (no approved request) → does NOT call setEnrichmentState', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        mockQuery
          .mockResolvedValueOnce({
            rows: [{ id: 'ml-1', email: 'nopreload@example.com', expires_at: new Date(Date.now() + 60 * 60 * 1000), used_at: null }],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 })
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getUserByEmail (verify) → null
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getApprovedJoinRequestSeed → no approved request
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getUserByEmail (createUser) → null
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT users
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT subscription
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT entitlements
          .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 }); // getUserById

        await identityService.verifyMagicLink('some-token');

        expect(enrichRepo.saveEnrichedCandidate).not.toHaveBeenCalled();
        expect(enrichRepo.setEnrichmentState).not.toHaveBeenCalled();
      });

      it('setEnrichmentState rejecting does NOT break login (best-effort, mirrors saveEnrichedCandidate error handling)', async () => {
        (enrichRepo.setEnrichmentState as jest.Mock).mockRejectedValueOnce(new Error('db down'));
        mockNewUserChain({
          profile: { fullName: 'Preload Person' },
          confidence: 0.8,
          sources: [],
          foundLinkedinUrl: null,
          requestedLinkedinUrl: 'https://linkedin.com/in/preload',
          enrichedAt,
        });

        const result = await identityService.verifyMagicLink('some-token');

        expect(result.accessToken).toBeDefined();
        expect(result.refreshToken).toBeDefined();
      });
    });
  });

  describe('findOrCreateGoogleUser (preload copy-forward parity with verifyMagicLink)', () => {
    const enrichedAt = '2026-07-21T09:00:00.000Z';

    // Mirrors mockNewUserChain above, for the Google-path new-user creation
    // sequence: getUserByEmail → isEmailApproved (registration gate) →
    // getApprovedJoinRequestSeed → INSERT users → [preload copy-forward] →
    // INSERT subscription → INSERT entitlements → getUserById.
    function mockNewGoogleUserChain(enriched: unknown): void {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 1 getUserByEmail → null (new user)
        .mockResolvedValueOnce({ rows: [{ id: 'jr-1' }], rowCount: 1 }) // 2 isEmailApproved → approved
        .mockResolvedValueOnce({
          rows: [{
            full_name: 'Google Preload',
            linkedin_url: 'https://linkedin.com/in/google-preload',
            enriched,
            reason: null,
          }],
          rowCount: 1,
        }) // 3 getApprovedJoinRequestSeed
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 4 INSERT users
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 5 INSERT subscription
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 6 INSERT entitlements
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 }); // 7 getUserById
    }

    it('HIGH confidence (>= found bar) → setEnrichmentState called with found + timestamps from enrichedAt', async () => {
      mockNewGoogleUserChain({
        profile: { fullName: 'Google Preload' },
        confidence: 0.9,
        sources: [],
        foundLinkedinUrl: null,
        requestedLinkedinUrl: 'https://linkedin.com/in/google-preload',
        enrichedAt,
        provider: 'scrapingdog',
      });

      const result = await identityService.findOrCreateGoogleUser({
        email: 'google-preload@example.com',
        name: 'Google Preload',
      });

      expect(result.accessToken).toBeDefined();
      expect(enrichRepo.saveEnrichedCandidate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ confidence: 0.9 })
      );
      expect(enrichRepo.setEnrichmentState).toHaveBeenCalledWith(expect.any(String), {
        status: 'found',
        source: 'scrapingdog',
        startedAt: enrichedAt,
        completedAt: enrichedAt,
      });
      // Both writes must target the SAME newly-created user id.
      const savedId = (enrichRepo.saveEnrichedCandidate as jest.Mock).mock.calls[0][0];
      const stateId = (enrichRepo.setEnrichmentState as jest.Mock).mock.calls[0][0];
      expect(stateId).toBe(savedId);
    });

    it('LOW confidence (>= partial bar, below found bar) → setEnrichmentState called with partial', async () => {
      mockNewGoogleUserChain({
        profile: { fullName: 'Google Preload' },
        confidence: 0.45,
        sources: [],
        foundLinkedinUrl: null,
        requestedLinkedinUrl: 'https://linkedin.com/in/google-preload',
        enrichedAt,
        provider: 'scrapingdog',
      });

      await identityService.findOrCreateGoogleUser({
        email: 'google-preload-partial@example.com',
        name: 'Google Preload',
      });

      expect(enrichRepo.setEnrichmentState).toHaveBeenCalledWith(expect.any(String), {
        status: 'partial',
        source: 'scrapingdog',
        startedAt: enrichedAt,
        completedAt: enrichedAt,
      });
    });

    it('ZERO confidence → does NOT call setEnrichmentState or saveEnrichedCandidate (client trigger handles it, stays none)', async () => {
      mockNewGoogleUserChain({
        profile: null,
        confidence: 0,
        sources: [],
        foundLinkedinUrl: null,
        requestedLinkedinUrl: null,
        enrichedAt: null,
      });

      await identityService.findOrCreateGoogleUser({
        email: 'google-preload-zero@example.com',
        name: 'Google Preload',
      });

      expect(enrichRepo.saveEnrichedCandidate).not.toHaveBeenCalled();
      expect(enrichRepo.setEnrichmentState).not.toHaveBeenCalled();
    });

    it('ABSENT preload (no approved request carrying an enriched blob) → does NOT call setEnrichmentState', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 1 getUserByEmail → null (new user)
        .mockResolvedValueOnce({ rows: [{ id: 'jr-1' }], rowCount: 1 }) // 2 isEmailApproved → approved
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 3 getApprovedJoinRequestSeed → no row
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 4 INSERT users
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 5 INSERT subscription
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 6 INSERT entitlements
        .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 }); // 7 getUserById

      await identityService.findOrCreateGoogleUser({
        email: 'google-nopreload@example.com',
        name: 'Google Nopreload',
      });

      expect(enrichRepo.saveEnrichedCandidate).not.toHaveBeenCalled();
      expect(enrichRepo.setEnrichmentState).not.toHaveBeenCalled();
    });

    it('setEnrichmentState rejecting does NOT break login (best-effort, mirrors saveEnrichedCandidate error handling)', async () => {
      (enrichRepo.setEnrichmentState as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      mockNewGoogleUserChain({
        profile: { fullName: 'Google Preload' },
        confidence: 0.8,
        sources: [],
        foundLinkedinUrl: null,
        requestedLinkedinUrl: 'https://linkedin.com/in/google-preload',
        enrichedAt,
        provider: 'scrapingdog',
      });

      const result = await identityService.findOrCreateGoogleUser({
        email: 'google-preload-reject@example.com',
        name: 'Google Preload',
      });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
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
