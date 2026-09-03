// ─── GET /users/find (13 Aug 2026, Task C1) ──────────────────────────────────
// The member-facing people search. Pins: it needs auth, it hands the caller's
// own id to the service (so self and blocks are excluded server-side), it is
// registered ahead of /:id so "find" is never read as a user id, and the
// admin-only /users/search is untouched.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
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
jest.mock('../../services/onboarding/avatar.service', () => ({
  __esModule: true,
  getAvatarBlob: jest.fn(),
  captureAvatar: jest.fn(),
}));
jest.mock('../../services/user/user-search.service', () => ({
  __esModule: true,
  searchMembers: jest.fn(),
}));
jest.mock('../../services/identity/identity.service', () => ({
  __esModule: true,
  getUsers: jest.fn(),
  getUserById: jest.fn(),
}));

import userRoutes from '../../routes/users';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { searchMembers } from '../../services/user/user-search.service';
import * as identityService from '../../services/identity/identity.service';

const app = express();
app.use(express.json());
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub = 'user-seeker', role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, displayName: 'Seeker', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => {
  jest.clearAllMocks();
  (searchMembers as jest.Mock).mockResolvedValue([]);
});

describe('GET /users/find', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/users/find?q=claus');
    expect(res.status).toBe(401);
    expect(searchMembers).not.toHaveBeenCalled();
  });

  it('searches as the caller, with the query and a parsed limit', async () => {
    (searchMembers as jest.Mock).mockResolvedValue([
      { userId: 'u-2', displayName: 'Claus', avatarUrl: null, jobTitle: 'CEO', company: 'Vokt', location: null },
    ]);
    const res = await request(app)
      .get('/users/find?q=claus&limit=5')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(searchMembers).toHaveBeenCalledWith('user-seeker', 'claus', 5);
  });

  it('a plain member may use it — this is not the admin search', async () => {
    const res = await request(app)
      .get('/users/find?q=claus')
      .set('Authorization', `Bearer ${token('user-plain', 'member')}`);
    expect(res.status).toBe(200);
  });

  it('is registered ahead of /:id, so "find" is never looked up as a user id', async () => {
    const res = await request(app)
      .get('/users/find?q=claus')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(identityService.getUserById).not.toHaveBeenCalled();
  });

  it('the admin-only /users/search stays admin-only', async () => {
    const res = await request(app)
      .get('/users/search?q=claus')
      .set('Authorization', `Bearer ${token('user-plain', 'member')}`);
    expect(res.status).toBe(403);
  });
});
