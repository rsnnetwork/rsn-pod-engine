// ─── Circles: who is told, what is limited, and what production's client still gets (1 Nov 2026) ─────────────
// Every change to a circle tells the people it touches: the circle's members, the person who made it, the member
// who acted and the member whose link changed. Each hears the circle's page and member tags and their own list
// tag; the member whose link changed is also named, so a list that shows that member's circles redraws for the
// people who share the circle. Every route is rate limited.
//
// These go through each route to the emit: the real routes and the real fanout helper, a fake database that
// answers by WHO the SQL asks for, and the emit boundary recorded. The circle services are stand-ins; their rules
// are in services/circle/circle.service.test.ts. The last group is production's own client: the calls its circle
// screens make, answered exactly as before.

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
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/circle/circle.service');
jest.mock('../../services/circle/circle-join.service');
jest.mock('../../services/circle/circle-wall.service');
jest.mock('../../services/circle/circle-entities.service');

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn();
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as circleService from '../../services/circle/circle.service';
import * as joinService from '../../services/circle/circle-join.service';
import * as wallService from '../../services/circle/circle-wall.service';
import * as linkService from '../../services/circle/circle-entities.service';
import circleRoutes from '../../routes/circles';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { circleReadLimiter, circleWriteLimiter, wallWriteLimiter } from '../../middleware/rateLimit';
import { E } from '../../realtime/entities';

const CIRCLE = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const POD = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const POST = '5b1d7e90-2f4a-4c6b-8d3e-0a9c7f5e1b44';

const ADMIN = 'user-admin';       // made the circle
const MEMBER = 'user-member';     // in it
const JOINER = 'user-joiner';     // joins it in the test
const PLATFORM = 'user-platform'; // a platform admin who is not in it
const ASKER = '7c2e9a41-3d5b-4e6f-8a1c-9b0d2e4f6a33'; // asks to join (an id: it sits in the path)
const LINKED_ENTITY = '2b6d8f1a-4c3e-4a5b-9d7f-1e3c5a7b9d22'; // T15: an entity linked to the circle
const ENTITY_ADMIN = 'user-entity-admin';                       // its admin, not in the circle

/** Who is in the circle, as the fake database holds it; a test changes it to mirror its write. */
let members: string[];
let creator: string;
/** Final fix wave X3: the platform admins (who run every circle); none unless a test says so. */
let admins: string[];
/** Final fix wave S1: the circle's events that have not ended (sessions.circle_id); none unless a test says so. */
let upcoming: string[];

beforeEach(() => {
  jest.clearAllMocks();
  members = [ADMIN, MEMBER];
  creator = ADMIN;
  admins = [];
  upcoming = [];
  mockEmitEntities.mockResolvedValue(undefined);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT status, account_kind FROM users/.test(text)) return { rows: [{ status: 'active', account_kind: 'member' }] }; // authenticate
    // T14: the manager gate reads the circle, then whether the caller is its owner or a moderator. Shirley pilot S2:
    // the role alone decides (the person who made it, `creator`, is its owner here); who can join asks for the owner.
    if (/SELECT id, name, join_policy FROM circles WHERE id = \$1 AND archived_at IS NULL/.test(text)) {
      return { rows: [{ id: CIRCLE, name: 'Doctors', join_policy: 'open' }] };
    }
    if (/SELECT 1 FROM circle_members m WHERE m\.circle_id = \$1 AND m\.user_id = \$2 AND m\.role IN \('owner', 'moderator'\)/.test(text)) {
      return { rows: params[1] === creator ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT role FROM circle_members WHERE circle_id = \$1 AND user_id = \$2/.test(text)) {
      if (params[1] === creator) return { rows: [{ role: 'owner' }] };
      return { rows: members.includes(String(params[1])) ? [{ role: 'member' }] : [] };
    }
    // S2: which circles a pod is in is read only by someone who may see the pod (canViewPod); this pod is public.
    if (/SELECT p\.visibility::text AS visibility, EXISTS/.test(text)) {
      return { rows: [{ visibility: 'public', active_member: false }] };
    }
    // T15: an entity's live links, for the entity's own fan-out when it is linked or unlinked.
    if (/SELECT m\.user_id FROM entity_members m WHERE m\.entity_id = \$1 AND m\.status IN \('active', 'pending'\)/.test(text)) {
      return { rows: params[0] === LINKED_ENTITY ? [{ user_id: ENTITY_ADMIN }] : [] };
    }
    if (/SELECT user_id FROM circle_members WHERE circle_id = \$1 UNION SELECT created_by FROM circles WHERE id = \$1/.test(text)) {
      return { rows: [...new Set([...members, creator])].map(user_id => ({ user_id })) };
    }
    if (/SELECT u\.id AS user_id FROM users u WHERE u\.role IN \('admin', 'super_admin'\) AND u\.status = 'active' ORDER BY u\.id LIMIT \$1/.test(text)) {
      return { rows: admins.slice(0, Number(params[0])).map(user_id => ({ user_id })) };
    }
    if (/SELECT id FROM sessions WHERE circle_id = \$1 AND status NOT IN \('completed', 'cancelled'\) ORDER BY scheduled_at NULLS LAST, id LIMIT \$2/.test(text)) {
      return { rows: params[0] === CIRCLE ? upcoming.slice(0, Number(params[1])).map(id => ({ id })) : [] };
    }
    return { rows: [] };
  });
  jest.mocked(circleService.createCircle).mockResolvedValue({ id: CIRCLE });
  jest.mocked(circleService.updateCircle).mockResolvedValue({ approvedUserIds: [] });
  jest.mocked(circleService.archiveCircle).mockResolvedValue(undefined);
  jest.mocked(circleService.attachPod).mockResolvedValue(undefined);
  jest.mocked(circleService.detachPod).mockResolvedValue({ detached: true });
  jest.mocked(circleService.joinCircle).mockResolvedValue(undefined);
  jest.mocked(circleService.leaveCircle).mockResolvedValue(undefined);
  jest.mocked(circleService.listCircles).mockResolvedValue([]);
  jest.mocked(circleService.getCircleDetail).mockResolvedValue({ id: CIRCLE } as never);
  jest.mocked(joinService.requestToJoinCircle).mockResolvedValue({ status: 'requested', created: true });
  jest.mocked(joinService.cancelJoinRequest).mockResolvedValue({ cancelled: true });
  jest.mocked(joinService.approveJoinRequest).mockResolvedValue(undefined);
  jest.mocked(joinService.declineJoinRequest).mockResolvedValue(undefined);
  jest.mocked(joinService.removeCircleMember).mockResolvedValue(undefined);
  jest.mocked(joinService.ringApproved).mockResolvedValue(undefined);
  jest.mocked(joinService.listJoinRequests).mockResolvedValue([]);
  jest.mocked(joinService.listAttachablePods).mockResolvedValue({ items: [], nextPage: null });
  jest.mocked(linkService.linkEntity).mockResolvedValue(undefined);
  jest.mocked(linkService.unlinkEntity).mockResolvedValue({ unlinked: true });
});

