// ─── GET /api/sessions/:id/report (10 Nov 2026 spec, Part 3 Task 4) ─────────────────────────────────────────────
//
// The route around getEventReport (a stand-in here; its rules are in services/session/event-report.test.ts): JSON by
// default, a CSV part with the right headers, a CSV without a part refused, each download written to the event's
// history (report.downloaded, the part and its rows) with session:<id>:audit sent to the organisers, and the two
// limiters keyed per member (thirty reads a minute; twenty downloads in ten minutes, JSON reads not counted).
//
// And the two ratings routes this task touches: POST /ratings tells the organisers' report only once the event is
// closing or over, and the legacy GET /ratings/sessions/:id/export keeps its shape but gives a host no private note
// and no individual score (an admin still gets the scores, never the notes).

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

const SESSION = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const MATCH = '33333333-3333-4333-8333-333333333333';

let lateStatus = 'completed';
const mockClientQuery = jest.fn().mockResolvedValue({ rows: [] });
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: (...a: unknown[]) => mockClientQuery(...a) }),
  __esModule: true,
}));
const mockEmit = jest.fn().mockResolvedValue(undefined);
const io = {};
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => io,
  __esModule: true,
}));
const mockGetReport = jest.fn();
jest.mock('../../services/session/event-report.service', () => ({
  ...jest.requireActual('../../services/session/event-report.service'),
  getEventReport: (...a: unknown[]) => mockGetReport(...a),
}));
const mockSubmit = jest.fn();
jest.mock('../../services/rating/rating.service', () => ({
  ...jest.requireActual('../../services/rating/rating.service'),
  submitRating: (...a: unknown[]) => mockSubmit(...a),
}));
jest.mock('../../services/orchestration/orchestration.service', () => ({
  notifyRatingSubmitted: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/session/session.service', () => ({
  getSessionById: jest.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', hostUserId: '22222222-2222-4222-8222-222222222222' }),
  isSessionParticipant: jest.fn().mockResolvedValue(true),
  __esModule: true,
}));

import type { EventReport } from '@rsn/shared';
import eventReportRoutes from '../../routes/event-report';
import ratingRoutes from '../../routes/ratings';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ForbiddenError } from '../../middleware/errors';

const app = express();
app.use(express.json());
app.use('/sessions', eventReportRoutes);
app.use('/ratings', ratingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });

// A distinct member per test, so the per-member limiters of one test never reach another.
let n = 0;
const nextMember = () => `44444444-4444-4444-8444-${String(++n).padStart(12, '0')}`;

const REPORT: EventReport = {
  event: { id: SESSION, title: 'Founders', status: 'completed', timezone: 'Europe/Copenhagen', scheduledAt: '2026-11-10T17:00:00.000Z', startedAt: null, endedAt: null },
  generatedAt: '2026-11-11T08:00:00.000Z',
  summary: {
    registered: 1, attended: 1, noShows: 0, removed: 0, stayed: 1, leftEarly: 0, couldNotJoin: 0, guests: 0,
    attendanceRate: 1, roundsPlanned: 1, roundsRun: 0, meetings: 0, manualRooms: 0, uniquePairsMet: 0, ratingsExpected: 0,
    ratingsSubmitted: 0, ratingCompletion: null, avgQuality: null, qualityDistribution: [0, 0, 0, 0, 0], didntWork: 0,
    meetAgainRate: null, mutualMatches: 0, feedbackCount: 0, scheduleVersionsPublished: 0,
  },
  people: [{
    userId: HOST, displayName: '=SUM(1,2)', email: 'a@example.com', accountKind: 'member', formerMember: false,
    role: 'participant', registeredAt: '2026-11-01T09:00:00.000Z', admittedVia: 'open', groups: [],
    joinedAt: '2026-11-10T17:01:00.000Z', leftAt: null, outcome: 'stayed', missedAMeeting: false, roundsCompleted: 1,
    meetings: 0, peopleMet: 0, ratingsGiven: 0, ratingsExpected: 0, mutualMatches: 0,
  }],
  rounds: [],
  meetings: [],
  mutualMatches: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  lateStatus = 'completed';
  mockGetReport.mockResolvedValue(REPORT);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM users WHERE id = \$1/.test(sql) && /account_kind/.test(sql)) return { rows: [{ status: 'active', account_kind: 'member' }] };
    if (/s\.status IN \('closing_lobby', 'completed'\)/.test(sql)) {
      return { rows: ['closing_lobby', 'completed'].includes(lateStatus) ? [{ session_id: SESSION }] : [] };
    }
    if (/pod_members/.test(sql)) return { rows: [{ user_id: HOST }] }; // resolveEventOrganiserIds
    if (/FROM session_cohosts WHERE session_id = \$1/.test(sql)) return { rows: [{ user_id: HOST }] }; // emitEventAuditChanged
    return legacyExportRows(sql, params);
  });
});

