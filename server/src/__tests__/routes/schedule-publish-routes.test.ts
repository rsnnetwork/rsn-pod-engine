// ─── /api/sessions/:id/schedule: publishing and reading versions (10 Nov 2026 spec, Part 2 Task 9) ────────────
// What each route accepts and passes on. The services are stand-ins: who may publish, the conflict check, the
// version write, the bells and the live rewrite are tested in services/schedule/publish.test.ts and
// live-repair-keeps-locks.test.ts.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
let accountKind = 'member';
jest.mock('../../db', () => ({
  // authenticate() reads the account's status and kind before any route runs.
  query: jest.fn(async () => ({ rows: [{ status: 'active', account_kind: accountKind }] })),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/schedule/schedule-board.service', () => ({
  getBoard: jest.fn(), generateBoard: jest.fn(), applyBoardOp: jest.fn(), __esModule: true,
}));
const mockPreview = jest.fn();
const mockPublish = jest.fn();
const mockVersions = jest.fn();
const mockMine = jest.fn();
jest.mock('../../services/schedule/schedule-publish.service', () => ({
  previewPublish: (...a: unknown[]) => mockPreview(...a),
  publishSchedule: (...a: unknown[]) => mockPublish(...a),
  listScheduleVersions: (...a: unknown[]) => mockVersions(...a),
  getMySchedule: (...a: unknown[]) => mockMine(...a),
  __esModule: true,
}));

import scheduleRoutes from '../../routes/schedule';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/sessions', scheduleRoutes);
// The guest allowlist reads the full path Express routed by, as the app mounts it.
app.use('/api/sessions', scheduleRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string) => ({ Authorization: `Bearer ${token(sub)}` });

const EVENT = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const ME = { userId: 'host-1', role: 'member' };

beforeEach(() => {
  jest.clearAllMocks();
  accountKind = 'member';
  mockPreview.mockResolvedValue({ blocking: [], warnings: [], impactedUserIds: [], nextVersion: 2 });
  mockPublish.mockResolvedValue({ version: 2, impactedUserIds: ['u1'] });
  mockVersions.mockResolvedValue([{ version: 1 }]);
  mockMine.mockResolvedValue({ version: 1, publishedAt: '2026-11-11T10:00:00.000Z', rounds: [] });
});

describe('publishing routes', () => {
  it('ask for a sign-in', async () => {
    expect((await request(app).get(`/sessions/${EVENT}/schedule/publish-preview`)).status).toBe(401);
    expect((await request(app).post(`/sessions/${EVENT}/schedule/publish`).send({ expectedRevision: 1 })).status).toBe(401);
    expect((await request(app).get(`/sessions/${EVENT}/schedule/versions`)).status).toBe(401);
    expect((await request(app).get(`/sessions/${EVENT}/schedule/mine`)).status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('the preview, the versions and my schedule are read for the signed-in person', async () => {
    const preview = await request(app).get(`/sessions/${EVENT}/schedule/publish-preview`).set(as('host-1'));
    expect(preview.body).toEqual({ success: true, data: { blocking: [], warnings: [], impactedUserIds: [], nextVersion: 2 } });
    expect(mockPreview).toHaveBeenCalledWith(EVENT, ME);
    const versions = await request(app).get(`/sessions/${EVENT}/schedule/versions`).set(as('host-1'));
    expect(versions.body).toEqual({ success: true, data: [{ version: 1 }] });
    expect(mockVersions).toHaveBeenCalledWith(EVENT, ME);
    const mine = await request(app).get(`/sessions/${EVENT.toUpperCase()}/schedule/mine`).set(as('member-7'));
    expect(mine.status).toBe(200);
    expect(mockMine).toHaveBeenCalledWith(EVENT, 'member-7');
  });

  it('my schedule before the first version is null', async () => {
    mockMine.mockResolvedValueOnce(null);
    const res = await request(app).get(`/sessions/${EVENT}/schedule/mine`).set(as('member-7'));
    expect(res.body).toEqual({ success: true, data: null });
  });

  it('publish passes the revision and the trimmed note on, and answers the version', async () => {
    const res = await request(app).post(`/sessions/${EVENT}/schedule/publish`).set(as('host-1'))
      .send({ expectedRevision: 5, note: '  Final plan  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { version: 2, impactedUserIds: ['u1'] } });
    expect(mockPublish).toHaveBeenCalledWith(EVENT, ME, 5, { note: 'Final plan' });
  });

  it.each([
    ['no revision', {}],
    ['a negative revision', { expectedRevision: -1 }],
    ['a note over 500 characters', { expectedRevision: 1, note: 'x'.repeat(501) }],
  ])('publish refuses %s with a 400, before the service', async (_label, body) => {
    const res = await request(app).post(`/sessions/${EVENT}/schedule/publish`).set(as('host-1')).send(body);
    expect(res.status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('a refused publish answers 409 SCHEDULE_HAS_CONFLICTS with the list in error.details.blocking', async () => {
    const { ConflictError } = jest.requireActual('../../middleware/errors');
    const blocking = [{ round: 1, room: 2, message: "Ann and Ben can't be in the same meeting." }];
    mockPublish.mockRejectedValueOnce(new ConflictError('SCHEDULE_HAS_CONFLICTS', 'Fix the conflicts before publishing.', { blocking }));
    const res = await request(app).post(`/sessions/${EVENT}/schedule/publish`).set(as('host-1')).send({ expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'SCHEDULE_HAS_CONFLICTS', message: 'Fix the conflicts before publishing.', details: { blocking } });
  });

  it('an event guest reads their own schedule; every other schedule route answers them GUEST_MEMBERSHIP_REQUIRED', async () => {
    accountKind = 'event_guest';
    expect((await request(app).get(`/api/sessions/${EVENT}/schedule/mine`).set(as('guest-1'))).status).toBe(200);
    for (const [method, url] of [['get', 'publish-preview'], ['get', 'versions'], ['post', 'publish']] as const) {
      const res = await request(app)[method](`/api/sessions/${EVENT}/schedule/${url}`).set(as('guest-1')).send({ expectedRevision: 1 });
      expect({ url, status: res.status, code: res.body.error?.code }).toEqual({ url, status: 403, code: 'GUEST_MEMBERSHIP_REQUIRED' });
    }
    expect(mockPublish).not.toHaveBeenCalled();
    const scope = fs.readFileSync(path.join(__dirname, '../../middleware/guest-scope.ts'), 'utf8');
    expect(scope).toContain("{ method: 'GET', pattern: exact(`/api/sessions/${ID}/schedule/mine`) }");
    expect(scope).not.toMatch(/schedule\/(publish|versions)/);
  });

  it('read and write limits as the board routes, and mounted beside them', () => {
    const route = fs.readFileSync(path.join(__dirname, '../../routes/schedule.ts'), 'utf8');
    expect(route).toMatch(/router\.get\('\/:id\/schedule\/publish-preview', authenticate, scheduleReadLimiter/);
    expect(route).toMatch(/router\.post\('\/:id\/schedule\/publish', authenticate, scheduleWriteLimiter/);
    expect(route).toMatch(/router\.get\('\/:id\/schedule\/versions', authenticate, scheduleReadLimiter/);
    expect(route).toMatch(/router\.get\('\/:id\/schedule\/mine', authenticate, scheduleReadLimiter/);
  });
});
