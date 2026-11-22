// ─── 21 Nov 2026: the admin-given Premium badge, and a member's standard meeting request ─────────────────────────
//
// Shradha: "can we update a premium badge to them?" PUT /admin/users/profile-badge gives the badge to the members
// named (null takes it away), for admins only, and tells everyone who could be looking. Display only: the route never
// writes is_premium. Stefan: "I should be able in my profile to state my 'standard message' and preferred format":
// PUT /users/me takes meetNoteDefault (at most MEET_NOTE_MAX, trimmed, blank clears it, {first} kept as typed) and
// meetFormatDefault (one of MEETING_FORMATS, or null), and tells the member's own screens.

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
  updateUser: jest.fn(),
  updateUserStatus: jest.fn(),
  updateUserRole: jest.fn(),
  deleteUser: jest.fn(),
}));
jest.mock('../../services/user/profile-badge.service', () => ({
  __esModule: true,
  PROFILE_BADGE_BULK_MAX: 100,
  setProfileBadge: jest.fn(),
}));
jest.mock('../../middleware/audit', () => ({ __esModule: true, recordAudit: jest.fn(async () => {}), auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  accountAudience: jest.fn(async () => ({ podIds: [], events: [], people: [], groupIds: [], circleIds: [] })),
  fanoutAccountAudience: jest.fn(async () => {}),
  fanoutAccountStatusChange: jest.fn(async () => {}),
  fanoutAdminEntities: jest.fn(async () => {}),
  fanoutCommunitiesOf: jest.fn(async () => {}),
  fanoutPodEntities: jest.fn(async () => {}),
  fanoutProfileChange: jest.fn(async () => {}),
  fanoutUserBlocks: jest.fn(async () => {}),
  fanoutUserEntity: jest.fn(async () => {}),
}));

import userRoutes from '../../routes/users';
import adminRoutes from '../../routes/admin';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as identityService from '../../services/identity/identity.service';
import { setProfileBadge } from '../../services/user/profile-badge.service';
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
const SUPER = `Bearer ${token('u-super', 'super_admin')}`;
const HOST = `Bearer ${token('u-host', 'host')}`;
const MEMBER = `Bearer ${token('u-member')}`;
const A = '7a0d3b4e-1f2a-4c5d-8e9f-0a1b2c3d4e5f';
const B = '8b1e4c5f-2a3b-4d6e-9fa0-1b2c3d4e5f60';
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async (sql: string) => (
    sql === 'SELECT status, account_kind FROM users WHERE id = $1' ? { rows: [{ status: 'active', account_kind: 'member' }] } : { rows: [], rowCount: 0 }
  ));
  (identityService.updateUser as jest.Mock).mockImplementation(async (id: string, input: object) => ({ id, ...input }));
});

