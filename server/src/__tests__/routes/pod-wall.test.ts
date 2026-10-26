// ─── /api/pods/:podId/wall: the routes (26 Oct 2026) ─────────────────────────
// What each route accepts, whom it lets through, what it answers, and that a write is rate limited.
// The service is a stand-in; its rules (who may do what, the bells, the tags) are tested in
// services/pod/pod-wall.service.test.ts. The routes are mounted beside the real pods router, as in
// index.ts, so a wall path that the pods router swallowed would show here.

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
// The real pods router is mounted below, so its collaborators are stand-ins that must stay untouched.
jest.mock('../../services/pod/pod.service');
jest.mock('../../realtime/fanout', () => ({
  fanoutPodEntities: jest.fn(),
  fanoutPodMembershipForUser: jest.fn(),
  __esModule: true,
}));
jest.mock('../../realtime/emit', () => ({
  emitEntities: jest.fn(),
  getRealtimeIo: jest.fn(),
  __esModule: true,
}));

const mockList = jest.fn();
const mockGet = jest.fn();
const mockCreate = jest.fn();
const mockDelete = jest.fn();
const mockPin = jest.fn();
const mockReact = jest.fn();
const mockComments = jest.fn();
const mockAddComment = jest.fn();
const mockLike = jest.fn();
const mockDeleteComment = jest.fn();
jest.mock('../../services/pod/pod-wall.service', () => ({
  listPosts: (...a: unknown[]) => mockList(...a),
  getPost: (...a: unknown[]) => mockGet(...a),
  createPost: (...a: unknown[]) => mockCreate(...a),
  deletePost: (...a: unknown[]) => mockDelete(...a),
  setPinned: (...a: unknown[]) => mockPin(...a),
  reactToPost: (...a: unknown[]) => mockReact(...a),
  listComments: (...a: unknown[]) => mockComments(...a),
  addComment: (...a: unknown[]) => mockAddComment(...a),
  likeComment: (...a: unknown[]) => mockLike(...a),
  deleteComment: (...a: unknown[]) => mockDeleteComment(...a),
  __esModule: true,
}));

import podRoutes from '../../routes/pods';
import podWallRoutes from '../../routes/pod-wall';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { wallWriteLimiter } from '../../middleware/rateLimit';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import * as podService from '../../services/pod/pod.service';

const app = express();
app.use(express.json());
// The order index.ts mounts them in.
app.use('/pods', podRoutes);
app.use('/pods', podWallRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// Each describe signs in as its own member, so no block of tests uses up another's allowance.
const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });

const POD = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const POST = '9d2e4b61-7c3a-4d58-b1f0-6e5a4c3b2d10';
const COMMENT = '0b6f6a52-2d1c-4a8e-9f3b-7e1d5c4a3b21';
const CLIENT = 'c1c1c1c1-0000-4000-8000-000000000001';
const base = `/pods/${POD}/wall`;

const services = [mockList, mockGet, mockCreate, mockDelete, mockPin, mockReact, mockComments, mockAddComment, mockLike, mockDeleteComment];
const nothingCalled = () => { for (const m of services) expect(m).not.toHaveBeenCalled(); };

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ pinned: [], posts: [], nextCursor: null, viewer: { canPost: true, canModerate: false } });
  mockGet.mockResolvedValue({ id: POST });
  mockCreate.mockResolvedValue({ id: POST });
  mockDelete.mockResolvedValue(undefined);
  mockPin.mockResolvedValue(undefined);
  mockReact.mockResolvedValue({ reactionCount: 1, reactions: { like: 1 }, myReaction: 'like' });
  mockComments.mockResolvedValue({ comments: [], truncated: false });
  mockAddComment.mockResolvedValue({ id: COMMENT, createdAt: '2026-10-26T10:05:00.000Z', parentCommentId: null });
  mockLike.mockResolvedValue({ likeCount: 1, likedByMe: true });
  mockDeleteComment.mockResolvedValue({ postId: POST });
});

