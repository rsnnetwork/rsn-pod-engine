// ─── /api/groups: the routes (26 Oct 2026) ───────────────────────────────────
//
// Group chats of 3 to 50 people (COM-04). What each route accepts, whom it lets through, what it answers,
// and that a change tells the screens (through the fanout helpers) only once it has happened. The service is
// a stand-in; its rules are tested in services/dm/group.service.test.ts, and who the fanout tells in
// groups-fanout.test.ts.

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
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockCreateFromEvent = jest.fn();
const mockCreateCustom = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockMessages = jest.fn();
const mockSend = jest.fn();
const mockPush = jest.fn();
const mockRead = jest.fn();
const mockLeave = jest.fn();
const mockAdd = jest.fn();
const mockRemove = jest.fn();
jest.mock('../../services/dm/group.service', () => ({
  createGroupFromEvent: (...a: unknown[]) => mockCreateFromEvent(...a),
  createCustomGroup: (...a: unknown[]) => mockCreateCustom(...a),
  listMyGroups: (...a: unknown[]) => mockList(...a),
  getGroup: (...a: unknown[]) => mockGet(...a),
  listGroupMessages: (...a: unknown[]) => mockMessages(...a),
  sendGroupMessage: (...a: unknown[]) => mockSend(...a),
  pushGroupBells: (...a: unknown[]) => mockPush(...a),
  markGroupRead: (...a: unknown[]) => mockRead(...a),
  leaveGroup: (...a: unknown[]) => mockLeave(...a),
  addGroupMembers: (...a: unknown[]) => mockAdd(...a),
  removeGroupMember: (...a: unknown[]) => mockRemove(...a),
  __esModule: true,
}));
const mockFanoutGroup = jest.fn();
const mockFanoutGroupForUser = jest.fn();
jest.mock('../../realtime/fanout', () => ({
  fanoutGroupEntities: (...a: unknown[]) => mockFanoutGroup(...a),
  fanoutGroupForUser: (...a: unknown[]) => mockFanoutGroupForUser(...a),
  __esModule: true,
}));

import groupRoutes from '../../routes/groups';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { groupCreateLimiter, groupMessageLimiter, groupReadLimiter, groupWriteLimiter } from '../../middleware/rateLimit';
import { AppError, ConflictError, ForbiddenError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/groups', groupRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// Each describe signs in as its own member, so no block of tests uses up another's allowance.
const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });

const GROUP = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SESSION = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const B = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const services = [mockCreateFromEvent, mockCreateCustom, mockList, mockGet, mockMessages, mockSend, mockRead, mockLeave, mockAdd, mockRemove];
const nothingCalled = () => {
  for (const m of services) expect(m).not.toHaveBeenCalled();
  expect(mockFanoutGroup).not.toHaveBeenCalled();
  expect(mockFanoutGroupForUser).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
};
const full = () => new ConflictError(ErrorCodes.GROUP_FULL, 'This group is full (50 people).');

const sent = {
  message: { id: 'm-1', groupId: GROUP, fromUserId: 'u-send', senderName: 'Claus', senderAvatarUrl: null, content: 'Hello all', createdAt: '2026-10-26T10:00:00.000Z' },
  bells: { title: 'Claus wrote in ‘G’', body: 'Hello all', link: `/messages/g/${GROUP}`, rows: [{ id: 'n-1', userId: A, createdAt: new Date() }] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateFromEvent.mockResolvedValue({ id: GROUP, name: 'Video meeting · Test', type: 'event', sessionId: SESSION, memberCount: 3 });
  mockCreateCustom.mockResolvedValue({ id: GROUP, name: 'Old', type: 'custom', sessionId: null, memberCount: 3 });
  mockList.mockResolvedValue([]);
  mockGet.mockResolvedValue({ id: GROUP, members: [] });
  mockMessages.mockResolvedValue({ messages: [], nextCursor: null });
  mockSend.mockResolvedValue(sent);
  mockPush.mockResolvedValue(undefined);
  mockRead.mockResolvedValue({ lastReadAt: '2026-10-26T10:00:00.000Z' });
  mockLeave.mockResolvedValue({ left: true, newAdminId: null });
  mockAdd.mockResolvedValue({ added: [B], memberCount: 4 });
  mockRemove.mockResolvedValue({ removedUserId: B });
  mockFanoutGroup.mockResolvedValue(undefined);
  mockFanoutGroupForUser.mockResolvedValue(undefined);
});

