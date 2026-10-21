// ─── POST /join-requests remembers the site it was made on (7 Oct 2026) ──────
//
// Browsers send an Origin header on a cross-site fetch, which is how the preview's
// request form reaches the API. The route hands it to the service, which keeps it only
// when it is one of our own sites and not the main app (the live app stores nothing, so
// nothing changes for it). The header is the caller's to forge, and so is the body, so
// neither may ever store a site that is not ours or choose what is stored.
//
// These go through express with the real router and service; only the database and the
// emails are stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 15,
    // As in production: the main app is app.rsn.network, so the preview is a different site of ours.
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({
  sendJoinRequestConfirmationEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestDeclineEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestReminderEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestAdminReviewEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/onboarding/providers/registry', () => ({
  resolveEnrichProvider: () => 'none',
  runProvider: jest.fn(),
  resultFromOutcome: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/onboarding/enrichment.service', () => ({
  applyMatchVerification: jest.fn(),
  normalizeLinkedinUrl: jest.fn(),
  __esModule: true,
}));
jest.mock('../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import joinRequestRoutes from '../../routes/join-requests';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';

const app = express();
app.use(express.json());
app.use('/join-requests', joinRequestRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const BODY = { fullName: 'Sam Applicant', email: 'sam@example.com', linkedinUrl: 'https://www.linkedin.com/in/sam', reason: 'I run a studio' };

beforeEach(() => {
  mockQuery.mockReset().mockImplementation((text: string, params: unknown[] = []) => {
    if (/SELECT id FROM join_requests WHERE email/.test(text)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO join_requests/.test(text)) {
      return Promise.resolve({ rows: [{
        id: 'jr-1', full_name: params[0], email: params[1], linkedin_url: params[2], reason: params[3], status: 'pending', sign_in_origin: params[4],
        created_at: new Date('2026-10-07T10:00:00Z'), updated_at: new Date('2026-10-07T10:00:00Z'),
      }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

function submit(origin?: string, body: object = BODY) {
  const req = request(app).post('/join-requests').send(body);
  return origin === undefined ? req : req.set('Origin', origin);
}
const insert = () => mockQuery.mock.calls.find((c) => /INSERT INTO join_requests/.test(String(c[0])));
const storedOrigin = () => (insert()![1] as unknown[])[4];

describe('POST /join-requests: the site the request is made on', () => {
  it('stores the preview when the form was sent from the preview', async () => {
    const res = await submit(PREVIEW);
    expect(res.status).toBe(201);
    expect(storedOrigin()).toBe(PREVIEW);
  });

  it('stores nothing when it was sent from the main app: the live app is exactly as before', async () => {
    const res = await submit(MAIN);
    expect(res.status).toBe(201);
    expect(storedOrigin()).toBeNull();
  });

  it('stores nothing when there is no Origin header', async () => {
    expect((await submit()).status).toBe(201);
    expect(storedOrigin()).toBeNull();
  });

  it.each([
    'https://evil.example',
    'https://preview.rsn.network.evil.example',
    'https://preview.rsn.network@evil.example',
    'http://preview.rsn.network',
    'https://api.rsn.network',
    'http://localhost:5173',
    'null',
  ])('stores nothing for a forged Origin of %j, and still takes the request', async (origin) => {
    const res = await submit(origin);
    expect(res.status).toBe(201);
    expect(storedOrigin()).toBeNull();
  });

  it('the body cannot choose the stored site, with or without an Origin', async () => {
    const naming = { ...BODY, sign_in_origin: PREVIEW, signInOrigin: PREVIEW, origin: PREVIEW };
    expect((await submit(undefined, naming)).status).toBe(201);
    expect(storedOrigin()).toBeNull();

    mockQuery.mockClear();
    expect((await submit(MAIN, naming)).status).toBe(201);
    expect(storedOrigin()).toBeNull();
    expect(insert()![1]).toHaveLength(5);
  });

  it('answers as before: 201 and the request, which does not carry the site', async () => {
    const res = await submit(PREVIEW);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: 'jr-1', fullName: BODY.fullName, email: BODY.email, status: 'pending' });
    expect(res.body.data).not.toHaveProperty('signInOrigin');
    expect(res.body.data).not.toHaveProperty('sign_in_origin');
  });

  it('still refuses a second pending request with a 409, and stores nothing', async () => {
    mockQuery.mockImplementationOnce(() => Promise.resolve({ rows: [{ id: 'jr-0' }] }));
    const res = await submit(PREVIEW);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('You already have a pending request.');
    expect(insert()).toBeUndefined();
  });

  it('still refuses an invalid request with a 400, and stores nothing', async () => {
    const res = await submit(PREVIEW, { ...BODY, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(insert()).toBeUndefined();
  });
});
