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
//
// Version 1 (the template, admins only) is what production's client still calls and is pinned first,
// unchanged. Version 2 (26 Oct 2026: the organiser's own words) is reached only with `?v=2` on the
// eligibility call and a `body` on the send.

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
  getEligibilityV2ForEvent: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/post-event-message/post-event-message.service', () => ({
  previewJob: jest.fn(),
  createJob: jest.fn(),
  createJobV2: jest.fn(),
  conflictForActiveSend: jest.fn(),
  getLatestJob: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/post-event-message/event-organisers', () => ({
  getEventOrganiserAccess: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/post-event-message/send-progress', () => ({
  resolveProgressAudience: jest.fn(),
  reportProgress: jest.fn(),
  __esModule: true,
}));

const fakeIo = { id: 'io' };
jest.mock('../../realtime/emit', () => ({
  getRealtimeIo: jest.fn(() => fakeIo),
  __esModule: true,
}));

// ─── Retrieve mock handles ───────────────────────────────────────────────────

import { query as _mockDbQuery } from '../../db';
import {
  getEligibilityForEvent as _mockGetEligibility,
  getEligibilityV2ForEvent as _mockGetEligibilityV2,
} from '../../services/post-event-message/broadcast-eligibility';
import {
  previewJob as _mockPreviewJob,
  createJob as _mockCreateJob,
  createJobV2 as _mockCreateJobV2,
  conflictForActiveSend as _mockConflictForActiveSend,
  getLatestJob as _mockGetLatestJob,
} from '../../services/post-event-message/post-event-message.service';
import { getEventOrganiserAccess as _mockGetAccess } from '../../services/post-event-message/event-organisers';
import {
  resolveProgressAudience as _mockResolveAudience,
  reportProgress as _mockReportProgress,
} from '../../services/post-event-message/send-progress';
import * as authModule from '../../middleware/auth';

const mockDbQuery = _mockDbQuery as jest.Mock;
const mockGetEligibility = _mockGetEligibility as jest.Mock;
const mockGetEligibilityV2 = _mockGetEligibilityV2 as jest.Mock;
const mockPreviewJob = _mockPreviewJob as jest.Mock;
const mockCreateJob = _mockCreateJob as jest.Mock;
const mockCreateJobV2 = _mockCreateJobV2 as jest.Mock;
const mockConflictForActiveSend = _mockConflictForActiveSend as jest.Mock;
const mockGetLatestJob = _mockGetLatestJob as jest.Mock;
const mockGetAccess = _mockGetAccess as jest.Mock;
const mockResolveAudience = _mockResolveAudience as jest.Mock;
const mockReportProgress = _mockReportProgress as jest.Mock;