const app = express();
app.use(express.json());
app.use('/circles', circleRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string, role = 'member') =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });

/** The fanout runs after the answer is sent; let it finish. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));

type Emit = [unknown, string[], string[]];
const emits = () => mockEmitEntities.mock.calls as Emit[];

/** Every emit, as recipient → the tags they were sent. */
function heard(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [io, recipients, tags] of emits()) {
    expect(io).toBe(mockIo);
    for (const r of recipients) out[r] = [...(out[r] ?? []), ...tags].sort();
  }
  return out;
}
const sorted = (tags: string[]) => [...tags].sort();
const page = (user: string, ...extra: string[]) => sorted([E.circle(CIRCLE), E.circleMembers(CIRCLE), E.userCircles(user), ...extra]);

describe('the circle tags', () => {
  it('are domain-shaped, and the client builds them as the server sends them', async () => {
    const { E: clientE } = await import('../../../../client/src/realtime/entities');
    expect(E.circle('c-1')).toBe('circle:c-1');
    expect(E.circleMembers('c-1')).toBe('circle:c-1:members');
    expect(E.circleInvites('c-1')).toBe('circle:c-1:invites');
    expect(E.userCircles('u-1')).toBe('user:u-1:circles');
    expect(clientE.circle('c-1')).toBe(E.circle('c-1'));
    expect(clientE.circleMembers('c-1')).toBe(E.circleMembers('c-1'));
    expect(clientE.circleInvites('c-1')).toBe(E.circleInvites('c-1'));
    expect(clientE.userCircles('u-1')).toBe(E.userCircles('u-1'));
  });
});

describe('who hears a circle change', () => {
  it('a new circle: its creator, who is its owner, hears the circle and their own list', async () => {
    members = [ADMIN];
    const res = await request(app).post('/circles').set(as(ADMIN, 'admin')).send({ name: 'Doctors' });
    expect(res.status).toBe(201);
    await settle();
    // The creator is the changed person: their own event lists are told too (final fix wave S1).
    expect(heard()).toEqual({ [ADMIN]: page(ADMIN, E.userSessions(ADMIN)) });
  });

  it('a join: everyone in the circle and the joiner hear the circle, their own list and the joiner\'s', async () => {
    members = [ADMIN, MEMBER, JOINER];
    expect((await request(app).post(`/circles/${CIRCLE}/join`).set(as(JOINER))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: page(ADMIN, E.userCircles(JOINER)),
      [MEMBER]: page(MEMBER, E.userCircles(JOINER)),
      [JOINER]: page(JOINER, E.userSessions(JOINER)),
    });
    expect(emits().every(([, recipients]) => recipients.length === 1)).toBe(true);
  });

  it('a leave: the member who left is told too, though they are no longer in the circle', async () => {
    members = [ADMIN];
    expect((await request(app).post(`/circles/${CIRCLE}/leave`).set(as(MEMBER))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: page(ADMIN, E.userCircles(MEMBER)),
      [MEMBER]: page(MEMBER, E.userSessions(MEMBER)),
    });
  });

  it('a creator with no member row (a circle made before owners existed) is still told', async () => {
    members = [MEMBER];
    expect((await request(app).post(`/circles/${CIRCLE}/join`).set(as(JOINER))).status).toBe(200);
    await settle();
    expect(Object.keys(heard()).sort()).toEqual([ADMIN, JOINER, MEMBER].sort());
  });

  it.each([
    ['an edit', 'patch', `/circles/${CIRCLE}`, { name: 'Doctors and nurses' }],
    ['an archive', 'post', `/circles/${CIRCLE}/archive`, undefined],
    ['a pod attached', 'post', `/circles/${CIRCLE}/pods`, { podId: POD }],
    ['a pod detached', 'delete', `/circles/${CIRCLE}/pods/${POD}`, undefined],
  ] as const)('%s by a platform admin who is not in it: its people and the admin, each with their own list only', async (_name, method, url, body) => {
    const res = await request(app)[method](url).set(as(PLATFORM, 'admin')).send(body);
    expect(res.status).toBeLessThan(300);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: page(ADMIN),
      [MEMBER]: page(MEMBER),
      [PLATFORM]: page(PLATFORM),
    });
  });

  it('a refused change tells no one', async () => {
    jest.mocked(circleService.updateCircle).mockRejectedValueOnce(new Error('nope'));
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN, 'admin')).send({ name: 'Doctors' })).status).toBe(500);
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(MEMBER)).send({ name: 'Doctors' })).status).toBe(403);
    await settle();
    expect(emits()).toEqual([]);
  });
});

