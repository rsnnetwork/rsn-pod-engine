// ─── Route Integration Tests ─────────────────────────────────────────────────
// Tests the API routes using supertest with fully mocked services.
// These tests validate: routing, validation, auth checks, and response shapes.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { UserRole, SessionStatus, PodType, DEFAULT_SESSION_CONFIG, InviteType, InviteStatus } from '@rsn/shared';

// ─── Mock all dependencies before importing routes ──────────────────────────

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    jwtAccessExpiry: '15m',
    jwtRefreshExpiry: '7d',
    magicLinkSecret: 'test-magic-link-secret',
    magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
  },
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../../db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  __esModule: true,
}));

// Mock identity service
jest.mock('../../services/identity/identity.service');
jest.mock('../../services/pod/pod.service');
jest.mock('../../services/session/session.service');
jest.mock('../../services/invite/invite.service');
jest.mock('../../services/rating/rating.service');
jest.mock('../../services/matching/matching.service');

import * as identityService from '../../services/identity/identity.service';
import * as podService from '../../services/pod/pod.service';
import * as sessionService from '../../services/session/session.service';
import * as inviteService from '../../services/invite/invite.service';
import * as ratingService from '../../services/rating/rating.service';
import { query as dbQuery } from '../../db';
import * as eventAccess from '../../services/session/event-access';

import authRoutes from '../../routes/auth';
import userRoutes from '../../routes/users';
import podRoutes from '../../routes/pods';
import sessionRoutes from '../../routes/sessions';
import inviteRoutes from '../../routes/invites';
import ratingRoutes from '../../routes/ratings';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

