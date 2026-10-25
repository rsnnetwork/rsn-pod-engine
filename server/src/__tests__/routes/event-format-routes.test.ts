// ─── The event-format API (26 Oct 2026) ──────────────────────────────────────────────────────────
//
// POST/PUT /api/sessions take an optional top-level `format` (one of the defined formats; anything else is a
// 400 before the service is reached), and the old form's body without it is still accepted. A meeting has
// no rounds, so GET /sessions/:id/plan answers an empty plan for it (production's live page hides the Event
// Plan strip on an empty plan). POST /pods now tells the creator's lists and the admin pod list, where it
// used to emit nothing and the client had to refetch by hand.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm',
    magicLinkExpiryMinutes: 15, clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/session/session.service');
jest.mock('../../services/pod/pod.service');

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn(async () => {});
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => (mockEmitEntities as jest.Mock)(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as sessionService from '../../services/session/session.service';
import * as podService from '../../services/pod/pod.service';
import sessionRoutes from '../../routes/sessions';
import podRoutes from '../../routes/pods';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const POD_ID = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const SESSION_ID = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const ME = 'user-me';
const ADMIN_A = 'user-admin-a';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/sessions', sessionRoutes);
  a.use('/pods', podRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

function token(role = 'member', sub = ME) {
  return jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });
}

const flush = () => new Promise((r) => setImmediate(r));

/** The database: the auth middleware's status lookup finds an active member; `extra` answers the rest. */
function db(extra: (sql: string) => { rows: unknown[] } | undefined = () => undefined) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT status FROM users WHERE id = \$1/.test(sql)) return { rows: [{ status: 'active' }] };
    return extra(sql) ?? { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  db();
  mockEmitEntities.mockClear();
  (sessionService.createSession as jest.Mock).mockResolvedValue({ id: SESSION_ID, podId: POD_ID, format: 'video_meeting' });
  (sessionService.updateSession as jest.Mock).mockResolvedValue({ id: SESSION_ID, podId: POD_ID, format: 'video_meeting' });
});

describe('POST /sessions', () => {
  const body = { podId: POD_ID, title: 'Video meeting · Test', scheduledAt: '2026-11-01T12:00:00.000Z' };

  it('passes an explicit format and a meeting length to the service', async () => {
    const res = await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, format: 'video_meeting', config: { durationMinutes: 90, maxParticipants: 8 } });
    expect(res.status).toBe(201);
    const input = (sessionService.createSession as jest.Mock).mock.calls[0][1];
    expect(input).toMatchObject({ format: 'video_meeting', config: { durationMinutes: 90, maxParticipants: 8 } });
  });

  it('passes a round length in minutes through to the service', async () => {
    await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, format: 'speed_networking', config: { roundMinutes: 4 } });
    expect((sessionService.createSession as jest.Mock).mock.calls[0][1].config).toEqual({ roundMinutes: 4 });
  });

  it('leaves the range of the two form settings to the service, which answers in the definition’s words', async () => {
    await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, config: { eventType: 'video_meeting', durationMinutes: 1440 } });
    await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, config: { roundMinutes: 0.001 } });
    const configs = (sessionService.createSession as jest.Mock).mock.calls.map((c) => c[1].config);
    expect(configs).toEqual([{ eventType: 'video_meeting', durationMinutes: 1440 }, { roundMinutes: 0.001 }]);
  });

  it('refuses a form setting that is not a number, before the service', async () => {
    const res = await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, config: { roundMinutes: 'four' } });
    expect(res.status).toBe(400);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('refuses a format that does not exist, before the service', async () => {
    const res = await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, format: 'roundtable' });
    expect(res.status).toBe(400);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it("still accepts production's old body: config.eventType and no format", async () => {
    const res = await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`)
      .send({ ...body, config: { eventType: 'video_meeting', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500 } });
    expect(res.status).toBe(201);
    const input = (sessionService.createSession as jest.Mock).mock.calls[0][1];
    expect(input.format).toBeUndefined();
    expect(input.config).toMatchObject({ eventType: 'video_meeting', maxParticipants: 500 });
  });
});

describe('PUT /sessions/:id', () => {
  it('passes an explicit format to the service', async () => {
    const res = await request(app()).put(`/sessions/${SESSION_ID}`).set('Authorization', `Bearer ${token()}`)
      .send({ format: 'speed_networking', config: { numberOfRounds: 3 } });
    expect(res.status).toBe(200);
    expect((sessionService.updateSession as jest.Mock).mock.calls[0][2]).toMatchObject({ format: 'speed_networking' });
  });

  it('refuses a format that does not exist', async () => {
    const res = await request(app()).put(`/sessions/${SESSION_ID}`).set('Authorization', `Bearer ${token()}`)
      .send({ format: 'nonsense' });
    expect(res.status).toBe(400);
    expect(sessionService.updateSession).not.toHaveBeenCalled();
  });
});

describe('GET /sessions/:id/plan', () => {
  function eventRow(row: Record<string, unknown>) {
    db((sql) => (/FROM sessions WHERE id = \$1/.test(sql) ? { rows: [row] } : undefined));
  }

  it('is empty for a video meeting: no rounds, nothing planned', async () => {
    eventRow({ host_user_id: ME, pod_id: POD_ID, config: { durationMinutes: 60, eventType: 'video_meeting' }, event_format: 'video_meeting' });
    const res = await request(app()).get(`/sessions/${SESSION_ID}/plan`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ rounds: [], totalRounds: 0 });
    expect(mockQuery.mock.calls.some(([sql]) => /FROM matches/.test(sql as string))).toBe(false);
  });

  it('still lists every round of a speed-networking event', async () => {
    eventRow({ host_user_id: ME, pod_id: POD_ID, config: { numberOfRounds: 3 }, event_format: 'speed_networking' });
    const res = await request(app()).get(`/sessions/${SESSION_ID}/plan`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalRounds).toBe(3);
    expect(res.body.data.rounds).toHaveLength(3);
  });

  it('still refuses a participant who is not a host', async () => {
    eventRow({ host_user_id: 'someone-else', pod_id: POD_ID, config: {}, event_format: 'video_meeting' });
    const res = await request(app()).get(`/sessions/${SESSION_ID}/plan`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /pods tells the creator and the admins', () => {
  it('emits the new pod and the creator’s pods to the creator, and admin:pods to every admin', async () => {
    (podService.createPod as jest.Mock).mockResolvedValue({ id: POD_ID, podType: 'reason', orchestrationMode: 'free_form' });
    db((sql) => {
      if (/FROM pod_members/.test(sql)) return { rows: [{ user_id: ME }] };
      if (/FROM users WHERE role IN \('admin', 'super_admin'\)/.test(sql)) return { rows: [{ id: ADMIN_A }] };
      return undefined;
    });
    const res = await request(app()).post('/pods').set('Authorization', `Bearer ${token()}`)
      .send({ name: 'Test', podType: 'reason' });
    expect(res.status).toBe(201);
    await flush(); await flush();
    const told = (mockEmitEntities as jest.Mock).mock.calls.map(([, users, tags]) => ({ users, tags }));
    expect(told).toContainEqual({ users: [ME], tags: expect.arrayContaining([`pod:${POD_ID}`, `user:${ME}:pods`]) });
    expect(told).toContainEqual({ users: [ADMIN_A], tags: expect.arrayContaining(['admin:pods']) });
    // The service decides the type-derived defaults; the route passes the body through untouched.
    expect((podService.createPod as jest.Mock).mock.calls[0][1]).toEqual({ name: 'Test', podType: 'reason' });
  });
});
