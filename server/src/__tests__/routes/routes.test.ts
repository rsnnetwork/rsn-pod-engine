// ─── Route Integration Tests ─────────────────────────────────────────────────
// Tests the API routes using supertest with fully mocked services.
// These tests validate: routing, validation, auth checks, and response shapes.

import express = require('express');
import request = require('supertest');
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

// ─── Additional Pod Route Tests ─────────────────────────────────────────────

describe('Pod Routes - Extended', () => {
  const app = createApp();

  describe('PUT /pods/:id', () => {
    it('should update a pod', async () => {
      (podService.updatePod as jest.Mock).mockResolvedValue({ ...mockPod, name: 'Updated' });

      const token = makeToken();
      const res = await request(app)
        .put('/pods/pod-123')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated');
    });
  });

  describe('GET /pods/:id/members', () => {
    it('should return pod members', async () => {
      (podService.getPodMembers as jest.Mock).mockResolvedValue([
        { id: 'pm-1', podId: 'pod-123', userId: 'user-123', role: 'director', status: 'active' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .get('/pods/pod-123/members')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('POST /pods/:id/members', () => {
    it('should add a member', async () => {
      (podService.addMember as jest.Mock).mockResolvedValue({
        id: 'pm-2', podId: 'pod-123', userId: '00000000-0000-0000-0000-000000000002', role: 'member', status: 'active',
      });

      const token = makeToken();
      const res = await request(app)
        .post('/pods/pod-123/members')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: '00000000-0000-0000-0000-000000000002' });

      expect(res.status).toBe(201);
    });

    it('should reject without userId', async () => {
      const token = makeToken();
      const res = await request(app)
        .post('/pods/pod-123/members')
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
        .delete('/pods/pod-123/members/user-456')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('POST /pods/:id/leave', () => {
    it('should allow leaving a pod', async () => {
      (podService.leavePod as jest.Mock).mockResolvedValue(undefined);

      const token = makeToken();
      const res = await request(app)
        .post('/pods/pod-123/leave')
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
        .put('/sessions/session-123')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Updated');
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
        id: 'sp-1', sessionId: 'session-123', userId: 'user-123', status: 'registered',
      });

      const token = makeToken();
      const res = await request(app)
        .post('/sessions/session-123/register')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /sessions/:id/register', () => {
    it('should unregister participant', async () => {
      (sessionService.unregisterParticipant as jest.Mock).mockResolvedValue(undefined);

      const token = makeToken();
      const res = await request(app)
        .delete('/sessions/session-123/register')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /sessions/:id/participants', () => {
    it('should return participants', async () => {
      (sessionService.getSessionParticipants as jest.Mock).mockResolvedValue([
        { id: 'sp-1', userId: 'user-123', status: 'registered' },
      ]);

      const token = makeToken();
      const res = await request(app)
        .get('/sessions/session-123/participants')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });
});

// ─── Extended Invite Route Tests ────────────────────────────────────────────

describe('Invite Routes - Extended', () => {
  const app = createApp();

  const mockInviteData = {
    id: 'invite-1', code: 'ABC123', type: InviteType.POD,
    inviterId: 'user-123', inviteeEmail: null, podId: 'pod-123',
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
    id: 'rating-1', matchId: 'match-1', fromUserId: 'user-123',
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