// ─── App Factory ────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/users', userRoutes);
  app.use('/pods', podRoutes);
  app.use('/sessions', sessionRoutes);
  app.use('/invites', inviteRoutes);
  app.use('/ratings', ratingRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(overrides: Partial<{ sub: string; email: string; role: string; sessionId: string }> = {}) {
  return jwt.sign({
    sub: overrides.sub || '05e70000-0000-4000-8000-000000000123',
    email: overrides.email || 'test@example.com',
    role: overrides.role || 'member',
    sessionId: overrides.sessionId || 'sess-1',
  }, JWT_SECRET, { expiresIn: '15m' });
}

// ─── Shared Mocks ───────────────────────────────────────────────────────────

const mockUser = {
  id: '05e70000-0000-4000-8000-000000000123',
  email: 'test@example.com',
  displayName: 'Test User',
  firstName: 'Test',
  lastName: 'User',
  role: UserRole.MEMBER,
  profileComplete: true,
  emailVerified: true,
  avatarUrl: null,
  bio: null,
  company: null,
  jobTitle: null,
  industry: null,
  interests: [],
  reasonsToConnect: [],
  languages: ['english'],
  timezone: 'UTC',
  location: null,
  linkedinUrl: null,
  status: 'active',
  lastActiveAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPod = {
  id: 'd0d0d0d0-0000-4000-8000-000000000123',
  name: 'Test Pod',
  description: null,
  podType: PodType.SPEED_NETWORKING,
  orchestrationMode: 'timed_rounds',
  communicationMode: 'video',
  visibility: 'private',
  status: 'active',
  maxMembers: 50,
  rules: null,
  createdBy: '05e70000-0000-4000-8000-000000000123',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSession = {
  id: '5e550000-0000-4000-8000-000000000123',
  podId: 'd0d0d0d0-0000-4000-8000-000000000123',
  title: 'Test Session',
  description: null,
  scheduledAt: new Date(),
  startedAt: null,
  endedAt: null,
  status: SessionStatus.SCHEDULED,
  currentRound: 0,
  config: DEFAULT_SESSION_CONFIG,
  hostUserId: '05e70000-0000-4000-8000-000000000123',
  lobbyRoomId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (podService.getMemberRole as jest.Mock).mockResolvedValue('director');
  (ratingService.isMatchParticipant as jest.Mock).mockResolvedValue(true);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Auth Routes', () => {
  const app = createApp();

  describe('POST /auth/magic-link', () => {
    it('should accept a valid email', async () => {
      (identityService.sendMagicLink as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post('/auth/magic-link')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject invalid email', async () => {
      const res = await request(app)
        .post('/auth/magic-link')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing email', async () => {
      const res = await request(app)
        .post('/auth/magic-link')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/verify', () => {
    it('should verify a valid token', async () => {
      (identityService.verifyMagicLink as jest.Mock).mockResolvedValue({
        accessToken: 'abc',
        refreshToken: 'def',
        expiresAt: Date.now() + 900000,
      });

      const res = await request(app)
        .post('/auth/verify')
        .send({ token: 'valid-magic-link-token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accessToken');
    });

    it('should reject empty token', async () => {
      const res = await request(app)
        .post('/auth/verify')
        .send({ token: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh tokens', async () => {
      (identityService.refreshAccessToken as jest.Mock).mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 900000,
      });

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: 'old-refresh-token' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('accessToken');
    });
  });

  describe('GET /auth/session', () => {
    it('should return session info for authenticated user', async () => {
      (identityService.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const token = makeToken();
      const res = await request(app)
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe('05e70000-0000-4000-8000-000000000123');
    });

    it('should return 401 without token', async () => {
      const res = await request(app).get('/auth/session');

      expect(res.status).toBe(401);
    });

    it('should surface onboardingStatus and lastOnboardedAt from the user record', async () => {
      const lastOnboardedAt = new Date('2026-07-01T12:00:00Z');
      (identityService.getUserById as jest.Mock).mockResolvedValue({
        ...mockUser,
        onboardingStatus: 'update_required',
        lastOnboardedAt,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.onboardingStatus).toBe('update_required');
      expect(res.body.data.user.lastOnboardedAt).toBe(lastOnboardedAt.toISOString());
    });

    it('should serialize Date to ISO string in session response', async () => {
      const dateValue = new Date('2026-06-15T10:30:45.123Z');
      (identityService.getUserById as jest.Mock).mockResolvedValue({
        ...mockUser,
        lastOnboardedAt: dateValue,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.data.user.lastOnboardedAt).toBe('string');
      expect(res.body.data.user.lastOnboardedAt).toBe(dateValue.toISOString());
    });

    it('should handle null lastOnboardedAt as JSON null', async () => {
      (identityService.getUserById as jest.Mock).mockResolvedValue({
        ...mockUser,
        lastOnboardedAt: null,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.lastOnboardedAt).toBeNull();
    });

    // 30 Oct review (2.1): the preview takes everyone who has not done the new onboarding through it, so the
    // session says which version they finished: 2, or null for an earlier one or none.
    it('carries which onboarding the member finished: 2, and null when they have not done the new one', async () => {
      (identityService.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, onboardingStatus: 'completed', onboardingVersion: 2 });
      const v2 = await request(app).get('/auth/session').set('Authorization', `Bearer ${makeToken()}`);
      expect(v2.status).toBe(200);
      expect(v2.body.data.user.onboardingVersion).toBe(2);

      for (const onboardingVersion of [null, undefined]) {
        (identityService.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, onboardingStatus: 'completed', onboardingVersion });
        const v1 = await request(app).get('/auth/session').set('Authorization', `Bearer ${makeToken()}`);
        expect(v1.body.data.user).toHaveProperty('onboardingVersion', null);
      }
    });

    // Production's client (origin/main: authStore.checkSession, ProtectedRoute, the profile and Settings pages)
    // reads the session as it was; the new field is only added beside every one of them.
    it('production\'s client still gets every field it read before onboardingVersion was added', async () => {
      const before = [
        'id', 'email', 'displayName', 'firstName', 'lastName', 'avatarUrl', 'bannerUrl', 'bio', 'company', 'jobTitle',
        'industry', 'location', 'linkedinUrl', 'interests', 'reasonsToConnect', 'languages', 'timezone', 'phone', 'role',
        'profileComplete', 'onboardingCompleted', 'onboardingStatus', 'lastOnboardedAt', 'expertiseText', 'whatICareAbout',
        'whatICanHelpWith', 'whoIWantToMeet', 'whyIWantToMeet', 'myIntent', 'notifyEmail', 'notifyEventReminders',
        'notifyMatches', 'profileVisible', 'inviteOptOutPublicEvents',
      ];
      // Every field held (null where the member has nothing), so a field the route stopped sending cannot hide as undefined.
      const stored = { ...Object.fromEntries(before.map(k => [k, null])), ...mockUser, onboardingStatus: 'completed', onboardingVersion: 2 };
      (identityService.getUserById as jest.Mock).mockResolvedValue(stored);
      const res = await request(app).get('/auth/session').set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data.user).sort()).toEqual([...before, 'onboardingVersion'].sort());
      expect(res.body.data.user).toMatchObject({ id: mockUser.id, email: mockUser.email, onboardingStatus: 'completed', location: null });
    });

    // 21 Oct 2026: the member's banner rides the session like their photo does, as its address or null.
    it('carries the banner\'s address, and null when the member has none', async () => {
      const bannerUrl = 'http://localhost:3001/api/users/05e70000-0000-4000-8000-000000000123/banner?v=1761040000000';
      (identityService.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, bannerUrl });
      const withOne = await request(app).get('/auth/session').set('Authorization', `Bearer ${makeToken()}`);
      expect(withOne.status).toBe(200);
      expect(withOne.body.data.user.bannerUrl).toBe(bannerUrl);

      (identityService.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, bannerUrl: null });
      const without = await request(app).get('/auth/session').set('Authorization', `Bearer ${makeToken()}`);
      expect(without.body.data.user).toHaveProperty('bannerUrl', null);
    });

    // 29 Sep 2026: the Settings page fills its five switches from this payload.
    // It carried none of them, so every switch read its built-in default (on, on,
    // on, on, off) and any Save wrote those defaults back over what the member had
    // chosen, which could quietly un-hide a hidden profile. The stored values
    // below are the opposite of the defaults, so a fallback cannot pass for them.
    const SETTINGS_DEFAULTS: Record<string, boolean> = {
      profileVisible: true,
      notifyEmail: true,
      notifyEventReminders: true,
      notifyMatches: true,
      inviteOptOutPublicEvents: false,
    };

    it('carries the Settings of a hidden member who turned notifications off', async () => {
      const stored = {
        profileVisible: false,
        notifyEmail: false,
        notifyEventReminders: false,
        notifyMatches: false,
        inviteOptOutPublicEvents: true,
      };
      (identityService.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, ...stored });

      const res = await request(app)
        .get('/auth/session')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject(stored);
    });

    // One field flipped at a time, so a preference read from the wrong column
    // (say notifyEmail taken from notifyMatches) cannot hide behind equal values.
    it.each(Object.keys(SETTINGS_DEFAULTS))('carries %s as stored, with the other four untouched', async (key) => {
      const stored = { ...SETTINGS_DEFAULTS, [key]: !SETTINGS_DEFAULTS[key] };
      (identityService.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, ...stored });

      const res = await request(app)
        .get('/auth/session')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject(stored);
    });
  });
});

describe('User Routes', () => {
  const app = createApp();

  describe('GET /users/me', () => {
    it('should return current user profile', async () => {
      (identityService.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const token = makeToken();
      const res = await request(app)
        .get('/users/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('05e70000-0000-4000-8000-000000000123');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/users/me');

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /users/me', () => {
    it('should update user profile', async () => {
      (identityService.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        displayName: 'Updated Name',
      });

      const token = makeToken();
      const res = await request(app)
        .put('/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe('Updated Name');
    });

    // 30 Oct review (1.2): location is required on the preview's screens, never here. Production's profile form
    // (origin/main ProfilePage.tsx) posts location: '' for every member who has none (44 of 81 on 1 Nov), and the
    // old onboarding and Settings saves post no location at all; each still saves.
    it.each([
      ['an empty location, as production\'s form sends it', { location: '' }],
      ['no location at all', {}],
      ['only a country', { location: 'USA' }],
    ])('production\'s profile save with %s still saves', async (_label, location) => {
      (identityService.updateUser as jest.Mock).mockResolvedValue({ ...mockUser, displayName: 'Jane Doe' });
      const productionForm = {
        displayName: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', bio: '', company: '', jobTitle: '', industry: '',
        linkedinUrl: '', timezone: 'Europe/Copenhagen', phone: '', interests: [], reasonsToConnect: [], languages: ['english'],
        expertiseText: null, whatICareAbout: null, whatICanHelpWith: null, whoIWantToMeet: null, whyIWantToMeet: null, myIntent: null,
        ...location,
      };
      const res = await request(app).put('/users/me').set('Authorization', `Bearer ${makeToken()}`).send(productionForm);
      expect(res.status).toBe(200);
      expect(identityService.updateUser).toHaveBeenCalledWith(mockUser.id, expect.objectContaining(location));
    });

    it('should reject invalid update data', async () => {
      const token = makeToken();
      const res = await request(app)
        .put('/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 'x'.repeat(200) }); // exceeds max 100

      expect(res.status).toBe(400);
    });
  });

  describe('GET /users/:id', () => {
    it('should return user by id', async () => {
      (identityService.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const token = makeToken();
      const res = await request(app)
        .get('/users/05e70000-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /users (admin only)', () => {
    it('should return 403 for non-admin users', async () => {
      const token = makeToken({ role: 'member' });
      const res = await request(app)
        .get('/users')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should return users list for admin', async () => {
      (identityService.getUsers as jest.Mock).mockResolvedValue({
        users: [mockUser],
        total: 1,
      });

      const token = makeToken({ role: 'admin' });
      const res = await request(app)
        .get('/users')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });
});

describe('Pod Routes', () => {
  const app = createApp();

  describe('POST /pods', () => {
    it('should create a pod', async () => {
      (podService.createPod as jest.Mock).mockResolvedValue(mockPod);

      const token = makeToken();
      const res = await request(app)
        .post('/pods')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test Pod' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('d0d0d0d0-0000-4000-8000-000000000123');
    });

    it('should reject pod without name', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/pods')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /pods', () => {
    it('should return user pods', async () => {
      (podService.listPods as jest.Mock).mockResolvedValue({
        pods: [mockPod],
        total: 1,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/pods')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /pods/:id', () => {
    it('should return pod by id', async () => {
      (podService.getPodById as jest.Mock).mockResolvedValue(mockPod);

      // Admin role bypasses canViewPod DB lookups (short-circuits on role check).
      const token = makeToken({ role: 'admin' });
      const res = await request(app)
        .get('/pods/d0d0d0d0-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('d0d0d0d0-0000-4000-8000-000000000123');
    });
  });
});

describe('Session Routes', () => {
  const app = createApp();

  describe('POST /sessions', () => {
    it('should create a session', async () => {
      (sessionService.createSession as jest.Mock).mockResolvedValue(mockSession);

      const token = makeToken();
      const res = await request(app)
        .post('/sessions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          podId: '00000000-0000-0000-0000-000000000001',
          title: 'Test Session',
          scheduledAt: '2025-01-15T18:00:00Z',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('5e550000-0000-4000-8000-000000000123');
    });

    // T11 (1 Nov 2026) — production's form sends no visibility: the event is created NULL (it follows its pod).
    it('passes no visibility when the production form sends none, and the preview visibility when it does', async () => {
      (sessionService.createSession as jest.Mock).mockClear().mockResolvedValue(mockSession);
      const token = makeToken();
      const base = {
        podId: '00000000-0000-0000-0000-000000000001', title: 'Test Session', scheduledAt: '2025-01-15T18:00:00Z',
        format: 'speed_networking', config: { numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 25 },
      };
      const old = await request(app).post('/sessions').set('Authorization', `Bearer ${token}`).send(base);
      expect(old.status).toBe(201);
      expect((sessionService.createSession as jest.Mock).mock.calls[0][1]).not.toHaveProperty('visibility');
      const preview = await request(app).post('/sessions').set('Authorization', `Bearer ${token}`)
        .send({ ...base, visibility: 'public_with_approval' });
      expect(preview.status).toBe(201);
      expect((sessionService.createSession as jest.Mock).mock.calls[1][1]).toMatchObject({ visibility: 'public_with_approval' });
      const wrong = await request(app).post('/sessions').set('Authorization', `Bearer ${token}`)
        .send({ ...base, visibility: 'invite_only' });
      expect(wrong.status).toBe(400);
    });

    // T13 (1 Nov 2026) — production's form (origin/main client/src/features/sessions/event-form.ts, sessionBody) sends no
    // circleId: the service gets none, so the event names no circle, exactly as before. The preview's circle preset
    // passes its circle through; anything that is not an id is refused before the service.
    it('passes no circleId for production\'s form body, the preview\'s circleId when sent, and refuses one that is not an id', async () => {
      (sessionService.createSession as jest.Mock).mockClear().mockResolvedValue(mockSession);
      const token = makeToken();
      const productionBody = {
        podId: '00000000-0000-0000-0000-000000000001', title: 'Speed networking · Founding RSN Circle',
        scheduledAt: '2026-11-08T18:00:00.000Z', format: 'speed_networking',
        config: {
          eventType: 'speed_networking', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 25,
          timerVisibility: 'always_visible', matchingPolicy: 'platform_wide',
        },
      };
      const old = await request(app).post('/sessions').set('Authorization', `Bearer ${token}`).send(productionBody);
      expect(old.status).toBe(201);
      expect((sessionService.createSession as jest.Mock).mock.calls[0][1]).not.toHaveProperty('circleId');
      expect((sessionService.createSession as jest.Mock).mock.calls[0][1]).not.toHaveProperty('visibility');
      const circleId = '0c1c0000-0000-4000-8000-000000000001';
      const preview = await request(app).post('/sessions').set('Authorization', `Bearer ${token}`).send({ ...productionBody, circleId });
      expect(preview.status).toBe(201);
      expect((sessionService.createSession as jest.Mock).mock.calls[1][1]).toMatchObject({ circleId });
      const wrong = await request(app).post('/sessions').set('Authorization', `Bearer ${token}`).send({ ...productionBody, circleId: 'founders' });
      expect(wrong.status).toBe(400);
      expect(sessionService.createSession).toHaveBeenCalledTimes(2);
    });

    it('should reject session without title', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/sessions')
        .set('Authorization', `Bearer ${token}`)
        .send({ podId: '00000000-0000-0000-0000-000000000001', scheduledAt: '2025-01-15T18:00:00Z' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /sessions/:id', () => {
    it('should return session by id', async () => {
      (sessionService.getSessionById as jest.Mock).mockResolvedValue(mockSession);
      // T11: the additive access block reads one row; none here, so the answer is today's shape.
      (dbQuery as jest.Mock).mockImplementation(async (sql: string) =>
        (sql.includes('event_join_requests') ? { rows: [], rowCount: 0 } : undefined));

      // Admin role bypasses canViewSession DB lookups (short-circuits on role check).
      const token = makeToken({ role: 'admin' });
      const res = await request(app)
        .get('/sessions/5e550000-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('5e550000-0000-4000-8000-000000000123');
      // T13: an event with no circle reads no circle and carries no circle block (production's shape).
      expect(res.body.data).not.toHaveProperty('circle');
      // T14: the access read's closed-circle check names circles inside its own query (guarded by circle_id IS NOT NULL);
      // what must not happen is a separate lookup of the event's circle.
      expect((dbQuery as jest.Mock).mock.calls.some(([sql]) => /FROM circles WHERE/.test(String(sql)))).toBe(false);
      (dbQuery as jest.Mock).mockReset();
    });

    // T13 (1 Nov 2026) — additive: an event for a whole circle names it, so the preview's page says "For <circle>".
    it('names the circle an event is for, beside every field it had', async () => {
      const circleId = '0c1c0000-0000-4000-8000-000000000001';
      (sessionService.getSessionById as jest.Mock).mockResolvedValue({ ...mockSession, circleId, visibility: 'private' });
      (sessionService.getParticipantCount as jest.Mock).mockResolvedValue(3);
      (dbQuery as jest.Mock).mockImplementation(async (sql: string) => {
        if (/SELECT id, name FROM circles WHERE id = \$1 AND archived_at IS NULL/.test(sql)) {
          return { rows: [{ id: circleId, name: 'Founding Circle' }], rowCount: 1 };
        }
        if (sql.includes('SELECT status FROM users')) return { rows: [{ status: 'active' }], rowCount: 1 };
        if (sql.includes('event_join_requests')) return { rows: [], rowCount: 0 };
        return undefined;
      });
      const res = await request(app)
        .get('/sessions/5e550000-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${makeToken({ role: 'admin' })}`);
      (dbQuery as jest.Mock).mockReset();
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: mockSession.id, podId: mockSession.podId, title: mockSession.title, participantCount: 3,
        circleId, circle: { id: circleId, name: 'Founding Circle' },
      });
    });

    // T11 fix round 1: a private event refuses a stranger with today's 403 and words (production's client reads
    // them) plus the code EVENT_PRIVATE, so the preview can say "This event is private". A NULL event: unchanged.
    const refusalFor = async (visibility: string | null) => {
      (dbQuery as jest.Mock).mockImplementation(async (sql: string) => {
        if (sql.includes('FROM sessions s') && sql.includes('pod_visibility')) {
          return { rows: [{ host_user_id: 'someone-else', pod_id: 'p1', pod_visibility: 'private', is_cohost: false, visibility, account_closed: false }], rowCount: 1 };
        }
        if (sql.includes('event_join_requests')) {
          return { rows: [{ visibility, pod_id: 'p1', pod_visibility: 'private', is_host: false, is_cohost: false, is_pod_organiser: false,
            in_audience: false, is_invited: false, participant_status: null, account_active: true, my_request: null }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT visibility FROM sessions')) return { rows: [{ visibility }], rowCount: 1 };
        if (sql.includes('SELECT status FROM users')) return { rows: [{ status: 'active' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      const res = await request(app)
        .get('/sessions/5e550000-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${makeToken()}`);
      (dbQuery as jest.Mock).mockReset();
      return res;
    };

    it('answers a stranger on a private event 403 with the code EVENT_PRIVATE and the words production shows', async () => {
      const res = await refusalFor('private');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'EVENT_PRIVATE', message: 'You must be registered or a pod member to view this event.' });
    });

    it('answers a stranger on a NULL event in a private pod exactly as before', async () => {
      const res = await refusalFor(null);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'AUTH_FORBIDDEN', message: 'You must be registered or a pod member to view this event.' });
    });
  });
});

describe('Invite Routes', () => {
  const app = createApp();

  const mockInvite = {
    id: 'invite-1',
    code: 'ABC123',
    type: InviteType.POD,
    inviterId: '05e70000-0000-4000-8000-000000000123',
    inviteeEmail: null,
    podId: 'd0d0d0d0-0000-4000-8000-000000000123',
    sessionId: null,
    status: InviteStatus.PENDING,
    maxUses: 1,
    useCount: 0,
    expiresAt: null,
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe('POST /invites', () => {
    it('should create an invite', async () => {
      (inviteService.createInvite as jest.Mock).mockResolvedValue(mockInvite);

      const token = makeToken();
      const res = await request(app)
        .post('/invites')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'pod', podId: '00000000-0000-0000-0000-000000000001' });

      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe('ABC123');
    });
  });

  describe('GET /invites/:code', () => {
    it('should return invite by code', async () => {
      (inviteService.getInviteByCode as jest.Mock).mockResolvedValue(mockInvite);
      // Route does direct query() calls for enrichment (inviter name, pod details)
      (dbQuery as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ displayName: 'Host User' }], rowCount: 1 })  // inviter name
        .mockResolvedValueOnce({ rows: [{ name: 'Test Pod', description: null }], rowCount: 1 }); // pod details

      const token = makeToken();
      const res = await request(app)
        .get('/invites/ABC123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });
});

describe('404 Handler', () => {
  const app = createApp();

  it('should return 404 for undefined routes', async () => {
    const res = await request(app).get('/api/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('/api/nonexistent');
  });

  it('should return 404 for wrong HTTP methods', async () => {
    const res = await request(app).delete('/auth/magic-link');

    expect(res.status).toBe(404);
  });
});

// ─── Additional Pod Route Tests ─────────────────────────────────────────────

describe('Pod Routes - Extended', () => {
  const app = createApp();

  describe('PUT /pods/:id', () => {
    it('should update a pod', async () => {
      (podService.updatePod as jest.Mock).mockResolvedValue({ ...mockPod, name: 'Updated' });

      const token = makeToken();
      const res = await request(app)
        .put('/pods/d0d0d0d0-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated');
    });
  });

  describe('GET /pods/:id/members', () => {
    it('should return pod members', async () => {
      (podService.getPodMembers as jest.Mock).mockResolvedValue([
        { id: 'pm-1', podId: 'd0d0d0d0-0000-4000-8000-000000000123', userId: '05e70000-0000-4000-8000-000000000123', role: 'director', status: 'active' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .get('/pods/d0d0d0d0-0000-4000-8000-000000000123/members')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('POST /pods/:id/members', () => {
    it('should add a member', async () => {
      (podService.addMember as jest.Mock).mockResolvedValue({
        id: 'pm-2', podId: 'd0d0d0d0-0000-4000-8000-000000000123', userId: '00000000-0000-0000-0000-000000000002', role: 'member', status: 'active',
      });

      const token = makeToken();
      const res = await request(app)
        .post('/pods/d0d0d0d0-0000-4000-8000-000000000123/members')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: '00000000-0000-0000-0000-000000000002' });

      expect(res.status).toBe(201);
    });

    it('should reject without userId', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/pods/d0d0d0d0-0000-4000-8000-000000000123/members')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /pods/:id/members/:userId', () => {
    it('should remove a member', async () => {
      (podService.removeMember as jest.Mock).mockResolvedValue(undefined);

      const token = makeToken();
      const res = await request(app)
        .delete('/pods/d0d0d0d0-0000-4000-8000-000000000123/members/user-456')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('POST /pods/:id/leave', () => {
    it('should allow leaving a pod', async () => {
      (podService.leavePod as jest.Mock).mockResolvedValue(undefined);

      const token = makeToken();
      const res = await request(app)
        .post('/pods/d0d0d0d0-0000-4000-8000-000000000123/leave')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });
});

// ─── Extended Session Route Tests ───────────────────────────────────────────

describe('Session Routes - Extended', () => {
  const app = createApp();

  describe('PUT /sessions/:id', () => {
    it('should update a session', async () => {
      (sessionService.updateSession as jest.Mock).mockResolvedValue({ ...mockSession, title: 'Updated' });

      const token = makeToken();
      const res = await request(app)
        .put('/sessions/5e550000-0000-4000-8000-000000000123')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Updated');
    });

    // T13 (1 Nov 2026) — production's edit form sends no circleId (the event keeps its circle); the preview may clear it.
    it('passes no circleId for production\'s edit body and passes a clear (null) through', async () => {
      (sessionService.updateSession as jest.Mock).mockClear().mockResolvedValue(mockSession);
      const token = makeToken();
      const path = '/sessions/5e550000-0000-4000-8000-000000000123';
      expect((await request(app).put(path).set('Authorization', `Bearer ${token}`).send({ title: 'Updated' })).status).toBe(200);
      expect((sessionService.updateSession as jest.Mock).mock.calls[0][2]).not.toHaveProperty('circleId');
      expect((await request(app).put(path).set('Authorization', `Bearer ${token}`).send({ circleId: null })).status).toBe(200);
      expect((sessionService.updateSession as jest.Mock).mock.calls[1][2]).toEqual({ circleId: null });
      expect((await request(app).put(path).set('Authorization', `Bearer ${token}`).send({ circleId: 'x' })).status).toBe(400);
    });
  });

  describe('GET /sessions', () => {
    it('should list sessions', async () => {
      (sessionService.listSessions as jest.Mock).mockResolvedValue({
        sessions: [mockSession],
        total: 1,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/sessions')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('POST /sessions/:id/register', () => {
    it('should register participant', async () => {
      (sessionService.registerParticipant as jest.Mock).mockResolvedValue({
        id: 'sp-1', sessionId: '5e550000-0000-4000-8000-000000000123', userId: '05e70000-0000-4000-8000-000000000123', status: 'registered',
      });

      const token = makeToken();
      const res = await request(app)
        .post('/sessions/5e550000-0000-4000-8000-000000000123/register')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /sessions/:id/register', () => {
    it('should unregister participant', async () => {
      (sessionService.unregisterParticipant as jest.Mock).mockResolvedValue(undefined);

      const token = makeToken();
      const res = await request(app)
        .delete('/sessions/5e550000-0000-4000-8000-000000000123/register')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /sessions/:id/participants', () => {
    it('should return participants', async () => {
      (sessionService.getSessionParticipants as jest.Mock).mockResolvedValue([
        { id: 'sp-1', userId: '05e70000-0000-4000-8000-000000000123', status: 'registered' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .get('/sessions/5e550000-0000-4000-8000-000000000123/participants')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    // T13 fix (1 Nov 2026): the people the event page registers on opening it read the list as its pod's members do,
    // because that page registers them only once the list has loaded: the event's audience (for an event for a whole
    // circle, the circle's active members, who are not in the pod) and its invitees (fix round 1), each only while they
    // may see the event. Everyone else: as before, word for word. The rule is read through readEventAccessFacts, mocked
    // here, so these tests do not depend on its SQL.
    describe('who reads it', () => {
      const SESSION = '5e550000-0000-4000-8000-000000000123';
      const facts = (over: Partial<eventAccess.EventAccessFacts>): eventAccess.EventAccessFacts => ({
        visibility: 'private', podId: 'p1', podVisibility: 'private', isHost: false, isCohost: false, isPodOrganiser: false,
        inAudience: false, isInvited: false, participantStatus: null, accountActive: true, myRequest: null,
        outsideClosedCircle: false, ...over,
      });
      let readFacts: jest.SpyInstance;
      const arm = (world: { podMember?: boolean; facts?: Partial<eventAccess.EventAccessFacts> }) => {
        (sessionService.getSessionById as jest.Mock).mockResolvedValue({ ...mockSession, hostUserId: 'someone-else', podId: 'p1' });
        (sessionService.isSessionParticipant as jest.Mock).mockResolvedValue(false);
        (podService.getMemberRole as jest.Mock).mockResolvedValue(world.podMember ? 'member' : null);
        (sessionService.getSessionParticipants as jest.Mock).mockResolvedValue([
          { id: 'sp-1', userId: 'someone-else', status: 'registered', email: 'host@example.com' },
        ]);
        (dbQuery as jest.Mock).mockImplementation(async (sql: string) =>
          (sql.includes('SELECT status FROM users') ? { rows: [{ status: 'active' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
        readFacts = jest.spyOn(eventAccess, 'readEventAccessFacts').mockResolvedValue(facts(world.facts ?? {}));
      };
      const read = () => request(app).get(`/sessions/${SESSION}/participants`).set('Authorization', `Bearer ${makeToken()}`);
      // Put back what the tests after this block read: the event hosted by the token's member, and the pod role.
      afterEach(() => {
        (dbQuery as jest.Mock).mockReset();
        (podService.getMemberRole as jest.Mock).mockResolvedValue('director');
        (sessionService.getSessionById as jest.Mock).mockResolvedValue(mockSession);
        (sessionService.isSessionParticipant as jest.Mock).mockReset();
        readFacts?.mockRestore();
      });

      it('a circle member who is not in the pod reads it (the public card, no email)', async () => {
        arm({ facts: { inAudience: true } });
        const res = await read();
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).not.toHaveProperty('email');
      });

      it('an invitee who is not in the pod and holds no place yet reads it (fix round 1), without email', async () => {
        arm({ facts: { isInvited: true } });
        const res = await read();
        expect(res.status).toBe(200);
        expect(res.body.data[0]).not.toHaveProperty('email');
      });

      it('an invitee or a circle member whose account is closed is refused', async () => {
        arm({ facts: { isInvited: true, accountActive: false } });
        expect((await read()).status).toBe(403);
        readFacts.mockRestore();
        arm({ facts: { inAudience: true, accountActive: false } });
        expect((await read()).status).toBe(403);
      });

      it('someone outside the event\'s audience is refused with the same words as before', async () => {
        arm({ facts: {} });
        const res = await read();
        expect(res.status).toBe(403);
        expect(res.body.error.message).toBe('You must be a participant or pod member to view this list');
      });

      it('a pod member reads it as before, without the event access read', async () => {
        arm({ podMember: true });
        const res = await read();
        expect(res.status).toBe(200);
        expect(readFacts).not.toHaveBeenCalled();
      });
    });
  });
});

// ─── Extended Invite Route Tests ────────────────────────────────────────────

describe('Invite Routes - Extended', () => {
  const app = createApp();

  const mockInviteData = {
    id: 'invite-1', code: 'ABC123', type: InviteType.POD,
    inviterId: '05e70000-0000-4000-8000-000000000123', inviteeEmail: null, podId: 'd0d0d0d0-0000-4000-8000-000000000123',
    sessionId: null, status: InviteStatus.PENDING, maxUses: 1, useCount: 0,
    expiresAt: null, acceptedByUserId: null, acceptedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };

  describe('GET /invites', () => {
    it('should list user invites', async () => {
      (inviteService.listInvitesByUser as jest.Mock).mockResolvedValue({
        invites: [mockInviteData], total: 1,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/invites')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('POST /invites/:code/accept', () => {
    it('should accept an invite', async () => {
      (inviteService.acceptInvite as jest.Mock).mockResolvedValue({
        ...mockInviteData, status: InviteStatus.ACCEPTED,
      });

      const token = makeToken();
      const res = await request(app)
        .post('/invites/ABC123/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });
});

// ─── Rating Route Tests ─────────────────────────────────────────────────────

describe('Rating Routes', () => {
  const app = createApp();

  const mockRating = {
    id: 'rating-1', matchId: 'match-1', fromUserId: '05e70000-0000-4000-8000-000000000123',
    toUserId: 'user-456', qualityScore: 4, meetAgain: true,
    feedback: null, createdAt: new Date(),
  };

  describe('POST /ratings', () => {
    it('should submit a rating', async () => {
      (ratingService.submitRating as jest.Mock).mockResolvedValue(mockRating);

      const token = makeToken();
      const res = await request(app)
        .post('/ratings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          matchId: '00000000-0000-0000-0000-000000000001',
          qualityScore: 4,
          meetAgain: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.qualityScore).toBe(4);
    });

    it('should reject invalid quality score', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/ratings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          matchId: '00000000-0000-0000-0000-000000000001',
          qualityScore: 10,
          meetAgain: true,
        });

      expect(res.status).toBe(400);
    });

    it('should reject missing matchId', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/ratings')
        .set('Authorization', `Bearer ${token}`)
        .send({ qualityScore: 4, meetAgain: true });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /ratings/match/:matchId', () => {
    it('should return ratings for a match', async () => {
      (ratingService.getRatingsByMatch as jest.Mock).mockResolvedValue([mockRating]);

      const token = makeToken();
      const res = await request(app)
        .get('/ratings/match/match-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /ratings/my', () => {
    it('should return user ratings', async () => {
      (ratingService.getRatingsByUser as jest.Mock).mockResolvedValue([mockRating]);

      const token = makeToken();
      const res = await request(app)
        .get('/ratings/my')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /ratings/received', () => {
    it('should return user received ratings', async () => {
      (ratingService.getRatingsReceived as jest.Mock).mockResolvedValue([mockRating]);

      const token = makeToken();
      const res = await request(app)
        .get('/ratings/received')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /ratings/sessions/:id/people-met', () => {
    it('should return people met data', async () => {
      (ratingService.getPeopleMet as jest.Mock).mockResolvedValue({
        sessionId: 'session-1', sessionTitle: 'Test', sessionDate: new Date(),
        connections: [], mutualConnections: [],
      });

      const token = makeToken();
      const res = await request(app)
        .get('/ratings/sessions/session-1/people-met')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /ratings/sessions/:id/stats', () => {
    it('should return session rating stats', async () => {
      (ratingService.getSessionRatingStats as jest.Mock).mockResolvedValue({
        totalRatings: 10, avgQualityScore: 3.5, meetAgainRate: 0.6, mutualMeetAgainCount: 2,
      });

      const token = makeToken();
      const res = await request(app)
        .get('/ratings/sessions/session-1/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalRatings).toBe(10);
    });
  });

  describe('GET /ratings/encounters', () => {
    it('should return user encounters', async () => {
      (ratingService.getUserEncounters as jest.Mock).mockResolvedValue([]);

      const token = makeToken();
      const res = await request(app)
        .get('/ratings/encounters')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });
});
