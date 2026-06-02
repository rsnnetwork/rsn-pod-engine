// ─── Post-Event Message Route Tests ──────────────────────────────────────────
//
// Tests the four /sessions/:sessionId/post-event-message/... endpoints using
// supertest with mocked service + DB layers. Follows the exact pattern
// established in routes.test.ts.
//
// authenticate is mocked to inject req.user directly — this keeps the test
// focused on routing / guard logic rather than JWT plumbing.  The "returns 401
// without a token" cases below use a SECOND createApp that keeps the real
// authenticate so the absence of a token is properly rejected.

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

// ─── Module mocks (hoisted) ──────────────────────────────────────────────────
//
// jest.mock() is hoisted above imports by Babel/ts-jest; variable declarations
// are NOT hoisted.  We declare mock fns inside the factories and retrieve them
// after via jest.requireMock() or by importing the mocked module.

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    jwtAccessExpiry: '15m',
    jwtRefreshExpiry: '7d',
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
  __esModule: true,
}));

// Mock authenticate as a jest.fn() so tests can call mockImplementation on it.
jest.mock('../../middleware/auth', () => ({
  authenticate: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/post-event-message/broadcast-eligibility', () => ({
  getEligibilityForEvent: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/post-event-message/post-event-message.service', () => ({
  previewJob: jest.fn(),
  createJob: jest.fn(),
  getLatestJob: jest.fn(),
  __esModule: true,
}));

// ─── Retrieve mock handles ───────────────────────────────────────────────────

import { query as _mockDbQuery } from '../../db';
import { getEligibilityForEvent as _mockGetEligibility } from '../../services/post-event-message/broadcast-eligibility';
import {
  previewJob as _mockPreviewJob,
  createJob as _mockCreateJob,
  getLatestJob as _mockGetLatestJob,
} from '../../services/post-event-message/post-event-message.service';
import * as authModule from '../../middleware/auth';

const mockDbQuery = _mockDbQuery as jest.Mock;
const mockGetEligibility = _mockGetEligibility as jest.Mock;
const mockPreviewJob = _mockPreviewJob as jest.Mock;
const mockCreateJob = _mockCreateJob as jest.Mock;
const mockGetLatestJob = _mockGetLatestJob as jest.Mock;

import postEventMessageRoutes from '../../routes/post-event-message';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

// ─── App factories ────────────────────────────────────────────────────────────

