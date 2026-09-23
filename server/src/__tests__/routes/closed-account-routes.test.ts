// ─── Closed accounts through the real router (23 Sep 2026) ───────────────────
//
// The client reads err.response.data.error.code to say WHY sign-in failed, and
// treats a 401 from /auth/refresh as final but a 403 elsewhere as an answer.
// Those shapes are decided by the route + error handler, so these go through
// express with the real identity service and only the database mocked.
// Also: closing or deleting an account now leaves an audit record, because on
// 23 Sep nobody could tell who had deleted Shradha's accounts.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.test', apiBaseUrl: 'https://api.test',
    googleClientId: 'gid', googleClientSecret: 'gsecret',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({ sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined), __esModule: true }));

// Every account in this file is closed, except the admin doing the closing.
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: jest.fn(),
  __esModule: true,
}));

import authRoutes from '../../routes/auth';
import userRoutes from '../../routes/users';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const closedUser = { id: '11111111-1111-1111-1111-111111111111', email: 'shradha@vokt.ai', displayName: 'Shradha', role: 'member', status: 'deactivated' };
const ADMIN = '22222222-2222-2222-2222-222222222222';

function answer(sql: string) {
  if (/FROM magic_links WHERE token_hash/.test(sql)) {
    return { rows: [{ id: 'ml-1', email: closedUser.email, expires_at: new Date(Date.now() + 3_600_000), used_at: null }] };
  }
  if (/SELECT status FROM users WHERE id/.test(sql)) return { rows: [{ status: 'active' }] }; // the admin's own request
  if (/FROM refresh_tokens WHERE token_hash/.test(sql)) return { rows: [{ id: 'rt-1', revoked_at: null }] };
  if (/FROM users WHERE (email|id) =/.test(sql)) return { rows: [closedUser] };
  return { rows: [], rowCount: 1 };
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const realFetch = global.fetch;
beforeEach(() => {
  mockQuery.mockReset().mockImplementation((sql: string) => Promise.resolve(answer(sql)));
});
afterAll(() => { global.fetch = realFetch; });

const sessionWritten = () => mockQuery.mock.calls.some(c => /INSERT INTO refresh_tokens/.test(String(c[0])));

describe('a closed account at every sign-in door', () => {
  it('POST /auth/magic-link → 403 ACCOUNT_CLOSED with the reason in words', async () => {
    const res = await request(app).post('/auth/magic-link').send({ email: 'shradha@vokt.ai' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_CLOSED');
    expect(res.body.error.message).toMatch(/closed\. Ask to join again/);
  });

  it('POST /auth/verify → 403 ACCOUNT_CLOSED, and no session is written', async () => {
    const res = await request(app).post('/auth/verify').send({ token: 'a'.repeat(64) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_CLOSED');
    expect(sessionWritten()).toBe(false);
  });

  it('POST /auth/refresh → 401 that still names the reason', async () => {
    const rt = jwt.sign({ sub: closedUser.id, sessionId: 's', type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
    const res = await request(app).post('/auth/refresh').send({ refreshToken: rt });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_CLOSED');
    expect(sessionWritten()).toBe(false);
  });

  it('Google → back to the login page with ?error=ACCOUNT_CLOSED, not the generic failure', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ json: async () => ({ access_token: 'g-token' }) })
      .mockResolvedValueOnce({ json: async () => ({ email: 'shradha@vokt.ai', name: 'Shradha' }) }) as unknown as typeof fetch;

    const res = await request(app).get('/auth/google/callback').query({ code: 'c', state: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.test/login?error=ACCOUNT_CLOSED');
    expect(sessionWritten()).toBe(false);
  });
});

describe('who closed an account is on record', () => {
  const adminToken = (role: string) => jwt.sign({ sub: ADMIN, email: 'a@rsn', role, sessionId: 's' }, JWT_SECRET, { expiresIn: '1h' });
  const audits = () => mockQuery.mock.calls.filter(c => /INSERT INTO audit_log/.test(String(c[0]))).map(c => c[1] as unknown[]);

  it('Remove (status → deactivated) writes user.status_changed with the admin as actor', async () => {
    const res = await request(app).put(`/users/${closedUser.id}/status`)
      .set('Authorization', `Bearer ${adminToken('admin')}`).send({ status: 'deactivated' });
    expect(res.status).toBe(200);
    const [row] = audits();
    expect(row.slice(0, 4)).toEqual([ADMIN, 'user.status_changed', 'user', closedUser.id]);
    expect(JSON.parse(String(row[4]))).toEqual({ status: 'deactivated' });
  });

  it('Delete Forever writes user.deleted with the admin as actor', async () => {
    const res = await request(app).delete(`/users/${closedUser.id}`)
      .set('Authorization', `Bearer ${adminToken('super_admin')}`);
    expect(res.status).toBe(200);
    const [row] = audits();
    expect(row.slice(0, 4)).toEqual([ADMIN, 'user.deleted', 'user', closedUser.id]);
  });
});