describe('POST /groups/from-event/:sessionId', () => {
  const me = as('u-start');

  it('starts the group, answers 201 with it, then tells its members\' screens', async () => {
    const res = await request(app).post(`/groups/from-event/${SESSION}`).set(me).send({ name: 'Crew', memberIds: [A, B] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: expect.objectContaining({ id: GROUP, memberCount: 3 }) });
    expect(mockCreateFromEvent).toHaveBeenCalledWith({ userId: 'u-start', role: 'member' }, SESSION, { name: 'Crew', memberIds: [A, B] });
    expect(mockFanoutGroup).toHaveBeenCalledWith(GROUP);
  });

  it('with no body starts it with everyone who took part (the service decides who)', async () => {
    await request(app).post(`/groups/from-event/${SESSION}`).set(me).send({});
    expect(mockCreateFromEvent).toHaveBeenCalledWith({ userId: 'u-start', role: 'member' }, SESSION, { name: undefined, memberIds: undefined });
  });

  it('passes the signed-in role on, so an admin can start one for any completed event', async () => {
    await request(app).post(`/groups/from-event/${SESSION}`).set(as('u-admin', 'admin')).send({});
    expect(mockCreateFromEvent.mock.calls[0][0]).toEqual({ userId: 'u-admin', role: 'admin' });
  });

  it('reads ids written in capitals as the same ids', async () => {
    await request(app).post(`/groups/from-event/${SESSION.toUpperCase()}`).set(me).send({ memberIds: [A.toUpperCase()] });
    expect(mockCreateFromEvent).toHaveBeenCalledWith(expect.anything(), SESSION, { name: undefined, memberIds: [A] });
  });

  it('trims the name', async () => {
    await request(app).post(`/groups/from-event/${SESSION}`).set(me).send({ name: '  Crew  ' });
    expect(mockCreateFromEvent.mock.calls[0][2]).toEqual({ name: 'Crew', memberIds: undefined });
  });

  it.each([
    ['an event id that is not an id', 'not-an-id', {}],
    ['a member id that is not an id', SESSION, { memberIds: ['nope'] }],
    ['a name over 200 characters', SESSION, { name: 'x'.repeat(201) }],
    ['a name with a character that cannot be stored', SESSION, { name: 'bad\u0000name' }],
    ['more than 200 people', SESSION, { memberIds: Array.from({ length: 201 }, () => A) }],
    ['people that are not a list', SESSION, { memberIds: A }],
  ])('refuses %s without calling the service', async (_what, session, body) => {
    const res = await request(app).post(`/groups/from-event/${session}`).set(me).send(body);
    expect(res.status).toBe(400);
    nothingCalled();
  });

  it('passes a refusal on, word for word, and tells no screens', async () => {
    mockCreateFromEvent.mockRejectedValueOnce(full());
    const res = await request(app).post(`/groups/from-event/${SESSION}`).set(me).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual(expect.objectContaining({ code: 'GROUP_FULL', message: 'This group is full (50 people).' }));
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });

  it('needs a signed-in member', async () => {
    expect((await request(app).post(`/groups/from-event/${SESSION}`).send({})).status).toBe(401);
    nothingCalled();
  });
});

describe('GET /groups', () => {
  it('lists the member\'s groups and tells no screens', async () => {
    const data = [{ id: GROUP, name: 'G', memberCount: 3, unreadCount: 2, lastMessage: null, sessionId: SESSION }];
    mockList.mockResolvedValueOnce(data);
    const res = await request(app).get('/groups').set(as('u-list'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data });
    expect(mockList).toHaveBeenCalledWith('u-list');
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });

  it('needs a signed-in member', async () => {
    expect((await request(app).get('/groups')).status).toBe(401);
  });
});

describe('GET /groups/:id', () => {
  it('answers the group with its members', async () => {
    const res = await request(app).get(`/groups/${GROUP}`).set(as('u-get'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: GROUP, members: [] } });
    expect(mockGet).toHaveBeenCalledWith(GROUP, 'u-get');
  });

  it('refuses an id that is not an id', async () => {
    expect((await request(app).get('/groups/nope').set(as('u-get'))).status).toBe(400);
    nothingCalled();
  });

  it('passes a refusal on', async () => {
    mockGet.mockRejectedValueOnce(new ForbiddenError('You are not in this group.'));
    const res = await request(app).get(`/groups/${GROUP}`).set(as('u-get'));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('You are not in this group.');
  });
});