/** App with mocked auth that injects an admin user — used for most tests. */
function createApp() {
  // Patch the mocked authenticate to inject req.user
  (authModule.authenticate as jest.Mock).mockImplementation(
    (req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        userId: 'user-admin-1',
        email: 'admin@example.com',
        role: 'admin' as any,
        sessionId: 'sess-1',
      };
      next();
    },
  );
  const app = express();
  app.use(express.json());
  app.use('/sessions', postEventMessageRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** App with mocked auth that does NOT set req.user, so routes return 401. */
function createUnauthApp() {
  (authModule.authenticate as jest.Mock).mockImplementation(
    (_req: Request, res: Response, _next: NextFunction) => {
      res.status(401).json({ success: false, error: { code: 'AUTH_UNAUTHORIZED', message: 'Authentication required' } });
    },
  );
  const app = express();
  app.use(express.json());
  app.use('/sessions', postEventMessageRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken() {
  return jwt.sign(
    { sub: 'user-admin-1', email: 'admin@example.com', role: 'admin', sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' },
  );
}

// ─── Test data ────────────────────────────────────────────────────────────────

const SESSION_ID = 'aaaabbbb-0000-0000-0000-000000000001';

const eligEnabled = { enabled: true, visible: true, reason: 'admin' as const };
const eligDisabled = { enabled: false, visible: true, reason: 'director_coming_soon' as const };

const mockJob = {
  id: 'job-001',
  sessionId: SESSION_ID,
  status: 'pending' as const,
  totalRecipients: 10,
  sentCount: 0,
  failedCount: 0,
  createdAt: '2026-05-29T12:00:00.000Z',
  completedAt: null,
};

const mockPreview = {
  sessionId: SESSION_ID,
  totalRecipients: 10,
  buckets: [{ bucket: 'stayed', count: 8 }, { bucket: 'left_early', count: 2 }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── GET /sessions/:sessionId/post-event-message/eligibility ─────────────────

describe('GET /sessions/:sessionId/post-event-message/eligibility', () => {
  it('returns eligibility object for an admin', async () => {
    const app = createApp();

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });
    mockGetEligibility.mockResolvedValueOnce(eligEnabled);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/eligibility`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ enabled: true, visible: true, reason: 'admin' });
  });

  it('returns 200 with enabled:false when eligibility service returns disabled', async () => {
    const app = createApp();

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });
    mockGetEligibility.mockResolvedValueOnce(eligDisabled);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/eligibility`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it('returns 404 when session does not exist', async () => {
    const app = createApp();

    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/eligibility`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    const app = createUnauthApp();
    const res = await request(app).get(
      `/sessions/${SESSION_ID}/post-event-message/eligibility`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── POST /sessions/:sessionId/post-event-message ────────────────────────────

describe('POST /sessions/:sessionId/post-event-message', () => {
  it('returns 403 when getEligibilityForEvent resolves { enabled: false }', async () => {
    const app = createApp();

    mockGetEligibility.mockResolvedValueOnce(eligDisabled);

    const res = await request(app)
      .post(`/sessions/${SESSION_ID}/post-event-message`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('returns 201 with job when enabled and event is completed', async () => {
    const app = createApp();

    mockGetEligibility.mockResolvedValueOnce(eligEnabled);
    mockDbQuery.mockResolvedValueOnce({ rows: [{ status: 'completed' }] });
    mockCreateJob.mockResolvedValueOnce(mockJob);

    const res = await request(app)
      .post(`/sessions/${SESSION_ID}/post-event-message`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: 'job-001', status: 'pending' });
  });

  it('returns 409 when event is not yet completed', async () => {
    const app = createApp();

    mockGetEligibility.mockResolvedValueOnce(eligEnabled);
    mockDbQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }] });

    const res = await request(app)
      .post(`/sessions/${SESSION_ID}/post-event-message`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(409);
  });

  it('returns 404 when event does not exist', async () => {
    const app = createApp();

    mockGetEligibility.mockResolvedValueOnce(eligEnabled);
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/sessions/${SESSION_ID}/post-event-message`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    const app = createUnauthApp();
    const res = await request(app).post(
      `/sessions/${SESSION_ID}/post-event-message`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── GET /sessions/:sessionId/post-event-message/preview ─────────────────────

describe('GET /sessions/:sessionId/post-event-message/preview', () => {
  it('returns preview object for an enabled admin on a completed event', async () => {
    const app = createApp();

    mockGetEligibility.mockResolvedValueOnce(eligEnabled);
    mockDbQuery.mockResolvedValueOnce({ rows: [{ status: 'completed' }] });
    mockPreviewJob.mockResolvedValueOnce(mockPreview);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/preview`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalRecipients).toBe(10);
  });

  it('returns 403 when feature is not enabled', async () => {
    const app = createApp();

    mockGetEligibility.mockResolvedValueOnce(eligDisabled);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/preview`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
  });
});

// ─── GET /sessions/:sessionId/post-event-message/status ──────────────────────

describe('GET /sessions/:sessionId/post-event-message/status', () => {
  it('returns the latest job when one exists', async () => {
    const app = createApp();

    mockGetLatestJob.mockResolvedValueOnce(mockJob);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/status`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: 'job-001' });
  });

  it('returns null data when no job exists yet', async () => {
    const app = createApp();

    mockGetLatestJob.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/status`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns 401 without a token', async () => {
    const app = createUnauthApp();
    const res = await request(app).get(
      `/sessions/${SESSION_ID}/post-event-message/status`,
    );
    expect(res.status).toBe(401);
  });
});
