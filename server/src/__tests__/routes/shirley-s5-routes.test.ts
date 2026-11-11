// ─── Shirley Palmer's S5 routes (11 Nov 2026): reports, presence, block ─────────────────────────────────
//
// Through express with the real routers, the real validation and the real limiters; sign-in, the services and the
// database are stand-ins.
//   - POST /reports: a member, a message or a post; its own limiter (10 an hour per member, refusals not counted);
//     "You already reported this." passes through as a 409 in those words.
//   - GET /dm/presence: online / away / offline per partner, blocked pairs left out of the read; `online` kept.
//   - GET /dm/conversations/:id/partner-presence: { online, state }.
//   - GET /calls/user/:userId/presence: only for someone the member may call.
//   - POST /users/:id/block ends what the two had going (read from source: the users router is heavy to stand up).

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', jwtSecret: 'test-secret', rateLimitWindowMs: 60_000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
let mockUser = 'aaaaaaaa-0000-4000-8000-000000000001';
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { userId: req.headers['x-as'] ?? mockUser, email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockSubmit = jest.fn();
jest.mock('../../services/report/report.service', () => ({
  __esModule: true,
  submitReport: (...a: unknown[]) => mockSubmit(...a),
  listOpenReports: jest.fn(), resolveReport: jest.fn(), dismissReport: jest.fn(),
}));
const mockFanoutAdmin = jest.fn(() => Promise.resolve());
jest.mock('../../realtime/fanout', () => ({ __esModule: true, fanoutAdminEntities: (...a: unknown[]) => mockFanoutAdmin(...(a as [])) }));
const mockPartnerPresence = jest.fn();
jest.mock('../../services/dm/meeting-call.service', () => ({
  __esModule: true,
  partnerPresence: (...a: unknown[]) => mockPartnerPresence(...a),
  requestCallToUser: jest.fn(), requestCall: jest.fn(), getIncomingCallRequest: jest.fn(), getOutgoingCallRequest: jest.fn(),
}));
jest.mock('../../services/dm/meeting-windows.service', () => ({ __esModule: true }));
const mockPresenceOf = jest.fn();
const mockPresenceState = jest.fn();
jest.mock('../../services/presence/presence.service', () => ({
  __esModule: true,
  presenceOf: (...a: unknown[]) => mockPresenceOf(...a),
  presenceState: (...a: unknown[]) => mockPresenceState(...a),
}));
const mockRequireConnection = jest.fn();
jest.mock('../../services/dm/call-eligibility', () => ({
  __esModule: true, requireConnection: (...a: unknown[]) => mockRequireConnection(...a),
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import reportRoutes from '../../routes/reports';
import callsRoutes from '../../routes/calls';
import meetingRoutes from '../../routes/meeting';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ConflictError, ForbiddenError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/reports', reportRoutes);
app.use('/calls', callsRoutes);
app.use('/dm', meetingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = 'cccccccc-0000-4000-8000-000000000003';
const MSG = 'dddddddd-0000-4000-8000-000000000004';
let n = 0;
/** A fresh member per test, so each has its own bucket (the limiter keys on the member the signed token names). */
const someone = () => {
  const id = `member-${++n}`;
  mockUser = id;
  return `Bearer ${jwt.sign({ sub: id }, 'test-secret')}`;
};

beforeEach(() => {
  mockSubmit.mockReset().mockResolvedValue({ id: 'rep-1' });
  mockPartnerPresence.mockReset();
  mockPresenceOf.mockReset();
  mockPresenceState.mockReset();
  mockRequireConnection.mockReset().mockResolvedValue({ name: 'Bo' });
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
});

describe('POST /reports', () => {
  it('a member report reaches the service with who is reporting, and every admin queue is told', async () => {
    const res = await request(app).post('/reports').set('authorization', someone()).send({ reportedId: B, reason: 'spam' });
    expect(res.status).toBe(201);
    expect(mockSubmit).toHaveBeenCalledWith(
      { userId: mockUser, role: 'member' },
      { reportedId: B, reason: 'spam', description: undefined, conversationId: undefined, subject: undefined },
    );
    expect(mockFanoutAdmin).toHaveBeenCalledWith('violations');
  });

  it('a message report needs no member id (the service names the author), and its id is read in any case', async () => {
    const res = await request(app).post('/reports').set('authorization', someone())
      .send({ reason: 'harassment', subject: { kind: 'dm_message', id: MSG.toUpperCase() } });
    expect(res.status).toBe(201);
    expect(mockSubmit.mock.calls[0][1]).toMatchObject({ subject: { kind: 'dm_message', id: MSG } });
  });

  it.each([
    ['nothing to report', { reason: 'spam' }],
    ['no reason (none is chosen for the person)', { reportedId: B }],
    ['an unknown reason', { reportedId: B, reason: 'annoying' }],
    ['an unknown kind of subject', { reason: 'spam', subject: { kind: 'event', id: MSG } }],
    ['a subject id that is no id', { reason: 'spam', subject: { kind: 'pod_post', id: 'x' } }],
    ['details over 2000 characters', { reportedId: B, reason: 'spam', description: 'x'.repeat(2001) }],
  ])('%s is a 400 and reaches no service', async (_label, body) => {
    const res = await request(app).post('/reports').set('authorization', someone()).send(body);
    expect(res.status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('the same report again is a 409 that says "You already reported this."', async () => {
    mockSubmit.mockRejectedValue(new ConflictError(ErrorCodes.REPORT_ALREADY_SENT, 'You already reported this.'));
    const res = await request(app).post('/reports').set('authorization', someone()).send({ reportedId: B, reason: 'spam' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'REPORT_ALREADY_SENT', message: 'You already reported this.' });
  });

  it('has its own limit: 10 reports an hour per member; the 11th is a 429 in words, and refusals are not counted', async () => {
    const who = someone();
    mockSubmit.mockRejectedValueOnce(new ConflictError(ErrorCodes.REPORT_ALREADY_SENT, 'You already reported this.'));
    expect((await request(app).post('/reports').set('authorization', who).send({ reportedId: B, reason: 'spam' })).status).toBe(409);
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post('/reports').set('authorization', who).send({ reportedId: B, reason: 'spam' })).status).toBe(201);
    }
    const res = await request(app).post('/reports').set('authorization', who).send({ reportedId: B, reason: 'spam' });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/a lot of reports this hour/);
    // Another member is not held back by it.
    expect((await request(app).post('/reports').set('authorization', someone()).send({ reportedId: B, reason: 'spam' })).status).toBe(201);
  });
});

describe('GET /dm/presence', () => {
  it('reads my partners with blocked pairs left out, and answers states plus the older online map', async () => {
    mockQuery.mockResolvedValue({ rows: [{ partner_id: 'u-1' }, { partner_id: 'u-2' }, { partner_id: 'u-3' }] });
    mockPresenceOf.mockResolvedValue({ 'u-1': 'online', 'u-2': 'away', 'u-3': 'offline' });
    const res = await request(app).get('/dm/presence').set('authorization', someone());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      online: { 'u-1': true, 'u-2': false, 'u-3': false },
      states: { 'u-1': 'online', 'u-2': 'away', 'u-3': 'offline' },
    });
    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('NOT EXISTS ( SELECT 1 FROM user_blocks b');
    expect(sql).toContain('LIMIT 500');
    expect(mockPresenceOf).toHaveBeenCalledWith(['u-1', 'u-2', 'u-3']);
  });

  it('a partner the read could not place is left out of both maps (unknown, never offline)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ partner_id: 'u-1' }] });
    mockPresenceOf.mockResolvedValue({});
    const res = await request(app).get('/dm/presence').set('authorization', someone());
    expect(res.body.data).toEqual({ online: {}, states: {} });
  });
});

describe('GET /dm/conversations/:id/partner-presence', () => {
  it.each([['online', true], ['away', false], ['offline', false], [null, false]] as const)('%s answers { online: %s, state }', async (state, online) => {
    mockPartnerPresence.mockResolvedValue(state);
    const res = await request(app).get(`/dm/conversations/${CONV}/partner-presence`).set('authorization', someone());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ online, state });
  });

  it('a blocked pair is refused, as a call is', async () => {
    mockPartnerPresence.mockRejectedValue(new ForbiddenError('You cannot call this member'));
    const res = await request(app).get(`/dm/conversations/${CONV}/partner-presence`).set('authorization', someone());
    expect(res.status).toBe(403);
  });
});