import postEventMessageRoutes from '../../routes/post-event-message';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { postEventMessageLimiter } from '../../middleware/rateLimit';
import { NotFoundError, ConflictError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

// ─── App factories ────────────────────────────────────────────────────────────

interface Caller { userId: string; role: string; email?: string }
const ADMIN: Caller = { userId: 'user-admin-1', role: 'admin', email: 'admin@example.com' };
const CLAUS: Caller = { userId: 'user-claus', role: 'member', email: 'claus@example.com' };
const GUEST: Caller = { userId: 'user-guest', role: 'member', email: 'guest@example.com' };

/** App with mocked auth that injects the given user (an admin by default). */
function createApp(caller: Caller = ADMIN) {
  // Patch the mocked authenticate to inject req.user
  (authModule.authenticate as jest.Mock).mockImplementation(
    (req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        userId: caller.userId,
        email: caller.email ?? `${caller.userId}@example.com`,
        role: caller.role as any,
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

// The send limiter counts per signed-in person, read from the token's `sub`. Every call gets a sub of
// its own unless a test names one, so the tests below do not spend each other's 10 sends an hour.
let tokenSeq = 0;
function makeToken(sub = `user-anon-${(tokenSeq += 1)}`) {
  return jwt.sign(
    { sub, email: 'admin@example.com', role: 'admin', sessionId: 'sess-1' },
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

const v2Ok = {
  enabled: true, visible: true, reason: 'ok' as const, explanation: '',
  audience: { tookPart: 2, registeredNoShow: 1 },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAudience.mockResolvedValue([ADMIN.userId, 'host-1']);
  mockReportProgress.mockResolvedValue(undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// Version 1 — unchanged
// ═════════════════════════════════════════════════════════════════════════════

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

  it.each(['', '?v=1', '?v=3', '?v=two', '?version=2', '?v=2&v=3'])(
    'a call that does not ask for version 2 (%p) gets the version 1 answer, from the version 1 rule',
    async (query) => {
      const app = createApp();
      mockDbQuery.mockResolvedValueOnce({ rows: [{ id: SESSION_ID }] });
      mockGetEligibility.mockResolvedValueOnce(eligDisabled);

      const res = await request(app)
        .get(`/sessions/${SESSION_ID}/post-event-message/eligibility${query}`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(eligDisabled);
      expect(mockGetEligibilityV2).not.toHaveBeenCalled();
    },
  );
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

  describe('a call with no body is the old template send, exactly', () => {
    it.each([
      ['no body at all', undefined],
      ['an empty object', {}],
      ['unrelated fields', { windows: [] }],
    ])('%s: version 1 rule, version 1 job, nothing of version 2 touched', async (_name, payload) => {
      const app = createApp();
      mockGetEligibility.mockResolvedValueOnce(eligEnabled);
      mockDbQuery.mockResolvedValueOnce({ rows: [{ status: 'completed' }] });
      mockCreateJob.mockResolvedValueOnce(mockJob);

      const req = request(app)
        .post(`/sessions/${SESSION_ID}/post-event-message`)
        .set('Authorization', `Bearer ${makeToken()}`);
      const res = await (payload === undefined ? req : req.send(payload));

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ id: 'job-001' });
      expect(mockCreateJob).toHaveBeenCalledWith(SESSION_ID, ADMIN.userId);
      expect(mockCreateJobV2).not.toHaveBeenCalled();
      expect(mockGetEligibilityV2).not.toHaveBeenCalled();
    });

    it('a member still gets the old "coming soon" refusal: a director is not an admin to the old rule', async () => {
      const app = createApp(CLAUS);
      mockGetEligibility.mockResolvedValueOnce(eligDisabled);

      const res = await request(app)
        .post(`/sessions/${SESSION_ID}/post-event-message`)
        .set('Authorization', `Bearer ${makeToken(CLAUS.userId)}`);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('This feature is coming soon');
      expect(mockCreateJob).not.toHaveBeenCalled();
    });
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

const organiserAccess = { isOrganiser: true, isHost: true, isCohost: false, isPodOrganiser: false, isAdmin: false, status: 'completed', timeZone: null };
const guestAccess = { ...organiserAccess, isOrganiser: false, isHost: false };

describe('GET /sessions/:sessionId/post-event-message/status', () => {
  it('returns the latest job when one exists', async () => {
    const app = createApp();

    mockGetAccess.mockResolvedValueOnce({ ...organiserAccess, isAdmin: true });
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

    mockGetAccess.mockResolvedValueOnce(organiserAccess);
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

  // Until 26 Oct any member could read any event's send counts by guessing an id.
  describe('is for the people running the event, and admins', () => {
    it('a plain participant is refused, and the job is never read for them', async () => {
      const app = createApp(GUEST);
      mockGetAccess.mockResolvedValueOnce(guestAccess);

      const res = await request(app)
        .get(`/sessions/${SESSION_ID}/post-event-message/status`)
        .set('Authorization', `Bearer ${makeToken(GUEST.userId)}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
      expect(res.body.error.message).toBe('Only the people running this event can see this.');
      expect(mockGetLatestJob).not.toHaveBeenCalled();
    });

    it('asks who the caller is to the event with their own id and the role from their sign-in', async () => {
      const app = createApp(CLAUS);
      mockGetAccess.mockResolvedValueOnce(organiserAccess);
      mockGetLatestJob.mockResolvedValueOnce(mockJob);

      await request(app)
        .get(`/sessions/${SESSION_ID}/post-event-message/status`)
        .set('Authorization', `Bearer ${makeToken(CLAUS.userId)}`);

      expect(mockGetAccess).toHaveBeenCalledWith(CLAUS.userId, 'member', SESSION_ID);
    });

    it('an event that does not exist is a 404, not an empty answer', async () => {
      const app = createApp();
      mockGetAccess.mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/sessions/${SESSION_ID}/post-event-message/status`)
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(404);
      expect(mockGetLatestJob).not.toHaveBeenCalled();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Version 2 — the organiser's own words
// ═════════════════════════════════════════════════════════════════════════════

describe('GET …/eligibility?v=2', () => {
  it('answers with the version 2 rule for this person, this event, and the role from their sign-in', async () => {
    const app = createApp(CLAUS);
    mockGetEligibilityV2.mockResolvedValueOnce(v2Ok);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/eligibility?v=2`)
      .set('Authorization', `Bearer ${makeToken(CLAUS.userId)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: v2Ok });
    expect(mockGetEligibilityV2).toHaveBeenCalledWith(CLAUS.userId, 'member', SESSION_ID);
    expect(mockGetEligibility).not.toHaveBeenCalled();
  });

  it('a person who does not run the event gets a 200 with visible:false, which is not an error', async () => {
    const app = createApp(GUEST);
    const hidden = { enabled: false, visible: false, reason: 'not_organiser', explanation: '', audience: { tookPart: 0, registeredNoShow: 0 } };
    mockGetEligibilityV2.mockResolvedValueOnce(hidden);

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/eligibility?v=2`)
      .set('Authorization', `Bearer ${makeToken(GUEST.userId)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(hidden);
  });

  it('an event that does not exist is a 404', async () => {
    const app = createApp();
    mockGetEligibilityV2.mockRejectedValueOnce(new NotFoundError('Session', SESSION_ID));

    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/post-event-message/eligibility?v=2`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

describe('POST with a body (version 2)', () => {
  const post = (app: express.Express, payload: unknown, who: Caller = CLAUS, query = '') =>
    request(app)
      .post(`/sessions/${SESSION_ID}/post-event-message${query}`)
      .set('Authorization', `Bearer ${makeToken(`${who.userId}-${(tokenSeq += 1)}`)}`)
      .send(payload as object);

  it('sends the organiser\'s words: checked with the version 2 rule, job made with the text as written, 201', async () => {
    const app = createApp(CLAUS);
    mockGetEligibilityV2.mockResolvedValueOnce(v2Ok);
    mockCreateJobV2.mockResolvedValueOnce(mockJob);

    const res = await post(app, { body: 'Thank you all for coming.\n\nThe recording is on its way.', includeNoShows: true });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: mockJob });
    expect(mockGetEligibilityV2).toHaveBeenCalledWith(CLAUS.userId, 'member', SESSION_ID);
    expect(mockCreateJobV2).toHaveBeenCalledWith(SESSION_ID, CLAUS.userId, {
      body: 'Thank you all for coming.\n\nThe recording is on its way.',
      includeNoShows: true,
    });
    // None of version 1 is involved.
    expect(mockGetEligibility).not.toHaveBeenCalled();
    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('does not message the people who never came unless asked', async () => {
    const app = createApp(CLAUS);
    mockGetEligibilityV2.mockResolvedValueOnce(v2Ok);
    mockCreateJobV2.mockResolvedValueOnce(mockJob);

    await post(app, { body: 'Thanks' });

    expect(mockCreateJobV2.mock.calls[0][2]).toEqual({ body: 'Thanks', includeNoShows: false });
  });

  it('takes the spaces and blank lines off the ends of the text and nothing else', async () => {
    const app = createApp(CLAUS);
    mockGetEligibilityV2.mockResolvedValueOnce(v2Ok);
    mockCreateJobV2.mockResolvedValueOnce(mockJob);

    await post(app, { body: '  \n  Hi all,\n\n   keep   the   spacing   \n ' });

    expect(mockCreateJobV2.mock.calls[0][2].body).toBe('Hi all,\n\n   keep   the   spacing');
  });

  it('accepts exactly 2000 characters', async () => {
    const app = createApp(CLAUS);
    mockGetEligibilityV2.mockResolvedValueOnce(v2Ok);
    mockCreateJobV2.mockResolvedValueOnce(mockJob);

    const res = await post(app, { body: 'x'.repeat(2000) });

    expect(res.status).toBe(201);
    expect(mockCreateJobV2.mock.calls[0][2].body).toHaveLength(2000);
  });

  it('asks the version 2 rule also when only ?v=2 is on the call, and then insists on a body', async () => {
    const app = createApp(CLAUS);

    const res = await post(app, {}, CLAUS, '?v=2');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Write a message first.');
    expect(mockCreateJob).not.toHaveBeenCalled(); // a forgotten body must never fall back to a template for everyone
    expect(mockCreateJobV2).not.toHaveBeenCalled();
  });

  describe('a body that cannot be sent is a 400 with a sentence a person can read, and nothing runs', () => {
    it.each([
      ['an empty string', { body: '' }, 'Write a message first.'],
      ['only spaces and lines', { body: '   \n\t  ' }, 'Write a message first.'],
      ['null', { body: null }, 'Write a message first.'],
      ['a number', { body: 12345 }, 'Write a message first.'],
      ['a list', { body: ['a', 'b'] }, 'Write a message first.'],
      ['an object', { body: { text: 'hi' } }, 'Write a message first.'],
      ['2001 characters', { body: 'x'.repeat(2001) }, 'Messages can be up to 2000 characters.'],
      ['a character the database cannot hold', { body: 'hello\u0000world' }, 'That message has a character that cannot be sent.'],
    ])('%s', async (_name, payload, message) => {
      const app = createApp(CLAUS);

      const res = await post(app, payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe(message);
      expect(mockGetEligibilityV2).not.toHaveBeenCalled();
      expect(mockCreateJobV2).not.toHaveBeenCalled();
      expect(mockCreateJob).not.toHaveBeenCalled(); // an invalid body never turns into the old template send
    });

    it('a yes/no choice that is not a yes or no', async () => {
      const app = createApp(CLAUS);

      const res = await post(app, { body: 'Thanks', includeNoShows: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Choose whether to include the people who did not come.');
      expect(mockCreateJobV2).not.toHaveBeenCalled();
    });
  });

  describe('when it cannot be sent right now, the reason is the answer', () => {
    const refusal = (reason: string, explanation: string, extra: object = {}) => ({
      enabled: false, visible: true, reason, explanation, audience: { tookPart: 1, registeredNoShow: 0 }, ...extra,
    });

    it('someone who does not run the event is refused with a 403, and nothing is made', async () => {
      const app = createApp(GUEST);
      mockGetEligibilityV2.mockResolvedValueOnce({
        enabled: false, visible: false, reason: 'not_organiser', explanation: '', audience: { tookPart: 0, registeredNoShow: 0 },
      });

      const res = await post(app, { body: 'Hello everyone' }, GUEST);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
      expect(res.body.error.message).toBe('Only the people running this event can message everyone.');
      expect(mockCreateJobV2).not.toHaveBeenCalled();
    });

    it.each([
      ['not_ended', 'You can message everyone after the event ends.'],
      ['no_recipients', 'Nobody else took part in this event.'],
      ['limit', 'You can send another message at 14:20.'],
    ])('%s: a 409 that says exactly what the screen would have said', async (reason, explanation) => {
      const app = createApp(CLAUS);
      mockGetEligibilityV2.mockResolvedValueOnce(refusal(reason, explanation));

      const res = await post(app, { body: 'Hello everyone' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(explanation);
      expect(mockCreateJobV2).not.toHaveBeenCalled();
    });

    it('a send is already going out: a 409 that says whose, from the job', async () => {
      const app = createApp(CLAUS);
      mockGetEligibilityV2.mockResolvedValueOnce(refusal('sending', 'Sending… 3 of 40.'));
      mockConflictForActiveSend.mockResolvedValueOnce(
        new ConflictError(ErrorCodes.VALIDATION_ERROR, "Another organiser's message is being sent; try again in a minute."),
      );

      const res = await post(app, { body: 'Hello everyone' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe("Another organiser's message is being sent; try again in a minute.");
      expect(mockConflictForActiveSend).toHaveBeenCalledWith(SESSION_ID, CLAUS.userId);
      expect(mockCreateJobV2).not.toHaveBeenCalled();
    });

    it('two organisers pressing Send at the same moment: the one who loses the race is told plainly', async () => {
      const app = createApp(CLAUS);
      mockGetEligibilityV2.mockResolvedValueOnce(v2Ok); // both passed the check
      mockCreateJobV2.mockRejectedValueOnce(
        new ConflictError(ErrorCodes.VALIDATION_ERROR, "Another organiser's message is being sent; try again in a minute."),
      );

      const res = await post(app, { body: 'Hello everyone' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe("Another organiser's message is being sent; try again in a minute.");
      expect(mockReportProgress).not.toHaveBeenCalled(); // nothing started, so nobody is told it did
    });

    it('an event that does not exist is a 404', async () => {
      const app = createApp(CLAUS);
      mockGetEligibilityV2.mockRejectedValueOnce(new NotFoundError('Session', SESSION_ID));
      const res = await post(app, { body: 'Hello everyone' });
      expect(res.status).toBe(404);
    });
  });

  it('tells the sender and the other organisers it started, once the job exists', async () => {
    const app = createApp(CLAUS);
    mockGetEligibilityV2.mockResolvedValueOnce(v2Ok);
    mockCreateJobV2.mockResolvedValueOnce(mockJob);
    mockResolveAudience.mockResolvedValueOnce([CLAUS.userId, 'host-1']);

    await post(app, { body: 'Hello everyone' });

    expect(mockResolveAudience).toHaveBeenCalledWith(SESSION_ID, CLAUS.userId);
    expect(mockReportProgress).toHaveBeenCalledWith(fakeIo, [CLAUS.userId, 'host-1'], SESSION_ID);
  });
});

// ─── Malformed ids ────────────────────────────────────────────────────────────

describe('an id that is not an id', () => {
  it.each([
    ['get', '/sessions/not-a-uuid/post-event-message/eligibility'],
    ['get', '/sessions/not-a-uuid/post-event-message/eligibility?v=2'],
    ['get', '/sessions/not-a-uuid/post-event-message/preview'],
    ['post', '/sessions/not-a-uuid/post-event-message'],
    ['get', '/sessions/not-a-uuid/post-event-message/status'],
  ] as const)('%s %s is a 404 before anything is read', async (method, path) => {
    const app = createApp();

    const res = await request(app)[method](path).set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockGetEligibility).not.toHaveBeenCalled();
    expect(mockGetEligibilityV2).not.toHaveBeenCalled();
    expect(mockGetAccess).not.toHaveBeenCalled();
  });
});

// ─── The send is rate limited ─────────────────────────────────────────────────

describe('sending is rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlersOf = (method: string, path: string) =>
    (postEventMessageRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it('the send carries postEventMessageLimiter, after authenticate and ahead of its handler', () => {
    const handlers = handlersOf('post', '/:sessionId/post-event-message');
    const at = handlers.indexOf(postEventMessageLimiter);
    const signedIn = handlers.indexOf(authModule.authenticate);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });

  it('refuses the 11th send in an hour with a friendly 429, for that person only', async () => {
    const heavy: Caller = { userId: 'user-heavy', role: 'admin' };
    const other: Caller = { userId: 'user-other', role: 'admin' };
    const app = createApp(heavy);
    mockGetEligibility.mockResolvedValue(eligEnabled);
    mockDbQuery.mockResolvedValue({ rows: [{ status: 'completed' }] });
    mockCreateJob.mockResolvedValue(mockJob);

    const send = (who: Caller) =>
      request(app).post(`/sessions/${SESSION_ID}/post-event-message`).set('Authorization', `Bearer ${makeToken(who.userId)}`);

    for (let i = 0; i < 10; i += 1) expect((await send(heavy)).status).toBe(201);
    const refused = await send(heavy);
    expect(refused.status).toBe(429);
    expect(refused.body.success).toBe(false);
    expect(refused.body.error.message).toBe('You have sent a lot of messages this hour. Please try again later.');

    mockCreateJob.mockClear();
    expect((await send(other)).status).toBe(201); // someone else on the same network is not held up
    expect(mockCreateJob).toHaveBeenCalledTimes(1);
  });
});