describe('GET /sessions/:id/report', () => {
  it('needs a sign-in, and a bad id is refused before the report is read', async () => {
    expect((await request(app).get(`/sessions/${SESSION}/report`)).status).toBe(401);
    expect((await request(app).get('/sessions/not-a-uuid/report').set(as(nextMember()))).status).toBe(400);
    expect(mockGetReport).not.toHaveBeenCalled();
  });

  it('answers the report as JSON by default, for the signed-in member', async () => {
    const me = nextMember();
    const res = await request(app).get(`/sessions/${SESSION.toUpperCase()}/report`).set(as(me));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: REPORT });
    expect(mockGetReport).toHaveBeenCalledWith(SESSION, { userId: me, role: 'member' });
    // A read: nothing written, nothing sent.
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('passes the service\'s refusal on as it is', async () => {
    mockGetReport.mockRejectedValue(new ForbiddenError('Only the people running this event can see its report.'));
    const res = await request(app).get(`/sessions/${SESSION}/report`).set(as(nextMember()));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the people running this event can see its report.');
  });

  it('a CSV needs a part; an unknown format, part or extra field is refused', async () => {
    const auth = as(nextMember());
    const noPart = await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv' }).set(auth);
    expect(noPart.status).toBe(400);
    expect(noPart.body.error.message).toBe('Choose which part of the report to download.');
    expect((await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'xml' }).set(auth)).status).toBe(400);
    expect((await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv', section: 'ratings' }).set(auth)).status).toBe(400);
    expect((await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'json', debug: '1' }).set(auth)).status).toBe(400);
    expect(mockGetReport).not.toHaveBeenCalled();
  });

  it('a CSV part is a file with a BOM, the right headers, its would-be formulas as text, and is written to the history', async () => {
    const me = nextMember();
    const res = await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv', section: 'attendance' }).set(as(me));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="rsn-event-2026-11-10-attendance.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.slice(1).split('\r\n');
    expect(lines[0].startsWith('Name,Email,Account,Role,Groups,Registered at (Europe/Copenhagen)')).toBe(true);
    expect(lines[1].startsWith(`"'=SUM(1,2)",a@example.com,Member`)).toBe(true);

    // report.downloaded, with the part and its row count, in the audit transaction...
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockClientQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audit_log/);
    expect(params.slice(0, 3)).toEqual([me, 'report.downloaded', SESSION]);
    expect(JSON.parse(params[3] as string)).toMatchObject({ automatic: false, after: { section: 'attendance', rows: 1 } });
    // ...and the organisers' history told.
    await new Promise((r) => setImmediate(r));
    expect(mockEmit).toHaveBeenCalledWith(io, [HOST], [`session:${SESSION}:audit`]);
  });

  it('every part downloads, each with its own name', async () => {
    const auth = as(nextMember());
    for (const section of ['meetings', 'mutual-matches']) {
      const res = await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv', section }).set(auth);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="rsn-event-2026-11-10-${section}.csv"`);
    }
  });

  it('a download whose history row cannot be written is refused, so no file leaves unrecorded', async () => {
    mockClientQuery.mockRejectedValueOnce(new Error('audit_log unavailable'));
    const res = await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv', section: 'attendance' }).set(as(nextMember()));
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('SUM');
  });

  it('thirty reads a minute per member; another member is not held back', async () => {
    const me = as(nextMember());
    for (let i = 0; i < 30; i++) expect((await request(app).get(`/sessions/${SESSION}/report`).set(me)).status).toBe(200);
    const limited = await request(app).get(`/sessions/${SESSION}/report`).set(me);
    expect(limited.status).toBe(429);
    expect((await request(app).get(`/sessions/${SESSION}/report`).set(as(nextMember()))).status).toBe(200);
  });

  it('twenty downloads in ten minutes per member, in words; JSON reads do not count and still work', async () => {
    const me = as(nextMember());
    const csv = () => request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv', section: 'meetings' }).set(me);
    for (let i = 0; i < 20; i++) expect((await csv()).status).toBe(200);
    const limited = await csv();
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toBe('You have downloaded this report a lot just now. Try again in a few minutes.');
    expect((await request(app).get(`/sessions/${SESSION}/report`).set(me)).status).toBe(200);
    expect((await request(app).get(`/sessions/${SESSION}/report`).query({ format: 'csv', section: 'meetings' }).set(as(nextMember()))).status).toBe(200);
  });
});

