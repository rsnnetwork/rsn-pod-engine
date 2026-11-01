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

beforeEach(() => {
  jest.clearAllMocks();
  members = [ADMIN, MEMBER];
  creator = ADMIN;
  mockEmitEntities.mockResolvedValue(undefined);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] }; // authenticate
    // T14: the manager gate reads the circle, then whether the caller made it or is its owner or a moderator.
    if (/SELECT id, name, join_policy, created_by FROM circles WHERE id = \$1 AND archived_at IS NULL/.test(text)) {
      return { rows: [{ id: CIRCLE, name: 'Doctors', join_policy: 'open', created_by: creator }] };
    }
    if (/SELECT 1 FROM circles c WHERE c.id = \$1 AND \(c.created_by = \$2/.test(text)) {
      return { rows: params[1] === creator ? [{ '?column?': 1 }] : [] };
    }
    // T15: an entity's live links, for the entity's own fan-out when it is linked or unlinked.
    if (/SELECT m\.user_id FROM entity_members m WHERE m\.entity_id = \$1 AND m\.status IN \('active', 'pending'\)/.test(text)) {
      return { rows: params[0] === LINKED_ENTITY ? [{ user_id: ENTITY_ADMIN }] : [] };
    }
    if (/SELECT user_id FROM circle_members WHERE circle_id = \$1 UNION SELECT created_by FROM circles WHERE id = \$1/.test(text)) {
      return { rows: [...new Set([...members, creator])].map(user_id => ({ user_id })) };
    }
    return { rows: [] };
  });
  jest.mocked(circleService.createCircle).mockResolvedValue({ id: CIRCLE });
  jest.mocked(circleService.updateCircle).mockResolvedValue({ approvedUserIds: [] });
  jest.mocked(circleService.archiveCircle).mockResolvedValue(undefined);
  jest.mocked(circleService.attachPod).mockResolvedValue(undefined);
  jest.mocked(circleService.detachPod).mockResolvedValue(undefined);
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
  jest.mocked(linkService.unlinkEntity).mockResolvedValue(undefined);
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
    expect(heard()).toEqual({ [ADMIN]: page(ADMIN) });
  });

  it('a join: everyone in the circle and the joiner hear the circle, their own list and the joiner\'s', async () => {
    members = [ADMIN, MEMBER, JOINER];
    expect((await request(app).post(`/circles/${CIRCLE}/join`).set(as(JOINER))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: page(ADMIN, E.userCircles(JOINER)),
      [MEMBER]: page(MEMBER, E.userCircles(JOINER)),
      [JOINER]: page(JOINER),
    });
    expect(emits().every(([, recipients]) => recipients.length === 1)).toBe(true);
  });

  it('a leave: the member who left is told too, though they are no longer in the circle', async () => {
    members = [ADMIN];
    expect((await request(app).post(`/circles/${CIRCLE}/leave`).set(as(MEMBER))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: page(ADMIN, E.userCircles(MEMBER)),
      [MEMBER]: page(MEMBER),
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

  it.each([['get', '/'], ['get', '/of-pod/:podId'], ['get', '/:id'], ['get', '/:id/requests'], ['get', '/:id/attachable-pods']])('%s %s carries the read limiter', (method, path) => {
    order(circleReadLimiter, method, path);
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
      [ASKER]: page(ASKER, requests),
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
    expect(heard()[ASKER]).toEqual(page(ASKER, requests));
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
    expect(heard()).toEqual({ [ADMIN]: page(ADMIN, E.userCircles(ASKER)), [ASKER]: page(ASKER) });
  });

  it('the owner (not a platform admin) may edit and close the circle; a plain member may not', async () => {
    const closed = await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'closed' });
    expect(closed.status).toBe(200);
    expect(circleService.updateCircle).toHaveBeenCalledWith(CIRCLE, { joinPolicy: 'closed' }, { userId: ADMIN, role: 'member' });
    await settle();
    expect(heard()[MEMBER]).toEqual(page(MEMBER, requests));
    mockEmitEntities.mockClear();
    const refused = await request(app).patch(`/circles/${CIRCLE}`).set(as(MEMBER)).send({ joinPolicy: 'open' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe('Only the people who run this circle can change it.');
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'secret' })).status).toBe(400);
  });

  it('reopening lets the waiting people in: each is rung and told, with the requests tag', async () => {
    jest.mocked(circleService.updateCircle).mockResolvedValueOnce({ approvedUserIds: [ASKER] });
    members = [ADMIN, MEMBER, ASKER];
    expect((await request(app).patch(`/circles/${CIRCLE}`).set(as(ADMIN)).send({ joinPolicy: 'open' })).status).toBe(200);
    await settle();
    expect(joinService.ringApproved).toHaveBeenCalledWith(CIRCLE, 'Doctors', [ASKER]);
    expect(heard()[ASKER]).toEqual(page(ASKER, requests));
    expect(heard()[MEMBER]).toEqual(page(MEMBER, E.userCircles(ASKER), requests));
  });

  it('attach by the owner attaches only pods they run (isAdmin false); a member is refused attach and detach', async () => {
    expect((await request(app).post(`/circles/${CIRCLE}/pods`).set(as(ADMIN)).send({ podId: POD })).status).toBe(201);
    expect(circleService.attachPod).toHaveBeenCalledWith(CIRCLE, POD, ADMIN, false);
    expect((await request(app).post(`/circles/${CIRCLE}/pods`).set(as(MEMBER)).send({ podId: POD })).status).toBe(403);
    expect((await request(app).delete(`/circles/${CIRCLE}/pods/${POD}`).set(as(MEMBER))).status).toBe(403);
    expect((await request(app).delete(`/circles/${CIRCLE}/pods/${POD}`).set(as(ADMIN))).status).toBe(200);
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
