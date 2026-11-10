// ─── Feedback after a meeting: the routes (30 Oct 2026, item 5c) ─────────────
//
// POST /meetings/:id/feedback (a meeting's two people, once it has started; a second press edits) and the admin
// list and CSV (GET /admin/feedback, /admin/feedback.csv; admins only, each download in the audit log). What each
// accepts and refuses, who may call it, and the limits. The services are stand-ins (their rules run on a real
// Postgres in services/meetings/meeting-feedback.sql.test.ts); the routers, the sign-in, the role check and the
// limiters are real.

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
const mockDbQuery = jest.fn();
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active; recordAudit writes its row through the same query.
  query: (...a: unknown[]) => mockDbQuery(...a),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/meetings/meeting.service', () => ({
  listMeetings: jest.fn(), getMeetingSummary: jest.fn(), getMeeting: jest.fn(), cancelMeeting: jest.fn(), __esModule: true,
}));
const mockSubmit = jest.fn();
const mockAnnounce = jest.fn();
const mockList = jest.fn();
const mockAll = jest.fn();
jest.mock('../../services/meetings/meeting-feedback.service', () => {
  const real = jest.requireActual('../../services/meetings/meeting-feedback.service');
  return {
    __esModule: true,
    ADMIN_FEEDBACK_PAGE_MAX: real.ADMIN_FEEDBACK_PAGE_MAX,
    isAdminFeedbackCursor: real.isAdminFeedbackCursor,
    adminFeedbackCsv: real.adminFeedbackCsv,
    submitMeetingFeedback: (...a: unknown[]) => mockSubmit(...a),
    announceFeedback: (...a: unknown[]) => mockAnnounce(...a),
    listAdminFeedback: (...a: unknown[]) => mockList(...a),
    allAdminFeedback: (...a: unknown[]) => mockAll(...a),
  };
});

