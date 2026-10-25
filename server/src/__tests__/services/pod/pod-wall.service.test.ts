// ─── The pod wall (26 Oct 2026) ───────────────────────────────────────────────
//
// 25 Oct, Stefan, back in the pod after an event: "We can't write in the pod itself. There's no wall,
// like a Facebook wall. There should be." A pod's discussion, built on the circle wall's rules
// (circle-wall.service.ts) with the pod's own: only ACTIVE members read and write, whatever a pod's
// visibility (a circle's wall is readable by any member); an archived pod is read-only; the director or
// host moderates; and, unlike the circle wall, every change reaches open screens through entity tags
// and every bell is pushed live and honours the member's group-bell setting.
//
// The database is a fake that answers by WHAT the SQL asks for and refuses any statement the test did
// not expect, so a new query cannot slip in unseen. The SQL itself is pinned where the rules live in it
// (the active-only audience, blocks both ways, the group-bell preference, the dedupe windows); the same
// statements run against a real Postgres in the task's local smoke.

const mockQuery = jest.fn();
// What ran on the transaction's own client, so a test can say a write happened INSIDE the transaction.
const mockTxSql: string[] = [];
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({
      query: (...a: unknown[]) => {
        mockTxSql.push(String(a[0]).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim());
        return mockQuery(...a);
      },
    }),
  __esModule: true,
}));
const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockCanView = jest.fn();
jest.mock('../../../services/pods/pod-access', () => ({
  canViewPod: (...args: unknown[]) => mockCanView(...args),
  __esModule: true,
}));
const mockFanout = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  fanoutPodWall: (...args: unknown[]) => mockFanout(...args),
  __esModule: true,
}));
const mockPush = jest.fn();
const mockIo = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => mockPush(room, event, payload) }),
};
let currentIo: typeof mockIo | null = mockIo;
const mockEmitEntities = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => currentIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as wall from '../../../services/pod/pod-wall.service';
import { E } from '../../../realtime/entities';
import {
  COMMENT_RATE_PER_MIN, MEDIA_HOST_PREFIX, POST_RATE_PER_MIN,
} from '../../../services/circle/circle-wall.service';

const POD = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const POST = '9d2e4b61-7c3a-4d58-b1f0-6e5a4c3b2d10';
const COMMENT = '0b6f6a52-2d1c-4a8e-9f3b-7e1d5c4a3b21';
const REPLY_TO = '5e8d7c61-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CLIENT_ID = 'c1c1c1c1-0000-4000-8000-000000000001';
const OTHER_POD = '8f1e2d3c-4b5a-4968-8776-655443322110';

const VIEWER = 'viewer-1';
const AUTHOR = 'author-1';
const asMember = { userId: VIEWER, role: 'member' };
const asAdmin = { userId: VIEWER, role: 'admin' };
const asSuperAdmin = { userId: VIEWER, role: 'super_admin' };
// A platform role that is not an admin one: a platform "host" gets no moderation from it.
const asPlatformHost = { userId: VIEWER, role: 'host' };

interface World {
  pod: { name: string; status: string } | null;
  member: { role: string; status: string } | null;
  viewerName: string | null;
  canView: boolean;
  recentPosts: number;
  recentComments: number;
  priorPost: { id: string; pod_id: string; deleted_at: Date | null } | null;
  insertedPostId: string | null;
  postHead: { author_id: string; content: string } | null;
  postRow: Record<string, unknown> | null;
  feed: Record<string, unknown>[];
  pinned: Record<string, unknown>[];
  bellRows: Array<{ id: string; user_id: string; created_at: Date }>;
  parent: { id: string; author_id: string; parent_comment_id: string | null } | null;
  comments: Record<string, unknown>[];
  lockedPost: { author_id: string; deleted_at: Date | null } | null;
  lockedComment: { author_id: string; post_id: string; deleted_at: Date | null } | null;
  commentsRemoved: number;
  pinnedRows: number;
  likeTarget: { post_id: string } | null;
  likeCount: number;
  likedByMe: boolean;
  reactionRows: Array<{ reaction: string; n: number; mine: boolean }>;
}

let world: World;

const BELL_ROW = { id: 'n-1', user_id: 'member-1', created_at: new Date('2026-10-26T10:00:05.000Z') };

const aPost = (over: Record<string, unknown> = {}) => ({
  id: POST, pod_id: POD, author_id: AUTHOR, display_name: 'Ada Author', avatar_url: 'https://cdn.example/ada.jpg',
  author_closed: false, content: 'hello pod', media: [], link_url: null, comment_count: 0, pinned_at: null,
  created_at: new Date('2026-10-26T10:00:00.000Z'), reaction_count: 0, reactions: {}, my_reaction: null,
  ...over,
});

/** A statement on one line, with no space just inside its brackets, so a pattern is not a map of the indentation. */
const norm = (sql: unknown) => String(sql).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
const sqlOf = (call: unknown[]) => norm(call[0]);
const calls = (re: RegExp) => mockQuery.mock.calls.filter((c) => re.test(sqlOf(c)));
const writes = () => mockQuery.mock.calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/i.test(sqlOf(c)));
const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });

/** What the fake database answers, by what the statement asks for. */
function answer(sql: string, params: unknown[]): unknown {
  const text = norm(sql);
  const is = (re: RegExp) => re.test(text);

  if (is(/FROM pods p LEFT JOIN pod_members pm ON pm\.pod_id = p\.id AND pm\.user_id = \$2 WHERE p\.id = \$1/)) {
    return rows(world.pod ? [{
      name: world.pod.name, status: world.pod.status,
      member_role: world.member?.role ?? null, member_status: world.member?.status ?? null,
      viewer_name: world.viewerName,
    }] : []);
  }
  if (is(/count\(\*\)::text AS c FROM pod_posts WHERE author_id = \$1/)) return rows([{ c: String(world.recentPosts) }]);
  if (is(/count\(\*\)::text AS c FROM pod_post_comments WHERE author_id = \$1/)) return rows([{ c: String(world.recentComments) }]);
  if (is(/SELECT id, pod_id, deleted_at FROM pod_posts WHERE author_id = \$1 AND client_id = \$2/)) {
    return rows(world.priorPost ? [world.priorPost] : []);
  }
  if (is(/INSERT INTO pod_posts \(/)) {
    return rows(world.insertedPostId ? [{ id: world.insertedPostId }] : []);
  }
  if (is(/INSERT INTO notifications/)) return rows(world.bellRows);
  if (is(/SELECT p\.author_id, p\.content FROM pod_posts p WHERE p\.id = \$1/)) {
    return rows(world.postHead ? [world.postHead] : []);
  }
  if (is(/FROM pod_posts p JOIN users u ON u\.id = p\.author_id/)) {
    if (is(/p\.pinned_at IS NOT NULL/)) return rows(world.pinned);
    if (is(/WHERE p\.id = \$1/)) return rows(world.postRow ? [world.postRow] : []);
    return rows(world.feed);
  }
  if (is(/SELECT author_id, deleted_at FROM pod_posts WHERE id = \$1 AND pod_id = \$2 FOR UPDATE/)) {
    return rows(world.lockedPost ? [world.lockedPost] : []);
  }
  if (is(/UPDATE pod_posts SET deleted_at = NOW\(\), deleted_by = \$2 WHERE id = \$1/)) return rows([]);
  if (is(/UPDATE pod_posts SET pinned_at = CASE WHEN \$3::boolean THEN NOW\(\) ELSE NULL END/)) {
    return { rows: [], rowCount: world.pinnedRows };
  }
  if (is(/INSERT INTO pod_post_reactions/)) return rows([{ reaction: params[2] }]);
  if (is(/DELETE FROM pod_post_reactions/)) return rows([]);
  if (is(/FROM pod_post_reactions WHERE post_id = \$1 GROUP BY reaction/)) return rows(world.reactionRows);
  if (is(/FROM pod_post_comments c WHERE c\.id = \$1 AND c\.post_id = \$2/)) return rows(world.parent ? [world.parent] : []);
  if (is(/INSERT INTO pod_post_comments/)) return rows([{ id: COMMENT, created_at: new Date('2026-10-26T10:05:00.000Z') }]);
  if (is(/UPDATE pod_posts SET comment_count = comment_count \+ 1/)) return rows([]);
  if (is(/FROM pod_post_comments c JOIN users u ON u\.id = c\.author_id/)) return rows(world.comments);
  if (is(/SELECT c\.post_id FROM pod_post_comments c JOIN pod_posts p ON p\.id = c\.post_id/)) {
    return rows(world.likeTarget ? [world.likeTarget] : []);
  }
  if (is(/INSERT INTO pod_comment_likes/)) return rows([]);
  if (is(/DELETE FROM pod_comment_likes/)) return rows([]);
  if (is(/count\(\*\)::int AS like_count, bool_or\(user_id = \$2\) AS liked_by_me FROM pod_comment_likes/)) {
    return rows([{ like_count: world.likeCount, liked_by_me: world.likedByMe }]);
  }
  if (is(/FROM pod_post_comments c JOIN pod_posts p ON p\.id = c\.post_id WHERE c\.id = \$1 AND p\.pod_id = \$2/)) {
    return rows(world.lockedComment ? [world.lockedComment] : []);
  }
  if (is(/UPDATE pod_post_comments SET deleted_at = NOW\(\)/)) {
    return rows(Array.from({ length: world.commentsRemoved }, (_, i) => ({ id: `gone-${i}` })));
  }
  if (is(/UPDATE pod_posts SET comment_count = GREATEST\(comment_count - \$2, 0\)/)) return rows([]);
  throw new Error(`Unexpected SQL in the pod wall test: ${text.slice(0, 240)}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPush.mockReset();
  mockTxSql.length = 0;
  currentIo = mockIo;
  world = {
    pod: { name: 'Founders pod', status: 'active' },
    member: { role: 'member', status: 'active' },
    viewerName: 'Vera Viewer',
    canView: true,
    recentPosts: 0,
    recentComments: 0,
    priorPost: null,
    insertedPostId: POST,
    postHead: { author_id: AUTHOR, content: 'hello pod' },
    postRow: aPost(),
    feed: [],
    pinned: [],
    bellRows: [BELL_ROW],
    parent: null,
    comments: [],
    lockedPost: { author_id: VIEWER, deleted_at: null },
    lockedComment: { author_id: VIEWER, post_id: POST, deleted_at: null },
    commentsRemoved: 1,
    pinnedRows: 1,
    likeTarget: { post_id: POST },
    likeCount: 1,
    likedByMe: true,
    reactionRows: [{ reaction: 'love', n: 2, mine: true }, { reaction: 'like', n: 1, mine: false }],
  };
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => answer(sql, params));
  mockCanView.mockImplementation(async () => world.canView);
  mockFanout.mockResolvedValue(undefined);
  mockEmitEntities.mockResolvedValue(undefined);
});

const MEMBER_STATUSES_THAT_MAY_NOT = ['invited', 'pending_approval', 'declined', 'no_response', 'left', 'removed'];

// ─── Who may read and write ──────────────────────────────────────────────────

describe('only ACTIVE members read and post, on every kind of pod', () => {
  // Every entry point, with the arguments that would otherwise succeed.
  const entryPoints: Array<[string, () => Promise<unknown>]> = [
    ['list the posts', () => wall.listPosts(POD, asMember)],
    ['read one post', () => wall.getPost(POD, POST, asMember)],
    ['post', () => wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'hi' })],
    ['delete a post', () => wall.deletePost(POD, POST, asMember)],
    ['pin a post', () => wall.setPinned(POD, POST, asMember, true)],
    ['react', () => wall.reactToPost(POD, POST, asMember, 'love')],
    ['list the comments', () => wall.listComments(POD, POST, asMember)],
    ['comment', () => wall.addComment(POD, POST, asMember, { content: 'nice' })],
    ['like a comment', () => wall.likeComment(POD, COMMENT, asMember, true)],
    ['delete a comment', () => wall.deleteComment(POD, COMMENT, asMember)],
  ];

  it.each(MEMBER_STATUSES_THAT_MAY_NOT)('a member whose status is %s is refused every entry point, and nothing is written or sent', async (status) => {
    world.member = { role: 'member', status };
    for (const [, run] of entryPoints) {
      await expect(run()).rejects.toMatchObject({
        statusCode: 403,
        message: 'Join this pod to read and post in its discussion',
      });
    }
    expect(writes()).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a signed-in member who is not in a visible pod at all gets the same 403, and the sentence the brief gives', async () => {
    world.member = null;
    await expect(wall.listPosts(POD, asMember)).rejects.toMatchObject({
      statusCode: 403,
      code: 'AUTH_FORBIDDEN',
      message: 'Join this pod to read and post in its discussion',
    });
  });

  it('a private pod is invisible to someone who cannot see it: 404, as canViewPod says, not 403', async () => {
    world.member = null;
    world.canView = false;
    await expect(wall.listPosts(POD, asMember)).rejects.toMatchObject({ statusCode: 404, code: 'POD_NOT_FOUND' });
    expect(mockCanView).toHaveBeenCalledWith(VIEWER, POD, 'member');
  });

  it('a pod that does not exist is a 404 too, and canViewPod is never asked', async () => {
    world.pod = null;
    await expect(wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'hi' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockCanView).not.toHaveBeenCalled();
  });

  it('an active member passes the gate with any member role', async () => {
    for (const role of ['member', 'host', 'director']) {
      world.member = { role, status: 'active' };
      await expect(wall.listPosts(POD, asMember)).resolves.toMatchObject({ posts: [] });
    }
  });

  it('decides access from one read: the pod, and the viewer\'s own membership row in it', async () => {
    await wall.listPosts(POD, asMember);
    const [first] = calls(/FROM pods p LEFT JOIN pod_members pm/);
    expect(first[1]).toEqual([POD, VIEWER]);
    expect(calls(/FROM pods p LEFT JOIN pod_members pm/)).toHaveLength(1);
  });
});

describe('platform admins moderate; they do not post', () => {
  beforeEach(() => { world.member = null; });

  it.each([['admin', asAdmin], ['super_admin', asSuperAdmin]])('a %s who is not in the pod can read the wall and is shown the moderator controls only', async (_role, viewer) => {
    const feed = await wall.listPosts(POD, viewer);
    expect(feed.viewer).toEqual({ canPost: false, canModerate: true });
    expect(mockCanView).not.toHaveBeenCalled();
  });

  it('can read one post and its comments', async () => {
    await expect(wall.getPost(POD, POST, asAdmin)).resolves.toMatchObject({ id: POST });
    await expect(wall.listComments(POD, POST, asAdmin)).resolves.toEqual([]);
  });

  it('cannot post, comment, react or like unless they are a member: 403, nothing written', async () => {
    await expect(wall.createPost(POD, asAdmin, { clientId: CLIENT_ID, content: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(wall.addComment(POD, POST, asAdmin, { content: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(wall.reactToPost(POD, POST, asAdmin, 'like')).rejects.toMatchObject({ statusCode: 403 });
    await expect(wall.likeComment(POD, COMMENT, asAdmin, true)).rejects.toMatchObject({ statusCode: 403 });
    expect(writes()).toHaveLength(0);
  });

  it('can delete any post and any comment, and pin', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    world.lockedComment = { author_id: AUTHOR, post_id: POST, deleted_at: null };
    await expect(wall.deletePost(POD, POST, asAdmin)).resolves.toBeUndefined();
    await expect(wall.deleteComment(POD, COMMENT, asAdmin)).resolves.toEqual({ postId: POST });
    await expect(wall.setPinned(POD, POST, asAdmin, true)).resolves.toBeUndefined();
  });

  it('an admin who is also an active member can post', async () => {
    world.member = { role: 'member', status: 'active' };
    const feed = await wall.listPosts(POD, asAdmin);
    expect(feed.viewer).toEqual({ canPost: true, canModerate: true });
  });

  it('a platform "host" is not a pod host: the platform role moderates nothing here', async () => {
    world.member = { role: 'member', status: 'active' };
    const feed = await wall.listPosts(POD, asPlatformHost);
    expect(feed.viewer).toEqual({ canPost: true, canModerate: false });
  });
});

describe('an archived pod is read-only', () => {
  beforeEach(() => { world.pod = { name: 'Founders pod', status: 'archived' }; });

  it('can still be read, and says nothing may be added or changed, even by the director', async () => {
    expect((await wall.listPosts(POD, asMember)).viewer).toEqual({ canPost: false, canModerate: false });
    world.member = { role: 'director', status: 'active' };
    expect((await wall.listPosts(POD, asMember)).viewer).toEqual({ canPost: false, canModerate: false });
    world.member = null;
    expect((await wall.listPosts(POD, asAdmin)).viewer).toEqual({ canPost: false, canModerate: false });
    await expect(wall.getPost(POD, POST, asMember)).rejects.toMatchObject({ statusCode: 403 }); // not a member now
    world.member = { role: 'member', status: 'active' };
    await expect(wall.getPost(POD, POST, asMember)).resolves.toMatchObject({ id: POST });
    await expect(wall.listComments(POD, POST, asMember)).resolves.toEqual([]);
  });

  it('refuses a post, comment, reply, reaction, like, delete and pin with 409 POD_ARCHIVED, in words, and writes nothing', async () => {
    world.member = { role: 'director', status: 'active' };
    // Each is started only when its turn comes, so one that wrongly succeeds fails this test cleanly.
    const refusals: Array<() => Promise<unknown>> = [
      () => wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'hi' }),
      () => wall.addComment(POD, POST, asMember, { content: 'hi' }),
      () => wall.addComment(POD, POST, asMember, { content: 'hi', parentCommentId: REPLY_TO }),
      () => wall.reactToPost(POD, POST, asMember, 'like'),
      () => wall.reactToPost(POD, POST, asMember, null),
      () => wall.likeComment(POD, COMMENT, asMember, true),
      () => wall.deletePost(POD, POST, asMember),
      () => wall.deleteComment(POD, COMMENT, asMember),
      () => wall.setPinned(POD, POST, asMember, true),
    ];
    for (const refuse of refusals) {
      await expect(refuse()).rejects.toMatchObject({
        statusCode: 409, code: 'POD_ARCHIVED', message: 'This pod is archived, so its discussion is read-only',
      });
    }
    expect(writes()).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it.each(['draft', 'suspended'])('a %s pod is closed to new activity too, with its own words', async (status) => {
    world.pod = { name: 'Founders pod', status };
    await expect(wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'hi' })).rejects.toMatchObject({
      statusCode: 409, code: 'POD_NOT_ACTIVE', message: 'This pod is not open for new activity right now',
    });
    expect((await wall.listPosts(POD, asMember)).viewer.canPost).toBe(false);
  });
});

// ─── Posting ─────────────────────────────────────────────────────────────────

describe('createPost', () => {
  const post = (input: Partial<{ clientId: string; content: string; media: unknown }> = {}) =>
    wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'Hello pod', ...input });

  it('stores the trimmed text with the pod and its author, and answers the post as the viewer sees it', async () => {
    world.postRow = aPost({ content: 'Hello pod' });
    const made = await post({ content: '  Hello pod  ' });
    const [insert] = calls(/INSERT INTO pod_posts/);
    expect(insert[1]).toEqual([CLIENT_ID, POD, VIEWER, 'Hello pod', '[]', null]);
    expect(made).toEqual({
      id: POST, podId: POD, authorId: AUTHOR, authorName: 'Ada Author', authorAvatarUrl: 'https://cdn.example/ada.jpg',
      authorClosed: false, content: 'Hello pod', media: [], linkUrl: null, commentCount: 0, pinnedAt: null,
      createdAt: '2026-10-26T10:00:00.000Z', reactionCount: 0, reactions: {}, myReaction: null,
    });
  });

  it('is idempotent in the database: ON CONFLICT (author_id, client_id) DO NOTHING', async () => {
    await post();
    const [insert] = calls(/INSERT INTO pod_posts/);
    expect(sqlOf(insert)).toMatch(/ON CONFLICT \(author_id, client_id\) DO NOTHING RETURNING id/);
  });

  it('stamps the post to the millisecond, because a feed cursor is a millisecond and a post it lands on must not be skipped', async () => {
    await post();
    expect(sqlOf(calls(/INSERT INTO pod_posts/)[0])).toMatch(/date_trunc\('milliseconds', NOW\(\)\)/);
  });

  it('keeps the first web address in the text as the link card, and never fetches it', async () => {
    await post({ content: 'read https://example.com/a?b=1 and http://b.co' });
    expect(calls(/INSERT INTO pod_posts/)[0][1]).toEqual([CLIENT_ID, POD, VIEWER, 'read https://example.com/a?b=1 and http://b.co', '[]', 'https://example.com/a?b=1']);
  });

  it('accepts pictures from our own uploads only, at most four', async () => {
    const ok = { type: 'image', url: `${MEDIA_HOST_PREFIX}demo/a.jpg` };
    await post({ content: '', media: [ok] });
    expect(JSON.parse(String(calls(/INSERT INTO pod_posts/)[0][1][4]))).toEqual([{ type: 'image', url: ok.url, meta: null }]);
    await expect(post({ media: [{ type: 'image', url: 'https://evil.example/a.jpg' }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(post({ media: Array(5).fill(ok) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a post with nothing in it, and one over 8000 characters', async () => {
    await expect(post({ content: '   ' })).rejects.toMatchObject({ statusCode: 400, message: 'Say something or attach something' });
    await expect(post({ content: 'x'.repeat(8001) })).rejects.toMatchObject({ statusCode: 400, message: 'Post too long (max 8000 characters)' });
    expect(writes()).toHaveLength(0);
  });

  it(`stops a member posting more than ${POST_RATE_PER_MIN} times in a minute: 429, nothing written`, async () => {
    world.recentPosts = POST_RATE_PER_MIN;
    await expect(post()).rejects.toMatchObject({ statusCode: 429 });
    expect(writes()).toHaveLength(0);
  });

  describe('a retried submit (the same clientId)', () => {
    it('returns the first post and does nothing else: no second row, no bells, nothing sent', async () => {
      world.priorPost = { id: POST, pod_id: POD, deleted_at: null };
      const again = await post();
      expect(again.id).toBe(POST);
      expect(writes()).toHaveLength(0);
      expect(mockFanout).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('still succeeds when the member is at the posting cap, because it posts nothing', async () => {
      world.priorPost = { id: POST, pod_id: POD, deleted_at: null };
      world.recentPosts = POST_RATE_PER_MIN;
      await expect(post()).resolves.toMatchObject({ id: POST });
    });

    it('that loses a race with its own twin gets the winner\'s post, and does nothing else', async () => {
      world.insertedPostId = null; // the INSERT conflicted: the twin had just landed
      let lookups = 0;
      mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/SELECT id, pod_id, deleted_at FROM pod_posts WHERE author_id/.test(String(sql).replace(/\s+/g, ' '))) {
          lookups += 1;
          return rows(lookups === 1 ? [] : [{ id: POST, pod_id: POD, deleted_at: null }]);
        }
        return answer(sql, params);
      });
      await expect(post()).resolves.toMatchObject({ id: POST });
      expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
      expect(mockFanout).not.toHaveBeenCalled();
    });

    it('sent to another pod is refused (409), never answered with a post from the first', async () => {
      world.priorPost = { id: POST, pod_id: OTHER_POD, deleted_at: null };
      await expect(post()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('for a post a moderator has since deleted is a 404, never the deleted post', async () => {
      world.priorPost = { id: POST, pod_id: POD, deleted_at: new Date() };
      await expect(post()).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('tells the pod', () => {
    it('sends the wall\'s tag to the pod\'s active members once the post is saved', async () => {
      await post();
      expect(mockFanout).toHaveBeenCalledTimes(1);
      expect(mockFanout).toHaveBeenCalledWith(POD);
    });

    it('does not tell anyone when the write failed', async () => {
      mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO pod_posts/.test(String(sql))) throw new Error('disk full');
        return answer(sql, params);
      });
      await expect(post()).rejects.toThrow('disk full');
      expect(mockFanout).not.toHaveBeenCalled();
      expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
    });
  });
});

// ─── The bell for a new post ─────────────────────────────────────────────────

describe('the bell for a new post', () => {
  const post = () => wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'Big news https://example.com' });

  it('is ONE statement however many members the pod has: an INSERT ... SELECT, not a loop', async () => {
    world.bellRows = Array.from({ length: 40 }, (_, i) => ({ id: `n-${i}`, user_id: `member-${i}`, created_at: new Date() }));
    await post();
    expect(calls(/INSERT INTO notifications/)).toHaveLength(1);
    expect(mockPush).toHaveBeenCalledTimes(40);
    // After the post is saved, not inside its transaction: a bell that fails must not undo the post.
    expect(mockTxSql.some((q) => /INSERT INTO notifications/.test(q))).toBe(false);
    const sql = sqlOf(calls(/INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/^INSERT INTO notifications \(id, user_id, type, title, body, link\) SELECT gen_random_uuid\(\), pm\.user_id, 'pod_post', /);
    expect(sql).toMatch(/FROM pod_members pm JOIN users u ON u\.id = pm\.user_id/);
    expect(sql).toMatch(/RETURNING id, user_id, created_at$/);
  });

  it('goes to ACTIVE members only, never to the author, and never to a closed, suspended or banned account', async () => {
    await post();
    const sql = sqlOf(calls(/INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/pm\.pod_id = \$1 AND pm\.status = 'active' AND pm\.user_id <> \$2/);
    expect(sql).toMatch(/u\.status = 'active'/);
  });

  it('honours the member\'s group-bell setting (on unless they turned it off)', async () => {
    await post();
    expect(sqlOf(calls(/INSERT INTO notifications/)[0])).toContain(
      "COALESCE((u.notification_prefs->>'group_bell')::boolean, true)",
    );
  });

  it('skips a member who has blocked the author or been blocked by them: no bells between blocked pairs', async () => {
    await post();
    const sql = sqlOf(calls(/INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/b\.blocker_id = pm\.user_id AND b\.blocked_id = \$2/);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = pm\.user_id/);
  });

  it('rings a member once per pod per hour, however many posts are made', async () => {
    await post();
    const sql = sqlOf(calls(/INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM notifications n WHERE n\.user_id = pm\.user_id AND n\.type = 'pod_post' AND n\.link = \$5::text AND n\.created_at > NOW\(\) - INTERVAL '1 hour'\)/);
    // The dedupe key is the pod's page, not the post: a second post in the hour finds the first one's bell.
    expect(calls(/INSERT INTO notifications/)[0][1]).toEqual([POD, VIEWER, 'New post in Founders pod', 'Big news https://example.com', `/pods/${POD}`]);
  });

  it('says what was shared when a post is a picture only', async () => {
    await wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: '', media: [{ type: 'image', url: `${MEDIA_HOST_PREFIX}demo/a.jpg` }] });
    expect(calls(/INSERT INTO notifications/)[0][1][3]).toBe('Shared an attachment');
  });

  it('shortens a long post to 120 characters in the bell', async () => {
    await wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'y'.repeat(300) });
    expect(calls(/INSERT INTO notifications/)[0][1][3]).toBe('y'.repeat(120));
  });

  it('is pushed live to each member it was inserted for: notification:new on their own room plus their own bell tag', async () => {
    world.bellRows = [
      { id: 'n-1', user_id: 'member-1', created_at: new Date('2026-10-26T10:00:05.000Z') },
      { id: 'n-2', user_id: 'member-2', created_at: new Date('2026-10-26T10:00:05.000Z') },
    ];
    await post();
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenCalledWith('user:member-1', 'notification:new', {
      id: 'n-1', type: 'pod_post', title: 'New post in Founders pod', body: 'Big news https://example.com',
      link: `/pods/${POD}`, isRead: false, createdAt: new Date('2026-10-26T10:00:05.000Z'),
    });
    expect(mockPush).toHaveBeenCalledWith('user:member-2', 'notification:new', expect.objectContaining({ id: 'n-2' }));
    // Each member is sent their own bell tag and no one else's.
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['member-1'], [E.userNotifications('member-1')]);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['member-2'], [E.userNotifications('member-2')]);
  });

  it('pushes nothing when nobody was rung (everyone muted, blocked, already rung this hour, or alone in the pod)', async () => {
    world.bellRows = [];
    await post();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('never fails the post: a bell that cannot be written is logged and the post is still answered', async () => {
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO notifications/.test(String(sql))) throw new Error('constraint');
      return answer(sql, params);
    });
    await expect(post()).resolves.toMatchObject({ id: POST });
    expect(mockWarn).toHaveBeenCalled();
    expect(mockFanout).toHaveBeenCalledWith(POD);
  });

  it('never fails the post: a socket that cannot be reached is logged and the post is still answered', async () => {
    mockPush.mockImplementation(() => { throw new Error('socket closed'); });
    await expect(post()).resolves.toMatchObject({ id: POST });
    expect(mockWarn).toHaveBeenCalled();
  });

  it('is not pushed when there is no socket server (the row is written, the bell shows on the next fetch)', async () => {
    currentIo = null;
    await expect(post()).resolves.toMatchObject({ id: POST });
    expect(calls(/INSERT INTO notifications/)).toHaveLength(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

// ─── The feed ────────────────────────────────────────────────────────────────

describe('listPosts', () => {
  it('serves the newest first by (created_at, id) with a keyset, never OFFSET, and blocks filtered in both directions', async () => {
    await wall.listPosts(POD, asMember, { cursor: `${Date.parse('2026-10-26T10:00:00.000Z')}_${POST}` });
    const feedSql = sqlOf(calls(/ORDER BY p\.created_at DESC/)[0]);
    expect(feedSql).toMatch(/WHERE p\.pod_id = \$1 AND p\.deleted_at IS NULL/);
    expect(feedSql).toMatch(/\(p\.created_at, p\.id\) < \(\$3, \$4::uuid\)/);
    expect(feedSql).toMatch(/ORDER BY p\.created_at DESC, p\.id DESC LIMIT \$5$/);
    expect(feedSql).not.toMatch(/OFFSET/i);
    expect(feedSql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    expect(feedSql).toMatch(/b\.blocker_id = p\.author_id AND b\.blocked_id = \$2/);
    expect(calls(/ORDER BY p\.created_at DESC/)[0][1]).toEqual([POD, VIEWER, new Date('2026-10-26T10:00:00.000Z'), POST, 21]);
  });

  it('asks for one more than a page, to know whether there is another, and hands back a cursor for it', async () => {
    const at = (n: number) => new Date(Date.parse('2026-10-26T10:00:00.000Z') - n * 1000);
    world.feed = Array.from({ length: 21 }, (_, i) => aPost({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, created_at: at(i) }));
    const feed = await wall.listPosts(POD, asMember);
    expect(feed.posts).toHaveLength(20);
    expect(feed.nextCursor).toBe(`${at(19).getTime()}_00000000-0000-4000-8000-000000000019`);
  });

  it('has no cursor on the last page', async () => {
    world.feed = [aPost()];
    expect((await wall.listPosts(POD, asMember)).nextCursor).toBeNull();
  });

  it('never serves more than 50 a page, and never fewer than one', async () => {
    await wall.listPosts(POD, asMember, { limit: 500 });
    expect(calls(/ORDER BY p\.created_at DESC/)[0][1]).toEqual([POD, VIEWER, 51]);
    mockQuery.mockClear();
    await wall.listPosts(POD, asMember, { limit: 0 });
    expect(calls(/ORDER BY p\.created_at DESC/)[0][1]).toEqual([POD, VIEWER, 2]);
  });

  it.each(['OFFSET 40; DROP TABLE pods', 'abc_def', '123_not-a-uuid', `99999999999999999999_${POST}`])('refuses the cursor %s', async (cursor) => {
    await expect(wall.listPosts(POD, asMember, { cursor })).rejects.toMatchObject({ statusCode: 400, message: 'Bad cursor' });
    expect(calls(/FROM pod_posts p/)).toHaveLength(0);
  });

  it('shows up to three pinned posts, most recently pinned first, on the first page only', async () => {
    world.pinned = [aPost({ pinned_at: new Date('2026-10-26T09:00:00.000Z') })];
    const first = await wall.listPosts(POD, asMember);
    expect(first.pinned).toHaveLength(1);
    expect(first.pinned[0].pinnedAt).toBe('2026-10-26T09:00:00.000Z');
    const pinnedSql = sqlOf(calls(/p\.pinned_at IS NOT NULL/)[0]);
    expect(pinnedSql).toMatch(/ORDER BY p\.pinned_at DESC LIMIT 3$/);
    expect(pinnedSql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    mockQuery.mockClear();
    const later = await wall.listPosts(POD, asMember, { cursor: `${Date.now()}_${POST}` });
    expect(later.pinned).toEqual([]);
    expect(calls(/p\.pinned_at IS NOT NULL/)).toHaveLength(0);
  });

  it('tells the screen what the viewer may do', async () => {
    expect((await wall.listPosts(POD, asMember)).viewer).toEqual({ canPost: true, canModerate: false });
    world.member = { role: 'director', status: 'active' };
    expect((await wall.listPosts(POD, asMember)).viewer).toEqual({ canPost: true, canModerate: true });
    world.member = { role: 'host', status: 'active' };
    expect((await wall.listPosts(POD, asMember)).viewer).toEqual({ canPost: true, canModerate: true });
  });

  it('draws a post by a closed account as "Former member", with no picture, and says it is closed', async () => {
    world.feed = [aPost({ author_closed: true })];
    const [one] = (await wall.listPosts(POD, asMember)).posts;
    expect(one).toMatchObject({ authorName: 'Former member', authorAvatarUrl: null, authorClosed: true, authorId: AUTHOR });
  });

  it('counts the reactions on each post and says which one is the viewer\'s', async () => {
    world.feed = [aPost({ reaction_count: 3, reactions: { love: 2, like: 1 }, my_reaction: 'love', comment_count: 4 })];
    const [one] = (await wall.listPosts(POD, asMember)).posts;
    expect(one).toMatchObject({ reactionCount: 3, reactions: { love: 2, like: 1 }, myReaction: 'love', commentCount: 4 });
  });
});

describe('getPost', () => {
  it('belongs to this pod and is not deleted: a post of another pod cannot be reached through this one', async () => {
    await wall.getPost(POD, POST, asMember);
    const sql = sqlOf(calls(/FROM pod_posts p JOIN users u/)[0]);
    expect(sql).toMatch(/WHERE p\.id = \$1 AND p\.pod_id = \$3 AND p\.deleted_at IS NULL/);
    expect(calls(/FROM pod_posts p JOIN users u/)[0][1]).toEqual([POST, VIEWER, POD]);
  });

  it('hides a post whose author is blocked either way (the same block filter as the feed)', async () => {
    await wall.getPost(POD, POST, asMember);
    const sql = sqlOf(calls(/FROM pod_posts p JOIN users u/)[0]);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    expect(sql).toMatch(/b\.blocker_id = p\.author_id AND b\.blocked_id = \$2/);
  });

  it('is a 404 when the post is gone, in another pod, or hidden by a block', async () => {
    world.postRow = null;
    await expect(wall.getPost(POD, POST, asMember)).rejects.toMatchObject({ statusCode: 404, message: 'That post could not be found' });
  });
});

// ─── Deleting and pinning ────────────────────────────────────────────────────

describe('deletePost', () => {
  it('lets an author delete their own post: a soft delete that says who did it', async () => {
    world.lockedPost = { author_id: VIEWER, deleted_at: null };
    await expect(wall.deletePost(POD, POST, asMember)).resolves.toBeUndefined();
    expect(calls(/FOR UPDATE/)[0][1]).toEqual([POST, POD]);
    expect(calls(/UPDATE pod_posts SET deleted_at/)[0][1]).toEqual([POST, VIEWER]);
    expect(calls(/DELETE FROM pod_posts/i)).toHaveLength(0);
    expect(mockTxSql.filter((q) => /FOR UPDATE|^UPDATE pod_posts SET deleted_at/.test(q))).toHaveLength(2);
  });

  it('refuses another member: only your own posts', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    await expect(wall.deletePost(POD, POST, asMember)).rejects.toMatchObject({ statusCode: 403, message: 'You can only delete your own posts' });
    expect(calls(/UPDATE pod_posts SET deleted_at/)).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it.each(['director', 'host'])('lets the pod\'s %s delete anyone\'s post', async (role) => {
    world.member = { role, status: 'active' };
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    await expect(wall.deletePost(POD, POST, asMember)).resolves.toBeUndefined();
    expect(calls(/UPDATE pod_posts SET deleted_at/)[0][1]).toEqual([POST, VIEWER]);
  });

  it('is a 404 for a post that is gone, already deleted, or in another pod', async () => {
    world.lockedPost = null;
    await expect(wall.deletePost(POD, POST, asMember)).rejects.toMatchObject({ statusCode: 404 });
    world.lockedPost = { author_id: VIEWER, deleted_at: new Date() };
    await expect(wall.deletePost(POD, POST, asMember)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('tells the pod the feed and the post\'s thread are gone', async () => {
    await wall.deletePost(POD, POST, asMember);
    expect(mockFanout).toHaveBeenCalledWith(POD, [E.podWallPost(POST)]);
  });
});

describe('setPinned', () => {
  it.each(['director', 'host'])('lets the pod\'s %s pin and unpin', async (role) => {
    world.member = { role, status: 'active' };
    await wall.setPinned(POD, POST, asMember, true);
    await wall.setPinned(POD, POST, asMember, false);
    expect(calls(/UPDATE pod_posts SET pinned_at/).map((c) => c[1])).toEqual([[POST, POD, true], [POST, POD, false]]);
  });

  it('refuses an ordinary member: 403, nothing changed', async () => {
    await expect(wall.setPinned(POD, POST, asMember, true)).rejects.toMatchObject({ statusCode: 403 });
    expect(writes()).toHaveLength(0);
  });

  it('is a 404 for a post that is gone or in another pod (nothing was updated)', async () => {
    world.member = { role: 'director', status: 'active' };
    world.pinnedRows = 0;
    await expect(wall.setPinned(POD, POST, asMember, true)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('only touches a live post of this pod', async () => {
    world.member = { role: 'director', status: 'active' };
    await wall.setPinned(POD, POST, asMember, true);
    expect(sqlOf(calls(/UPDATE pod_posts SET pinned_at/)[0])).toMatch(/WHERE id = \$1 AND pod_id = \$2 AND deleted_at IS NULL$/);
  });

  it('tells the pod the feed and the post changed', async () => {
    world.member = { role: 'director', status: 'active' };
    await wall.setPinned(POD, POST, asMember, true);
    expect(mockFanout).toHaveBeenCalledWith(POD, [E.podWallPost(POST)]);
  });
});

// ─── Reactions ───────────────────────────────────────────────────────────────

describe('reactToPost', () => {
  it('sets the member\'s one reaction (a change replaces it) and answers the counts', async () => {
    const summary = await wall.reactToPost(POD, POST, asMember, 'love');
    const [upsert] = calls(/INSERT INTO pod_post_reactions/);
    expect(sqlOf(upsert)).toMatch(/ON CONFLICT \(post_id, user_id\) DO UPDATE SET reaction = EXCLUDED\.reaction/);
    expect(upsert[1]).toEqual([POST, VIEWER, 'love']);
    expect(summary).toEqual({ reactionCount: 3, reactions: { love: 2, like: 1 }, myReaction: 'love' });
  });

  it('clears it with null', async () => {
    world.reactionRows = [{ reaction: 'like', n: 1, mine: false }];
    const summary = await wall.reactToPost(POD, POST, asMember, null);
    expect(calls(/DELETE FROM pod_post_reactions/)[0][1]).toEqual([POST, VIEWER]);
    expect(summary).toEqual({ reactionCount: 1, reactions: { like: 1 }, myReaction: null });
  });

  it('refuses a reaction that is not one of the five kinds, before it asks the database anything', async () => {
    await expect(wall.reactToPost(POD, POST, asMember, 'sad' as never)).rejects.toMatchObject({ statusCode: 400, message: 'Unknown reaction' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('only reacts to a live post of this pod that the viewer can see (a block hides it)', async () => {
    await wall.reactToPost(POD, POST, asMember, 'like');
    const head = sqlOf(calls(/SELECT p\.author_id, p\.content FROM pod_posts p/)[0]);
    expect(head).toMatch(/WHERE p\.id = \$1 AND p\.pod_id = \$3 AND p\.deleted_at IS NULL/);
    expect(head).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    world.postHead = null;
    await expect(wall.reactToPost(POD, POST, asMember, 'like')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('tells the pod the feed\'s counts and the thread changed', async () => {
    await wall.reactToPost(POD, POST, asMember, 'like');
    expect(mockFanout).toHaveBeenCalledWith(POD, [E.podWallPost(POST)]);
  });

  describe('the author\'s bell', () => {
    it('rings the post author once an hour per post, with the post as the link', async () => {
      await wall.reactToPost(POD, POST, asMember, 'love');
      const [bell] = calls(/INSERT INTO notifications/);
      expect(bell[1]).toEqual([AUTHOR, POD, 'pod_reaction', 'Vera Viewer reacted to your post', 'hello pod', `/pods/${POD}?post=${POST}`, VIEWER, 60]);
      expect(sqlOf(bell)).toMatch(/n\.type = \$3::text AND n\.link = \$6::text AND n\.created_at > NOW\(\) - make_interval\(mins => \$8::int\)/);
    });

    it('is not sent for a reaction to your own post, or when a reaction is cleared', async () => {
      world.postHead = { author_id: VIEWER, content: 'mine' };
      await wall.reactToPost(POD, POST, asMember, 'love');
      await wall.reactToPost(POD, POST, asMember, null);
      expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
    });
  });
});

// ─── Comments ────────────────────────────────────────────────────────────────

describe('addComment', () => {
  const comment = (input: { content: string; parentCommentId?: string | null }) => wall.addComment(POD, POST, asMember, input);

  it('stores the trimmed comment and moves the post\'s count in the SAME transaction, and answers its id', async () => {
    const made = await comment({ content: '  Welcome!  ' });
    expect(calls(/INSERT INTO pod_post_comments/)[0][1]).toEqual([POST, VIEWER, 'Welcome!', null]);
    expect(calls(/UPDATE pod_posts SET comment_count = comment_count \+ 1/)[0][1]).toEqual([POST]);
    expect(mockTxSql.filter((q) => /^(INSERT INTO pod_post_comments|UPDATE pod_posts SET comment_count)/.test(q))).toHaveLength(2);
    expect(made).toEqual({ id: COMMENT, createdAt: '2026-10-26T10:05:00.000Z', parentCommentId: null });
  });

  it('refuses an empty comment, and one over 4000 characters', async () => {
    await expect(comment({ content: '   ' })).rejects.toMatchObject({ statusCode: 400, message: 'Comment cannot be empty' });
    await expect(comment({ content: 'z'.repeat(4001) })).rejects.toMatchObject({ statusCode: 400, message: 'Comment too long (max 4000 characters)' });
    expect(writes()).toHaveLength(0);
  });

  it(`stops a member commenting more than ${COMMENT_RATE_PER_MIN} times in a minute: 429, nothing written`, async () => {
    world.recentComments = COMMENT_RATE_PER_MIN;
    await expect(comment({ content: 'hi' })).rejects.toMatchObject({ statusCode: 429 });
    expect(writes()).toHaveLength(0);
  });

  it('is a 404 when the post is gone, in another pod, or hidden by a block', async () => {
    world.postHead = null;
    await expect(comment({ content: 'hi' })).rejects.toMatchObject({ statusCode: 404 });
    expect(writes()).toHaveLength(0);
  });

  it('tells the pod the feed\'s count and the thread changed', async () => {
    await comment({ content: 'hi' });
    expect(mockFanout).toHaveBeenCalledWith(POD, [E.podWallPost(POST)]);
  });

  describe('a reply', () => {
    beforeEach(() => { world.parent = { id: REPLY_TO, author_id: 'commenter-1', parent_comment_id: null }; });

    it('hangs under the comment it answers', async () => {
      const made = await comment({ content: 'agreed', parentCommentId: REPLY_TO });
      expect(calls(/INSERT INTO pod_post_comments/)[0][1]).toEqual([POST, VIEWER, 'agreed', REPLY_TO]);
      expect(made.parentCommentId).toBe(REPLY_TO);
    });

    it('to a reply hangs under the top-level comment (one level deep), but rings the person actually answered', async () => {
      world.parent = { id: REPLY_TO, author_id: 'commenter-2', parent_comment_id: 'top-level-id' };
      const made = await comment({ content: 'agreed', parentCommentId: REPLY_TO });
      expect(made.parentCommentId).toBe('top-level-id');
      expect(calls(/INSERT INTO notifications/)[0][1][0]).toBe('commenter-2');
    });

    it('must answer a live comment of this post that the viewer can see: otherwise 404', async () => {
      world.parent = null;
      await expect(comment({ content: 'agreed', parentCommentId: REPLY_TO })).rejects.toMatchObject({ statusCode: 404 });
      const sql = sqlOf(calls(/FROM pod_post_comments c WHERE c\.id = \$1 AND c\.post_id = \$2/)[0]);
      expect(sql).toMatch(/c\.deleted_at IS NULL/);
      expect(sql).toMatch(/b\.blocker_id = \$3 AND b\.blocked_id = c\.author_id/);
      expect(sql).toMatch(/b\.blocker_id = c\.author_id AND b\.blocked_id = \$3/);
      expect(writes()).toHaveLength(0);
    });

    it('rings the commenter as a reply, and the post author as a comment, each once', async () => {
      await comment({ content: 'agreed', parentCommentId: REPLY_TO });
      const bells = calls(/INSERT INTO notifications/).map((c) => c[1]);
      expect(bells).toEqual([
        ['commenter-1', POD, 'pod_reply', 'Vera Viewer replied to your comment', 'agreed', `/pods/${POD}?post=${POST}`, VIEWER, 15],
        [AUTHOR, POD, 'pod_comment', 'Vera Viewer commented on your post', 'agreed', `/pods/${POD}?post=${POST}`, VIEWER, 15],
      ]);
    });

    it('rings the post author once when they are the one answered (a reply, not also a comment)', async () => {
      world.parent = { id: REPLY_TO, author_id: AUTHOR, parent_comment_id: null };
      await comment({ content: 'agreed', parentCommentId: REPLY_TO });
      expect(calls(/INSERT INTO notifications/).map((c) => (c[1] as unknown[])[2])).toEqual(['pod_reply']);
    });
  });

  describe('the bells', () => {
    it('ring the post author for a comment, once every 15 minutes per post', async () => {
      await comment({ content: 'Welcome!' });
      const [bell] = calls(/INSERT INTO notifications/);
      expect(bell[1]).toEqual([AUTHOR, POD, 'pod_comment', 'Vera Viewer commented on your post', 'Welcome!', `/pods/${POD}?post=${POST}`, VIEWER, 15]);
      expect(sqlOf(bell)).toMatch(/n\.created_at > NOW\(\) - make_interval\(mins => \$8::int\)/);
    });

    it('do not ring you for your own post or your own comment', async () => {
      world.postHead = { author_id: VIEWER, content: 'mine' };
      await comment({ content: 'talking to myself' });
      world.parent = { id: REPLY_TO, author_id: VIEWER, parent_comment_id: null };
      await comment({ content: 'still me', parentCommentId: REPLY_TO });
      expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
    });

    it.each(['pod_post', 'pod_comment', 'pod_reply', 'pod_reaction'])('the %s bell goes to nobody who has switched group bells off, left the pod, is closed or is blocked either way', async (type) => {
      if (type === 'pod_post') {
        await wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'x' });
      } else if (type === 'pod_reaction') {
        await wall.reactToPost(POD, POST, asMember, 'like');
      } else {
        world.parent = { id: REPLY_TO, author_id: 'commenter-1', parent_comment_id: null };
        await comment(type === 'pod_reply' ? { content: 'x', parentCommentId: REPLY_TO } : { content: 'x' });
      }
      const sql = sqlOf(calls(/INSERT INTO notifications/).find((c) => (type === 'pod_post' ? true : (c[1] as unknown[])[2] === type))!);
      expect(sql).toContain("COALESCE((u.notification_prefs->>'group_bell')::boolean, true)");
      expect(sql).toMatch(/u\.status = 'active'/);
      expect(sql).toMatch(/pm\.status = 'active'/);
      expect(sql).toMatch(/user_blocks b/);
      expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM notifications n/);
    });

    it('are pushed live like a post\'s: notification:new on the recipient\'s room and their own bell tag', async () => {
      world.bellRows = [{ id: 'n-9', user_id: AUTHOR, created_at: new Date('2026-10-26T10:06:00.000Z') }];
      await comment({ content: 'Welcome!' });
      expect(mockPush).toHaveBeenCalledWith(`user:${AUTHOR}`, 'notification:new', {
        id: 'n-9', type: 'pod_comment', title: 'Vera Viewer commented on your post', body: 'Welcome!',
        link: `/pods/${POD}?post=${POST}`, isRead: false, createdAt: new Date('2026-10-26T10:06:00.000Z'),
      });
      expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, [AUTHOR], [E.userNotifications(AUTHOR)]);
    });

    it('fall back to "A member" when the commenter has no name', async () => {
      world.viewerName = null;
      await comment({ content: 'Welcome!' });
      expect(calls(/INSERT INTO notifications/)[0][1][3]).toBe('A member commented on your post');
    });
  });
});

describe('listComments', () => {
  it('serves a post\'s comments oldest first, bounded, with likes, and drops authors blocked either way', async () => {
    world.comments = [{
      id: COMMENT, author_id: AUTHOR, display_name: 'Ada Author', avatar_url: null, author_closed: false,
      content: 'first', created_at: new Date('2026-10-26T10:05:00.000Z'), parent_comment_id: null, like_count: 2, liked_by_me: true,
    }];
    const list = await wall.listComments(POD, POST, asMember);
    const sql = sqlOf(calls(/FROM pod_post_comments c JOIN users u/)[0]);
    expect(sql).toMatch(/WHERE c\.post_id = \$1 AND c\.deleted_at IS NULL/);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = c\.author_id/);
    expect(sql).toMatch(/b\.blocker_id = c\.author_id AND b\.blocked_id = \$2/);
    expect(sql).toMatch(/ORDER BY c\.created_at ASC, c\.id ASC LIMIT 400$/);
    expect(list).toEqual([{
      id: COMMENT, authorId: AUTHOR, authorName: 'Ada Author', authorAvatarUrl: null, authorClosed: false,
      content: 'first', createdAt: '2026-10-26T10:05:00.000Z', parentCommentId: null, likeCount: 2, likedByMe: true,
    }]);
  });

  it('hides the replies of a comment that was deleted', async () => {
    await wall.listComments(POD, POST, asMember);
    expect(sqlOf(calls(/FROM pod_post_comments c JOIN users u/)[0])).toMatch(
      /\(c\.parent_comment_id IS NULL OR EXISTS \(SELECT 1 FROM pod_post_comments pc WHERE pc\.id = c\.parent_comment_id AND pc\.deleted_at IS NULL\)\)/,
    );
  });

  it('is a 404 for a post that is gone, in another pod or hidden by a block, and reads no comments then', async () => {
    world.postHead = null;
    await expect(wall.listComments(POD, POST, asMember)).rejects.toMatchObject({ statusCode: 404 });
    expect(calls(/FROM pod_post_comments c JOIN users u/)).toHaveLength(0);
  });

  it('draws a closed account\'s comment as "Former member"', async () => {
    world.comments = [{
      id: COMMENT, author_id: AUTHOR, display_name: 'Ada Author', avatar_url: 'x', author_closed: true,
      content: 'first', created_at: new Date('2026-10-26T10:05:00.000Z'), parent_comment_id: null, like_count: 0, liked_by_me: false,
    }];
    const [one] = await wall.listComments(POD, POST, asMember);
    expect(one).toMatchObject({ authorName: 'Former member', authorAvatarUrl: null, authorClosed: true });
  });
});

describe('likeComment', () => {
  it('likes once (a second like changes nothing) and answers the count', async () => {
    const out = await wall.likeComment(POD, COMMENT, asMember, true);
    const [like] = calls(/INSERT INTO pod_comment_likes/);
    expect(sqlOf(like)).toMatch(/ON CONFLICT DO NOTHING$/);
    expect(like[1]).toEqual([COMMENT, VIEWER]);
    expect(out).toEqual({ likeCount: 1, likedByMe: true });
  });

  it('unlikes', async () => {
    world.likeCount = 0;
    world.likedByMe = false;
    const out = await wall.likeComment(POD, COMMENT, asMember, false);
    expect(calls(/DELETE FROM pod_comment_likes/)[0][1]).toEqual([COMMENT, VIEWER]);
    expect(out).toEqual({ likeCount: 0, likedByMe: false });
  });

  it('rings nobody: a like on a comment is a nod, not news', async () => {
    await wall.likeComment(POD, COMMENT, asMember, true);
    expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
  });

  it('only reaches a live comment of a live post of THIS pod whose authors the viewer has not blocked', async () => {
    await wall.likeComment(POD, COMMENT, asMember, true);
    const sql = sqlOf(calls(/SELECT c\.post_id FROM pod_post_comments c/)[0]);
    expect(sql).toMatch(/c\.id = \$1 AND p\.pod_id = \$3 AND c\.deleted_at IS NULL AND p\.deleted_at IS NULL/);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = c\.author_id/);
    world.likeTarget = null;
    await expect(wall.likeComment(POD, COMMENT, asMember, true)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('tells the pod about the thread ONLY: a like does not change the feed, so no member refetches theirs', async () => {
    await wall.likeComment(POD, COMMENT, asMember, true);
    expect(mockFanout).toHaveBeenCalledWith(POD, [E.podWallPost(POST)], { wall: false });
  });
});

describe('deleteComment', () => {
  it('lets the author delete their own comment, and its replies go with it, and the post\'s count drops by all of them', async () => {
    world.commentsRemoved = 3;
    const out = await wall.deleteComment(POD, COMMENT, asMember);
    const [soft] = calls(/UPDATE pod_post_comments SET deleted_at/);
    expect(sqlOf(soft)).toMatch(/WHERE \(id = \$1 OR parent_comment_id = \$1\) AND deleted_at IS NULL RETURNING id$/);
    expect(calls(/UPDATE pod_posts SET comment_count = GREATEST/)[0][1]).toEqual([POST, 3]);
    expect(calls(/DELETE FROM pod_post_comments/i)).toHaveLength(0);
    expect(mockTxSql.filter((q) => /FOR UPDATE|^UPDATE pod_post_comments SET deleted_at|^UPDATE pod_posts SET comment_count/.test(q))).toHaveLength(3);
    expect(out).toEqual({ postId: POST });
  });

  it('locks the comment inside its transaction, and only for a post of this pod', async () => {
    await wall.deleteComment(POD, COMMENT, asMember);
    const [lock] = calls(/FOR UPDATE/);
    expect(lock[1]).toEqual([COMMENT, POD]);
  });

  it('refuses another member: only your own comments', async () => {
    world.lockedComment = { author_id: AUTHOR, post_id: POST, deleted_at: null };
    await expect(wall.deleteComment(POD, COMMENT, asMember)).rejects.toMatchObject({ statusCode: 403, message: 'You can only delete your own comments' });
    expect(writes()).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it.each(['director', 'host'])('lets the pod\'s %s delete anyone\'s comment', async (role) => {
    world.member = { role, status: 'active' };
    world.lockedComment = { author_id: AUTHOR, post_id: POST, deleted_at: null };
    await expect(wall.deleteComment(POD, COMMENT, asMember)).resolves.toEqual({ postId: POST });
  });

  it('is a 404 for a comment that is gone, already deleted, or in another pod', async () => {
    world.lockedComment = null;
    await expect(wall.deleteComment(POD, COMMENT, asMember)).rejects.toMatchObject({ statusCode: 404 });
    world.lockedComment = { author_id: VIEWER, post_id: POST, deleted_at: new Date() };
    await expect(wall.deleteComment(POD, COMMENT, asMember)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('tells the pod the feed\'s count and the thread changed', async () => {
    await wall.deleteComment(POD, COMMENT, asMember);
    expect(mockFanout).toHaveBeenCalledWith(POD, [E.podWallPost(POST)]);
  });
});

// ─── The wall is its own: it shares the circle wall's rules, not its rows ────

describe('the pod wall touches no circle table', () => {
  it('every statement the service runs names only pod tables, notifications, pods, pod_members, users and user_blocks', async () => {
    world.member = { role: 'director', status: 'active' };
    world.parent = { id: REPLY_TO, author_id: 'commenter-1', parent_comment_id: null };
    await wall.listPosts(POD, asMember);
    await wall.getPost(POD, POST, asMember);
    await wall.createPost(POD, asMember, { clientId: CLIENT_ID, content: 'hi' });
    await wall.setPinned(POD, POST, asMember, true);
    await wall.reactToPost(POD, POST, asMember, 'like');
    await wall.addComment(POD, POST, asMember, { content: 'hi', parentCommentId: REPLY_TO });
    await wall.listComments(POD, POST, asMember);
    await wall.likeComment(POD, COMMENT, asMember, true);
    await wall.deleteComment(POD, COMMENT, asMember);
    await wall.deletePost(POD, POST, asMember);
    for (const call of mockQuery.mock.calls) expect(sqlOf(call)).not.toMatch(/\bcircle[s_]/i);
  });
});