describe('the routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlersOf = (method: string, path: string) =>
    (circleRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  const order = (limiter: unknown, method: string, path: string) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(2); // the route exists
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(limiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  };

  it.each([['get', '/'], ['get', '/of-pod/:podId'], ['get', '/:id'], ['get', '/:id/requests'], ['get', '/:id/attachable-pods'],
    // Final fix wave SM4 (2 Nov 2026): the wall's three reads too.
    ['get', '/:id/posts'], ['get', '/posts/:postId'], ['get', '/posts/:postId/comments']])('%s %s carries the read limiter', (method, path) => {
    order(circleReadLimiter, method, path);
  });

  it('every read route has the read limiter: nothing is left unlimited', () => {
    const stack = (circleRoutes as unknown as { stack: Layer[] }).stack;
    const unlimited = stack
      .filter((layer) => layer.route?.methods.get)
      .filter((layer) => !layer.route!.stack.map((s) => s.handle).includes(circleReadLimiter))
      .map((layer) => `get ${layer.route!.path}`);
    expect(unlimited).toEqual([]);
  });

  // The wall polls every 30 s (all its loaded pages), and a phone that comes back to the tab reads the page, the
  // feed and every open comment thread again. One allowance covers the circle's page and its wall: 120 a minute.
  it('a member reading a circle and its wall has 120 reads a minute, then is told to slow down, in words', async () => {
    const reader = as('user-busy-reader');
    jest.mocked(wallService.listPosts).mockResolvedValue({ pinned: [], posts: [], nextCursor: null });
    jest.mocked(wallService.listComments).mockResolvedValue([]);
    const paths = [`/circles/${CIRCLE}`, `/circles/${CIRCLE}/posts`, `/circles/posts/${POST}/comments`];
    for (let i = 0; i < 120; i += 1) {
      expect((await request(app).get(paths[i % paths.length]).set(reader)).status).toBe(200);
    }
    const refused = await request(app).get(`/circles/${CIRCLE}/posts`).set(reader);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
  });

  it.each([
    ['post', '/'], ['patch', '/:id'], ['post', '/:id/archive'], ['post', '/:id/pods'], ['delete', '/:id/pods/:podId'],
    ['post', '/:id/join'], ['post', '/:id/leave'],
    ['post', '/:id/request'], ['delete', '/:id/request'], ['post', '/:id/requests/:userId/approve'],
    ['post', '/:id/requests/:userId/decline'], ['delete', '/:id/members/:userId'],
    ['post', '/:id/entities'], ['delete', '/:id/entities/:entityId'],
  ])('%s %s carries the write limiter', (method, path) => {
    order(circleWriteLimiter, method, path);
  });

  it.each([
    ['post', '/:id/posts'], ['post', '/posts/:postId/react'], ['post', '/posts/:postId/share'], ['delete', '/posts/:postId'],
    ['post', '/posts/:postId/pin'], ['post', '/posts/:postId/unpin'], ['post', '/posts/:postId/comments'],
    ['post', '/comments/:commentId/like'], ['delete', '/comments/:commentId'],
  ])('the wall\'s %s %s carries the wall write limiter', (method, path) => {
    order(wallWriteLimiter, method, path);
  });

  it('every mutating route has one of the two: nothing is left unlimited', () => {
    const stack = (circleRoutes as unknown as { stack: Layer[] }).stack;
    const unlimited = stack
      .filter((layer) => layer.route && ['post', 'patch', 'put', 'delete'].some((m) => layer.route!.methods[m]))
      .filter((layer) => {
        const handlers = layer.route!.stack.map((s) => s.handle);
        return ![circleWriteLimiter, wallWriteLimiter].some((l) => handlers.includes(l));
      })
      .map((layer) => `${Object.keys(layer.route!.methods).join(',')} ${layer.route!.path}`);
    expect(unlimited).toEqual([]);
  });
});

