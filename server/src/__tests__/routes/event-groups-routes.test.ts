// ─── /api/sessions/:id/groups: the matching-groups routes (10 Nov 2026 spec, Part 2 Task 5) ──────────────
// What each route accepts and passes on. The service is a stand-in: who may read and change, the live refusal,
// the audit and the fan-out are tested in services/session/event-groups.test.ts.

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
const mockRead = jest.fn();
const mockSave = jest.fn();
const mockSet = jest.fn();
jest.mock('../../services/session/event-groups.service', () => ({
  readEventGroups: (...a: unknown[]) => mockRead(...a),
  saveEventGroupRules: (...a: unknown[]) => mockSave(...a),
  setParticipantGroups: (...a: unknown[]) => mockSet(...a),
  __esModule: true,
}));

import eventGroupRoutes from '../../routes/event-groups';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/sessions', eventGroupRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });

const EVENT = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const PERSON = '9b3e6d21-7c4a-4f18-a2d5-0e8f1c6b4a77';

const rules = {
  groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders', description: 'Angels and funds' }],
  question: 'Are you a founder or a funder?',
  allowMultiple: false,
  fallback: 'leave_unmatched',
  rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ groups: [], question: 'Which group are you in?', allowMultiple: false, mine: [] });
  mockSave.mockImplementation(async (_id: string, _actor: unknown, r: unknown) => r);
  mockSet.mockResolvedValue(undefined);
});

describe('GET /sessions/:id/groups', () => {
  it('answers the view for the signed-in viewer', async () => {
    const res = await request(app).get(`/sessions/${EVENT}/groups`).set(as('u-reader'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ groups: [], question: 'Which group are you in?', allowMultiple: false, mine: [] });
    expect(mockRead).toHaveBeenCalledWith(EVENT, { userId: 'u-reader', role: 'member' });
  });

  it('refuses an id that is not an event id, and anyone signed out', async () => {
    expect((await request(app).get('/sessions/nope/groups').set(as('u-reader'))).status).toBe(400);
    expect((await request(app).get(`/sessions/${EVENT}/groups`)).status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('PUT /sessions/:id/groups', () => {
  it('passes the organiser\'s rules on, as the actor', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/groups`).set(as('u-host')).send(rules);
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(EVENT, { userId: 'u-host', role: 'member' }, {
      groups: [
        { key: 'founder', label: 'Founders', description: null },
        { key: 'funder', label: 'Funders', description: 'Angels and funds' },
      ],
      question: 'Are you a founder or a funder?',
      allowMultiple: false,
      fallback: 'leave_unmatched',
      rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
    });
  });

  it('fills the defaults: the standard question, one group each, people left unmatched, no round rules', async () => {
    await request(app).put(`/sessions/${EVENT}/groups`).set(as('u-host')).send({ groups: rules.groups });
    expect(mockSave.mock.calls[0][2]).toMatchObject({
      question: 'Which group are you in?', allowMultiple: false, fallback: 'leave_unmatched', rounds: [],
    });
  });

  it.each([
    ['13 groups', { groups: Array.from({ length: 13 }, (_, i) => ({ key: `g${i}`, label: `G${i}` })) }],
    ['a key with capitals and spaces', { groups: [{ key: 'Big Group', label: 'Big' }] }],
    ['a label of 41 characters', { groups: [{ key: 'a', label: 'x'.repeat(41) }] }],
    ['an unknown mode', { groups: rules.groups, rounds: [{ fromRound: 1, toRound: 2, mode: 'random', allowedPairs: [] }] }],
    ['an unknown fallback', { groups: rules.groups, fallback: 'shuffle' }],
    ['a round 0', { groups: rules.groups, rounds: [{ fromRound: 0, toRound: 2, mode: 'open' }] }],
  ])('refuses %s before the service is asked', async (_label, body) => {
    const res = await request(app).put(`/sessions/${EVENT}/groups`).set(as('u-host')).send(body);
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('PUT /sessions/:id/participants/:userId/groups', () => {
  it('passes the keys on as the organiser\'s assignment', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/participants/${PERSON}/groups`).set(as('u-host')).send({ groupKeys: ['funder'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ groupKeys: ['funder'] });
    expect(mockSet).toHaveBeenCalledWith(EVENT, { userId: 'u-host', role: 'member' }, PERSON, ['funder'], 'organiser');
  });

  it('refuses a malformed key or a person id that is not an id', async () => {
    expect((await request(app).put(`/sessions/${EVENT}/participants/${PERSON}/groups`).set(as('u-host')).send({ groupKeys: ['Funder!'] })).status).toBe(400);
    expect((await request(app).put(`/sessions/${EVENT}/participants/nobody/groups`).set(as('u-host')).send({ groupKeys: ['funder'] })).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('the wiring', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

  it('every route signs in and is rate limited; writes by groupsWriteLimiter (30 a minute per person)', () => {
    const src = read('routes/event-groups.ts');
    expect(src).toMatch(/router\.get\('\/:id\/groups', authenticate, eventChatReadLimiter,/);
    expect(src).toMatch(/router\.put\('\/:id\/groups', authenticate, groupsWriteLimiter,/);
    expect(src).toMatch(/router\.put\('\/:id\/participants\/:userId\/groups', authenticate, groupsWriteLimiter,/);
    const limiter = read('middleware/rateLimit.ts');
    const block = limiter.slice(limiter.indexOf('export const groupsWriteLimiter'));
    expect(block).toMatch(/windowMs: 60 \* 1000,\s+max: 30,/);
    expect(block).toMatch(/keyGenerator: userOrIpKey/);
  });

  it('is mounted at /api/sessions', () => {
    expect(read('index.ts')).toMatch(/app\.use\('\/api\/sessions', eventGroupRoutes\);/);
  });

  it('POST /sessions/:id/register accepts groupKeys and passes them to registerParticipant, and nothing else changes', () => {
    const src = read('routes/sessions.ts');
    const start = src.indexOf("'/:id/register',");
    const route = src.slice(start, src.indexOf('\n);\n', start));
    expect(route).toMatch(/validate\(registerBodySchema\.default\(\{\}\)\)/);
    expect(route).toMatch(/registerParticipant\(\s*req\.params\.id, req\.user!\.userId, req\.user!\.role, groupKeys \? \{ groupKeys \} : undefined,\s*\)/);
    expect(src).toMatch(/const registerBodySchema = z\.object\(\{\s*groupKeys: z\.array\(z\.string\(\)\.refine\(isGroupKey,[^)]*\)\)\.max\(GROUP_LIMITS\.maxGroups\)\.optional\(\),\s*\}\)\.passthrough\(\);/);
  });
});
