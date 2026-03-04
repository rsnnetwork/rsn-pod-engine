// ─── Route Integration Tests ─────────────────────────────────────────────────
// Tests the API routes using supertest with fully mocked services.
// These tests validate: routing, validation, auth checks, and response shapes.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
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

import authRoutes from '../../routes/auth';
import userRoutes from '../../routes/users';
import podRoutes from '../../routes/pods';
import sessionRoutes from '../../routes/sessions';
import inviteRoutes from '../../routes/invites';
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
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(overrides: Partial<{ sub: string; email: string; role: string; sessionId: string }> = {}) {
  return jwt.sign({
    sub: overrides.sub || 'user-123',
    email: overrides.email || 'test@example.com',
    role: overrides.role || 'member',
    sessionId: overrides.sessionId || 'sess-1',
  }, JWT_SECRET, { expiresIn: '15m' });
}

// ─── Shared Mocks ───────────────────────────────────────────────────────────

const mockUser = {
  id: 'user-123',
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
  id: 'pod-123',
  name: 'Test Pod',
  description: null,
  podType: PodType.SPEED_NETWORKING,
  orchestrationMode: 'timed_rounds',
  communicationMode: 'video',
  visibility: 'private',
  status: 'active',
  maxMembers: 50,
  rules: null,
  createdBy: 'user-123',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSession = {
  id: 'session-123',
  podId: 'pod-123',
  title: 'Test Session',
  description: null,
  scheduledAt: new Date(),
  startedAt: null,
  endedAt: null,
  status: SessionStatus.SCHEDULED,
  currentRound: 0,
  config: DEFAULT_SESSION_CONFIG,
  hostUserId: 'user-123',
  lobbyRoomId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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
      expect(res.body.data.user.id).toBe('user-123');
    });

    it('should return 401 without token', async () => {
      const res = await request(app).get('/auth/session');

      expect(res.status).toBe(401);
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
      expect(res.body.data.id).toBe('user-123');
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
        .get('/users/user-123')
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
      expect(res.body.data.id).toBe('pod-123');
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

      const token = makeToken();
      const res = await request(app)
        .get('/pods/pod-123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('pod-123');
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
      expect(res.body.data.id).toBe('session-123');
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

      const token = makeToken();
      const res = await request(app)
        .get('/sessions/session-123')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('session-123');
    });
  });
});

describe('Invite Routes', () => {
  const app = createApp();

  const mockInvite = {
    id: 'invite-1',
    code: 'ABC123',
    type: InviteType.POD,
    inviterId: 'user-123',
    inviteeEmail: null,
    podId: 'pod-123',
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