describe('production\'s client: the calls its circle screens make are answered as before', () => {
  it('the list and a circle\'s page (AppLayout, CirclesPage, CircleDetailPage) answer the same envelope', async () => {
    jest.mocked(circleService.listCircles).mockResolvedValueOnce([{ id: CIRCLE, name: 'Doctors', isMember: true }] as never);
    const list = await request(app).get('/circles').set(as(MEMBER));
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ success: true, data: [{ id: CIRCLE, name: 'Doctors', isMember: true }] });
    const detail = await request(app).get(`/circles/${CIRCLE}`).set(as(MEMBER));
    expect(detail.body).toEqual({ success: true, data: { id: CIRCLE } });
    // T2 (1 Nov 2026): with the viewer's role, so an admin is named every attached pod's event and a member only those they may open (D3).
    expect(circleService.getCircleDetail).toHaveBeenCalledWith(CIRCLE, MEMBER, 'member');
  });

  it('join and leave (the Join circle button) answer { ok: true } to any member, role-gated by nothing', async () => {
    for (const verb of ['join', 'leave']) {
      const res = await request(app).post(`/circles/${CIRCLE}/${verb}`).set(as(MEMBER));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { ok: true } });
    }
  });

  it('attach and detach a pod (the admin\'s picker) keep their bodies and answers; a member who does not run it is refused', async () => {
    const attached = await request(app).post(`/circles/${CIRCLE}/pods`).set(as(PLATFORM, 'admin')).send({ podId: POD });
    expect(attached.status).toBe(201);
    expect(attached.body).toEqual({ success: true, data: { ok: true } });
    // T14: a platform admin attaches any pod (the fourth argument); the people who run it, only pods they run.
    expect(circleService.attachPod).toHaveBeenCalledWith(CIRCLE, POD, PLATFORM, true);
    const detached = await request(app).delete(`/circles/${CIRCLE}/pods/${POD}`).set(as(PLATFORM, 'admin'));
    expect(detached.body).toEqual({ success: true, data: { ok: true } });
    expect((await request(app).post(`/circles/${CIRCLE}/pods`).set(as(MEMBER)).send({ podId: POD })).status).toBe(403);
  });

  it('creating a circle (admin) still answers 201 { id }', async () => {
    const res = await request(app).post('/circles').set(as(PLATFORM, 'admin')).send({ name: 'Doctors', description: 'x' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: CIRCLE } });
    expect(circleService.createCircle).toHaveBeenCalledWith(PLATFORM, { name: 'Doctors', description: 'x' });
  });

  it('the wall\'s calls (post, react, pin) reach the wall service as before', async () => {
    jest.mocked(wallService.reactToPost).mockResolvedValue({ reaction: 'like' } as never);
    const res = await request(app).post(`/circles/posts/${POST}/react`).set(as(MEMBER)).send({ reaction: 'like' });
    expect(res.status).toBe(200);
    expect(wallService.reactToPost).toHaveBeenCalledWith(POST, MEMBER, 'like');
    expect((await request(app).post(`/circles/posts/${POST}/pin`).set(as(MEMBER))).status).toBe(403);
  });
});

