// ─── GET /users/:id/entities: a person's entities (21 Oct 2026) ──────────────
// [{ id, name, kind, role, title }] for the person's active entities. Blocked (either way), closed
// and unknown people are a 404 in the same words, as the person brief is; the service decides that,
// and is a stand-in here (services/entity/entity.service.test.ts holds its rules).

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/onboarding/avatar.service', () => ({ __esModule: true, getAvatarBlob: jest.fn(), captureAvatar: jest.fn() }));
jest.mock('../../services/identity/identity.service', () => ({ __esModule: true, getUsers: jest.fn(), getUserById: jest.fn() }));
const mockListUserEntities = jest.fn();
jest.mock('../../services/entity/entity.service', () => ({
  listUserEntities: (...a: unknown[]) => mockListUserEntities(...a),
  __esModule: true,
}));
const mockFanout = jest.fn();
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: mockFanout, fanoutPodEntities: mockFanout, fanoutUserBlocks: mockFanout, fanoutUserEntity: mockFanout,
  __esModule: true,
}));

import userRoutes from '../../routes/users';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { entityReadLimiter } from '../../middleware/rateLimit';
import { NotFoundError } from '../../middleware/errors';

const app = express();
app.use(express.json());
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string) =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });
const PERSON = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

beforeEach(() => {
  jest.clearAllMocks();
  mockListUserEntities.mockResolvedValue([]);
});

describe('GET /users/:id/entities', () => {
  it('answers the person\'s entities as the service lists them, and tells no screens', async () => {
    const list = [{ id: 'e-1', name: 'Acme Ltd', kind: 'company', role: 'founder', title: 'CEO' }];
    mockListUserEntities.mockResolvedValueOnce(list);
    const res = await request(app).get(`/users/${PERSON}/entities`).set(as('u-viewer'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: list });
    expect(mockListUserEntities).toHaveBeenCalledWith('u-viewer', PERSON);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('reads an id typed in capitals as the same person', async () => {
    await request(app).get(`/users/${PERSON.toUpperCase()}/entities`).set(as('u-viewer'));
    expect(mockListUserEntities).toHaveBeenCalledWith('u-viewer', PERSON);
  });

  it('answers 404 with no data when the person is not available (blocked, closed or unknown)', async () => {
    mockListUserEntities.mockRejectedValueOnce(new NotFoundError('User', PERSON, 'This person is not available.'));
    const res = await request(app).get(`/users/${PERSON}/entities`).set(as('u-viewer'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'USER_NOT_FOUND', message: 'This person is not available.' } });
  });

  it('refuses an id that is not a member id, and a missing token, without asking the service', async () => {
    expect((await request(app).get('/users/sarah/entities').set(as('u-viewer'))).status).toBe(400);
    expect((await request(app).get(`/users/${PERSON}/entities`)).status).toBe(401);
    expect(mockListUserEntities).not.toHaveBeenCalled();
  });

  it('is rate limited per member, after authenticate and ahead of its handler', () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
    const handlers = (userRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === '/:id/entities' && layer.route.methods.get)
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));
    expect(handlers.length).toBeGreaterThan(2);
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(entityReadLimiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });
});