describe('GET /calls/user/:userId/presence (the profile\'s call button)', () => {
  it('answers where a connection is', async () => {
    mockPresenceState.mockResolvedValue('away');
    const res = await request(app).get(`/calls/user/${B}/presence`).set('authorization', someone());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ state: 'away' });
    expect(mockRequireConnection).toHaveBeenCalledWith(mockUser, B);
  });

  it('probes nobody the member may not call: the refusal stands and presence is never read', async () => {
    mockRequireConnection.mockRejectedValue(new ForbiddenError('You can call the people you are connected with. Send a meeting request first.'));
    const res = await request(app).get(`/calls/user/${B}/presence`).set('authorization', someone());
    expect(res.status).toBe(403);
    expect(mockPresenceState).not.toHaveBeenCalled();
  });

  it('an id that is no member id is a 400', async () => {
    const res = await request(app).get('/calls/user/not-an-id/presence').set('authorization', someone());
    expect(res.status).toBe(400);
  });
});

describe('POST /users/:id/block (source)', () => {
  it('after the block is saved and both sides told, ends any call between the two, best-effort', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../routes/users.ts'), 'utf8');
    const block = src.slice(src.indexOf("'/:id/block',"), src.indexOf('// DELETE /users/:id/block'));
    expect(block).toMatch(/fanoutUserBlocks\(req\.user!\.userId, req\.params\.id\)\.catch\(\(\) => \{\}\);\s*\/\/[^\n]*\n[^\n]*\n\s*endCallsOnBlock\(req\.user!\.userId, req\.params\.id\)\.catch\(/);
  });
});
