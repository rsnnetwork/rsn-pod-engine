// ─── GET /api/sessions/:id/audit (Part 2, Task 1) ────────────────────────────
// Who may read an event's history (its organisers and platform admins, nobody else), what a page looks like and
// that a bad id or cursor is refused before the service runs. The service is a stand-in: its paging and
// "Former member" rules are tested in services/audit/event-audit.test.ts.

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
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockCanAct = jest.fn();
jest.mock('../../services/roles/effective-role.service', () => ({
  canActAsHost: (...a: unknown[]) => mockCanAct(...a),
  __esModule: true,
}));
const mockList = jest.fn();
jest.mock('../../services/audit/event-audit', () => ({
  listEventAudit: (...a: unknown[]) => mockList(...a),
  isEventAuditCursor: (v: string) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/i.test(v),
  __esModule: true,
}));

import eventAuditRoutes from '../../routes/event-audit';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/sessions', eventAuditRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const SESSION = '11111111-1111-4111-8111-111111111111';
const token = (role: string, userId = '22222222-2222-4222-8222-222222222222') =>
  jwt.sign({ sub: userId, email: 'a@b.test', role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const page = { entries: [], nextCursor: null };

beforeEach(() => {
  jest.clearAllMocks();
  // authenticate() checks the account is still active; the admin path checks the event exists.
  mockQuery.mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member', id: SESSION }] });
  mockList.mockResolvedValue(page);
});

describe('GET /sessions/:id/audit', () => {
  it('needs a sign-in', async () => {
    const res = await request(app).get(`/sessions/${SESSION}/audit`);
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('refuses a participant', async () => {
    mockCanAct.mockResolvedValue({ allowed: false, effectiveRole: 'participant' });
    const res = await request(app).get(`/sessions/${SESSION}/audit`).set('Authorization', `Bearer ${token('member')}`);
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lets a co-host (or host) read it', async () => {
    mockCanAct.mockResolvedValue({ allowed: true, effectiveRole: 'cohost' });
    const res = await request(app).get(`/sessions/${SESSION}/audit`).set('Authorization', `Bearer ${token('member')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: page });
    expect(mockList).toHaveBeenCalledWith(SESSION, { cursor: undefined, limit: undefined });
  });

  it('lets a platform admin read it without being a host, and a missing event is a 404 for them', async () => {
    const ok = await request(app).get(`/sessions/${SESSION}/audit`).set('Authorization', `Bearer ${token('admin')}`);
    expect(ok.status).toBe(200);
    expect(mockCanAct).not.toHaveBeenCalled();

    mockQuery.mockReset();
    // The sign-in check is cached for a minute; only the existence read reaches the database now.
    mockQuery.mockImplementation(async (sql: string) => ({ rows: /FROM sessions/.test(sql) ? [] : [{ status: 'active', account_kind: 'member' }] }));
    const gone = await request(app).get(`/sessions/${SESSION}/audit`).set('Authorization', `Bearer ${token('admin')}`);
    expect(gone.status).toBe(404);
  });

  it('passes the cursor and limit on', async () => {
    mockCanAct.mockResolvedValue({ allowed: true, effectiveRole: 'event_host' });
    const cursor = '2026-11-10T12:00:59.000000Z|aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    await request(app).get(`/sessions/${SESSION}/audit`).query({ cursor, limit: '25' }).set('Authorization', `Bearer ${token('member')}`);
    expect(mockList).toHaveBeenCalledWith(SESSION, { cursor, limit: 25 });
  });

  it('refuses a bad event id, a bad cursor and a limit above 100 before the service runs', async () => {
    mockCanAct.mockResolvedValue({ allowed: true, effectiveRole: 'event_host' });
    const auth = { Authorization: `Bearer ${token('member')}` };
    expect((await request(app).get('/sessions/not-a-uuid/audit').set(auth)).status).toBe(400);
    expect((await request(app).get(`/sessions/${SESSION}/audit`).query({ cursor: 'junk' }).set(auth)).status).toBe(400);
    expect((await request(app).get(`/sessions/${SESSION}/audit`).query({ limit: '101' }).set(auth)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