// Every route, with a body that would otherwise succeed.
const routes: Array<[string, 'get' | 'post' | 'delete', string, object | undefined]> = [
  ['list posts', 'get', `${base}/posts`, undefined],
  ['read a post', 'get', `${base}/posts/${POST}`, undefined],
  ['create a post', 'post', `${base}/posts`, { clientId: CLIENT, content: 'hi' }],
  ['delete a post', 'delete', `${base}/posts/${POST}`, undefined],
  ['pin', 'post', `${base}/posts/${POST}/pin`, {}],
  ['unpin', 'post', `${base}/posts/${POST}/unpin`, {}],
  ['react', 'post', `${base}/posts/${POST}/react`, { reaction: 'like' }],
  ['list comments', 'get', `${base}/posts/${POST}/comments`, undefined],
  ['comment', 'post', `${base}/posts/${POST}/comments`, { content: 'nice' }],
  ['like a comment', 'post', `${base}/comments/${COMMENT}/like`, { liked: true }],
  ['delete a comment', 'delete', `${base}/comments/${COMMENT}`, undefined],
];

describe('every route needs a signed-in member', () => {
  it.each(routes)('%s: no token is a 401, and the service is not called', async (_name, method, path, body) => {
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(401);
    nothingCalled();
  });
});

describe('the ids in the address are checked before the service is called', () => {
  const me = as('u-ids');
  it.each([
    ['list posts', 'get', '/pods/not-a-pod/wall/posts'],
    ['read a post', 'get', `/pods/${POD}/wall/posts/not-a-post`],
    ['delete a post', 'delete', `/pods/${POD}/wall/posts/not-a-post`],
    ['pin', 'post', `/pods/${POD}/wall/posts/not-a-post/pin`],
    ['unpin', 'post', `/pods/${POD}/wall/posts/not-a-post/unpin`],
    ['react', 'post', `/pods/${POD}/wall/posts/not-a-post/react`],
    ['list comments', 'get', `/pods/${POD}/wall/posts/not-a-post/comments`],
    ['comment', 'post', `/pods/${POD}/wall/posts/not-a-post/comments`],
    ['like a comment', 'post', `/pods/${POD}/wall/comments/not-a-comment/like`],
    ['delete a comment', 'delete', `/pods/${POD}/wall/comments/not-a-comment`],
    ['create a post', 'post', '/pods/12345/wall/posts'],
  ] as const)('%s with a bad id is a 400', async (_name, method, path) => {
    const res = await request(app)[method](path).set(me).send({ clientId: CLIENT, content: 'hi', reaction: 'like', liked: true });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    nothingCalled();
  });

  it('reads an upper-case id as the same pod', async () => {
    await request(app).get(`/pods/${POD.toUpperCase()}/wall/posts`).set(me);
    expect(mockList).toHaveBeenCalledWith(POD, { userId: 'u-ids', role: 'member' }, { cursor: undefined });
  });
});

describe('GET /pods/:podId/wall/posts', () => {
  const me = as('u-list');

  it('answers the feed to the service\'s call as this member, with their platform role', async () => {
    const feed = { pinned: [], posts: [{ id: POST }], nextCursor: 'abc_def', viewer: { canPost: true, canModerate: true } };
    mockList.mockResolvedValueOnce(feed);
    const res = await request(app).get(`${base}/posts`).set(as('u-list', 'admin'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: feed });
    expect(mockList).toHaveBeenCalledWith(POD, { userId: 'u-list', role: 'admin' }, { cursor: undefined });
  });

  it('passes the cursor on', async () => {
    await request(app).get(`${base}/posts`).query({ cursor: '1761472800000_abc' }).set(me);
    expect(mockList).toHaveBeenCalledWith(POD, { userId: 'u-list', role: 'member' }, { cursor: '1761472800000_abc' });
  });

  it.each([
    ['a cursor longer than 100 characters', { cursor: 'x'.repeat(101) }],
    ['two cursors at once', 'cursor=a&cursor=b'],
  ])('refuses %s without calling the service', async (_what, q) => {
    const res = await request(app).get(`${base}/posts`).query(q).set(me);
    expect(res.status).toBe(400);
    nothingCalled();
  });

  it('a service refusal comes out as its own status and words', async () => {
    mockList.mockRejectedValueOnce(new ForbiddenError('Join this pod to read and post in its discussion'));
    const res = await request(app).get(`${base}/posts`).set(me);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: { code: 'AUTH_FORBIDDEN', message: 'Join this pod to read and post in its discussion' } });
    mockList.mockRejectedValueOnce(new NotFoundError('Pod', POD, 'That pod could not be found'));
    expect((await request(app).get(`${base}/posts`).set(me)).status).toBe(404);
  });
});

