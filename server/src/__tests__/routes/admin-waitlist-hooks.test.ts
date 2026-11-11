// ─── The admin's own status writes move the waiting lists on (Part 3 Task 3, fix round 1; review I-2) ───────────────
//
// A suspended, banned or closed account holds no place (capacityTakenSql counts active accounts), so every path that
// writes users.status away from active must tell the waiting list of each upcoming or live event that account held a
// place in, once the write is done. Besides updateUserStatus and deleteUser (identity.service), two admin routes write
// the status themselves: the bulk action (suspend, ban, delete for up to 100 accounts) and resolving a report with a
// suspension or a ban. Both read the events before the write and move the lines on after it.

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
/** Every statement, in order, with what each hook did in between (to hold "read before the write, told after"). */
const mockTrail: string[] = [];
const mockQuery = jest.fn(async (sql: string) => {
  mockTrail.push(sql.replace(/\s+/g, ' ').trim().slice(0, 200));
  if (sql === 'SELECT status, account_kind FROM users WHERE id = $1') return { rows: [{ status: 'active', account_kind: 'member' }] };
  if (/^UPDATE users SET status = \$1, updated_at = NOW\(\) WHERE id = ANY/.test(sql)) return { rows: [{ id: 'u-a' }, { id: 'u-b' }], rowCount: 2 };
  // The reported account (Part 3 Task 2 reads it first, as user_id, to check who may act on them).
  if (sql.startsWith('SELECT reported_id AS user_id FROM user_reports')) return { rows: [{ user_id: 'u-reported' }] };
  return { rows: [], rowCount: 0 };
});
jest.mock('../../db', () => ({
  query: (sql: string) => mockQuery(sql),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../middleware/audit', () => ({ __esModule: true, recordAudit: jest.fn(async () => {}), auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutAccountStatusChange: jest.fn(async () => {}),
  fanoutAdminEntities: jest.fn(async () => {}),
  fanoutUserEntity: jest.fn(async () => {}),
}));
jest.mock('../../services/report/report.service', () => ({
  __esModule: true, resolveReport: jest.fn(async () => {}), dismissReport: jest.fn(async () => {}),
}));
const mockHeld = jest.fn();
const mockMoveOn = jest.fn();
jest.mock('../../services/session/event-waitlist.service', () => ({
  __esModule: true,
  eventsHeldByActiveAccounts: (ids: string[]) => { mockTrail.push(`held:${ids.join(',')}`); return mockHeld(ids); },
  moveWaitlistsOn: (ids: string[]) => { mockTrail.push(`move-on:${ids.join(',')}`); mockMoveOn(ids); },
}));

import adminRoutes from '../../routes/admin';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/admin', adminRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
const ADMIN = `Bearer ${jwt.sign({ sub: 'u-admin', email: 'admin@example.com', role: 'admin', type: 'access' }, JWT_SECRET, { expiresIn: '1h' })}`;
const A = '7a0d3b4e-1f2a-4c5d-8e9f-0a1b2c3d4e5f';
const B = '8b1e4c5f-2a3b-4d6e-9fa0-1b2c3d4e5f6a';
const REPORT = '9c2f5d6a-3b4c-4e7f-8ab1-2c3d4e5f6a7b';

beforeEach(() => {
  mockTrail.length = 0;
  mockQuery.mockClear();
  mockHeld.mockReset().mockResolvedValue(['ev-1', 'ev-2']);
  mockMoveOn.mockReset();
});

const between = (first: string, then: RegExp, last: string) => {
  const i = mockTrail.indexOf(first);
  const j = mockTrail.findIndex((s) => then.test(s));
  const k = mockTrail.indexOf(last);
  return i > -1 && j > i && k > j;
};

describe('POST /admin/users/bulk-action', () => {
  it.each(['suspend', 'ban', 'delete'])('%s: the events the active accounts held are read before the write, and their lines move on after it', async (action) => {
    const res = await request(app).post('/admin/users/bulk-action').set('Authorization', ADMIN).send({ userIds: [A, B], action });
    expect(res.status).toBe(200);
    expect(mockHeld).toHaveBeenCalledWith([A, B]);
    expect(mockMoveOn).toHaveBeenCalledWith(['ev-1', 'ev-2']);
    expect(between(`held:${A},${B}`, /^UPDATE users SET status = \$1/, 'move-on:ev-1,ev-2')).toBe(true);
  });

  it('activate frees nothing: no read, and no line is moved on', async () => {
    const res = await request(app).post('/admin/users/bulk-action').set('Authorization', ADMIN).send({ userIds: [A], action: 'activate' });
    expect(res.status).toBe(200);
    expect(mockHeld).not.toHaveBeenCalled();
    expect(mockMoveOn).toHaveBeenCalledWith([]);
  });
});

describe('POST /admin/violations/:id/resolve', () => {
  it.each(['suspend', 'ban'])('a report resolved with %s: the reported account\'s events are read before the write, and moved on after it', async (action) => {
    const res = await request(app).post(`/admin/violations/${REPORT}/resolve`).set('Authorization', ADMIN).send({ action, source: 'report' });
    expect(res.status).toBe(200);
    expect(mockHeld).toHaveBeenCalledWith(['u-reported']);
    expect(between('held:u-reported', /^UPDATE users SET status = \$1, updated_at = NOW\(\) WHERE id = \$2/, 'move-on:ev-1,ev-2')).toBe(true);
  });

  it('a dismissed report touches no account and no line', async () => {
    const res = await request(app).post(`/admin/violations/${REPORT}/resolve`).set('Authorization', ADMIN).send({ action: 'dismiss', source: 'report' });
    expect(res.status).toBe(200);
    expect(mockHeld).not.toHaveBeenCalled();
    expect(mockMoveOn).not.toHaveBeenCalled();
  });
});
