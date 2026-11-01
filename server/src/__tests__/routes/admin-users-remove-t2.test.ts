// ─── The admin Users page answers, and a removed member's card no longer opens (T2, 1 Nov 2026) ─────────────────
//
// 30 Oct: Stefan removed two accounts twice each because the rows never left the list (the Active tab sent no status,
// and the list held every status). The list now says how many accounts each status tab holds, every status change is
// on record and reaches everyone who could be looking at the person, and another member opening a removed person's old
// profile page is told in words that they are no longer a member.
//
// Production's own admin client (origin/main client/src/features/admin/AdminUsersPage.tsx) keeps working exactly as
// before: it asks GET /users?page=&pageSize=[&search=][&role=][&status=deactivated|banned], and acts with
// PUT /users/:id/status { status }, PUT /users/:id/role { role }, DELETE /users/:id and POST /admin/users/bulk-action.
// Each of those request shapes is driven here and answers with the fields it read before.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/onboarding/avatar.service', () => ({ __esModule: true, getAvatarBlob: jest.fn(), captureAvatar: jest.fn() }));
jest.mock('../../services/user/user-search.service', () => ({ __esModule: true, searchMembers: jest.fn() }));
jest.mock('../../services/invite/connected-users', () => ({ __esModule: true, searchConnectedUsers: jest.fn() }));
jest.mock('../../services/identity/identity.service', () => ({
  __esModule: true,
  getUsers: jest.fn(),
  getUserById: jest.fn(),
  updateUserStatus: jest.fn(),
  updateUserRole: jest.fn(),
  deleteUser: jest.fn(),
}));
jest.mock('../../middleware/audit', () => ({ __esModule: true, recordAudit: jest.fn(async () => {}), auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  accountAudience: jest.fn(async () => ({ podIds: ['pod-1'], events: [], people: ['u-friend'], groupIds: [], circleIds: [] })),
  fanoutAccountAudience: jest.fn(async () => {}),
  fanoutAccountStatusChange: jest.fn(async () => {}),
  fanoutAdminEntities: jest.fn(async () => {}),
  fanoutPodEntities: jest.fn(async () => {}),
  fanoutUserBlocks: jest.fn(async () => {}),
  fanoutUserEntity: jest.fn(async () => {}),
}));

import userRoutes from '../../routes/users';
import adminRoutes from '../../routes/admin';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as identityService from '../../services/identity/identity.service';
import { recordAudit } from '../../middleware/audit';
import * as fanout from '../../realtime/fanout';

const app = express();
app.use(express.json());
app.use('/users', userRoutes);
app.use('/admin', adminRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, type: 'access' }, JWT_SECRET, { expiresIn: '1h' });
const ADMIN = `Bearer ${token('u-admin', 'admin')}`;
const MEMBER = `Bearer ${token('u-viewer')}`;
const GONE = '7a0d3b4e-1f2a-4c5d-8e9f-0a1b2c3d4e5f';

const person = (status: string) => ({
  id: GONE, email: 'gone@example.com', displayName: 'Gone Person', firstName: 'Gone', lastName: 'Person',
  avatarUrl: null, bio: 'Bio', company: 'Co', jobTitle: 'CEO', role: 'member', status,
});
const COUNTS = { active: 81, suspended: 1, deactivated: 2, banned: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  // The sign-in check reads the caller's own status: every caller here is active.
  mockQuery.mockImplementation(async (sql: string) => (
    sql === 'SELECT status FROM users WHERE id = $1' ? { rows: [{ status: 'active' }] } : { rows: [], rowCount: 0 }
  ));
  (identityService.getUsers as jest.Mock).mockResolvedValue({ users: [person('active')], total: 1, statusCounts: COUNTS });
});

describe('GET /users (the admin list)', () => {
  it('production\'s Active tab (no status) still answers with its page and meta, plus how many each status tab holds', async () => {
    const res = await request(app).get('/users?page=1&pageSize=20').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([person('active')]);
    expect(res.body.meta).toEqual({
      page: 1, pageSize: 20, totalCount: 1, totalPages: 1, hasNext: false, hasPrev: false, statusCounts: COUNTS,
    });
    expect(identityService.getUsers).toHaveBeenCalledWith({
      page: 1, pageSize: 20, role: undefined, status: undefined, search: undefined, withStatusCounts: true,
    });
  });

  it.each(['active', 'suspended', 'deactivated', 'banned'])('a tab asks for status=%s, with the search and role kept', async (status) => {
    const res = await request(app).get(`/users?page=2&pageSize=20&search=ste&role=member&status=${status}`).set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(identityService.getUsers).toHaveBeenCalledWith({
      page: 2, pageSize: 20, role: 'member', status, search: 'ste', withStatusCounts: true,
    });
  });

  it('refuses a status that is not one of the four, and a member', async () => {
    expect((await request(app).get('/users?status=removed').set('Authorization', ADMIN)).status).toBe(400);
    expect((await request(app).get('/users?page=1').set('Authorization', MEMBER)).status).toBe(403);
  });
});

