// ─── GET /api/circles/:id/export and /api/pods/:id/export (Shirley pilot S7, 11 Nov 2026; item 20, D6) ──────────
// What the routes accept (one of four sections, nothing else in the query, a real id), what a file looks like on the
// wire (text/csv, an attachment named by date only, never cached), that a refusal from the service is passed on with
// no file, the limiter on each, and that index.ts mounts them. The service is a stand-in; its rules are in
// services/space/space-export.service.test.ts.

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
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
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockExport = jest.fn();
const mockArchived = jest.fn();
jest.mock('../../services/space/space-export.service', () => ({
  exportSpaceSection: (...a: unknown[]) => mockExport(...a),
  listArchivedCirclesIRan: (...a: unknown[]) => mockArchived(...a),
  __esModule: true,
}));

import { circleExportRoutes, podExportRoutes } from '../../routes/space-export';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { SPACE_EXPORT_LIMITED, spaceExportLimiter } from '../../middleware/rateLimit';
import { ForbiddenError, NotFoundError } from '../../middleware/errors';

const app = express();
app.use('/circles', circleExportRoutes);
app.use('/pods', podExportRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });
const ID = 'c0000000-0000-4000-8000-0000000000aa';
const BODY = '﻿Name,Role,Joined\r\nShirley,Owner,2026-11-01\r\n';

beforeEach(() => {
  jest.clearAllMocks();
  mockExport.mockResolvedValue({ filename: 'reason-circle-members-2026-11-11.csv', body: BODY, rows: 1 });
});

describe('a file on the wire', () => {
  it.each([['circles', 'circle'], ['pods', 'pod']] as const)('/%s/:id/export: text/csv, an attachment named by date, never stored', async (base, kind) => {
    const res = await request(app).get(`/${base}/${ID}/export?section=members`).set(as('u-org'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="reason-circle-members-2026-11-11.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe(BODY);
    expect(mockExport).toHaveBeenCalledWith(kind, ID, 'members', { userId: 'u-org', role: 'member' });
  });

  it('the asker\'s platform role is passed on (the service refuses a role-less admin)', async () => {
    await request(app).get(`/pods/${ID}/export?section=space`).set(as('u-sa', 'super_admin'));
    expect(mockExport).toHaveBeenCalledWith('pod', ID, 'space', { userId: 'u-sa', role: 'super_admin' });
  });

  it('an id in capitals is the same space', async () => {
    await request(app).get(`/circles/${ID.toUpperCase()}/export?section=posts`).set(as('u-org'));
    expect(mockExport).toHaveBeenCalledWith('circle', ID, 'posts', expect.anything());
  });
});

describe('what the routes refuse', () => {
  it.each([
    ['no section', ''],
    ['a section that is not one', '?section=emails'],
    ['two sections', '?section=members&section=posts'],
    ['something else beside it', '?section=members&withEmails=1'],
  ])('%s: 400 in words, nothing read', async (_what, q) => {
    const res = await request(app).get(`/circles/${ID}/export${q}`).set(as('u-org'));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose which file to download.');
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('an id that is not one', async () => {
    const res = await request(app).get('/pods/undefined/export?section=members').set(as('u-org'));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("We couldn't find that pod.");
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('someone not signed in', async () => {
    const res = await request(app).get(`/circles/${ID}/export?section=members`);
    expect(res.status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it.each([
    ['a member who runs nothing', new ForbiddenError("Only the circle's owner and moderators can export its data."), 403],
    ['a private pod they may not see', new NotFoundError('Pod', ID, "We couldn't find that pod."), 404],
    ['an access log that could not be written', Object.assign(new Error('could not extend file'), { code: '53100' }), 500],
  ])('%s: the refusal, and no file', async (_who, err, status) => {
    mockExport.mockRejectedValueOnce(err);
    const res = await request(app).get(`/circles/${ID}/export?section=members`).set(as('u-x'));
    expect(res.status).toBe(status);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text).not.toContain('Shirley');
  });
});

describe('fix round 1', () => {
  it.each([['circles'], ['pods']])('HEAD /%s/:id/export is refused (405, Allow: GET) and writes no log row', async (base) => {
    const res = await request(app).head(`/${base}/${ID}/export?section=members`).set(as('u-head'));
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('GET /circles/archived/mine lists the archived circles the member ran, for that member only', async () => {
    const rows = [{ id: ID, name: 'Curious Humans', archivedAt: '2026-11-10T09:00:00.000Z', myRole: 'owner' }];
    mockArchived.mockResolvedValueOnce(rows);
    const res = await request(app).get('/circles/archived/mine').set(as('u-ran'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: rows });
    expect(mockArchived).toHaveBeenCalledWith('u-ran');
    expect((await request(app).get('/circles/archived/mine')).status).toBe(401);
  });

  it('the circle router never takes /archived/mine for a circle id (two segments; no /:id/:x GET there)', () => {
    const circles = fs.readFileSync(path.join(__dirname, '../../routes/circles.ts'), 'utf8');
    expect(circles).not.toMatch(/router\.get\('\/:id\/:/);
    expect(circles).not.toMatch(/router\.get\('\/archived/);
  });
});

describe('limits and mounting', () => {
  interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }
  it.each([['circles', circleExportRoutes], ['pods', podExportRoutes]] as const)('/%s/:id/export carries spaceExportLimiter after authenticate', (_b, router) => {
    const handlers = (router as unknown as { stack: Layer[] }).stack
      .filter((l) => l.route?.path === '/:id/export' && l.route.methods.get)
      .flatMap((l) => l.route!.stack.map((s) => s.handle));
    expect(handlers.indexOf(authenticate)).toBe(0);
    expect(handlers.indexOf(spaceExportLimiter)).toBe(1);
  });

  it('the twenty-first file in ten minutes is refused in words, for that member only', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await request(app).get(`/pods/${ID}/export?section=space`).set(as('u-busy'))).status).toBe(200);
    }
    const res = await request(app).get(`/pods/${ID}/export?section=space`).set(as('u-busy'));
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe(SPACE_EXPORT_LIMITED);
    expect((await request(app).get(`/pods/${ID}/export?section=space`).set(as('u-other'))).status).toBe(200);
  });

  it('index.ts mounts them beside the circle and pod routes', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    expect(index).toContain("import { circleExportRoutes, podExportRoutes } from './routes/space-export';");
    expect(index).toMatch(/app\.use\('\/api\/pods', podExportRoutes\);/);
    expect(index).toMatch(/app\.use\('\/api\/circles', circleExportRoutes\);/);
  });
});
