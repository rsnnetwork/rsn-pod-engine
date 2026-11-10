// ─── /api/sessions/:id/schedule: the matching board's routes (10 Nov 2026 spec, Part 2 Task 8) ────────────────
// What each route accepts and passes on. The service is a stand-in: who may edit, the revision check, locks,
// refusals, the audit and the fan-out are tested in services/schedule/board-*.test.ts.

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
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockGet = jest.fn();
const mockGenerate = jest.fn();
const mockApply = jest.fn();
jest.mock('../../services/schedule/schedule-board.service', () => ({
  getBoard: (...a: unknown[]) => mockGet(...a),
  generateBoard: (...a: unknown[]) => mockGenerate(...a),
  applyBoardOp: (...a: unknown[]) => mockApply(...a),
  __esModule: true,
}));

import scheduleRoutes from '../../routes/schedule';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/sessions', scheduleRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string) => ({ Authorization: `Bearer ${token(sub)}` });

const EVENT = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const PERSON = '9b3e6d21-7c4a-4f18-a2d5-0e8f1c6b4a77';
const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ sessionId: EVENT, revision: 3 });
  mockGenerate.mockResolvedValue({ board: { revision: 4 }, changed: [] });
  mockApply.mockResolvedValue({ board: { revision: 4 }, changed: [] });
});

describe('the matching board routes', () => {
  it('ask for a sign-in', async () => {
    expect((await request(app).get(`/sessions/${EVENT}/schedule`)).status).toBe(401);
    expect((await request(app).post(`/sessions/${EVENT}/schedule/ops`).send({})).status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('GET answers the board for the signed-in organiser', async () => {
    const res = await request(app).get(`/sessions/${EVENT}/schedule`).set(as('host-1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { sessionId: EVENT, revision: 3 } });
    expect(mockGet).toHaveBeenCalledWith(EVENT, { userId: 'host-1', role: 'member' });
  });

  it('generate passes the revision and the rounds on', async () => {
    const all = await request(app).post(`/sessions/${EVENT}/schedule/generate`).set(as('host-1')).send({ expectedRevision: 3, rounds: 'all' });
    expect(all.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledWith(EVENT, { userId: 'host-1', role: 'member' }, 3, 'all');
    await request(app).post(`/sessions/${EVENT}/schedule/generate`).set(as('host-1')).send({ expectedRevision: 3, rounds: [2, 3] });
    expect(mockGenerate).toHaveBeenLastCalledWith(EVENT, expect.anything(), 3, [2, 3]);
  });

  it('an edit passes the op on as sent (ids lower-cased), with its override and reason', async () => {
    const op = { kind: 'move', round: 2, userId: PERSON.toUpperCase(), toRoom: 4, override: true, reason: 'Asked to meet' };
    const res = await request(app).post(`/sessions/${EVENT}/schedule/ops`).set(as('host-1')).send({ expectedRevision: 7, op });
    expect(res.status).toBe(200);
    expect(mockApply).toHaveBeenCalledWith(EVENT, { userId: 'host-1', role: 'member' }, 7, { ...op, userId: PERSON });
  });

  it.each([
    ['no revision', { op: { kind: 'unassign', round: 1, userId: PERSON } }],
    ['an unknown kind', { expectedRevision: 0, op: { kind: 'teleport', round: 1, userId: PERSON } }],
    ['a swap with themselves', { expectedRevision: 0, op: { kind: 'swap', round: 1, userId: PERSON, withUserId: PERSON } }],
    ['round 0', { expectedRevision: 0, op: { kind: 'unassign', round: 0, userId: PERSON } }],
    ['a room that is not a number', { expectedRevision: 0, op: { kind: 'move', round: 1, userId: PERSON, toRoom: 'x' } }],
    ['someone who is not an id', { expectedRevision: 0, op: { kind: 'mark_no_show', userId: 'robert' } }],
    ['a reason over 500 characters', { expectedRevision: 0, op: { kind: 'unassign', round: 1, userId: PERSON, reason: 'x'.repeat(501) } }],
    ['no rounds to redistribute', { expectedRevision: 0, op: { kind: 'redistribute', rounds: [] } }],
  ])('refuses %s with a 400, before the service', async (_label, body) => {
    const res = await request(app).post(`/sessions/${EVENT}/schedule/ops`).set(as('host-1')).send(body);
    expect(res.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('accepts every kind of edit the board makes', async () => {
    const ops = [
      { kind: 'swap', round: 1, userId: PERSON, withUserId: OTHER },
      { kind: 'unassign', round: 1, userId: PERSON },
      { kind: 'lock_room', round: 1, room: 2 },
      { kind: 'unlock_room', round: 1, room: 2 },
      { kind: 'lock_slot', round: 1, userId: PERSON },
      { kind: 'unlock_slot', round: 1, userId: PERSON },
      { kind: 'redistribute', rounds: 'all' },
      { kind: 'mark_late', userId: PERSON, fromRound: 3 },
      { kind: 'mark_no_show', userId: PERSON },
      { kind: 'clear_absence', userId: PERSON },
    ];
    for (const op of ops) {
      const res = await request(app).post(`/sessions/${EVENT}/schedule/ops`).set(as('host-1')).send({ expectedRevision: 1, op });
      expect({ kind: op.kind, status: res.status }).toEqual({ kind: op.kind, status: 200 });
    }
  });

  it('are mounted under /api/sessions with their own read and write limits of 120 a minute', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    expect(index).toMatch(/app\.use\('\/api\/sessions', scheduleRoutes\)/);
    const route = fs.readFileSync(path.join(__dirname, '../../routes/schedule.ts'), 'utf8');
    expect(route).toMatch(/router\.get\('\/:id\/schedule', authenticate, scheduleReadLimiter/);
    expect(route).toMatch(/router\.post\('\/:id\/schedule\/generate', authenticate, scheduleWriteLimiter/);
    expect(route).toMatch(/router\.post\('\/:id\/schedule\/ops', authenticate, scheduleWriteLimiter/);
    const limits = fs.readFileSync(path.join(__dirname, '../../middleware/rateLimit.ts'), 'utf8');
    for (const name of ['scheduleReadLimiter', 'scheduleWriteLimiter']) {
      const at = limits.indexOf(`export const ${name}`);
      expect(limits.slice(at, at + 200)).toMatch(/max: 120/);
    }
  });
});
