// ─── Group chats: who is told, and what (26 Oct 2026) ────────────────────────
//
// Every change to a group chat tells each member, as they are after the change, two tags: the group's own
// (dm-group:<id>, its thread and members) and their own Messages list (user:<id>:dms, which carries the
// unread counts). Someone the change took out of the group (who left, or was removed) is told too, so their
// Messages drops it. A read mark tells only the reader. The tag that was sent before 26 Oct, `group:<id>`,
// was in neither vocabulary, so no screen ever heard it; it is gone.
//
// These tests go through each route to the emit: the real routes and the real fanout helpers, a fake
// database that answers the members of a group, and the emit boundary recorded. The group service is a
// stand-in; its rules are tested in services/dm/group.service.test.ts.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
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
jest.mock('../../services/dm/group.service');

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn();
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as groupService from '../../services/dm/group.service';
import groupRoutes from '../../routes/groups';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { E } from '../../realtime/entities';
import { fanoutGroupEntities } from '../../realtime/fanout';

const GROUP = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SESSION = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const ADMIN = 'u-admin';
const ANA = 'u-ana';
const BEN = 'u-ben';
const LEAVER = 'u-leaver';
const BEN_ID = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const svc = groupService as jest.Mocked<typeof groupService>;

const app = express();
app.use(express.json());
app.use('/groups', groupRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string) => ({
  Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}`,
});

/** Who is in the group, as the fake database holds it after the write. */
let members: string[];

/** Each emit as [recipients, tags]. */
const emits = () => mockEmitEntities.mock.calls.map((c) => [c[1], c[2]]);
/** Waits for the fire-and-forget fanout the route started after answering. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  members = [ADMIN, ANA, BEN];
  mockEmitEntities.mockResolvedValue(undefined);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] }; // authenticate
    if (/SELECT user_id FROM dm_group_members WHERE group_id = \$1/.test(text)) {
      return { rows: params[0] === GROUP ? members.map((user_id) => ({ user_id })) : [] };
    }
    return { rows: [] };
  });
  svc.createGroupFromEvent.mockResolvedValue({ id: GROUP, name: 'G', type: 'event', podId: null, sessionId: SESSION, createdBy: ADMIN, lastMessageAt: null, createdAt: new Date(), memberCount: 3 });
  svc.sendGroupMessage.mockResolvedValue({
    message: { id: 'm-1', groupId: GROUP, fromUserId: ADMIN, senderName: 'Admin', senderAvatarUrl: null, content: 'hi', createdAt: new Date().toISOString() },
    bells: { title: 't', body: 'hi', link: `/messages/g/${GROUP}`, rows: [] },
  });
  svc.pushGroupBells.mockResolvedValue(undefined);
  svc.markGroupRead.mockResolvedValue({ lastReadAt: new Date().toISOString() });
  svc.leaveGroup.mockResolvedValue({ left: true, newAdminId: ANA });
  svc.addGroupMembers.mockResolvedValue({ added: [BEN], memberCount: 3 });
  svc.removeGroupMember.mockResolvedValue({ removedUserId: BEN_ID });
});

/** What every member hears after a change: the group's tag and their own Messages tag, nobody else's. */
const toEachMember = (ids: string[]) => ids.map((id) => [[id], [E.dmGroup(GROUP), E.userDms(id)]]);

describe('a group chat change tells each member their own two tags', () => {
  it('a group started from an event: every member it was started with', async () => {
    expect((await request(app).post(`/groups/from-event/${SESSION}`).set(as(ADMIN)).send({})).status).toBe(201);
    await settle();
    expect(emits()).toEqual(toEachMember([ADMIN, ANA, BEN]));
  });

  it('a message: every member, the sender\'s other tabs included', async () => {
    expect((await request(app).post(`/groups/${GROUP}/messages`).set(as(ADMIN)).send({ content: 'hi' })).status).toBe(201);
    await settle();
    expect(emits()).toEqual(toEachMember([ADMIN, ANA, BEN]));
  });

  it('people added: the members as they are now, the new ones included', async () => {
    expect((await request(app).post(`/groups/${GROUP}/members`).set(as(ADMIN)).send({ userIds: [BEN_ID] })).status).toBe(200);
    await settle();
    expect(emits()).toEqual(toEachMember([ADMIN, ANA, BEN]));
  });

  it('someone leaves: the members who stay, and the one who left, whose Messages drops the group', async () => {
    members = [ADMIN, ANA]; // after the leave
    expect((await request(app).post(`/groups/${GROUP}/leave`).set(as(LEAVER))).status).toBe(200);
    await settle();
    expect(emits()).toEqual(toEachMember([ADMIN, ANA, LEAVER]));
  });

  it('someone is removed: the members who stay, and the one removed', async () => {
    members = [ADMIN, ANA]; // after the removal
    expect((await request(app).delete(`/groups/${GROUP}/members/${BEN_ID}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    expect(emits()).toEqual(toEachMember([ADMIN, ANA, BEN_ID]));
  });

  it('a read mark: only the reader\'s own tabs', async () => {
    expect((await request(app).post(`/groups/${GROUP}/read`).set(as(ANA))).status).toBe(200);
    await settle();
    expect(emits()).toEqual(toEachMember([ANA]));
  });

  it('someone told twice (a member who is also named as having left) hears it once', async () => {
    await fanoutGroupEntities(GROUP, [ANA]);
    expect(emits()).toEqual(toEachMember([ADMIN, ANA, BEN]));
  });

  it('a failure to fan out is logged, never thrown at the route that already answered', async () => {
    mockEmitEntities.mockRejectedValueOnce(new Error('socket down'));
    await expect(fanoutGroupEntities(GROUP)).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});

describe('the old untyped tag is gone', () => {
  const read = (rel: string) => nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');

  it('nothing sends group:<id> any more, and the group tag is built from E', () => {
    const fanout = read('realtime/fanout.ts');
    expect(fanout).not.toMatch(/[`'"]group:\$\{/);
    expect(fanout).toMatch(/E\.dmGroup\(groupId\)/);
    expect(read('routes/groups.ts')).not.toMatch(/[`'"]group:/);
  });

  it('the group tag reads dm-group:<id>', () => {
    expect(E.dmGroup('g-1')).toBe('dm-group:g-1');
  });
});