describe('PUT /users/:id/status (production\'s Remove, Suspend, Ban and Reactivate)', () => {
  it.each(['deactivated', 'suspended', 'banned', 'active'])('%s: answers with the account, is on record, and reaches everyone around them', async (status) => {
    (identityService.updateUserStatus as jest.Mock).mockResolvedValue(person(status));
    const res = await request(app).put(`/users/${GONE}/status`).set('Authorization', ADMIN).send({ status });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(person(status));
    expect(identityService.updateUserStatus).toHaveBeenCalledWith(GONE, status);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'u-admin', action: 'user.status_changed', entityType: 'user', entityId: GONE, details: { status },
    }));
    expect(fanout.fanoutAdminEntities).toHaveBeenCalledWith('users');
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith(GONE);
    expect(fanout.fanoutAccountStatusChange).toHaveBeenCalledWith(GONE);
  });

  it('refuses a status that is not one of the four, and a member', async () => {
    expect((await request(app).put(`/users/${GONE}/status`).set('Authorization', ADMIN).send({ status: 'removed' })).status).toBe(400);
    expect((await request(app).put(`/users/${GONE}/status`).set('Authorization', MEMBER).send({ status: 'active' })).status).toBe(403);
    expect(identityService.updateUserStatus).not.toHaveBeenCalled();
  });
});

describe('DELETE /users/:id (production\'s Delete Forever)', () => {
  it('reads who is around the person before the delete takes them out of their pods and events, and tells them after', async () => {
    const order: string[] = [];
    (fanout.accountAudience as jest.Mock).mockImplementation(async () => { order.push('audience'); return { podIds: ['pod-1'], events: [], people: [], groupIds: [], circleIds: ['circle-1'] }; });
    (identityService.deleteUser as jest.Mock).mockImplementation(async () => { order.push('delete'); });
    (fanout.fanoutAccountAudience as jest.Mock).mockImplementation(async () => { order.push('tell'); });
    const res = await request(app).delete(`/users/${GONE}`).set('Authorization', `Bearer ${token('u-super', 'super_admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ message: 'User deleted' });
    expect(order).toEqual(['audience', 'delete', 'tell']);
    expect(fanout.fanoutAccountAudience).toHaveBeenCalledWith({ podIds: ['pod-1'], events: [], people: [], groupIds: [], circleIds: ['circle-1'] }, GONE);
  });
});

describe('POST /admin/users/bulk-action (production\'s bulk bar)', () => {
  it('a bulk status change reaches everyone around each account', async () => {
    mockQuery.mockImplementation(async (sql: string) => (
      sql === 'SELECT status FROM users WHERE id = $1' ? { rows: [{ status: 'active' }] }
        : /UPDATE users SET status/.test(sql) ? { rows: [{ id: GONE }, { id: 'u-two' }], rowCount: 2 } : { rows: [], rowCount: 0 }
    ));
    const res = await request(app).post('/admin/users/bulk-action').set('Authorization', ADMIN)
      .send({ userIds: [GONE, '8b1e4c5f-2a3b-4d6e-9fa0-1b2c3d4e5f6a'], action: 'activate' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ affected: 2 });
    expect(fanout.fanoutAccountStatusChange).toHaveBeenCalledWith(GONE);
    expect(fanout.fanoutAccountStatusChange).toHaveBeenCalledWith('u-two');
  });
});

describe('GET /users/:id (the old profile page)', () => {
  it.each(['deactivated', 'suspended', 'banned'])('a %s account no longer opens for another member, in words', async (status) => {
    (identityService.getUserById as jest.Mock).mockResolvedValue(person(status));
    const res = await request(app).get(`/users/${GONE}`).set('Authorization', MEMBER);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('This person is no longer a member of REASON.');
  });

  it('an admin still opens it, with the full profile', async () => {
    (identityService.getUserById as jest.Mock).mockResolvedValue(person('deactivated'));
    const res = await request(app).get(`/users/${GONE}`).set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'gone@example.com', status: 'deactivated' });
  });

  it('an active member\'s card still opens for another member, as before', async () => {
    (identityService.getUserById as jest.Mock).mockResolvedValue(person('active'));
    const res = await request(app).get(`/users/${GONE}`).set('Authorization', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.data.displayName).toBe('Gone Person');
    expect(res.body.data).not.toHaveProperty('email');
  });
});
