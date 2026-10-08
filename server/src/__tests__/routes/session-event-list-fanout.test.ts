// server/src/__tests__/routes/session-event-list-fanout.test.ts
// 8 Oct 2026: an event (the sessions table) was created, renamed, rescheduled, cancelled or
// deleted without telling the lists that show it. Home and Sessions listen on
// user:<id>:sessions, and the For You "next event" panel follows the member's pods
// (user:<id>:pods), so a changed event reached an open page only on focus or remount.
//
// These tests go through each route to the emit: the real routes and the real fanout helper,
// a fake database that answers by WHO the SQL asks for (participants, pod members, host), and
// the emit boundary recorded. The session service is mocked: its rules are tested elsewhere.
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    jwtAccessExpiry: '15m',
    jwtRefreshExpiry: '7d',
    magicLinkSecret: 'test-magic-link-secret',
    magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
  },
  __esModule: true,
}));
const mockLoggerWarn = jest.fn();
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/session/session.service');

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn();
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as sessionService from '../../services/session/session.service';
import sessionRoutes from '../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ForbiddenError } from '../../middleware/errors';

const POD_ID = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const SESSION_ID = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';

// Five people, each in a different relation to the event.
const ADMIN_HOST = 'user-admin-host'; // runs the event, has left it, and is not a member of the pod
const GUEST = 'user-guest';           // registered for the event, not a member of the pod
const MEMBER_A = 'user-member-a';     // member of the pod, and registered
const MEMBER_B = 'user-member-b';     // member of the pod, not registered
const OUTSIDER = 'user-outsider';     // has nothing to do with the event

const AUDIENCE = [ADMIN_HOST, GUEST, MEMBER_A, MEMBER_B];

/** What the database holds about this event, as far as who could be looking at it. */
const world = {
  podId: POD_ID as string | null,
  participants: [] as string[],
  podMembers: [] as string[],
  hostId: ADMIN_HOST,
  eventRowExists: true,
  failAudience: false,
  failFirstHostRead: false,
};

function resetWorld() {
  world.podId = POD_ID;
  world.participants = [GUEST, MEMBER_A];
  world.podMembers = [MEMBER_A, MEMBER_B];
  world.hostId = ADMIN_HOST;
  world.eventRowExists = true;
  world.failAudience = false;
  world.failFirstHostRead = false;
}

/**
 * Answers the audience SQL by the groups it asks for, from the event's rows as they are at that moment.
 * A person in two groups comes back twice: whoever tells them must still tell them once.
 */
function audienceRows(sql: string, params: unknown[]) {
  const ids: string[] = [];
  if (/FROM session_participants/.test(sql) && world.eventRowExists) ids.push(...world.participants);
  if (/FROM pod_members/.test(sql) && world.podId !== null && params.includes(world.podId)) ids.push(...world.podMembers);
  if (/host_user_id/.test(sql) && world.eventRowExists) ids.push(world.hostId);
  return ids.map((user_id) => ({ user_id }));
}