describe('POST /pods/:podId/wall/posts', () => {
  const me = as('u-post');
  const ok = { clientId: CLIENT, content: 'Hello pod' };
  const picture = { type: 'image', url: 'https://res.cloudinary.com/demo/a.jpg' };

  it('creates the post and answers 201 with it', async () => {
    mockCreate.mockResolvedValueOnce({ id: POST, content: 'Hello pod' });
    const res = await request(app).post(`${base}/posts`).set(me).send({ ...ok, media: [picture] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: POST, content: 'Hello pod' } });
    expect(mockCreate).toHaveBeenCalledWith(POD, { userId: 'u-post', role: 'member' }, {
      clientId: CLIENT, content: 'Hello pod', media: [{ ...picture, meta: undefined }],
    });
  });

  it('takes a picture with no text', async () => {
    const res = await request(app).post(`${base}/posts`).set(me).send({ clientId: CLIENT, media: [picture] });
    expect(res.status).toBe(201);
  });

  it.each([
    ['no clientId', { content: 'hi' }],
    ['a clientId that is not an id', { clientId: 'nope', content: 'hi' }],
    ['text that is not text', { clientId: CLIENT, content: 12 }],
    ['text over 8000 characters', { clientId: CLIENT, content: 'x'.repeat(8001) }],
    ['five pictures', { clientId: CLIENT, media: Array(5).fill(picture) }],
    ['a media item with no address', { clientId: CLIENT, media: [{ type: 'image' }] }],
    ['a media item of an unknown kind', { clientId: CLIENT, media: [{ type: 'script', url: 'https://res.cloudinary.com/x' }] }],
    ['an address over 2000 characters', { clientId: CLIENT, media: [{ type: 'image', url: `https://res.cloudinary.com/${'a'.repeat(2000)}` }] }],
    ['media that is not a list', { clientId: CLIENT, media: 'x' }],
  ])('refuses %s with a 400 and the field, without calling the service', async (_what, body) => {
    const res = await request(app).post(`${base}/posts`).set(me).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    nothingCalled();
  });

  it('turns a service refusal into its status: an archived pod 409, the posting cap 429', async () => {
    mockCreate.mockRejectedValueOnce(new AppError(409, ErrorCodes.POD_ARCHIVED, 'This pod is archived, so its discussion is read-only'));
    const archived = await request(app).post(`${base}/posts`).set(me).send(ok);
    expect(archived.status).toBe(409);
    expect(archived.body.error).toEqual({ code: 'POD_ARCHIVED', message: 'This pod is archived, so its discussion is read-only' });
    mockCreate.mockRejectedValueOnce(new AppError(429, ErrorCodes.VALIDATION_ERROR, 'You\'re posting too fast — give it a moment'));
    expect((await request(app).post(`${base}/posts`).set(me).send(ok)).status).toBe(429);
  });
});