// ─── T14 (1 Nov 2026): who can join, the asks, and the people who run a circle ─────────────────────────────────
describe('a closed circle\'s asks and answers: who hears them, and who may answer', () => {
  const requests = E.circleRequests(CIRCLE);

  it('builds the requests tag as the client does', async () => {
    const { E: clientE } = await import('../../../../client/src/realtime/entities');
    expect(requests).toBe(`circle:${CIRCLE}:requests`);
    expect(clientE.circleRequests(CIRCLE)).toBe(requests);
  });

  it('an ask: the circle\'s people and the asker hear the circle, its requests and the asker\'s list; the answer is { status }', async () => {
    members = [ADMIN, MEMBER];
    const res = await request(app).post(`/circles/${CIRCLE}/request`).set(as(ASKER));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'requested' } });
    expect(joinService.requestToJoinCircle).toHaveBeenCalledWith(CIRCLE, ASKER, 'member');
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: page(ADMIN, E.userCircles(ASKER), requests),
      [MEMBER]: page(MEMBER, E.userCircles(ASKER), requests),
      [ASKER]: page(ASKER, requests, E.userSessions(ASKER)),
    });
  });

  it('withdrawing an ask tells the same people; withdrawing nothing tells no one', async () => {
    expect((await request(app).delete(`/circles/${CIRCLE}/request`).set(as(ASKER))).body).toEqual({ success: true, data: { cancelled: true } });
    await settle();
    expect(Object.keys(heard()).sort()).toEqual([ADMIN, ASKER, MEMBER].sort());
    mockEmitEntities.mockClear();
    jest.mocked(joinService.cancelJoinRequest).mockResolvedValueOnce({ cancelled: false });
    expect((await request(app).delete(`/circles/${CIRCLE}/request`).set(as(ASKER))).status).toBe(200);
    await settle();
    expect(emits()).toEqual([]);
  });

  it.each(['approve', 'decline'] as const)('%s: the service decides who may (here the owner); the asker and the circle hear it', async (verb) => {
    members = verb === 'approve' ? [ADMIN, MEMBER, ASKER] : [ADMIN, MEMBER];
    const res = await request(app).post(`/circles/${CIRCLE}/requests/${ASKER}/${verb}`).set(as(ADMIN));
    expect(res.status).toBe(200);
    const fn = verb === 'approve' ? joinService.approveJoinRequest : joinService.declineJoinRequest;
    expect(fn).toHaveBeenCalledWith(CIRCLE, ASKER, { userId: ADMIN, role: 'member' });
    await settle();
    expect(heard()[ASKER]).toEqual(page(ASKER, requests, E.userSessions(ASKER)));
    expect(heard()[ADMIN]).toEqual(page(ADMIN, E.userCircles(ASKER), requests));
  });

  it('a refused answer (the service says 403) tells no one', async () => {
    const { AppError } = await import('../../middleware/errors');
    jest.mocked(joinService.approveJoinRequest).mockRejectedValueOnce(new AppError(403, 'AUTH_FORBIDDEN', 'Only the people who run this circle can answer requests.'));
    const res = await request(app).post(`/circles/${CIRCLE}/requests/${ASKER}/approve`).set(as(MEMBER));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the people who run this circle can answer requests.');
    await settle();
    expect(emits()).toEqual([]);
  });

  it('a malformed person in the path is a 400 in words, before any service', async () => {
    const res = await request(app).post(`/circles/${CIRCLE}/requests/not-a-person/approve`).set(as(ADMIN));
    expect(res.status).toBe(400);
    expect(joinService.approveJoinRequest).not.toHaveBeenCalled();
  });

  it('removing a member tells the circle and the person removed', async () => {
    members = [ADMIN];
    expect((await request(app).delete(`/circles/${CIRCLE}/members/${ASKER}`).set(as(ADMIN))).status).toBe(200);
    expect(joinService.removeCircleMember).toHaveBeenCalledWith(CIRCLE, ASKER, { userId: ADMIN, role: 'member' });
    await settle();
    expect(heard()).toEqual({ [ADMIN]: page(ADMIN, E.userCircles(ASKER)), [ASKER]: page(ASKER, E.userSessions(ASKER)) });
  });

  it('the owner (not a platform admin) may edit and close the circle; a plain member may not', async () => {
    const closed = await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'closed' });
    expect(closed.status).toBe(200);
    expect(circleService.updateCircle).toHaveBeenCalledWith(CIRCLE, { joinPolicy: 'closed' }, { userId: ADMIN, role: 'member' });
    await settle();
    // Closing also withdraws the invites of people who do not run it (final fix wave S2): the circle's invites change.
    expect(heard()[MEMBER]).toEqual(page(MEMBER, requests, E.circleInvites(CIRCLE)));
    mockEmitEntities.mockClear();
    const refused = await request(app).patch(`/circles/${CIRCLE}`).set(as(MEMBER)).send({ joinPolicy: 'open' });
    expect(refused.status).toBe(403);
    // Shirley pilot S2 (D3): who can join is the owner's choice; a name or description is anyone's who runs it.
    expect(refused.body.error.message).toBe("Only the circle's owner can choose who can join.");
    const renamed = await request(app).patch(`/circles/${CIRCLE}`).set(as(MEMBER)).send({ name: 'Nurses' });
    expect(renamed.status).toBe(403);
    expect(renamed.body.error.message).toBe('Only the people who run this circle can change it.');
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'secret' })).status).toBe(400);
  });

  it('reopening lets the waiting people in: each is rung and told, with the requests tag', async () => {
    jest.mocked(circleService.updateCircle).mockResolvedValueOnce({ approvedUserIds: [ASKER] });
    members = [ADMIN, MEMBER, ASKER];
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'open' })).status).toBe(200);
    await settle();
    expect(joinService.ringApproved).toHaveBeenCalledWith(CIRCLE, 'Doctors', [ASKER]);
    expect(heard()[ASKER]).toEqual(page(ASKER, requests, E.userSessions(ASKER)));
    expect(heard()[MEMBER]).toEqual(page(MEMBER, E.userCircles(ASKER), requests));
  });

  it('attach by the owner attaches only pods they run (isAdmin false); a member is refused attach and detach', async () => {
    expect((await request(app).post(`/circles/${CIRCLE}/pods`).set(as(ADMIN)).send({ podId: POD })).status).toBe(201);
    expect(circleService.attachPod).toHaveBeenCalledWith(CIRCLE, POD, ADMIN, false);
    expect((await request(app).post(`/circles/${CIRCLE}/pods`).set(as(MEMBER)).send({ podId: POD })).status).toBe(403);
    // S2: who may take a pod out (the circle's managers, or the pod's own director) is the service's to decide, with the
    // actor the route passes; its refusal is the route's answer and tells nobody.
    const { AppError } = jest.requireActual('../../middleware/errors');
    jest.mocked(circleService.detachPod).mockRejectedValueOnce(new AppError(403, 'AUTH_FORBIDDEN', 'no'));
    expect((await request(app).delete(`/circles/${CIRCLE}/pods/${POD}`).set(as(MEMBER))).status).toBe(403);
    expect(circleService.detachPod).toHaveBeenLastCalledWith(CIRCLE, POD, { userId: MEMBER, role: 'member' });
    mockEmitEntities.mockClear();
    jest.mocked(circleService.detachPod).mockResolvedValueOnce({ detached: false });
    expect((await request(app).delete(`/circles/${CIRCLE}/pods/${POD}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled(); // a link that was not there changed nothing
    expect((await request(app).delete(`/circles/${CIRCLE}/pods/${POD}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    // S2: the pod's own page ("In circles") is told too, through the pod's members.
    expect(mockQuery.mock.calls.some(([sql, params]) => /SELECT user_id FROM pod_members/.test(String(sql)) && (params as unknown[])[0] === POD)).toBe(true);
    expect(emits().some(([, , tags]) => tags.includes(E.pod(POD)))).toBe(true);
  });

  it('the attach picker pages with pageSize (50 unless asked, never over 100) and passes the search', async () => {
    await request(app).get(`/circles/${CIRCLE}/attachable-pods`).set(as(ADMIN));
    expect(joinService.listAttachablePods).toHaveBeenLastCalledWith(CIRCLE, { userId: ADMIN, role: 'member' }, { q: undefined, page: 1, pageSize: 50 });
    await request(app).get(`/circles/${CIRCLE}/attachable-pods?q=Found&page=2&pageSize=500`).set(as(ADMIN));
    expect(joinService.listAttachablePods).toHaveBeenLastCalledWith(CIRCLE, { userId: ADMIN, role: 'member' }, { q: 'Found', page: 2, pageSize: 100 });
  });

  it('the wall\'s reads carry the viewer\'s role, so a closed circle\'s wall is refused at the service', async () => {
    jest.mocked(wallService.listPosts).mockResolvedValue({ pinned: [], posts: [], nextCursor: null });
    jest.mocked(wallService.getPost).mockResolvedValue({ id: POST } as never);
    jest.mocked(wallService.listComments).mockResolvedValue([]);
    await request(app).get(`/circles/${CIRCLE}/posts`).set(as(MEMBER));
    expect(wallService.listPosts).toHaveBeenCalledWith(CIRCLE, MEMBER, { cursor: undefined }, 'member');
    await request(app).get(`/circles/posts/${POST}`).set(as(MEMBER));
    expect(wallService.getPost).toHaveBeenCalledWith(POST, MEMBER, 'member');
    await request(app).get(`/circles/posts/${POST}/comments`).set(as(MEMBER));
    expect(wallService.listComments).toHaveBeenCalledWith(POST, MEMBER, 'member');
  });

  it('production\'s Join circle on a closed circle gets the 403 in words its toast can show', async () => {
    const { AppError } = await import('../../middleware/errors');
    jest.mocked(circleService.joinCircle).mockRejectedValueOnce(new AppError(403, 'CIRCLE_CLOSED', 'This circle is closed. Ask to join and its owner will let you in.'));
    const res = await request(app).post(`/circles/${CIRCLE}/join`).set(as(ASKER));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'CIRCLE_CLOSED', message: 'This circle is closed. Ask to join and its owner will let you in.' } });
    expect(circleService.joinCircle).toHaveBeenCalledWith(CIRCLE, ASKER, { role: 'member' });
  });
});