describe('PUT /admin/users/profile-badge', () => {
  it('gives the badge to the members named, answers with who changed, and tells their screens, every admin and the people around them', async () => {
    (setProfileBadge as jest.Mock).mockResolvedValue({
      changed: [{ userId: A, from: null, to: 'premium' }, { userId: B, from: null, to: 'premium' }], missing: [], found: 2,
    });
    const res = await request(app).put('/admin/users/profile-badge').set('Authorization', ADMIN).send({ userIds: [A, B], badge: 'premium' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ badge: 'premium', changed: [A, B], missing: [] });
    expect(setProfileBadge).toHaveBeenCalledWith('u-admin', [A, B], 'premium', expect.anything());
    expect(fanout.fanoutAdminEntities).toHaveBeenCalledWith('users');
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith(A);
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith(B);
    await flush();
    expect(fanout.fanoutAccountStatusChange).toHaveBeenCalledWith(A);
    expect(fanout.fanoutAccountStatusChange).toHaveBeenCalledWith(B);
  });

  it('null takes the badge away; a super admin may too', async () => {
    (setProfileBadge as jest.Mock).mockResolvedValue({ changed: [{ userId: A, from: 'premium', to: null }], missing: [], found: 1 });
    const res = await request(app).put('/admin/users/profile-badge').set('Authorization', SUPER).send({ userIds: [A], badge: null });
    expect(res.status).toBe(200);
    expect(setProfileBadge).toHaveBeenCalledWith('u-super', [A], null, expect.anything());
  });

  it('a press that changes nothing (they already hold it) answers and tells nobody', async () => {
    (setProfileBadge as jest.Mock).mockResolvedValue({ changed: [], missing: [], found: 1 });
    const res = await request(app).put('/admin/users/profile-badge').set('Authorization', ADMIN).send({ userIds: [A], badge: 'premium' });
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toEqual([]);
    expect(fanout.fanoutUserEntity).not.toHaveBeenCalled();
    expect(fanout.fanoutAdminEntities).not.toHaveBeenCalled();
  });

  it('ids that name no member at all are a 404 in words, never an id', async () => {
    (setProfileBadge as jest.Mock).mockResolvedValue({ changed: [], missing: [A], found: 0 });
    const res = await request(app).put('/admin/users/profile-badge').set('Authorization', ADMIN).send({ userIds: [A, A.toUpperCase()], badge: 'premium' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('We could not find those members.');
  });

  it('refuses a member and a host before anything is read', async () => {
    for (const who of [MEMBER, HOST]) {
      const res = await request(app).put('/admin/users/profile-badge').set('Authorization', who).send({ userIds: [A], badge: 'premium' });
      expect(res.status).toBe(403);
    }
    expect((await request(app).put('/admin/users/profile-badge').send({ userIds: [A], badge: 'premium' })).status).toBe(401);
    expect(setProfileBadge).not.toHaveBeenCalled();
  });

  it('refuses a badge that is not offered, no members, more than a page, a missing badge and an id that is not one', async () => {
    const bad = [
      { userIds: [A], badge: 'gold' },
      { userIds: [A], badge: 'Premium' },
      { userIds: [], badge: 'premium' },
      { userIds: Array.from({ length: 101 }, () => A), badge: 'premium' },
      { userIds: [A] },
      { userIds: ['not-an-id'], badge: 'premium' },
    ];
    for (const body of bad) {
      const res = await request(app).put('/admin/users/profile-badge').set('Authorization', ADMIN).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(setProfileBadge).not.toHaveBeenCalled();
  });
});

describe('PUT /users/me: the standard meeting request', () => {
  const put = (body: object) => request(app).put('/users/me').set('Authorization', MEMBER).send(body);

  it('saves the note trimmed, {first} kept as typed, with a format, and tells the member\'s own screens', async () => {
    const res = await put({ meetNoteDefault: '  Hi {first}, shall we compare notes?  ', meetFormatDefault: 'coffee' });
    expect(res.status).toBe(200);
    expect(identityService.updateUser).toHaveBeenCalledWith('u-member', { meetNoteDefault: 'Hi {first}, shall we compare notes?', meetFormatDefault: 'coffee' });
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith('u-member');
  });

  it('a blank note or null clears it, and a null format goes back to the standard one', async () => {
    await put({ meetNoteDefault: '   ', meetFormatDefault: null });
    expect(identityService.updateUser).toHaveBeenLastCalledWith('u-member', { meetNoteDefault: null, meetFormatDefault: null });
    await put({ meetNoteDefault: null });
    expect(identityService.updateUser).toHaveBeenLastCalledWith('u-member', { meetNoteDefault: null });
  });

  it('a save that names neither leaves both alone', async () => {
    await put({ bio: 'Hello' });
    expect(identityService.updateUser).toHaveBeenLastCalledWith('u-member', { bio: 'Hello' });
  });

  it('takes exactly MEET_NOTE_MAX characters, and refuses one more with the form\'s own sentence', async () => {
    expect((await put({ meetNoteDefault: 'a'.repeat(300) })).status).toBe(200);
    // Spaces round it are not counted.
    expect((await put({ meetNoteDefault: ` ${'a'.repeat(300)} ` })).status).toBe(200);
    const res = await put({ meetNoteDefault: 'a'.repeat(301) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.meetNoteDefault).toEqual(['Keep the message to 300 characters or fewer.']);
    const huge = await put({ meetNoteDefault: 'a'.repeat(5000) });
    expect(huge.status).toBe(400);
    expect(huge.body.error.details.meetNoteDefault).toEqual(['Keep the message to 300 characters or fewer.']);
  });

  it('refuses a format that is not offered, a note that is not text, and a NUL character', async () => {
    const format = await put({ meetFormatDefault: 'phone' });
    expect(format.status).toBe(400);
    expect(format.body.error.details.meetFormatDefault).toEqual(['Choose one of the offered formats.']);
    expect((await put({ meetNoteDefault: 42 })).status).toBe(400);
    expect((await put({ meetNoteDefault: `Hi${String.fromCharCode(0)}there` })).status).toBe(400);
    expect(identityService.updateUser).not.toHaveBeenCalled();
  });
});