describe('POST /ratings tells the organisers\' report', () => {
  const rate = (sub: string) => request(app).post('/ratings').set(as(sub))
    .send({ matchId: MATCH, qualityScore: 4, meetAgain: true });

  beforeEach(() => {
    mockSubmit.mockResolvedValue({ id: 'r-1', matchId: MATCH });
  });

  it('once the event is closing or over (a rating from the recap)', async () => {
    for (const status of ['completed', 'closing_lobby']) {
      lateStatus = status;
      mockEmit.mockClear();
      expect((await rate(nextMember())).status).toBe(201);
      await new Promise((r) => setImmediate(r));
      expect(mockEmit).toHaveBeenCalledWith(io, [HOST], [`session:${SESSION}:ratings`]);
    }
  });

  it('not while a round is live: the round\'s close tells them once', async () => {
    lateStatus = 'round_rating';
    expect((await rate(nextMember())).status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ─── The legacy export ───────────────────────────────────────────────────────

const PRIVATE_NOTE = 'Talked over me the whole time';

/** What exportSessionData's statements read from Postgres, CASE expressions applied as Postgres would. */
function legacyExportRows(sql: string, params: unknown[]): { rows: Record<string, unknown>[] } {
  if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [{ id: SESSION, title: 'Founders', status: 'completed', config: {} }] };
  if (/FROM session_participants sp/.test(sql)) return { rows: [{ user_id: HOST, display_name: 'Ana', email: 'a@example.com' }] };
  if (/FROM ratings r/.test(sql) && /uf\.display_name AS from_name/.test(sql)) {
    const scores = params[1] === true;
    return {
      rows: [{
        match_id: MATCH, from_user_id: HOST, to_user_id: 'u-b', from_name: 'Ana', to_name: 'Ben', round_number: 1,
        quality_score: /CASE WHEN \$2::boolean THEN r\.quality_score END/.test(sql) && !scores ? null : 2,
        meet_again: /CASE WHEN \$2::boolean THEN r\.meet_again END/.test(sql) && !scores ? null : false,
        feedback: /NULL::text AS feedback/.test(sql) ? null : PRIVATE_NOTE,
      }],
    };
  }
  if (/FROM encounter_history eh/.test(sql) && /eh\.times_met/.test(sql)) {
    const scores = params[1] === true;
    return {
      rows: [{
        user_a_id: HOST, user_b_id: 'u-b', times_met: 1, mutual_meet_again: false,
        last_quality_score: /CASE WHEN \$2::boolean THEN eh\.last_quality_score END/.test(sql) && !scores ? null : 2,
      }],
    };
  }
  if (/AS "totalRatings"/.test(sql)) return { rows: [{ totalRatings: '1', avgQualityScore: '2', meetAgainCount: '0' }] };
  return { rows: [] };
}

describe('GET /ratings/sessions/:id/export keeps its shape and stops leaking', () => {
  it('a host gets every field, but no private note and no individual score', async () => {
    const res = await request(app).get(`/ratings/sessions/${SESSION}/export`).set(as(HOST));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['encounters', 'participants', 'ratings', 'rounds', 'session', 'stats']);
    const [rating] = res.body.data.ratings;
    expect(rating).toHaveProperty('feedback', null);
    expect(rating).toHaveProperty('quality_score', null);
    expect(rating).toHaveProperty('meet_again', null);
    expect(rating).toMatchObject({ from_name: 'Ana', to_name: 'Ben', round_number: 1 });
    expect(res.body.data.encounters[0]).toHaveProperty('last_quality_score', null);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_NOTE);
  });

  it('an admin still gets the scores, and never the private note either', async () => {
    const res = await request(app).get(`/ratings/sessions/${SESSION}/export`).set(as(nextMember(), 'admin'));
    expect(res.status).toBe(200);
    const [rating] = res.body.data.ratings;
    expect(rating).toMatchObject({ quality_score: 2, meet_again: false, feedback: null });
    expect(res.body.data.encounters[0].last_quality_score).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_NOTE);
  });
});