describe('the rest of the posts', () => {
  const me = as('u-posts');
  const viewer = { userId: 'u-posts', role: 'member' };

  it('GET one post answers it', async () => {
    mockGet.mockResolvedValueOnce({ id: POST, content: 'x' });
    const res = await request(app).get(`${base}/posts/${POST}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: POST, content: 'x' } });
    expect(mockGet).toHaveBeenCalledWith(POD, POST, viewer);
  });

  it('GET one post that is gone is the service\'s 404', async () => {
    mockGet.mockRejectedValueOnce(new NotFoundError('Post', POST, 'That post could not be found'));
    const res = await request(app).get(`${base}/posts/${POST}`).set(me);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('That post could not be found');
  });

  it('DELETE a post answers ok', async () => {
    const res = await request(app).delete(`${base}/posts/${POST}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(mockDelete).toHaveBeenCalledWith(POD, POST, viewer);
  });

  it('pin and unpin answer ok, and say which they are', async () => {
    expect((await request(app).post(`${base}/posts/${POST}/pin`).set(me).send({})).body).toEqual({ success: true, data: { ok: true } });
    expect((await request(app).post(`${base}/posts/${POST}/unpin`).set(me).send({})).body).toEqual({ success: true, data: { ok: true } });
    expect(mockPin.mock.calls).toEqual([[POD, POST, viewer, true], [POD, POST, viewer, false]]);
  });

  it('pin by someone who may not is the service\'s 403', async () => {
    mockPin.mockRejectedValueOnce(new ForbiddenError('Only the pod\'s director or host can pin posts'));
    expect((await request(app).post(`${base}/posts/${POST}/pin`).set(me).send({})).status).toBe(403);
  });

  it('react sets a reaction, or clears it with null, and answers the counts', async () => {
    const set = await request(app).post(`${base}/posts/${POST}/react`).set(me).send({ reaction: 'love' });
    expect(set.status).toBe(200);
    expect(set.body.data).toEqual({ reactionCount: 1, reactions: { like: 1 }, myReaction: 'like' });
    await request(app).post(`${base}/posts/${POST}/react`).set(me).send({ reaction: null });
    expect(mockReact.mock.calls).toEqual([[POD, POST, viewer, 'love'], [POD, POST, viewer, null]]);
  });

  it.each([
    ['no reaction', {}],
    ['a reaction that is not one of the five', { reaction: 'sad' }],
    ['a reaction that is not text', { reaction: 5 }],
  ])('react with %s is a 400', async (_what, body) => {
    expect((await request(app).post(`${base}/posts/${POST}/react`).set(me).send(body)).status).toBe(400);
    nothingCalled();
  });
});

describe('comments', () => {
  const me = as('u-comments');
  const viewer = { userId: 'u-comments', role: 'member' };

  it('GET lists a post\'s comments, and says whether there are more than are shown', async () => {
    mockComments.mockResolvedValueOnce({ comments: [{ id: COMMENT }], truncated: true });
    const res = await request(app).get(`${base}/posts/${POST}/comments`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { comments: [{ id: COMMENT }], truncated: true } });
    expect(mockComments).toHaveBeenCalledWith(POD, POST, viewer);
  });

  it('POST adds a comment and answers 201 with its id', async () => {
    const res = await request(app).post(`${base}/posts/${POST}/comments`).set(me).send({ content: 'Welcome!' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: COMMENT, createdAt: '2026-10-26T10:05:00.000Z', parentCommentId: null } });
    expect(mockAddComment).toHaveBeenCalledWith(POD, POST, viewer, { content: 'Welcome!', parentCommentId: null });
  });

  it('POST adds a reply under a comment', async () => {
    await request(app).post(`${base}/posts/${POST}/comments`).set(me).send({ content: 'agreed', parentCommentId: COMMENT });
    expect(mockAddComment).toHaveBeenCalledWith(POD, POST, viewer, { content: 'agreed', parentCommentId: COMMENT });
  });

  it.each([
    ['no text', {}],
    ['empty text', { content: '' }],
    ['text over 4000 characters', { content: 'z'.repeat(4001) }],
    ['a reply to something that is not a comment id', { content: 'hi', parentCommentId: 'nope' }],
  ])('POST with %s is a 400', async (_what, body) => {
    expect((await request(app).post(`${base}/posts/${POST}/comments`).set(me).send(body)).status).toBe(400);
    nothingCalled();
  });

  it('like and unlike answer the count', async () => {
    const liked = await request(app).post(`${base}/comments/${COMMENT}/like`).set(me).send({ liked: true });
    expect(liked.status).toBe(200);
    expect(liked.body).toEqual({ success: true, data: { likeCount: 1, likedByMe: true } });
    await request(app).post(`${base}/comments/${COMMENT}/like`).set(me).send({ liked: false });
    expect(mockLike.mock.calls).toEqual([[POD, COMMENT, viewer, true], [POD, COMMENT, viewer, false]]);
  });

  it.each([['no liked'], ['liked as text']])('like with %s is a 400', async (what) => {
    const body = what === 'no liked' ? {} : { liked: 'yes' };
    expect((await request(app).post(`${base}/comments/${COMMENT}/like`).set(me).send(body)).status).toBe(400);
    nothingCalled();
  });

  it('DELETE a comment answers ok, and does not hand the post id to the browser (it is for the tags)', async () => {
    const res = await request(app).delete(`${base}/comments/${COMMENT}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(mockDeleteComment).toHaveBeenCalledWith(POD, COMMENT, viewer);
  });
});

describe('the routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  // What a route runs, in order, read from the router itself.
  const handlersOf = (method: string, path: string) =>
    (podWallRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([
    ['post', '/:podId/wall/posts'],
    ['delete', '/:podId/wall/posts/:postId'],
    ['post', '/:podId/wall/posts/:postId/pin'],
    ['post', '/:podId/wall/posts/:postId/unpin'],
    ['post', '/:podId/wall/posts/:postId/react'],
    ['post', '/:podId/wall/posts/:postId/comments'],
    ['post', '/:podId/wall/comments/:commentId/like'],
    ['delete', '/:podId/wall/comments/:commentId'],
  ])('%s %s carries the write limiter, after authenticate and ahead of its handler', (method, path) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(2); // the route exists
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(wallWriteLimiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });

  it.each([
    ['get', '/:podId/wall/posts'],
    ['get', '/:podId/wall/posts/:postId'],
    ['get', '/:podId/wall/posts/:postId/comments'],
  ])('%s %s (a read) is not counted against writes', (method, path) => {
    expect(handlersOf(method, path)).not.toContain(wallWriteLimiter);
  });

  it('refuses the 61st write in a minute with a friendly 429, for that member only', async () => {
    const busy = as('u-busy');
    for (let i = 0; i < 60; i += 1) {
      expect((await request(app).post(`${base}/posts/${POST}/react`).set(busy).send({ reaction: 'like' })).status).toBe(200);
    }
    mockReact.mockClear();
    const refused = await request(app).post(`${base}/posts/${POST}/react`).set(busy).send({ reaction: 'like' });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
    expect(mockReact).not.toHaveBeenCalled();
    // Someone else can still write, and this member can still read.
    expect((await request(app).post(`${base}/posts/${POST}/react`).set(as('u-calm')).send({ reaction: 'like' })).status).toBe(200);
    expect((await request(app).get(`${base}/posts`).set(busy)).status).toBe(200);
  });
});

describe('mounting', () => {
  it('the pods router does not swallow a wall path: a wall request reaches the wall, not the pod handlers', async () => {
    await request(app).get(`${base}/posts`).set(as('u-mount'));
    expect(mockList).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(podService) as unknown[]) {
      if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('a path under a pod that is not on the wall is still not found', async () => {
    const res = await request(app).get(`/pods/${POD}/wall/elsewhere`).set(as('u-mount'));
    expect(res.status).toBe(404);
    nothingCalled();
  });

  it('index.ts mounts the wall under /api/pods, beside the pods router', () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, '../../index.ts'), 'utf8');
    expect(source).toMatch(/import podWallRoutes from '\.\/routes\/pod-wall';/);
    expect(source).toMatch(/app\.use\('\/api\/pods', podWallRoutes\);/);
    expect(source.indexOf("app.use('/api/pods', podRoutes);")).toBeLessThan(source.indexOf("app.use('/api/pods', podWallRoutes);"));
  });
});
