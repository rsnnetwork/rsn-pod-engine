// ─── /auth/onboarding/complete gate tests ───────────────────────────────────
// Guards against regressions in the mandatory-onboarding flow. The endpoint
// must (a) reject bodies missing any of the 5 required fields and (b) on a
// complete body, persist the fields, flip onboarding_completed + profile_complete
// to TRUE, and derive first_name / last_name when absent.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

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

jest.mock('../../services/identity/identity.service');

import { query as dbQuery } from '../../db';
import authRoutes from '../../routes/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { invalidateUserStatusCache } from '../../middleware/auth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(userId = 'user-abc') {
  return jwt.sign(
    { sub: userId, email: 'u@e.com', role: 'member', sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

const validBody = {
  displayName: 'Jane Doe',
  company: 'Acme Inc',
  jobTitle: 'Founder',
  industry: 'SaaS',
  reasonsToConnect: ['mentorship', 'hiring'],
};

describe('POST /auth/onboarding/complete', () => {
  const app = createApp();

  // Each test gets a unique userId so the auth middleware's status cache
  // doesn't leak between tests (the cache is module-level and persists
  // across beforeEach/jest.clearAllMocks).
  let testCounter = 0;
  function freshUserId() {
    testCounter += 1;
    return `user-onboard-${testCounter}`;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: auth middleware's SELECT status query returns 'active'.
    (dbQuery as jest.Mock).mockResolvedValue({ rows: [{ status: 'active' }], rowCount: 1 });
  });

  afterAll(() => {
    // Clear any cached statuses so these tests don't affect subsequent suites.
    for (let i = 1; i <= testCounter; i++) invalidateUserStatusCache(`user-onboard-${i}`);
  });

  it('rejects a request with no body (all required fields missing)', async () => {
    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields).toBeDefined();
    // Should flag at least the missing displayName + company + jobTitle + industry + reasonsToConnect
    const fields = Object.keys(res.body.error.fields);
    expect(fields.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a request with empty displayName', async () => {
    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send({ ...validBody, displayName: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields.displayName).toBeDefined();
  });

  it('rejects a request with empty company', async () => {
    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send({ ...validBody, company: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.company).toBeDefined();
  });

  it('rejects a request with empty reasonsToConnect array', async () => {
    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send({ ...validBody, reasonsToConnect: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.reasonsToConnect).toBeDefined();
  });

  it('rejects a request without authentication', async () => {
    const res = await request(app)
      .post('/auth/onboarding/complete')
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it('accepts a valid body, persists fields, and marks both flags true', async () => {
    // Sequence of DB queries the handler will make after auth middleware:
    //   1. Auth middleware: SELECT status FROM users — returns 'active'
    //   2. Handler: SELECT first_name, last_name FROM users — returns existing names
    //   3. Handler: UPDATE users SET display_name, first_name, last_name, company,
    //              job_title, industry, reasons_to_connect, onboarding_completed
    //   4. Handler: SELECT first_name, last_name, display_name, company, job_title,
    //              industry, reasons_to_connect (for profile_complete recompute)
    //   5. Handler: UPDATE users SET profile_complete
    (dbQuery as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 })           // auth middleware
      .mockResolvedValueOnce({ rows: [{ first_name: 'Jane', last_name: 'Doe' }], rowCount: 1 }) // existing names
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                                 // UPDATE users SET ...
      .mockResolvedValueOnce({                                                          // SELECT for recompute
        rows: [{
          first_name: 'Jane', last_name: 'Doe', display_name: 'Jane Doe',
          company: 'Acme Inc', job_title: 'Founder', industry: 'SaaS',
          reasons_to_connect: ['mentorship', 'hiring'],
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });                                // UPDATE profile_complete

    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.onboardingCompleted).toBe(true);
    expect(res.body.data.profileComplete).toBe(true);

    // Verify the UPDATE writes the fields
    const updateCall = (dbQuery as jest.Mock).mock.calls.find(c => /UPDATE users[\s\S]*onboarding_completed/.test(c[0]));
    expect(updateCall).toBeDefined();
    // Params order: [userId, displayName, firstName, lastName, company, jobTitle, industry, reasonsToConnect]
    expect(updateCall![1][1]).toBe('Jane Doe');
    expect(updateCall![1][4]).toBe('Acme Inc');
    expect(updateCall![1][5]).toBe('Founder');
    expect(updateCall![1][6]).toBe('SaaS');
    expect(updateCall![1][7]).toEqual(['mentorship', 'hiring']);

    // Verify the final profile_complete UPDATE was called with TRUE
    const completeCall = (dbQuery as jest.Mock).mock.calls.find(c => /SET profile_complete/.test(c[0]));
    expect(completeCall).toBeDefined();
    expect(completeCall![1][0]).toBe(true);
  });

  it('sets onboarding_status to completed and stamps last_onboarded_at in the same UPDATE (closes the loop trap)', async () => {
    (dbQuery as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 })           // auth middleware
      .mockResolvedValueOnce({ rows: [{ first_name: 'Jane', last_name: 'Doe' }], rowCount: 1 }) // existing names
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                                 // UPDATE users SET ...
      .mockResolvedValueOnce({                                                          // SELECT for recompute
        rows: [{
          first_name: 'Jane', last_name: 'Doe', display_name: 'Jane Doe',
          company: 'Acme Inc', job_title: 'Founder', industry: 'SaaS',
          reasons_to_connect: ['mentorship', 'hiring'],
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });                                // UPDATE profile_complete

    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send(validBody);

    expect(res.status).toBe(200);

    // A status-keyed route guard (D2) redirects on onboarding_status, not just
    // onboarding_completed — the form-fallback path must set BOTH in the same
    // UPDATE or a user completing via the form stays 'not_started'/'update_required'
    // and gets redirected back into onboarding forever.
    const updateCall = (dbQuery as jest.Mock).mock.calls.find(c => /UPDATE users[\s\S]*onboarding_completed/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toMatch(/onboarding_status\s*=\s*'completed'/i);
    expect(updateCall![0]).toMatch(/last_onboarded_at\s*=\s*NOW\(\)/i);
  });

  it('backfills first_name and last_name from displayName when missing', async () => {
    (dbQuery as jest.Mock).mockReset();
    (dbQuery as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ first_name: null, last_name: null }], rowCount: 1 }) // empty names
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          first_name: 'Jane', last_name: 'Doe', display_name: 'Jane Doe',
          company: 'Acme Inc', job_title: 'Founder', industry: 'SaaS',
          reasons_to_connect: ['mentorship', 'hiring'],
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send(validBody);

    expect(res.status).toBe(200);
    const updateCall = (dbQuery as jest.Mock).mock.calls.find(c => /UPDATE users[\s\S]*onboarding_completed/.test(c[0]));
    // firstName = "Jane", lastName = "Doe" derived from "Jane Doe"
    expect(updateCall![1][2]).toBe('Jane');
    expect(updateCall![1][3]).toBe('Doe');
  });

  it('keeps profile_complete false when backend still sees missing fields after save', async () => {
    (dbQuery as jest.Mock).mockReset();
    // Simulate: someone bypassed the server-side save and the reasons_to_connect
    // column is still empty after UPDATE — profile_complete should NOT flip TRUE.
    (dbQuery as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ status: 'active' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ first_name: 'Jane', last_name: 'Doe' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          first_name: 'Jane', last_name: 'Doe', display_name: 'Jane Doe',
          company: 'Acme Inc', job_title: 'Founder', industry: 'SaaS',
          reasons_to_connect: [], // still empty — shouldn't happen in practice but guard
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(app)
      .post('/auth/onboarding/complete')
      .set('Authorization', `Bearer ${makeToken(freshUserId())}`)
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.data.onboardingCompleted).toBe(true);
    expect(res.body.data.profileComplete).toBe(false);

    const completeCall = (dbQuery as jest.Mock).mock.calls.find(c => /SET profile_complete/.test(c[0]));
    expect(completeCall![1][0]).toBe(false);
  });
});