import meetingsRoutes from '../../routes/meetings';
import adminFeedbackRoutes from '../../routes/admin-feedback';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { meetingFeedbackLimiter, adminFeedbackExportLimiter, adminFeedbackReadLimiter } from '../../middleware/rateLimit';
import { ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes, type AdminFeedbackRow } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/meetings', meetingsRoutes);
app.use('/admin', adminFeedbackRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') => jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });
const ID = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

const saved = (extra: Record<string, unknown> = {}) => ({
  id: 'o-1', meetingId: ID, worthContinuing: 'yes', problems: [], problemText: null, createdAt: '2026-11-01T10:00:00.000Z', ...extra,
});

const row = (extra: Partial<AdminFeedbackRow> = {}): AdminFeedbackRow => ({
  id: 'o-1', answeredAt: '2026-11-01T10:00:00.000Z', source: 'meeting',
  meeting: { id: ID, startAt: '2026-11-01T09:30:00.000Z', durationMin: 30, kind: 'video' },
  from: { userId: 'u-a', displayName: 'Ana', isFormerMember: false },
  about: { userId: 'u-b', displayName: 'Former member', isFormerMember: true },
  answer: { worthContinuing: 'maybe', problems: ['connection', 'other'], problemText: '=HYPERLINK("x"), "quoted"', outcomes: [] },
  theirAnswer: { worthContinuing: 'yes', problems: [], problemText: null },
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member' }] });
  mockSubmit.mockResolvedValue(saved());
  mockAnnounce.mockResolvedValue(undefined);
  mockList.mockResolvedValue({ items: [row()], nextCursor: null });
  mockAll.mockResolvedValue([row(), row({ id: 'o-2', source: null, meeting: null, theirAnswer: null })]);
});

describe('POST /meetings/:id/feedback', () => {
  const me = as('u-answer');

  it('saves the answer for this member and tells the screens; the answer comes back as stored', async () => {
    const res = await request(app).post(`/meetings/${ID.toUpperCase()}/feedback`).set(me)
      .send({ worthContinuing: 'maybe', problems: ['connection'], problemText: 'It froze' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: saved() });
    expect(mockSubmit).toHaveBeenCalledWith('u-answer', ID, { worthContinuing: 'maybe', problems: ['connection'], problemText: 'It froze' });
    expect(mockAnnounce).toHaveBeenCalledWith('u-answer', ID);
  });

  it('takes Worth continuing on its own: problems and text are optional', async () => {
    expect((await request(app).post(`/meetings/${ID}/feedback`).set(me).send({ worthContinuing: 'yes' })).status).toBe(200);
    expect(mockSubmit).toHaveBeenCalledWith('u-answer', ID, { worthContinuing: 'yes' });
  });

  it.each([
    ['no answer at all', {}],
    ['an answer that is not Yes, Maybe or No', { worthContinuing: 'great' }],
    ['a problem that is not on the list', { worthContinuing: 'no', problems: ['noise'] }],
    ['problems that are not a list', { worthContinuing: 'no', problems: 'audio' }],
    ['text over 1000 characters', { worthContinuing: 'no', problemText: 'x'.repeat(1001) }],
  ])('refuses %s with a 400 and saves nothing', async (_label, body) => {
    const res = await request(app).post(`/meetings/${ID}/feedback`).set(me).send(body);
    expect(res.status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it('says in words why Worth continuing is missing', async () => {
    const res = await request(app).post(`/meetings/${ID}/feedback`).set(me).send({ worthContinuing: 'great' });
    expect(JSON.stringify(res.body)).toContain('Choose Yes, Maybe or No.');
  });

  it('takes 1000 characters exactly', async () => {
    expect((await request(app).post(`/meetings/${ID}/feedback`).set(me).send({ worthContinuing: 'no', problemText: 'x'.repeat(1000) })).status).toBe(200);
  });

  it('someone who is not one of the two gets the service\'s 403 sentence; nobody is told anything', async () => {
    mockSubmit.mockRejectedValueOnce(new ForbiddenError('Only the two people in this meeting can say how it went.'));
    const res = await request(app).post(`/meetings/${ID}/feedback`).set(me).send({ worthContinuing: 'yes' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the two people in this meeting can say how it went.');
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it('a meeting that has not started is a 409 said in words, and an unknown one a 404', async () => {
    mockSubmit.mockRejectedValueOnce(new ConflictError(ErrorCodes.MEETING_NOT_STARTED, 'You can say how it went once the meeting has started.'));
    const early = await request(app).post(`/meetings/${ID}/feedback`).set(me).send({ worthContinuing: 'yes' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'MEETING_NOT_STARTED', message: 'You can say how it went once the meeting has started.' });
    mockSubmit.mockRejectedValueOnce(new NotFoundError('Meeting', undefined, "We couldn't find that meeting."));
    expect((await request(app).post(`/meetings/${ID}/feedback`).set(me).send({ worthContinuing: 'yes' })).status).toBe(404);
  });

  it('a closed account is turned away by the sign-in check before the route runs', async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ status: 'deactivated' }] });
    const res = await request(app).post(`/meetings/${ID}/feedback`).set(as('u-closed')).send({ worthContinuing: 'yes' });
    expect(res.status).toBe(401);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('needs a signed-in member, and a meeting id', async () => {
    expect((await request(app).post(`/meetings/${ID}/feedback`).send({ worthContinuing: 'yes' })).status).toBe(401);
    expect((await request(app).post('/meetings/not-a-meeting/feedback').set(me).send({ worthContinuing: 'yes' })).status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('has an allowance of 30 an hour per member, said in words, and a refusal uses none of it', async () => {
    const busy = as('u-busy');
    for (let i = 0; i < 5; i += 1) {
      mockSubmit.mockRejectedValueOnce(new ConflictError(ErrorCodes.MEETING_NOT_STARTED, 'You can say how it went once the meeting has started.'));
      expect((await request(app).post(`/meetings/${ID}/feedback`).set(busy).send({ worthContinuing: 'yes' })).status).toBe(409);
    }
    for (let i = 0; i < 30; i += 1) {
      expect((await request(app).post(`/meetings/${ID}/feedback`).set(busy).send({ worthContinuing: 'yes' })).status).toBe(200);
    }
    const refused = await request(app).post(`/meetings/${ID}/feedback`).set(busy).send({ worthContinuing: 'yes' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toBe('You have sent a lot of feedback this hour. Try again later.');
    expect((await request(app).post(`/meetings/${ID}/feedback`).set(as('u-calm')).send({ worthContinuing: 'yes' })).status).toBe(200);
  });
});

describe('GET /admin/feedback', () => {
  const adminMe = as('u-admin', 'admin');

  it('answers a page of rows for an admin: 30 by default, every answer', async () => {
    const res = await request(app).get('/admin/feedback').set(adminMe);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { items: [row()], nextCursor: null } });
    expect(mockList).toHaveBeenCalledWith({ problemsOnly: false, limit: 30, cursor: undefined });
  });

  it('passes "Only with problems", the page size and the page on', async () => {
    const cursor = '2026-11-01T10:00:00.123456Z~5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
    await request(app).get('/admin/feedback').query({ problems: 'only', limit: '5', cursor }).set(adminMe);
    expect(mockList).toHaveBeenCalledWith({ problemsOnly: true, limit: 5, cursor });
  });

  it.each([
    ['a filter that does not exist', { problems: 'some' }],
    ['a page size over 100', { limit: '101' }],
    ['a page size of 0', { limit: '0' }],
    ['a page that is not one of this list\'s', { cursor: "x' OR 1=1" }],
  ])('refuses %s with a 400', async (_label, q) => {
    expect((await request(app).get('/admin/feedback').query(q).set(adminMe)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('a super admin reads it too', async () => {
    expect((await request(app).get('/admin/feedback').set(as('u-super', 'super_admin'))).status).toBe(200);
  });

  it('a member is refused with a 403, and reads nothing', async () => {
    const res = await request(app).get('/admin/feedback').set(as('u-member'));
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect((await request(app).get('/admin/feedback.csv').set(as('u-member'))).status).toBe(403);
    expect(mockAll).not.toHaveBeenCalled();
  });

  it('nobody signed out reads it', async () => {
    expect((await request(app).get('/admin/feedback')).status).toBe(401);
    expect((await request(app).get('/admin/feedback.csv')).status).toBe(401);
  });
});

describe('GET /admin/feedback.csv', () => {
  const adminMe = as('u-csv', 'admin');

  it('downloads every row as a CSV and writes who took it to the audit log first', async () => {
    const res = await request(app).get('/admin/feedback.csv').query({ problems: 'only' }).set(adminMe);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="reason-meeting-feedback-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(mockAll).toHaveBeenCalledWith(true);
    const audit = mockDbQuery.mock.calls.find((c) => /INSERT INTO audit_log/.test(String(c[0])));
    expect(audit).toBeDefined();
    expect(audit![1]).toEqual(['u-csv', 'admin.feedback_csv_download', 'meeting_feedback', null, JSON.stringify({ problems: 'only', rows: 2 }), expect.any(String)]);

    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('answered_at,source,meeting_id,meeting_start_at,meeting_kind,from_user_id,from_name,about_user_id,about_name,worth_continuing,problems,problem_text,outcomes,their_worth_continuing,their_problems,their_problem_text');
    // A member's words that a spreadsheet would run as a formula are written as text.
    expect(lines[1]).toBe(`2026-11-01T10:00:00.000Z,meeting,${ID},2026-11-01T09:30:00.000Z,video,u-a,Ana,u-b,Former member,maybe,connection other,"'=HYPERLINK(""x""), ""quoted""",,yes,,`);
    // The profile sheet's answer: no meeting, source "profile".
    expect(lines[2]).toMatch(/^2026-11-01T10:00:00\.000Z,profile,,,,u-a,Ana,u-b,Former member,maybe,/);
  });
});

describe('the routes are guarded and limited in the right order', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlersOf = (router: unknown, method: string, routePath: string) =>
    (router as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === routePath && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it('feedback signs in, then counts, then runs', () => {
    const handlers = handlersOf(meetingsRoutes, 'post', '/:id/feedback');
    expect(handlers.indexOf(authenticate)).toBe(0);
    expect(handlers.indexOf(meetingFeedbackLimiter)).toBe(1);
  });

  it('the admin list and CSV sign in, check the role, then count', () => {
    for (const [routePath, limiter] of [['/feedback', adminFeedbackReadLimiter], ['/feedback.csv', adminFeedbackExportLimiter]] as const) {
      const handlers = handlersOf(adminFeedbackRoutes, 'get', routePath);
      expect(handlers[0]).toBe(authenticate);
      expect(handlers.indexOf(limiter)).toBe(2);
      expect(String(handlers[1])).toBe(String(requireRole()));
    }
  });

  it('the server mounts the admin feedback routes under /api/admin', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    expect(index).toMatch(/import adminFeedbackRoutes from '\.\/routes\/admin-feedback';/);
    expect(index).toContain("app.use('/api/admin', adminFeedbackRoutes);");
  });
});