// ─── T15 (30 Oct review 7.3; L23): an entity linked to a circle ────────────────────────────────────────────────

describe('linking an entity to a circle: who may, and who hears it', () => {
  it('a link: the circle\'s people hear the circle, the entity\'s people hear the entity, the actor both', async () => {
    const res = await request(app).post(`/circles/${CIRCLE}/entities`).set(as(ADMIN)).send({ entityId: LINKED_ENTITY.toUpperCase() });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(linkService.linkEntity).toHaveBeenCalledWith(CIRCLE, LINKED_ENTITY, { userId: ADMIN, role: 'member' });
    await settle();
    const all = heard();
    expect(all[MEMBER]).toEqual(page(MEMBER));
    expect(all[ENTITY_ADMIN]).toEqual(sorted([E.entity(LINKED_ENTITY), E.userEntities(ENTITY_ADMIN)]));
    expect(all[ADMIN]).toEqual(expect.arrayContaining([E.circle(CIRCLE), E.entity(LINKED_ENTITY)]));
  });

  it('an unlink tells the same people', async () => {
    const res = await request(app).delete(`/circles/${CIRCLE}/entities/${LINKED_ENTITY}`).set(as(ENTITY_ADMIN));
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(linkService.unlinkEntity).toHaveBeenCalledWith(CIRCLE, LINKED_ENTITY, { userId: ENTITY_ADMIN, role: 'member' });
    await settle();
    const all = heard();
    expect(all[MEMBER]).toEqual(page(MEMBER));
    expect(all[ENTITY_ADMIN]).toEqual(expect.arrayContaining([E.entity(LINKED_ENTITY), E.circle(CIRCLE)]));
  });

  it('an unlink of a link that was not there tells nobody (review M5)', async () => {
    jest.mocked(linkService.unlinkEntity).mockResolvedValueOnce({ unlinked: false });
    const res = await request(app).delete(`/circles/${CIRCLE}/entities/${LINKED_ENTITY}`).set(as(ADMIN));
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a refused link tells nobody; a bad id or no entity is a 400 before the service', async () => {
    const { AppError } = await import('../../middleware/errors');
    jest.mocked(linkService.linkEntity).mockRejectedValueOnce(
      new AppError(403, 'AUTH_FORBIDDEN', 'Only the people who run this circle can link an entity to it.'));
    const refused = await request(app).post(`/circles/${CIRCLE}/entities`).set(as(MEMBER)).send({ entityId: LINKED_ENTITY });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe('Only the people who run this circle can link an entity to it.');
    expect((await request(app).post(`/circles/${CIRCLE}/entities`).set(as(ADMIN)).send({})).status).toBe(400);
    expect((await request(app).post(`/circles/${CIRCLE}/entities`).set(as(ADMIN)).send({ entityId: 'acme' })).status).toBe(400);
    expect((await request(app).delete(`/circles/${CIRCLE}/entities/acme`).set(as(ADMIN))).status).toBe(400);
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
    expect(linkService.unlinkEntity).not.toHaveBeenCalled();
  });
});

// ─── Final fix wave SM3 (2 Nov 2026): a malformed id in a circle path is a 400 in words, never a Postgres 500 ─────