describe('GET /groups/:id/messages', () => {
  const me = as('u-thread');

  it('answers a page, newest first, with where the next one starts', async () => {
    const page = { messages: [sent.message], nextCursor: 'm-1' };
    mockMessages.mockResolvedValueOnce(page);
    const res = await request(app).get(`/groups/${GROUP}/messages`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: page });
    expect(mockMessages).toHaveBeenCalledWith(GROUP, 'u-thread', { before: undefined, limit: undefined });
  });

  it('passes ?before= and ?limit= on', async () => {
    await request(app).get(`/groups/${GROUP}/messages`).query({ before: A.toUpperCase(), limit: '20' }).set(me);
    expect(mockMessages).toHaveBeenCalledWith(GROUP, 'u-thread', { before: A, limit: 20 });
  });

  it.each([
    ['a cursor that is not a message id', { before: 'yesterday' }],
    ['a page of 0', { limit: '0' }],
    ['a page over 100', { limit: '101' }],
    ['a page that is not a number', { limit: 'lots' }],
  ])('refuses %s without calling the service', async (_what, q) => {
    expect((await request(app).get(`/groups/${GROUP}/messages`).query(q).set(me)).status).toBe(400);
    nothingCalled();
  });
});

describe('POST /groups/:id/messages', () => {
  const me = as('u-send');

  it('keeps the message, answers 201 with it (and the old messageId and createdAt), then tells the group and pushes the bells', async () => {
    const res = await request(app).post(`/groups/${GROUP}/messages`).set(me).send({ content: '  Hello all  ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { messageId: 'm-1', createdAt: '2026-10-26T10:00:00.000Z', message: sent.message } });
    expect(mockSend).toHaveBeenCalledWith(GROUP, 'u-send', 'Hello all');
    expect(mockFanoutGroup).toHaveBeenCalledWith(GROUP);
    expect(mockPush).toHaveBeenCalledWith(sent.bells);
  });

  it.each([
    ['an empty message', { content: '   ' }],
    ['a message over 4000 characters', { content: 'x'.repeat(4001) }],
    ['a message with a character that cannot be stored', { content: 'a\u0000b' }],
    ['no message at all', {}],
  ])('refuses %s without calling the service', async (_what, body) => {
    expect((await request(app).post(`/groups/${GROUP}/messages`).set(me).send(body)).status).toBe(400);
    nothingCalled();
  });

  it('a refused message tells nobody and rings nobody', async () => {
    mockSend.mockRejectedValueOnce(new ForbiddenError('You are not in this group.'));
    expect((await request(app).post(`/groups/${GROUP}/messages`).set(me).send({ content: 'hi' })).status).toBe(403);
    expect(mockFanoutGroup).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('POST /groups/:id/read', () => {
  it('marks the group read and tells only the reader\'s own screens', async () => {
    const res = await request(app).post(`/groups/${GROUP}/read`).set(as('u-read'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { lastReadAt: '2026-10-26T10:00:00.000Z' } });
    expect(mockRead).toHaveBeenCalledWith(GROUP, 'u-read');
    expect(mockFanoutGroupForUser).toHaveBeenCalledWith(GROUP, 'u-read');
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });
});

describe('POST /groups/:id/leave', () => {
  it('leaves, then tells the group and the member who left', async () => {
    mockLeave.mockResolvedValueOnce({ left: true, newAdminId: A });
    const res = await request(app).post(`/groups/${GROUP}/leave`).set(as('u-leave'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { left: true, newAdminId: A } });
    expect(mockLeave).toHaveBeenCalledWith(GROUP, 'u-leave');
    expect(mockFanoutGroup).toHaveBeenCalledWith(GROUP, ['u-leave']);
  });

  it('a second press changes nothing and tells nobody', async () => {
    mockLeave.mockResolvedValueOnce({ left: false, newAdminId: null });
    expect((await request(app).post(`/groups/${GROUP}/leave`).set(as('u-leave'))).status).toBe(200);
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });
});

describe('POST /groups/:id/members', () => {
  const me = as('u-admin');

  it('adds people, then tells the group, the new people included', async () => {
    const res = await request(app).post(`/groups/${GROUP}/members`).set(me).send({ userIds: [B.toUpperCase()] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { added: [B], memberCount: 4 } });
    expect(mockAdd).toHaveBeenCalledWith(GROUP, 'u-admin', [B]);
    expect(mockFanoutGroup).toHaveBeenCalledWith(GROUP);
  });

  it('adding nobody new tells nobody', async () => {
    mockAdd.mockResolvedValueOnce({ added: [], memberCount: 3 });
    await request(app).post(`/groups/${GROUP}/members`).set(me).send({ userIds: [B] });
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });

  it('the 51st person is refused with the reason, word for word', async () => {
    mockAdd.mockRejectedValueOnce(full());
    const res = await request(app).post(`/groups/${GROUP}/members`).set(me).send({ userIds: [B] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This group is full (50 people).');
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });

  it.each([
    ['nobody', { userIds: [] }],
    ['an id that is not an id', { userIds: ['nope'] }],
    ['no list', {}],
  ])('refuses %s without calling the service', async (_what, body) => {
    expect((await request(app).post(`/groups/${GROUP}/members`).set(me).send(body)).status).toBe(400);
    nothingCalled();
  });
});

describe('DELETE /groups/:id/members/:userId', () => {
  const me = as('u-admin2');

  it('removes the person, then tells the group and the person removed', async () => {
    const res = await request(app).delete(`/groups/${GROUP}/members/${B.toUpperCase()}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { removedUserId: B } });
    expect(mockRemove).toHaveBeenCalledWith(GROUP, 'u-admin2', B);
    expect(mockFanoutGroup).toHaveBeenCalledWith(GROUP, [B]);
  });

  it('passes a refusal on and tells nobody', async () => {
    mockRemove.mockRejectedValueOnce(new AppError(404, ErrorCodes.GROUP_MEMBER_NOT_FOUND, 'This person is not in the group.'));
    const res = await request(app).delete(`/groups/${GROUP}/members/${B}`).set(me);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('This person is not in the group.');
    expect(mockFanoutGroup).not.toHaveBeenCalled();
  });

  it('refuses a member id that is not an id', async () => {
    expect((await request(app).delete(`/groups/${GROUP}/members/nope`).set(me)).status).toBe(400);
    nothingCalled();
  });
});

describe('POST /groups (the old custom group, unused by any screen)', () => {
  it('still takes its old body and answers 201, then tells the members\' screens', async () => {
    const res = await request(app).post('/groups').set(as('u-custom')).send({ name: 'Old', memberIds: [A, B] });
    expect(res.status).toBe(201);
    expect(mockCreateCustom).toHaveBeenCalledWith('u-custom', 'Old', [A, B]);
    expect(mockFanoutGroup).toHaveBeenCalledWith(GROUP);
  });
});

describe('the routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  // What a route runs, in order, read from the router itself.
  const handlersOf = (method: string, path: string) =>
    (groupRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([
    ['post', '/from-event/:sessionId', groupCreateLimiter],
    ['post', '/', groupCreateLimiter],
    ['get', '/', groupReadLimiter],
    ['get', '/:id', groupReadLimiter],
    ['get', '/:id/messages', groupReadLimiter],
    ['post', '/:id/messages', groupMessageLimiter],
    ['post', '/:id/read', groupWriteLimiter],
    ['post', '/:id/leave', groupWriteLimiter],
    ['post', '/:id/members', groupWriteLimiter],
    ['delete', '/:id/members/:userId', groupWriteLimiter],
  ])('%s %s carries its limiter, after authenticate and ahead of its handler', (method, path, limiter) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(2); // the route exists
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(limiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });

  it('refuses the 31st message in a minute with a friendly 429, for that member only', async () => {
    const busy = as('u-chatty');
    for (let i = 0; i < 30; i += 1) {
      expect((await request(app).post(`/groups/${GROUP}/messages`).set(busy).send({ content: `m${i}` })).status).toBe(201);
    }
    mockSend.mockClear();
    const refused = await request(app).post(`/groups/${GROUP}/messages`).set(busy).send({ content: 'one more' });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'You are sending messages very quickly. Wait a moment, then try again.' } });
    expect(mockSend).not.toHaveBeenCalled();
    expect((await request(app).post(`/groups/${GROUP}/messages`).set(as('u-calm')).send({ content: 'hi' })).status).toBe(201);
  });

  it('only a group that was started uses up the hourly allowance for starting them', async () => {
    const starter = as('u-starter');
    mockCreateFromEvent.mockRejectedValue(new AppError(400, ErrorCodes.GROUP_TOO_SMALL, 'A group chat needs at least 3 people.'));
    for (let i = 0; i < 12; i += 1) {
      expect((await request(app).post(`/groups/from-event/${SESSION}`).set(starter).send({})).status).toBe(400);
    }
    mockCreateFromEvent.mockResolvedValue({ id: GROUP, memberCount: 3 });
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post(`/groups/from-event/${SESSION}`).set(starter).send({})).status).toBe(201);
    }
    const refused = await request(app).post(`/groups/from-event/${SESSION}`).set(starter).send({});
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toBe('You have started a lot of group chats this hour. Try again later.');
  });
});