function armDatabase() {
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/SELECT status FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
    if (/SELECT pod_id FROM sessions WHERE id/.test(sql)) {
      return Promise.resolve({ rows: world.eventRowExists ? [{ pod_id: world.podId }] : [], rowCount: 1 });
    }
    if (/session_participants|pod_members|host_user_id/.test(sql)) {
      if (world.failAudience) return Promise.reject(new Error('database is down'));
      if (world.failFirstHostRead && /host_user_id/.test(sql)) {
        world.failFirstHostRead = false;
        return Promise.reject(new Error('connection reset'));
      }
      return Promise.resolve({ rows: audienceRows(sql, params), rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

/** What happened, in order, so a test can say "the event was gone before anyone was told". */
let order: string[] = [];

const session = () => ({ id: SESSION_ID, podId: world.podId, title: 'Friday founders', hostUserId: world.hostId });

const app = express();
app.use(express.json());
app.use('/sessions', sessionRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

let nextActor = 0;
function actor(role: 'member' | 'super_admin' = 'member') {
  nextActor += 1;
  const token = jwt.sign(
    { sub: `actor-${nextActor}`, email: `actor-${nextActor}@example.com`, role, sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' },
  );
  return { Authorization: `Bearer ${token}` };
}

/** The routes tell the lists after they have answered, without being waited for. */
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Every emit that names the member's own event or pod lists: [recipients, tags] as the helper sent them. */
function listEmits() {
  return mockEmitEntities.mock.calls
    .filter((call) => (call[2] as string[]).some((tag) => /^user:[^:]+:(sessions|pods)$/.test(tag)))
    .map((call) => ({ io: call[0], recipients: call[1] as string[], tags: [...(call[2] as string[])].sort() }));
}

/** Each of these people was told once, with their own two tags and nobody else's. */
function expectToldWithOwnTags(people: string[]) {
  const sent = listEmits();
  expect(sent.map((e) => e.recipients).flat().sort()).toEqual([...people].sort());
  for (const id of people) {
    expect(sent).toContainEqual({ io: mockIo, recipients: [id], tags: [`user:${id}:pods`, `user:${id}:sessions`] });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWorld();
  order = [];
  armDatabase();
  mockEmitEntities.mockImplementation(async (_io: unknown, _ids: string[], tags: string[]) => {
    if (tags.some((tag) => /^user:[^:]+:(sessions|pods)$/.test(tag))) order.push('told the lists');
  });
  (sessionService.createSession as jest.Mock).mockImplementation(async () => session());
  (sessionService.updateSession as jest.Mock).mockImplementation(async () => session());
  (sessionService.deleteSession as jest.Mock).mockImplementation(async () => { order.push('cancelled'); });
  (sessionService.hardDeleteSession as jest.Mock).mockImplementation(async () => {
    order.push('deleted');
    // The rows that name the participants and the host go with the event.
    world.eventRowExists = false;
  });
});

describe('creating an event', () => {
  it('tells everyone who could see it: its participants, its pod and its host, once each', async () => {
    const res = await request(app).post('/sessions').set(actor()).send({
      podId: POD_ID, title: 'Friday founders', scheduledAt: '2026-10-16T17:00:00.000Z',
    });
    await settle();

    expect(res.status).toBe(201);
    expectToldWithOwnTags(AUDIENCE);
    expect(listEmits().map((e) => e.recipients).flat()).not.toContain(OUTSIDER);
  });

  it('keeps telling the event and the pod their lists changed', async () => {
    await request(app).post('/sessions').set(actor()).send({
      podId: POD_ID, title: 'Friday founders', scheduledAt: '2026-10-16T17:00:00.000Z',
    });
    await settle();

    const tagsSent = mockEmitEntities.mock.calls.flatMap((call) => call[2] as string[]);
    expect(tagsSent).toEqual(expect.arrayContaining([`session:${SESSION_ID}`, `pod:${POD_ID}:sessions`]));
  });
});

describe('changing an event (renaming, rescheduling)', () => {
  it('tells everyone who could see it', async () => {
    const res = await request(app).put(`/sessions/${SESSION_ID}`).set(actor()).send({
      title: 'Friday founders, moved', scheduledAt: '2026-10-17T17:00:00.000Z',
    });
    await settle();

    expect(res.status).toBe(200);
    expectToldWithOwnTags(AUDIENCE);
  });

  it('tells the participants and the host when the event belongs to no pod, and nobody else', async () => {
    world.podId = null;
    await request(app).put(`/sessions/${SESSION_ID}`).set(actor()).send({ title: 'Friday founders, moved' });
    await settle();

    expectToldWithOwnTags([ADMIN_HOST, GUEST, MEMBER_A]);
  });

  it('tells nobody when the change is refused', async () => {
    (sessionService.updateSession as jest.Mock).mockRejectedValueOnce(new ForbiddenError('Only the session host can update the session'));
    const res = await request(app).put(`/sessions/${SESSION_ID}`).set(actor()).send({ title: 'Not yours' });
    await settle();

    expect(res.status).toBe(403);
    expect(listEmits()).toEqual([]);
  });

  it('still answers when the audience cannot be read, and tells nobody', async () => {
    world.failAudience = true;
    const res = await request(app).put(`/sessions/${SESSION_ID}`).set(actor()).send({ title: 'Friday founders, moved' });
    await settle();

    expect(res.status).toBe(200);
    expect(listEmits()).toEqual([]);
  });
});

describe('cancelling an event (DELETE /sessions/:id keeps the row and marks it cancelled)', () => {
  it('tells everyone who could see it, after it has been cancelled', async () => {
    const res = await request(app).delete(`/sessions/${SESSION_ID}`).set(actor());
    await settle();

    expect(res.status).toBe(200);
    expectToldWithOwnTags(AUDIENCE);
    expect(order[0]).toBe('cancelled');
    expect(order.filter((step) => step === 'told the lists')).toHaveLength(AUDIENCE.length);
  });
});

describe('deleting an event for good (DELETE /sessions/:id/permanent)', () => {
  it('tells everyone who could see it, including those whose rows go with the event, and only once it is gone', async () => {
    const res = await request(app).delete(`/sessions/${SESSION_ID}/permanent`).set(actor('super_admin'));
    await settle();

    expect(res.status).toBe(200);
    // The participants and the host are named by rows that no longer exist when the lists are told:
    // the audience had to be read before the delete, and the lists told after it.
    expectToldWithOwnTags(AUDIENCE);
    expect(order[0]).toBe('deleted');
    expect(order.filter((step) => step === 'told the lists')).toHaveLength(AUDIENCE.length);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('still tells the pod when the audience could not be read before the delete, and logs why', async () => {
    world.failFirstHostRead = true;
    const res = await request(app).delete(`/sessions/${SESSION_ID}/permanent`).set(actor('super_admin'));
    await settle();

    expect(res.status).toBe(200);
    // The participants and the host are gone by the second read; the pod's members are not.
    expectToldWithOwnTags([MEMBER_A, MEMBER_B]);
    // The fallback is a decision, not a silent swallow: the event and the reason are in the log.
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, err: expect.objectContaining({ message: 'connection reset' }) }),
      expect.any(String),
    );
  });

  it('is refused to anyone but a super admin, and tells nobody', async () => {
    const res = await request(app).delete(`/sessions/${SESSION_ID}/permanent`).set(actor('member'));
    await settle();

    expect(res.status).toBe(403);
    expect(sessionService.hardDeleteSession).not.toHaveBeenCalled();
    expect(listEmits()).toEqual([]);
  });
});