describe('every circle route checks the ids in its path', () => {
  const COMMENT = '9e3f1a2b-6c4d-4e5f-8a7b-1c2d3e4f5a66';
  const CIRCLE_WORDS = "We couldn't find that circle.";
  const POD_WORDS = "We couldn't find that pod.";
  const POST_WORDS = "We couldn't find that post.";
  const COMMENT_WORDS = "We couldn't find that comment.";
  type Probe = { method: 'get' | 'post' | 'delete'; path: (bad: string) => string; says: string; reached: () => unknown[][]; role?: string; body?: object };
  const probes: Array<[string, Probe]> = [
    ['POST /:id/join', { method: 'post', path: (b) => `/circles/${b}/join`, says: CIRCLE_WORDS, reached: () => jest.mocked(circleService.joinCircle).mock.calls }],
    ['POST /:id/leave', { method: 'post', path: (b) => `/circles/${b}/leave`, says: CIRCLE_WORDS, reached: () => jest.mocked(circleService.leaveCircle).mock.calls }],
    ['POST /:id/archive', { method: 'post', path: (b) => `/circles/${b}/archive`, says: CIRCLE_WORDS, role: 'admin', reached: () => jest.mocked(circleService.archiveCircle).mock.calls }],
    ['GET /of-pod/:podId', { method: 'get', path: (b) => `/circles/of-pod/${b}`, says: POD_WORDS, reached: () => jest.mocked(circleService.listCirclesOfPod).mock.calls }],
    ['DELETE /:id/pods/:podId', { method: 'delete', path: (b) => `/circles/${CIRCLE}/pods/${b}`, says: POD_WORDS, role: 'admin', reached: () => jest.mocked(circleService.detachPod).mock.calls }],
    ['GET /:id/posts', { method: 'get', path: (b) => `/circles/${b}/posts`, says: CIRCLE_WORDS, reached: () => jest.mocked(wallService.listPosts).mock.calls }],
    ['POST /:id/posts', { method: 'post', path: (b) => `/circles/${b}/posts`, says: CIRCLE_WORDS, body: { clientId: COMMENT, content: 'Hi' }, reached: () => jest.mocked(wallService.createPost).mock.calls }],
    ['GET /posts/:postId', { method: 'get', path: (b) => `/circles/posts/${b}`, says: POST_WORDS, reached: () => jest.mocked(wallService.getPost).mock.calls }],
    ['POST /posts/:postId/react', { method: 'post', path: (b) => `/circles/posts/${b}/react`, says: POST_WORDS, body: { reaction: 'like' }, reached: () => jest.mocked(wallService.reactToPost).mock.calls }],
    ['POST /posts/:postId/share', { method: 'post', path: (b) => `/circles/posts/${b}/share`, says: POST_WORDS, body: { circleId: CIRCLE, clientId: COMMENT }, reached: () => jest.mocked(wallService.sharePost).mock.calls }],
    ['DELETE /posts/:postId', { method: 'delete', path: (b) => `/circles/posts/${b}`, says: POST_WORDS, reached: () => jest.mocked(wallService.deletePost).mock.calls }],
    ['POST /posts/:postId/pin', { method: 'post', path: (b) => `/circles/posts/${b}/pin`, says: POST_WORDS, role: 'admin', reached: () => jest.mocked(wallService.pinPost).mock.calls }],
    ['POST /posts/:postId/unpin', { method: 'post', path: (b) => `/circles/posts/${b}/unpin`, says: POST_WORDS, role: 'admin', reached: () => jest.mocked(wallService.pinPost).mock.calls }],
    ['GET /posts/:postId/comments', { method: 'get', path: (b) => `/circles/posts/${b}/comments`, says: POST_WORDS, reached: () => jest.mocked(wallService.listComments).mock.calls }],
    ['POST /posts/:postId/comments', { method: 'post', path: (b) => `/circles/posts/${b}/comments`, says: POST_WORDS, body: { content: 'Hi' }, reached: () => jest.mocked(wallService.addComment).mock.calls }],
    ['POST /comments/:commentId/like', { method: 'post', path: (b) => `/circles/comments/${b}/like`, says: COMMENT_WORDS, body: { liked: true }, reached: () => jest.mocked(wallService.likeComment).mock.calls }],
    ['DELETE /comments/:commentId', { method: 'delete', path: (b) => `/circles/comments/${b}`, says: COMMENT_WORDS, reached: () => jest.mocked(wallService.deleteComment).mock.calls }],
  ];

  describe.each(probes)('%s', (_label, probe) => {
    const send = (id: string) => request(app)[probe.method](probe.path(id)).set(as(MEMBER, probe.role ?? 'member')).send(probe.body ?? {});

    it.each(['undefined', 'not-a-uuid', `${CIRCLE}x`])('refuses %s with a 400 in words, and the service is never reached', async (bad) => {
      const res = await send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe(probe.says);
      expect(probe.reached()).toEqual([]);
    });

    it("lets a well-formed id through, lower-cased, as production's client sends it", async () => {
      const id = probe.says === POD_WORDS ? POD : probe.says === POST_WORDS ? POST : probe.says === COMMENT_WORDS ? COMMENT : CIRCLE;
      const res = await send(id.toUpperCase());
      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
      expect(probe.reached().length).toBeGreaterThan(0);
      expect(probe.reached()[0]).toContain(id);
    });
  });
});

// ─── Final fix wave S1 (2 Nov 2026): a membership change tells the person's own event screens ──────────────────
// Circle membership decides who sees, auto-registers for and registers for a circle's events (event-access.ts), so the
// person whose membership changed is also sent their own Home and Events lists (user:<id>:sessions) and the page of
// each of the circle's events that has not ended (session:<id>). Nobody else is told another member's lists.

