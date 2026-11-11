// ─── The admin inspector's profile read (Shirley pilot S6 fix round 1) ──────────────────────────────────────────────
// GET /users/:id answers a block in either direction with the unknown 404, admins included. A member under investigation
// could therefore block every admin and blind the inspector, so the inspector reads GET /admin/users/:id, which asks
// about no block and is for admins only. GET /users/:id keeps its block rule for everyone.

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
// authenticate() reads the caller's status and kind; every caller here is an active member account.
jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const SUBJECT = '5ab1ec70-0000-4000-8000-00000000005b';
const subject = {
  id: SUBJECT, email: 'subject@example.com', displayName: 'Bart Q', firstName: 'Bart', lastName: 'Q',
  whoIWantToMeet: 'founders', status: 'active', role: 'member',
};
const mockGetUser = jest.fn();
jest.mock('../../services/identity/identity.service', () => ({
  __esModule: true,
  getUserById: (...a: unknown[]) => mockGetUser(...a),
  getUsers: jest.fn(),
}));
const mockAreBlocked = jest.fn();
jest.mock('../../services/block/block.service', () => ({ __esModule: true, areBlocked: (...a: unknown[]) => mockAreBlocked(...a) }));

import adminInspectRoutes from '../../routes/admin-inspect';
import userRoutes from '../../routes/users';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { NotFoundError } from '../../middleware/errors';

const app = express();
app.use(express.json());
app.use('/api/admin', adminInspectRoutes);
app.use('/api/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const auth = (sub: string, role: string) => ({
  Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}`,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockImplementation((id: string) => (id === SUBJECT ? Promise.resolve(subject) : Promise.reject(new NotFoundError('User', id))));
  // The member under investigation has blocked every admin (and the admins them).
  mockAreBlocked.mockResolvedValue(true);
});

describe('GET /api/admin/users/:id', () => {
  it.each(['admin', 'super_admin'])('a member who blocked the %s still opens in the inspector, with the full row', async (role) => {
    const res = await request(app).get(`/api/admin/users/${SUBJECT}`).set(auth('u-admin', role));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: SUBJECT, email: 'subject@example.com', displayName: 'Bart Q', whoIWantToMeet: 'founders' });
    expect(mockAreBlocked).not.toHaveBeenCalled();
  });

  it('is refused to a plain member (403) and reads nothing', async () => {
    const res = await request(app).get(`/api/admin/users/${SUBJECT}`).set(auth('u-member', 'member'));
    expect(res.status).toBe(403);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('refuses no sign-in (401), a malformed id (400) and answers an unknown id 404', async () => {
    expect((await request(app).get(`/api/admin/users/${SUBJECT}`)).status).toBe(401);
    expect((await request(app).get('/api/admin/users/not-a-member').set(auth('u-admin', 'admin'))).status).toBe(400);
    expect((await request(app).get('/api/admin/users/5ab1ec70-0000-4000-8000-0000000000ff').set(auth('u-admin', 'admin'))).status).toBe(404);
  });
});

describe('GET /api/users/:id keeps its block rule for everyone', () => {
  it('a plain member in a block gets the unknown 404', async () => {
    const res = await request(app).get(`/api/users/${SUBJECT}`).set(auth('u-member', 'member'));
    expect(res.status).toBe(404);
  });

  it('so does an admin on the member-facing read; the inspector does not use it', async () => {
    expect((await request(app).get(`/api/users/${SUBJECT}`).set(auth('u-admin', 'admin'))).status).toBe(404);
    const inspector = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/admin/AdminUserInspectorPage.tsx'), 'utf8');
    expect(inspector).toMatch(/queryFn: \(\) => api\.get\(`\/admin\/users\/\$\{encodeURIComponent\(id \?\? ''\)\}`\)/);
    expect(inspector).not.toMatch(/api\.get\(`\/users\/\$\{id\}`\)/);
    expect(inspector).toMatch(/meta: \{ entities: id \? \[E\.user\(id\), E\.adminUsers\] : \[E\.adminUsers\] \}/);
  });
});