describe("a membership change tells the changed person's event lists and open event pages", () => {
  const EV1 = 'e1e1e1e1-0000-4000-8000-000000000001';
  const EV2 = 'e2e2e2e2-0000-4000-8000-000000000002';
  const theirEvents = (user: string) => [E.userSessions(user), E.session(EV1), E.session(EV2)];

  it.each([
    ['an approved ask', () => request(app).post(`/circles/${CIRCLE}/requests/${ASKER}/approve`).set(as(ADMIN)), ASKER, [ADMIN, MEMBER, ASKER]],
    ['a join', () => request(app).post(`/circles/${CIRCLE}/join`).set(as(ASKER)), ASKER, [ADMIN, MEMBER, ASKER]],
    ['a leave', () => request(app).post(`/circles/${CIRCLE}/leave`).set(as(MEMBER)), MEMBER, [ADMIN]],
    ['a removal by a manager', () => request(app).delete(`/circles/${CIRCLE}/members/${ASKER}`).set(as(ADMIN)), ASKER, [ADMIN, MEMBER]],
  ] as const)('%s: the person hears their own lists and each upcoming circle event; the others hear neither', async (_name, act, changed, after) => {
    upcoming = [EV1, EV2];
    members = [...after];
    expect((await act()).status).toBe(200);
    await settle();
    const all = heard();
    expect(all[changed]).toEqual(expect.arrayContaining(theirEvents(changed)));
    for (const [who, tags] of Object.entries(all)) {
      if (who === changed) continue;
      expect(tags.filter((t) => t.startsWith('session:') || t.endsWith(':sessions'))).toEqual([]);
    }
  });

  it('a circle with no upcoming events still tells the person their own lists', async () => {
    members = [ADMIN, MEMBER, JOINER];
    expect((await request(app).post(`/circles/${CIRCLE}/join`).set(as(JOINER))).status).toBe(200);
    await settle();
    expect(heard()[JOINER]).toEqual(page(JOINER, E.userSessions(JOINER)));
  });

  it('a change with no changed person (an edit) reads no events and tells nobody about them', async () => {
    upcoming = [EV1];
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ name: 'Doctors and nurses' })).status).toBe(200);
    await settle();
    expect(Object.values(heard()).flat().filter((t) => t.startsWith('session:') || t.endsWith(':sessions'))).toEqual([]);
    expect(mockQuery.mock.calls.some(([sql]) => /FROM sessions WHERE circle_id/.test(String(sql)))).toBe(false);
  });

  it('reads at most 50 upcoming events, ended and cancelled ones left out', async () => {
    upcoming = Array.from({ length: 80 }, (_, i) => `e${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`);
    members = [ADMIN, MEMBER, JOINER];
    await request(app).post(`/circles/${CIRCLE}/join`).set(as(JOINER));
    await settle();
    const read = mockQuery.mock.calls.find(([sql]) => /FROM sessions WHERE circle_id/.test(String(sql).replace(/\s+/g, ' ')));
    expect(read?.[1]).toEqual([CIRCLE, 50]);
    expect(heard()[JOINER].filter((t) => t.startsWith('session:'))).toHaveLength(50);
  });
});

// ─── Final fix wave X3 (2 Nov 2026): the platform admins run every circle (L21), so they are told too ────────────

describe('a platform admin who runs a circle from outside it is told of its changes', () => {
  const requests = E.circleRequests(CIRCLE);

  it("an ask: the platform admin hears the circle, its requests and the asker's list, as its members do", async () => {
    admins = [PLATFORM];
    expect((await request(app).post(`/circles/${CIRCLE}/request`).set(as(ASKER))).status).toBe(200);
    await settle();
    expect(heard()[PLATFORM]).toEqual(page(PLATFORM, E.userCircles(ASKER), requests));
  });

  it.each(['approve', 'decline'] as const)("an answer (%s) by the owner reaches the platform admin's Requests panel and count", async (verb) => {
    admins = [PLATFORM];
    members = verb === 'approve' ? [ADMIN, MEMBER, ASKER] : [ADMIN, MEMBER];
    expect((await request(app).post(`/circles/${CIRCLE}/requests/${ASKER}/${verb}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    expect(heard()[PLATFORM]).toEqual(page(PLATFORM, E.userCircles(ASKER), requests));
  });

  it('closing the circle reaches the platform admin; an admin who is also a member is told once', async () => {
    admins = [PLATFORM, MEMBER];
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'closed' })).status).toBe(200);
    await settle();
    expect(heard()[PLATFORM]).toEqual(page(PLATFORM, requests, E.circleInvites(CIRCLE)));
    expect(heard()[MEMBER]).toEqual(page(MEMBER, requests, E.circleInvites(CIRCLE)));
    expect(emits().filter(([, r]) => r.includes(MEMBER))).toHaveLength(1);
  });

  it('the admins are read bounded (at most 200), and each recipient gets an emit of their own', async () => {
    admins = Array.from({ length: 250 }, (_, i) => `user-admin-${i}`);
    expect((await request(app).post(`/circles/${CIRCLE}/request`).set(as(ASKER))).status).toBe(200);
    await settle();
    const read = mockQuery.mock.calls.find(([sql]) => /FROM users u WHERE u\.role IN/.test(String(sql).replace(/\s+/g, ' ')));
    expect(read?.[1]).toEqual([200]);
    expect(Object.keys(heard()).filter((u) => u.startsWith('user-admin-'))).toHaveLength(200);
    expect(emits().every(([, recipients]) => recipients.length === 1)).toBe(true);
  });
});

// ─── Final fix wave S2 (2 Nov 2026): closing withdraws the invites of people who do not run the circle ──────────

describe('closing a circle: the withdrawn invites are told to their people', () => {
  it("each inviter and member invitee hears their own invites list, and no one else's", async () => {
    jest.mocked(circleService.updateCircle).mockResolvedValueOnce({ approvedUserIds: [], invitesChangedFor: [MEMBER, ASKER] });
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'closed' })).status).toBe(200);
    await settle();
    const all = heard();
    expect(all[ASKER]).toEqual([E.userInvites(ASKER)]);
    expect(all[MEMBER]).toEqual(expect.arrayContaining([E.userInvites(MEMBER)]));
    expect(all[MEMBER]).not.toContain(E.userInvites(ASKER));
    expect(all[ADMIN]).not.toContain(E.userInvites(MEMBER));
  });

  it("production's client: an edit with no policy (the admin's rename) answers { ok: true } and withdraws nothing", async () => {
    const res = await request(app).patch(`/circles/${CIRCLE}`).set(as(PLATFORM, 'admin')).send({ name: 'Doctors', description: 'x' });
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    await settle();
    expect(Object.values(heard()).flat()).not.toContain(E.circleInvites(CIRCLE));
  });
});
