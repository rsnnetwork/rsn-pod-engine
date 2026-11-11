// ─── Circle Wall (REASON v1 Phase 4, 20 Jul 2026; Shirley pilot S4, 11 Nov 2026) ─────────────────────────────
//
// Pins the UGC rules: members-only posting, Cloudinary-only media, SSRF-free link extraction, idempotent post
// creation, transactional counters, rate limits, block filtering at read, keyset (never OFFSET) pagination, soft
// deletes. S4 brings the circle wall to the pod wall's standard: members-only reads (D2) with no post id confirming
// anything to someone outside, moderation by the circle's owner and moderators (D3) recorded with a snapshot, at most
// three pins, authors' edits, D8 (someone no longer in the circle deletes their own words), entity tags on every write
// and bells that honour blocks, membership, open accounts and the group-bell setting.
//
// The database is a fake that answers by WHAT the SQL asks for and refuses any statement the test did not expect, so a
// new query cannot slip in unseen. The same statements ran against a real Postgres (PGlite) for the task report.

const mockQuery = jest.fn();
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
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockFanout = jest.fn();
const mockFanoutShares = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  fanoutCircleWall: (...args: unknown[]) => mockFanout(...args),
  fanoutCircleWallShares: (...args: unknown[]) => mockFanoutShares(...args),
  __esModule: true,
}));
const mockPush = jest.fn();
const mockIo = { to: (room: string) => ({ emit: (event: string, payload: unknown) => mockPush(room, event, payload) }) };
const mockEmitEntities = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import {
  validateMedia, extractLinkUrl, createPost, listPosts, deletePost, pinPost, editPost, editComment, addComment,
  reactToPost, likeComment, deleteComment, sharePost, getPost, listComments,
  MEDIA_HOST_PREFIX, POST_RATE_PER_MIN, COMMENT_RATE_PER_MIN, CIRCLE_CLOSED_READ, CIRCLE_WALL_MEMBERS_ONLY,
} from '../../../services/circle/circle-wall.service';
import { E } from '../../../realtime/entities';

const C1 = 'c1c1c1c1-1111-4111-8111-111111111111';
const C2 = 'c2c2c2c2-2222-4222-8222-222222222222';
const POST = '9d2e4b61-7c3a-4d58-b1f0-6e5a4c3b2d10';
const COMMENT = '0b6f6a52-2d1c-4a8e-9f3b-7e1d5c4a3b21';
const CLIENT_ID = '5b3f7d1e-0000-4000-8000-000000000001';
const VIEWER = 'viewer-1';
const AUTHOR = 'author-1';
const CREATED_AT = new Date('2026-11-11T10:00:00.000Z');
const EDITED_AT = new Date('2026-11-11T11:00:00.000Z');

type Role = 'owner' | 'moderator' | 'member' | null;
interface CircleState { name: string; archived: boolean; join_policy: 'open' | 'closed'; role: Role }
interface LockedPost { author_id: string; circle_id?: string; content?: string; media?: unknown[]; deleted_at: Date | null; pinned_at?: Date | null; edited_at?: Date | null; shared_from_post_id?: string | null }
interface LockedComment { author_id: string; post_id?: string; circle_id?: string; content?: string; deleted_at: Date | null; post_deleted_at?: Date | null; edited_at?: Date | null; withdrawn_at?: Date | null; has_replies?: boolean }

interface World {
  circles: Record<string, CircleState>;
  viewerName: string | null;
  recentPosts: number;
  recentComments: number;
  priorPost: { id: string; circle_id: string; deleted_at: Date | null } | null;
  insertedPostId: string | null;
  head: { circle_id: string; author_id: string; content: string; deleted_at: Date | null; blocked: boolean } | null;
  postRow: Record<string, unknown> | null;
  feed: Record<string, unknown>[];
  pinned: Record<string, unknown>[];
  bellRows: Array<{ id: string; user_id: string; created_at: Date }>;
  parent: { id: string; author_id: string; parent_comment_id: string | null } | null;
  comments: Record<string, unknown>[];
  lockedPost: LockedPost | null;
  lockedComment: LockedComment | null;
  commentsRemoved: number;
  pinnedCount: number;
  reactionChanged: boolean;
  reactionCleared: boolean;
  likeTarget: { circle_id: string; post_id: string } | null;
  likeChanged: boolean;
  shareSource: { id: string; shared_from_post_id: string | null } | null;
  shareRoot: { id: string; circle_id: string; blocked?: boolean } | null;
  /** S4 fix round 1: who had bells about a removed post or comment (deleted with it). */
  purgedBells: Array<{ user_id: string }>;
}
let world: World;

const aPost = (over: Record<string, unknown> = {}) => ({
  id: POST, circle_id: C1, author_id: AUTHOR, display_name: 'Ada Author', avatar_url: null, author_former: false,
  content: 'hello circle', media: [], link_url: null, comment_count: 0, pinned_at: null, created_at: CREATED_AT,
  edited_at: null, reaction_count: 0, reactions: {}, my_reaction: null, shared_from: null, ...over,
});

const norm = (sql: unknown) => String(sql).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
const sqlOf = (call: unknown[]) => norm(call[0]);
const calls = (re: RegExp) => mockQuery.mock.calls.filter((c) => re.test(sqlOf(c)));
const paramsOf = (re: RegExp) => calls(re)[0]?.[1] as unknown[] | undefined;
const writes = () => mockQuery.mock.calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/i.test(sqlOf(c)));
const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });

function answer(sql: string, params: unknown[] = []): unknown {
  const text = norm(sql);
  const is = (re: RegExp) => re.test(text);
  const circleOf = (id: unknown) => world.circles[String(id)];

  if (is(/^SELECT c\.name, \(c\.archived_at IS NOT NULL\) AS archived, c\.join_policy, m\.role AS member_role/)) {
    const c = circleOf(params[0]);
    return rows(c ? [{ name: c.name, archived: c.archived, join_policy: c.join_policy, member_role: c.role, viewer_name: world.viewerName }] : []);
  }
  if (is(/^SELECT role FROM circle_members WHERE circle_id = \$1 AND user_id = \$2$/)) {
    const c = circleOf(params[0]);
    return rows(c?.role ? [{ role: c.role }] : []);
  }
  if (is(/^SELECT p\.circle_id, p\.author_id, p\.content, p\.deleted_at, EXISTS/)) return rows(world.head ? [world.head] : []);
  if (is(/count\(\*\)::text AS c FROM circle_posts WHERE author_id = \$1/)) return rows([{ c: String(world.recentPosts) }]);
  if (is(/count\(\*\)::text AS c FROM circle_post_comments WHERE author_id = \$1/)) return rows([{ c: String(world.recentComments) }]);
  if (is(/^SELECT id, circle_id, deleted_at FROM circle_posts WHERE author_id = \$1 AND client_id = \$2$/)) return rows(world.priorPost ? [world.priorPost] : []);
  if (is(/^INSERT INTO circle_posts \(/)) return rows(world.insertedPostId ? [{ id: world.insertedPostId }] : []);
  if (is(/^UPDATE circles SET post_count = post_count \+ 1 WHERE id = \$1$/)) return rows([]);
  if (is(/^INSERT INTO notifications/)) return rows(world.bellRows);
  if (is(/FROM circle_posts p JOIN users u ON u\.id = p\.author_id/)) {
    if (is(/p\.pinned_at IS NOT NULL/)) return rows(world.pinned);
    if (is(/WHERE p\.id = \$1/)) return rows(world.postRow ? [world.postRow] : []);
    return rows(world.feed);
  }
  if (is(/^SELECT author_id, circle_id, content, media, created_at, edited_at, deleted_at, pinned_at FROM circle_posts WHERE id = \$1 FOR UPDATE$/)) {
    return rows(world.lockedPost ? [{ circle_id: C1, content: 'hello circle', media: [], created_at: CREATED_AT, edited_at: null, pinned_at: null, ...world.lockedPost }] : []);
  }
  if (is(/^SELECT p\.author_id, p\.circle_id, p\.content, p\.media, p\.shared_from_post_id, p\.edited_at, p\.deleted_at/)) {
    const lp = world.lockedPost;
    const c = lp ? circleOf(lp.circle_id ?? C1) : undefined;
    return rows(lp ? [{
      circle_id: C1, content: 'hello circle', media: [], shared_from_post_id: null, edited_at: null, ...lp,
      archived: !!c?.archived, is_member: !!c?.role,
    }] : []);
  }
  if (is(/^UPDATE circle_posts SET deleted_at = NOW\(\), deleted_by = \$2 WHERE id = \$1$/)) return rows([]);
  if (is(/^UPDATE circles SET post_count = GREATEST\(post_count - 1, 0\) WHERE id = \$1$/)) return rows([]);
  if (is(/^INSERT INTO audit_log \(actor_id, action, entity_type, entity_id, details\) VALUES \(\$1, \$2, \$3, \$4, \$5\)$/)) return rows([]);
  if (is(/^SELECT id FROM circles WHERE id = \$1 FOR NO KEY UPDATE$/)) return rows([{ id: params[0] }]);
  if (is(/^SELECT count\(\*\)::int AS n FROM circle_posts WHERE circle_id = \$1 AND deleted_at IS NULL AND pinned_at IS NOT NULL$/)) return rows([{ n: world.pinnedCount }]);
  if (is(/^UPDATE circle_posts SET pinned_at = CASE WHEN \$2::boolean THEN NOW\(\) ELSE NULL END WHERE id = \$1$/)) return rows([]);
  if (is(/^UPDATE circle_posts SET content = \$2, link_url = \$3, edited_at = NOW\(\) WHERE id = \$1 RETURNING edited_at$/)) return rows([{ edited_at: EDITED_AT }]);
  if (is(/^SELECT join_policy FROM circles WHERE id = \$1$/)) {
    const c = circleOf(params[0]);
    return rows(c ? [{ join_policy: c.join_policy }] : []);
  }
  if (is(/^SELECT p\.id, p\.shared_from_post_id FROM circle_posts p WHERE p\.id = \$1 AND p\.deleted_at IS NULL/)) return rows(world.shareSource ? [world.shareSource] : []);
  if (is(/^SELECT o\.id, o\.circle_id, EXISTS \(SELECT 1 FROM user_blocks b/)) return rows(world.shareRoot ? [{ blocked: false, ...world.shareRoot }] : []);
  if (is(/^DELETE FROM notifications WHERE type IN \(/)) return rows(world.purgedBells);
  if (is(/^INSERT INTO circle_post_reactions/)) return rows(world.reactionChanged ? [{ post_id: POST }] : []);
  if (is(/^DELETE FROM circle_post_reactions/)) return rows(world.reactionCleared ? [{ post_id: POST }] : []);
  if (is(/FROM circle_post_reactions WHERE post_id = \$1 GROUP BY reaction/)) {
    return rows([{ reaction: 'love', n: 2, mine: true }, { reaction: 'like', n: 1, mine: false }]);
  }
  if (is(/^SELECT c\.id, c\.author_id, c\.parent_comment_id FROM circle_post_comments c WHERE c\.id = \$1 AND c\.post_id = \$2/)) return rows(world.parent ? [world.parent] : []);
  if (is(/^INSERT INTO circle_post_comments/)) return rows([{ id: COMMENT, created_at: CREATED_AT }]);
  if (is(/^UPDATE circle_posts SET comment_count = comment_count \+ 1 WHERE id = \$1$/)) return rows([]);
  if (is(/FROM circle_post_comments c JOIN users u ON u\.id = c\.author_id/)) return rows(world.comments);
  if (is(/^SELECT p\.circle_id, c\.post_id FROM circle_post_comments c JOIN circle_posts p/)) return rows(world.likeTarget ? [world.likeTarget] : []);
  if (is(/^INSERT INTO circle_comment_likes/)) return rows(world.likeChanged ? [{ comment_id: COMMENT }] : []);
  if (is(/^DELETE FROM circle_comment_likes/)) return rows(world.likeChanged ? [{ comment_id: COMMENT }] : []);
  if (is(/count\(\*\)::int AS like_count, bool_or\(user_id = \$2\) AS liked_by_me FROM circle_comment_likes/)) return rows([{ like_count: 1, liked_by_me: true }]);
  if (is(/^SELECT c\.author_id, c\.post_id, p\.circle_id, c\.content, c\.edited_at, c\.deleted_at, c\.withdrawn_at, p\.deleted_at AS post_deleted_at/)) {
    const lc = world.lockedComment;
    const c = lc ? circleOf(lc.circle_id ?? C1) : undefined;
    return rows(lc ? [{ post_id: POST, circle_id: C1, content: 'first words', edited_at: null, withdrawn_at: null, post_deleted_at: null, ...lc, archived: !!c?.archived, is_member: !!c?.role }] : []);
  }
  if (is(/^UPDATE circle_post_comments SET content = \$2, edited_at = NOW\(\) WHERE id = \$1 RETURNING edited_at$/)) return rows([{ edited_at: EDITED_AT }]);
  if (is(/^SELECT c\.author_id, c\.post_id, p\.circle_id, c\.content, c\.created_at, c\.edited_at, c\.deleted_at, c\.withdrawn_at, EXISTS/)) {
    return rows(world.lockedComment ? [{ post_id: POST, circle_id: C1, content: 'first words', created_at: CREATED_AT, edited_at: null, withdrawn_at: null, has_replies: false, ...world.lockedComment }] : []);
  }
  if (is(/^UPDATE circle_post_comments SET deleted_at = NOW\(\), deleted_by = \$2/)) {
    return rows(Array.from({ length: world.commentsRemoved }, (_, i) => ({ id: `gone-${i}`, withdrawn_at: null })));
  }
  if (is(/^UPDATE circle_post_comments SET content = '', withdrawn_at = NOW\(\), deleted_by = \$2 WHERE id = \$1$/)) return rows([]);
  if (is(/^UPDATE circle_posts SET comment_count = GREATEST\(comment_count - 1, 0\) WHERE id = \$1$/)) return rows([]);
  if (is(/^UPDATE circle_posts SET comment_count = GREATEST\(comment_count - \$2, 0\) WHERE id = \$1$/)) return rows([]);
  throw new Error(`Unexpected SQL in the circle wall test: ${text.slice(0, 240)}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTxSql.length = 0;
  world = {
    circles: {
      [C1]: { name: 'Curious Humans', archived: false, join_policy: 'open', role: 'member' },
      [C2]: { name: 'Second circle', archived: false, join_policy: 'open', role: 'member' },
    },
    viewerName: 'Vera Viewer',
    recentPosts: 0,
    recentComments: 0,
    priorPost: null,
    insertedPostId: POST,
    head: { circle_id: C1, author_id: AUTHOR, content: 'hello circle', deleted_at: null, blocked: false },
    postRow: aPost(),
    feed: [],
    pinned: [],
    bellRows: [{ id: 'n-1', user_id: 'member-1', created_at: CREATED_AT }],
    parent: null,
    comments: [],
    lockedPost: { author_id: VIEWER, deleted_at: null },
    lockedComment: { author_id: VIEWER, deleted_at: null },
    commentsRemoved: 1,
    pinnedCount: 0,
    reactionChanged: true,
    reactionCleared: true,
    likeTarget: { circle_id: C1, post_id: POST },
    likeChanged: true,
    shareSource: { id: POST, shared_from_post_id: null },
    shareRoot: null,
    purgedBells: [],
  };
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => answer(sql, params ?? []));
  mockFanout.mockResolvedValue(undefined);
  mockFanoutShares.mockResolvedValue(undefined);
  mockEmitEntities.mockResolvedValue(undefined);
});

const asRole = (role: Role) => { world.circles[C1].role = role; };
const POST_MISSING = { statusCode: 404, message: 'That post could not be found' };

describe('validateMedia — Cloudinary-only, bounded', () => {
  it('accepts our CDN, rejects everything else', () => {
    expect(validateMedia([{ type: 'image', url: `${MEDIA_HOST_PREFIX}x/img.jpg` }])).toHaveLength(1);
    expect(() => validateMedia([{ type: 'image', url: 'https://evil.example/x.jpg' }])).toThrow();
    expect(() => validateMedia([{ type: 'script', url: `${MEDIA_HOST_PREFIX}x` }])).toThrow();
    expect(() => validateMedia(Array(5).fill({ type: 'image', url: `${MEDIA_HOST_PREFIX}x` }))).toThrow();
  });
});

describe('extractLinkUrl — never fetched, just extracted', () => {
  it('finds the first http(s) URL and ignores non-URLs', () => {
    expect(extractLinkUrl('check https://example.com/a and http://b.co too')).toBe('https://example.com/a');
    expect(extractLinkUrl('no links here')).toBeNull();
    expect(extractLinkUrl('ftp://nope.example')).toBeNull();
  });
});

// ─── D2: members-only reads, and no post id confirms anything to someone outside ─────────────────────────────

describe('D2: every circle wall is read by its members only', () => {
  it('a member reads the feed, and is told what they may do', async () => {
    const feed = await listPosts(C1, VIEWER, {}, 'member');
    expect(feed.viewer).toEqual({ canPost: true, canModerate: false });
  });

  it.each([['owner'], ['moderator']] as const)('the circle\'s %s is shown the moderator controls', async (role) => {
    asRole(role);
    expect((await listPosts(C1, VIEWER, {}, 'member')).viewer).toEqual({ canPost: true, canModerate: true });
  });

  it('someone outside an OPEN circle is told to join, before any post is read', async () => {
    asRole(null);
    await expect(listPosts(C1, VIEWER, {}, 'member')).rejects.toMatchObject({ statusCode: 403, message: CIRCLE_WALL_MEMBERS_ONLY });
    expect(calls(/FROM circle_posts p JOIN users u/)).toHaveLength(0);
  });

  it('someone outside a CLOSED circle is told in its own words', async () => {
    asRole(null);
    world.circles[C1].join_policy = 'closed';
    await expect(listPosts(C1, VIEWER, {}, 'member')).rejects.toMatchObject({ statusCode: 403, code: 'CIRCLE_CLOSED', message: CIRCLE_CLOSED_READ });
  });

  it('a circle that does not exist is a 404', async () => {
    await expect(listPosts('c9c9c9c9-9999-4999-8999-999999999999', VIEWER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a platform admin outside the circle reads and moderates, and does not post', async () => {
    asRole(null);
    expect((await listPosts(C1, VIEWER, {}, 'admin')).viewer).toEqual({ canPost: false, canModerate: true });
    expect((await listPosts(C1, VIEWER, {}, 'super_admin')).viewer).toEqual({ canPost: false, canModerate: true });
  });

  it('an archived circle is read-only: its members read, nobody posts, its moderators still moderate', async () => {
    world.circles[C1].archived = true;
    expect((await listPosts(C1, VIEWER, {}, 'member')).viewer).toEqual({ canPost: false, canModerate: false });
    asRole('owner');
    expect((await listPosts(C1, VIEWER, {}, 'member')).viewer).toEqual({ canPost: false, canModerate: true });
  });

  describe('a post id answers someone outside the circle exactly as a post that does not exist', () => {
    beforeEach(() => asRole(null));
    const postScoped: Array<[string, () => Promise<unknown>]> = [
      ['its comments', () => listComments(POST, VIEWER, 'member')],
      ['a reaction', () => reactToPost(POST, VIEWER, 'love')],
      ['a comment', () => addComment(POST, VIEWER, 'hi')],
      ['a share', () => sharePost(POST, VIEWER, { circleId: C2, clientId: CLIENT_ID })],
    ];

    it.each(postScoped)('%s: the same 404 as a missing post, and nothing written or sent', async (_what, run) => {
      await expect(run()).rejects.toMatchObject(POST_MISSING);
      world.head = null;
      await expect(run()).rejects.toMatchObject(POST_MISSING);
      expect(writes()).toHaveLength(0);
      expect(mockFanout).not.toHaveBeenCalled();
    });

    it('one post (the ?post= link) is null, the same as a missing one', async () => {
      await expect(getPost(POST, VIEWER, 'member')).resolves.toBeNull();
      world.postRow = null;
      await expect(getPost(POST, VIEWER, 'member')).resolves.toBeNull();
    });

    it('a like on a comment is the comment\'s 404', async () => {
      await expect(likeComment(COMMENT, VIEWER, true)).rejects.toMatchObject({ statusCode: 404, message: 'That comment could not be found' });
      expect(writes()).toHaveLength(0);
    });
  });

  it('a post by someone blocked either way reads as missing on every post path', async () => {
    world.head = { circle_id: C1, author_id: AUTHOR, content: 'x', deleted_at: null, blocked: true };
    await expect(listComments(POST, VIEWER)).rejects.toMatchObject(POST_MISSING);
    await expect(reactToPost(POST, VIEWER, 'like')).rejects.toMatchObject(POST_MISSING);
    await expect(addComment(POST, VIEWER, 'hi')).rejects.toMatchObject(POST_MISSING);
    const head = sqlOf(calls(/^SELECT p\.circle_id, p\.author_id, p\.content, p\.deleted_at, EXISTS/)[0]);
    expect(head).toContain('(b.blocker_id = $2 AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $2)');
    expect(writes()).toHaveLength(0);
  });

  it('a removed post tells a member "This post was removed."', async () => {
    world.head = { circle_id: C1, author_id: AUTHOR, content: 'x', deleted_at: new Date(), blocked: false };
    await expect(addComment(POST, VIEWER, 'hi')).rejects.toMatchObject({ statusCode: 404, message: 'This post was removed.' });
  });

  it('the people in it read one post and its comments', async () => {
    await expect(getPost(POST, VIEWER, 'member')).resolves.toMatchObject({ id: POST, editedAt: null });
    await expect(listComments(POST, VIEWER, 'member')).resolves.toEqual({ comments: [], truncated: false });
  });
});

// ─── Posting ─────────────────────────────────────────────────────────────────

describe('createPost', () => {
  const post = (content = 'hello wall') => createPost(C1, VIEWER, { clientId: CLIENT_ID, content });

  it('a member posts: inserted with the circle\'s count in one transaction; the circle\'s members are told', async () => {
    await post();
    expect(mockTxSql.filter((q) => /^INSERT INTO circle_posts|^UPDATE circles SET post_count = post_count \+ 1/.test(q))).toHaveLength(2);
    expect(sqlOf(calls(/^INSERT INTO circle_posts/)[0])).toMatch(/ON CONFLICT \(author_id, client_id\) DO NOTHING RETURNING id$/);
    expect(mockFanout).toHaveBeenCalledWith(C1);
  });

  it('someone outside the circle cannot post (403), nothing written', async () => {
    asRole(null);
    await expect(post()).rejects.toMatchObject({ statusCode: 403 });
    expect(writes()).toHaveLength(0);
  });

  it('an archived circle takes no posts: 409 in words', async () => {
    world.circles[C1].archived = true;
    await expect(post()).rejects.toMatchObject({ statusCode: 409, code: 'CIRCLE_ARCHIVED', message: 'This circle is archived, so its wall is read-only.' });
    expect(writes()).toHaveLength(0);
  });

  it(`rate limit: post ${POST_RATE_PER_MIN} in a minute → 429`, async () => {
    world.recentPosts = POST_RATE_PER_MIN;
    await expect(post()).rejects.toMatchObject({ statusCode: 429 });
    expect(writes()).toHaveLength(0);
  });

  it('an empty post (no text, no media) is refused; over 8000 characters is refused', async () => {
    await expect(post('   ')).rejects.toMatchObject({ statusCode: 400 });
    await expect(post('x'.repeat(8001))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a retried submit answers the first post and rings nobody, tells nobody (it posted nothing)', async () => {
    world.priorPost = { id: POST, circle_id: C1, deleted_at: null };
    await expect(post()).resolves.toMatchObject({ id: POST });
    expect(writes()).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('a retry of a post that was since removed says so', async () => {
    world.priorPost = { id: POST, circle_id: C1, deleted_at: new Date() };
    await expect(post()).rejects.toMatchObject({ statusCode: 404, message: 'This post was removed.' });
  });
});

describe('the bell for a new post', () => {
  const post = () => createPost(C1, VIEWER, { clientId: CLIENT_ID, content: 'Big news' });

  it('is ONE statement: the circle\'s other members with an open account and group bells on', async () => {
    await post();
    expect(calls(/^INSERT INTO notifications/)).toHaveLength(1);
    const sql = sqlOf(calls(/^INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/SELECT gen_random_uuid\(\), m\.user_id, 'circle_post', /);
    expect(sql).toMatch(/FROM circle_members m JOIN users u ON u\.id = m\.user_id WHERE m\.circle_id = \$1 AND m\.user_id <> \$2/);
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain("COALESCE((u.notification_prefs->>'group_bell')::boolean, true)");
    expect(mockTxSql.some((q) => /INSERT INTO notifications/.test(q))).toBe(false);
  });

  it('never rings someone who blocked the author or whom the author blocked', async () => {
    await post();
    const sql = sqlOf(calls(/^INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/b\.blocker_id = m\.user_id AND b\.blocked_id = \$2/);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = m\.user_id/);
  });

  it('opens the post itself, and still rings each member once per circle per hour', async () => {
    await post();
    const sql = sqlOf(calls(/^INSERT INTO notifications/)[0]);
    expect(sql).toMatch(/n\.type = 'circle_post' AND \(n\.link = \$6::text OR starts_with\(n\.link, \$6::text \|\| '\?'\)\) AND n\.created_at > NOW\(\) - INTERVAL '1 hour'/);
    expect(paramsOf(/^INSERT INTO notifications/)).toEqual([
      C1, VIEWER, 'New post in Curious Humans', 'Big news', `/circles/${C1}?post=${POST}`, `/circles/${C1}`,
    ]);
  });

  it('is pushed live to each member rung: notification:new plus their own bell tag', async () => {
    await post();
    expect(mockPush).toHaveBeenCalledWith('user:member-1', 'notification:new', expect.objectContaining({ type: 'circle_post', link: `/circles/${C1}?post=${POST}` }));
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['member-1'], [E.userNotifications('member-1')]);
  });

  it('never fails the post: a bell that cannot be written is logged and the post is still answered', async () => {
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO notifications/.test(sql)) throw new Error('bell down');
      return answer(sql, params ?? []);
    });
    await expect(post()).resolves.toMatchObject({ id: POST });
  });
});

describe('listPosts — keyset, blocks, pinned strip', () => {
  it('uses keyset (created_at, id) tuple comparison — never OFFSET', async () => {
    await listPosts(C1, VIEWER, { cursor: `${Date.now()}_5b3f7d1e-0000-4000-8000-00000000000a` });
    const feedSql = sqlOf(calls(/ORDER BY p\.created_at DESC/)[0]);
    expect(feedSql).toMatch(/\(p\.created_at, p\.id\) < /);
    expect(feedSql).not.toMatch(/OFFSET/i);
  });

  it('filters blocked authors in BOTH directions', async () => {
    await listPosts(C1, VIEWER);
    const feedSql = sqlOf(calls(/ORDER BY p\.created_at DESC/)[0]);
    expect(feedSql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    expect(feedSql).toMatch(/b\.blocker_id = p\.author_id AND b\.blocked_id = \$2/);
  });

  it('rejects a malformed cursor', async () => {
    await expect(listPosts(C1, VIEWER, { cursor: 'OFFSET 40; DROP TABLE circles' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('shows the pinned strip newest pin first, three at most', async () => {
    await listPosts(C1, VIEWER);
    expect(sqlOf(calls(/p\.pinned_at IS NOT NULL/)[0])).toMatch(/ORDER BY p\.pinned_at DESC LIMIT 3$/);
  });

  it('a share\'s embedded original is carried only from an open circle or to someone in it', async () => {
    await listPosts(C1, VIEWER);
    expect(sqlOf(calls(/ORDER BY p\.created_at DESC/)[0])).toContain(
      "AND (oc.join_policy <> 'closed' OR EXISTS (SELECT 1 FROM circle_members om WHERE om.circle_id = o.circle_id AND om.user_id = $2))",
    );
  });

  it('draws a post by a closed account as "Former member", and carries its edit stamp', async () => {
    world.feed = [aPost({ author_former: true, edited_at: EDITED_AT })];
    const [p] = (await listPosts(C1, VIEWER)).posts;
    expect(p).toMatchObject({ authorName: 'Former member', authorAvatarUrl: null, authorClosed: true, editedAt: EDITED_AT });
  });
});

// ─── Deleting (D3 moderation, D8 own words) ──────────────────────────────────

describe('deletePost', () => {
  it('the author deletes their own post: soft, says who, moves the count, tells the circle; no moderation record', async () => {
    await expect(deletePost(POST, VIEWER, 'member')).resolves.toEqual({ alreadyRemoved: false });
    expect(paramsOf(/^UPDATE circle_posts SET deleted_at/)).toEqual([POST, VIEWER]);
    expect(calls(/^UPDATE circles SET post_count = GREATEST/)).toHaveLength(1);
    expect(calls(/DELETE FROM circle_posts/)).toHaveLength(0);
    expect(calls(/INSERT INTO audit_log/)).toHaveLength(0);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)]);
  });

  it('D8: an author no longer in the circle still deletes their own post', async () => {
    asRole(null);
    await expect(deletePost(POST, VIEWER, 'member')).resolves.toEqual({ alreadyRemoved: false });
  });

  it.each([['owner', 'member'], ['moderator', 'member'], [null, 'admin']] as const)(
    'a circle %s (platform role %s) deletes anyone\'s post, and it is recorded with the words',
    async (role, platformRole) => {
      asRole(role);
      world.lockedPost = { author_id: AUTHOR, deleted_at: null, content: 'rude words' };
      await expect(deletePost(POST, VIEWER, platformRole)).resolves.toEqual({ alreadyRemoved: false });
      const params = paramsOf(/INSERT INTO audit_log/)!;
      expect(params.slice(0, 4)).toEqual([VIEWER, 'wall_post_removed', 'circle', C1]);
      expect(JSON.parse(params[4] as string)).toMatchObject({ wall: 'circle', postId: POST, authorId: AUTHOR, content: 'rude words' });
      expect(mockTxSql.some((q) => /^INSERT INTO audit_log/.test(q))).toBe(true);
    },
  );

  it('a member cannot delete someone else\'s post: 403, nothing written', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    await expect(deletePost(POST, VIEWER, 'member')).rejects.toMatchObject({ statusCode: 403, message: 'You can only delete your own posts' });
    expect(writes()).toHaveLength(0);
  });

  it('someone outside the circle gets the missing-post 404 for someone else\'s post', async () => {
    asRole(null);
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    await expect(deletePost(POST, VIEWER, 'member')).rejects.toMatchObject(POST_MISSING);
    world.lockedPost = null;
    await expect(deletePost(POST, VIEWER, 'member')).rejects.toMatchObject(POST_MISSING);
  });

  it('two moderators at once: the second is answered alreadyRemoved; nothing is written or told again', async () => {
    asRole('moderator');
    world.lockedPost = { author_id: AUTHOR, deleted_at: new Date() };
    await expect(deletePost(POST, VIEWER, 'member')).resolves.toEqual({ alreadyRemoved: true });
    expect(writes()).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
    expect(mockTxSql[0]).toMatch(/FOR UPDATE$/);
  });

  it('a member who could never have removed it is told it was removed', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: new Date() };
    await expect(deletePost(POST, VIEWER, 'member')).rejects.toMatchObject({ statusCode: 404, message: 'This post was removed.' });
  });
});

describe('pinPost — the circle\'s owner and moderators; at most three; recorded', () => {
  beforeEach(() => asRole('owner'));

  it.each([['owner', 'member'], ['moderator', 'member'], [null, 'admin']] as const)('a %s (platform %s) pins and unpins, each recorded and told', async (role, platformRole) => {
    asRole(role);
    world.lockedPost = { author_id: AUTHOR, deleted_at: null, pinned_at: null };
    await pinPost(POST, VIEWER, platformRole, true);
    world.lockedPost = { author_id: AUTHOR, deleted_at: null, pinned_at: new Date() };
    await pinPost(POST, VIEWER, platformRole, false);
    expect(calls(/^UPDATE circle_posts SET pinned_at/).map((c) => c[1])).toEqual([[POST, true], [POST, false]]);
    expect(calls(/INSERT INTO audit_log/).map((c) => (c[1] as unknown[])[1])).toEqual(['wall_post_pinned', 'wall_post_unpinned']);
    expect(mockFanout.mock.calls).toEqual([[C1, [E.circleWallPost(POST)]], [C1, [E.circleWallPost(POST)]]]);
  });

  it('a plain member cannot pin (403); someone outside gets the missing-post 404', async () => {
    asRole('member');
    await expect(pinPost(POST, VIEWER, 'member', true)).rejects.toMatchObject({ statusCode: 403, message: "Only the circle's owner or a moderator can pin posts" });
    asRole(null);
    await expect(pinPost(POST, VIEWER, 'member', true)).rejects.toMatchObject(POST_MISSING);
    expect(writes()).toHaveLength(0);
  });

  it('a fourth pin is refused until one is unpinned, counted under the circle row\'s lock taken after the post\'s', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: null, pinned_at: null };
    world.pinnedCount = 3;
    await expect(pinPost(POST, VIEWER, 'member', true)).rejects.toMatchObject({ statusCode: 409, code: 'WALL_PINS_FULL' });
    expect(writes()).toHaveLength(0);
    const post = mockTxSql.findIndex((q) => /FROM circle_posts WHERE id = \$1 FOR UPDATE$/.test(q));
    const circle = mockTxSql.findIndex((q) => /^SELECT id FROM circles WHERE id = \$1 FOR NO KEY UPDATE$/.test(q));
    const count = mockTxSql.findIndex((q) => /^SELECT count\(\*\)::int AS n FROM circle_posts/.test(q));
    expect(post).toBe(0);
    expect(circle).toBeGreaterThan(post);
    expect(count).toBeGreaterThan(circle);
  });

  it('re-pinning a pinned post moves it to the front without counting; unpinning one not pinned changes nothing', async () => {
    world.pinnedCount = 3;
    world.lockedPost = { author_id: AUTHOR, deleted_at: null, pinned_at: new Date() };
    await expect(pinPost(POST, VIEWER, 'member', true)).resolves.toBeUndefined();
    expect(calls(/FOR NO KEY UPDATE/)).toHaveLength(0);
    mockFanout.mockClear();
    world.lockedPost = { author_id: AUTHOR, deleted_at: null, pinned_at: null };
    await pinPost(POST, VIEWER, 'member', false);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('a post removed a moment before cannot be pinned: "This post was removed."', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: new Date() };
    await expect(pinPost(POST, VIEWER, 'member', true)).rejects.toMatchObject({ statusCode: 404, message: 'This post was removed.' });
  });
});

// ─── Edits ───────────────────────────────────────────────────────────────────

describe('editPost — the author\'s own words', () => {
  const edit = (content: string, expectedEditedAt?: string | null) => editPost(POST, VIEWER, { content, expectedEditedAt });

  it('writes the words, the link read again and the stamp under the post\'s lock; tells the circle; rings nobody', async () => {
    await expect(edit(' see https://x.example/a ')).resolves.toEqual({ changed: true, editedAt: EDITED_AT });
    expect(paramsOf(/^UPDATE circle_posts SET content/)).toEqual([POST, 'see https://x.example/a', 'https://x.example/a']);
    expect(mockTxSql[0]).toMatch(/FOR UPDATE OF p$/);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)]);
    expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
  });

  it('the same words change nothing and tell nobody', async () => {
    await expect(edit('hello circle')).resolves.toEqual({ changed: false, editedAt: null });
    expect(writes()).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('someone else\'s post: 403 for a member (even the owner); the missing-post 404 for someone outside', async () => {
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    asRole('owner');
    await expect(edit('x')).rejects.toMatchObject({ statusCode: 403, message: 'You can only edit your own words.' });
    asRole(null);
    await expect(edit('x')).rejects.toMatchObject(POST_MISSING);
  });

  it('a post removed a moment before: "This post was removed."', async () => {
    world.lockedPost = { author_id: VIEWER, deleted_at: new Date() };
    await expect(edit('x')).rejects.toMatchObject({ statusCode: 404, message: 'This post was removed.' });
    expect(writes()).toHaveLength(0);
  });

  it('D8: an author no longer in the circle cannot edit (they may only delete)', async () => {
    asRole(null);
    await expect(edit('x')).rejects.toMatchObject({ statusCode: 403, message: 'You are no longer in this circle. You can still delete your own posts and comments.' });
  });

  it('an archived circle takes no edits', async () => {
    world.circles[C1].archived = true;
    await expect(edit('x')).rejects.toMatchObject({ statusCode: 409, code: 'CIRCLE_ARCHIVED' });
  });

  it('refuses an edit over another one (two tabs)', async () => {
    world.lockedPost = { author_id: VIEWER, deleted_at: null, edited_at: new Date('2026-11-11T10:30:00.000Z') };
    await expect(edit('tab two', null)).rejects.toMatchObject({ statusCode: 409, code: 'WALL_EDIT_CONFLICT' });
    await expect(edit('tab one', '2026-11-11T10:30:00.000Z')).resolves.toMatchObject({ changed: true });
  });

  it('empty words are refused unless the post keeps a picture or a shared post', async () => {
    await expect(edit('  ')).rejects.toMatchObject({ statusCode: 400 });
    world.lockedPost = { author_id: VIEWER, deleted_at: null, shared_from_post_id: 'p-root' };
    await expect(edit('')).resolves.toMatchObject({ changed: true });
  });
});

describe('editComment — the author\'s own words', () => {
  it('writes the words and the stamp, and tells the thread only', async () => {
    await expect(editComment(COMMENT, VIEWER, { content: ' better ' })).resolves.toEqual({ changed: true, editedAt: EDITED_AT, postId: POST });
    expect(paramsOf(/^UPDATE circle_post_comments SET content/)).toEqual([COMMENT, 'better']);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)], { wall: false });
  });

  it('says which was removed: the post, or the comment', async () => {
    world.lockedComment = { author_id: VIEWER, deleted_at: null, post_deleted_at: new Date() };
    await expect(editComment(COMMENT, VIEWER, { content: 'x' })).rejects.toMatchObject({ message: 'This post was removed.' });
    world.lockedComment = { author_id: VIEWER, deleted_at: new Date() };
    await expect(editComment(COMMENT, VIEWER, { content: 'x' })).rejects.toMatchObject({ message: 'This comment was removed.' });
  });

  it('someone else\'s comment is 403; outside the circle it is the comment\'s 404', async () => {
    world.lockedComment = { author_id: AUTHOR, deleted_at: null };
    await expect(editComment(COMMENT, VIEWER, { content: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    asRole(null);
    await expect(editComment(COMMENT, VIEWER, { content: 'x' })).rejects.toMatchObject({ statusCode: 404, message: 'That comment could not be found' });
  });

  it('an empty comment or one over 4000 is refused before anything is locked', async () => {
    await expect(editComment(COMMENT, VIEWER, { content: ' ' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(editComment(COMMENT, VIEWER, { content: 'y'.repeat(4001) })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTxSql).toHaveLength(0);
  });
});

// ─── Reactions and comments ──────────────────────────────────────────────────

describe('reactToPost', () => {
  it('an unknown reaction is rejected before the database is asked', async () => {
    await expect(reactToPost(POST, VIEWER, 'angry' as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('sets the one reaction, rings the author through ringOne, tells the circle, answers the counts', async () => {
    const out = await reactToPost(POST, VIEWER, 'love');
    expect(sqlOf(calls(/^INSERT INTO circle_post_reactions/)[0])).toMatch(/WHERE circle_post_reactions\.reaction IS DISTINCT FROM EXCLUDED\.reaction RETURNING post_id$/);
    expect(out).toEqual({ reactionCount: 3, reactions: { love: 2, like: 1 }, myReaction: 'love' });
    expect(paramsOf(/^INSERT INTO notifications/)).toEqual([
      AUTHOR, C1, 'circle_reaction', 'Vera Viewer reacted to your post', 'hello circle', `/circles/${C1}?post=${POST}`, VIEWER, 60,
      `/circles/${C1}?post=${POST}`,
    ]);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)]);
  });

  it('the bell to one person asks that they are still in the circle, open, not muted and not blocked either way', async () => {
    await reactToPost(POST, VIEWER, 'love');
    const sql = sqlOf(calls(/^INSERT INTO notifications/)[0]);
    expect(sql).toContain('EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = $2 AND m.user_id = u.id)');
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain("COALESCE((u.notification_prefs->>'group_bell')::boolean, true)");
    expect(sql).toMatch(/b\.blocker_id = u\.id AND b\.blocked_id = \$7\) OR \(b\.blocker_id = \$7 AND b\.blocked_id = u\.id/);
  });

  it('the same reaction again changes nothing: nobody rung, nobody told', async () => {
    world.reactionChanged = false;
    await reactToPost(POST, VIEWER, 'love');
    expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('clearing rings nobody; your own post rings nobody', async () => {
    await reactToPost(POST, VIEWER, null);
    world.head = { circle_id: C1, author_id: VIEWER, content: 'mine', deleted_at: null, blocked: false };
    await reactToPost(POST, VIEWER, 'like');
    expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
  });

  it('an archived circle takes no reactions', async () => {
    world.circles[C1].archived = true;
    await expect(reactToPost(POST, VIEWER, 'like')).rejects.toMatchObject({ statusCode: 409 });
    expect(writes()).toHaveLength(0);
  });
});

describe('addComment — replies one level deep, bells to the right people', () => {
  it('a plain comment: count moves in the transaction, the post author is rung, the circle told', async () => {
    const out = await addComment(POST, VIEWER, 'Congrats!');
    expect(out).toMatchObject({ id: COMMENT, parentCommentId: null });
    expect(mockTxSql.filter((q) => /^INSERT INTO circle_post_comments|^UPDATE circle_posts SET comment_count = comment_count \+ 1/.test(q))).toHaveLength(2);
    expect(calls(/^INSERT INTO notifications/).map((c) => (c[1] as unknown[]).slice(0, 3))).toEqual([[AUTHOR, C1, 'circle_comment']]);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)]);
  });

  it('a reply to a reply hangs under the top comment; the bell goes to the person answered, once', async () => {
    world.parent = { id: 'cm-reply', author_id: AUTHOR, parent_comment_id: 'cm-top' };
    const out = await addComment(POST, VIEWER, 'Thanks', 'cm-reply');
    expect(out.parentCommentId).toBe('cm-top');
    expect(calls(/^INSERT INTO notifications/).map((c) => (c[1] as unknown[])[2])).toEqual(['circle_reply']);
  });

  it('the comment answered must be one the member can see: blocks both ways on it and on its parent', async () => {
    world.parent = null;
    await expect(addComment(POST, VIEWER, 'orphan', 'cm-hidden')).rejects.toMatchObject({ statusCode: 404 });
    const sql = sqlOf(calls(/^SELECT c\.id, c\.author_id, c\.parent_comment_id FROM circle_post_comments c/)[0]);
    expect(sql).toMatch(/c\.post_id = \$2/);
    expect(sql).toMatch(/b\.blocker_id = \$3 AND b\.blocked_id = c\.author_id/);
    expect(sql).toMatch(/pb\.blocker_id = pc\.author_id AND pb\.blocked_id = \$3/);
  });

  it(`stops a member commenting more than ${COMMENT_RATE_PER_MIN} times a minute`, async () => {
    world.recentComments = COMMENT_RATE_PER_MIN;
    await expect(addComment(POST, VIEWER, 'again')).rejects.toMatchObject({ statusCode: 429 });
    expect(writes()).toHaveLength(0);
  });

  it('an archived circle takes no comments', async () => {
    world.circles[C1].archived = true;
    await expect(addComment(POST, VIEWER, 'x')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listComments', () => {
  it('answers { comments, truncated } with edit stamps, blocks both ways, at most 400', async () => {
    world.comments = [{
      id: COMMENT, author_id: AUTHOR, display_name: 'Ada', avatar_url: null, author_former: false, content: 'x',
      created_at: CREATED_AT, edited_at: EDITED_AT, parent_comment_id: null, like_count: 2, liked_by_me: true,
    }];
    const list = await listComments(POST, VIEWER, 'member');
    expect(list).toEqual({
      comments: [{
        id: COMMENT, authorId: AUTHOR, authorName: 'Ada', authorAvatarUrl: null, authorClosed: false, content: 'x',
        createdAt: CREATED_AT, parentCommentId: null, likeCount: 2, likedByMe: true, editedAt: EDITED_AT, withdrawn: false,
      }],
      truncated: false,
    });
    const read = calls(/FROM circle_post_comments c JOIN users u/)[0];
    expect(sqlOf(read)).toMatch(/b\.blocker_id = c\.author_id AND b\.blocked_id = \$2/);
    expect(read[1]).toEqual([POST, VIEWER, 401]);
  });
});

describe('likeComment', () => {
  it('only a comment the member can see, on a live post; tells the thread only, only when it changed', async () => {
    await likeComment(COMMENT, VIEWER, true);
    const sql = sqlOf(calls(/^SELECT p\.circle_id, c\.post_id FROM circle_post_comments c/)[0]);
    expect(sql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    expect(sql).toMatch(/b\.blocker_id = c\.author_id AND b\.blocked_id = \$2/);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)], { wall: false });
    mockFanout.mockClear();
    world.likeChanged = false;
    await likeComment(COMMENT, VIEWER, true);
    expect(mockFanout).not.toHaveBeenCalled();
    expect(calls(/INSERT INTO notifications/)).toHaveLength(0);
  });

  it('an archived circle takes no likes', async () => {
    world.circles[C1].archived = true;
    await expect(likeComment(COMMENT, VIEWER, true)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('deleteComment', () => {
  it('the author, a comment with no replies: it goes alone, saying who; no record', async () => {
    world.commentsRemoved = 1;
    await expect(deleteComment(COMMENT, VIEWER, 'member')).resolves.toEqual({ postId: POST, alreadyRemoved: false });
    expect(sqlOf(calls(/^UPDATE circle_post_comments SET deleted_at/)[0])).toMatch(/WHERE \(id = \$1 OR \(\$3::boolean AND parent_comment_id = \$1\)\) AND deleted_at IS NULL RETURNING id, withdrawn_at$/);
    expect(paramsOf(/^UPDATE circle_post_comments SET deleted_at/)).toEqual([COMMENT, VIEWER, false]);
    expect(paramsOf(/comment_count = GREATEST/)).toEqual([POST, 1]);
    expect(calls(/INSERT INTO audit_log/)).toHaveLength(0);
    expect(mockFanout).toHaveBeenCalledWith(C1, [E.circleWallPost(POST)]);
  });

  it('fix round 1 (ruling): the author\'s comment with replies is withdrawn; other people\'s replies stay', async () => {
    world.lockedComment = { author_id: VIEWER, deleted_at: null, has_replies: true };
    await expect(deleteComment(COMMENT, VIEWER, 'member')).resolves.toEqual({ postId: POST, alreadyRemoved: false });
    expect(paramsOf(/^UPDATE circle_post_comments SET content = '', withdrawn_at = NOW\(\)/)).toEqual([COMMENT, VIEWER]);
    expect(calls(/^UPDATE circle_post_comments SET deleted_at/)).toHaveLength(0);
    expect(calls(/comment_count = GREATEST\(comment_count - 1, 0\)/)).toHaveLength(1);
    expect(calls(/INSERT INTO audit_log/)).toHaveLength(0);
    world.lockedComment = { author_id: VIEWER, deleted_at: null, has_replies: true, withdrawn_at: new Date() };
    await expect(deleteComment(COMMENT, VIEWER, 'member')).resolves.toEqual({ postId: POST, alreadyRemoved: true });
  });

  it('a moderator removes a comment with its thread; the count moves by the live ones only (a withdrawn one was already off it)', async () => {
    asRole('moderator');
    world.lockedComment = { author_id: AUTHOR, deleted_at: null, has_replies: true };
    world.commentsRemoved = 3;
    await deleteComment(COMMENT, VIEWER, 'member');
    expect(paramsOf(/^UPDATE circle_post_comments SET deleted_at/)).toEqual([COMMENT, VIEWER, true]);
    expect(paramsOf(/comment_count = GREATEST\(comment_count - \$2/)).toEqual([POST, 3]);
    expect(JSON.parse((paramsOf(/INSERT INTO audit_log/) as unknown[])[4] as string)).toMatchObject({ repliesRemoved: 2 });
  });

  it('D8: an author no longer in the circle still deletes their own comment', async () => {
    asRole(null);
    await expect(deleteComment(COMMENT, VIEWER, 'member')).resolves.toEqual({ postId: POST, alreadyRemoved: false });
  });

  it('a moderator removes anyone\'s comment, recorded; a member cannot; outside, the comment\'s 404', async () => {
    world.lockedComment = { author_id: AUTHOR, deleted_at: null, content: 'off topic' };
    asRole('moderator');
    await deleteComment(COMMENT, VIEWER, 'member');
    expect((paramsOf(/INSERT INTO audit_log/) as unknown[]).slice(0, 4)).toEqual([VIEWER, 'wall_comment_removed', 'circle', C1]);
    asRole('member');
    await expect(deleteComment(COMMENT, VIEWER, 'member')).rejects.toMatchObject({ statusCode: 403 });
    asRole(null);
    await expect(deleteComment(COMMENT, VIEWER, 'member')).rejects.toMatchObject({ statusCode: 404, message: 'That comment could not be found' });
  });

  it('removed a moment before: alreadyRemoved for whoever could have removed it, nothing written', async () => {
    world.lockedComment = { author_id: AUTHOR, deleted_at: new Date() };
    asRole('owner');
    await expect(deleteComment(COMMENT, VIEWER, 'member')).resolves.toEqual({ postId: POST, alreadyRemoved: true });
    expect(writes()).toHaveLength(0);
  });
});

describe('sharePost — attribution to the root, never into the same circle, only by someone who can read it', () => {
  it('a share carries the original post id; sharing a share points at the root', async () => {
    world.shareSource = { id: POST, shared_from_post_id: 'p-root' };
    world.shareRoot = { id: 'p-root', circle_id: 'c3c3c3c3-3333-4333-8333-333333333333' };
    world.circles['c3c3c3c3-3333-4333-8333-333333333333'] = { name: 'Third', archived: false, join_policy: 'open', role: null };
    world.insertedPostId = 'p-share';
    world.postRow = aPost({ id: 'p-share', circle_id: C2 });
    await sharePost(POST, VIEWER, { circleId: C2, clientId: CLIENT_ID });
    expect((paramsOf(/^INSERT INTO circle_posts/) as unknown[])[6]).toBe('p-root');
  });

  it('refuses to share into the circle it lives in', async () => {
    await expect(sharePost(POST, VIEWER, { circleId: C1, clientId: CLIENT_ID })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a closed circle\'s post stays in it, even for its member', async () => {
    world.circles[C1].join_policy = 'closed';
    await expect(sharePost(POST, VIEWER, { circleId: C2, clientId: CLIENT_ID }))
      .rejects.toMatchObject({ statusCode: 403, message: 'Posts in a closed circle stay in it.' });
    expect(writes()).toHaveLength(0);
  });

  it('the sharer must be in the target circle too', async () => {
    world.circles[C2].role = null;
    await expect(sharePost(POST, VIEWER, { circleId: C2, clientId: CLIENT_ID })).rejects.toMatchObject({ statusCode: 403 });
  });
});


// ─── S4 fix round 1 ──────────────────────────────────────────────────────────

describe('fix round 1: blocks win on share cards, both ways', () => {
  it('the feed\'s share card carries no original by someone blocked either way (no words, no name)', async () => {
    await listPosts(C1, VIEWER);
    const feed = sqlOf(calls(/ORDER BY p\.created_at DESC/)[0]);
    expect(feed).toContain('AND NOT EXISTS (SELECT 1 FROM user_blocks ob WHERE (ob.blocker_id = $2 AND ob.blocked_id = o.author_id) OR (ob.blocker_id = o.author_id AND ob.blocked_id = $2))) AS shared_from');
  });

  it('a share whose original the viewer may not see says only that it is not available', async () => {
    world.feed = [aPost({ shared_from_post_id: 'p-root', shared_from: null })];
    const [p] = (await listPosts(C1, VIEWER)).posts;
    expect(p).toMatchObject({ sharedFrom: null, sharedUnavailable: true });
    world.feed = [aPost()];
    expect((await listPosts(C1, VIEWER)).posts[0].sharedUnavailable).toBe(false);
  });

  it('sharing a share checks the ORIGINAL author against the sharer, both ways: a block answers as a missing post', async () => {
    world.shareSource = { id: POST, shared_from_post_id: 'p-root' };
    world.shareRoot = { id: 'p-root', circle_id: C2, blocked: true };
    await expect(sharePost(POST, VIEWER, { circleId: C2, clientId: CLIENT_ID })).rejects.toMatchObject(POST_MISSING);
    const root = calls(/^SELECT o\.id, o\.circle_id, EXISTS \(SELECT 1 FROM user_blocks b/)[0];
    expect(sqlOf(root)).toContain('(b.blocker_id = $2 AND b.blocked_id = o.author_id) OR (b.blocker_id = o.author_id AND b.blocked_id = $2)');
    expect(root[1]).toEqual(['p-root', VIEWER]);
    expect(writes()).toHaveLength(0);
  });
});

describe('fix round 1: removed words leave the bell lists too', () => {
  it('removing a post deletes every bell about it in the same transaction, then tells their people', async () => {
    asRole('owner');
    world.lockedPost = { author_id: AUTHOR, deleted_at: null };
    world.purgedBells = [{ user_id: 'member-7' }, { user_id: 'member-8' }, { user_id: 'member-7' }];
    await deletePost(POST, VIEWER, 'member');
    const purge = calls(/^DELETE FROM notifications/)[0];
    expect(sqlOf(purge)).toBe(`DELETE FROM notifications WHERE type IN ('circle_post', 'circle_reaction', 'circle_comment', 'circle_reply') AND (link = $1 OR link LIKE $2) RETURNING user_id`);
    expect(purge[1]).toEqual([`/circles/${C1}?post=${POST}`, `/circles/${C1}?post=${POST}&%`]);
    expect(mockTxSql.some((q) => /^DELETE FROM notifications/.test(q))).toBe(true);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['member-7'], [E.userNotifications('member-7')]);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['member-8'], [E.userNotifications('member-8')]);
    expect(mockEmitEntities.mock.calls.filter((c) => (c[1] as string[])[0] === 'member-7')).toHaveLength(1);
  });

  it('an author deleting their own post does the same', async () => {
    await deletePost(POST, VIEWER, 'member');
    expect(calls(/^DELETE FROM notifications/)).toHaveLength(1);
  });

  it('a second removal (alreadyRemoved) deletes nothing more', async () => {
    world.lockedPost = { author_id: VIEWER, deleted_at: new Date() };
    await deletePost(POST, VIEWER, 'member');
    expect(calls(/^DELETE FROM notifications/)).toHaveLength(0);
  });

  it('a comment\'s bells name it, so removing it (and a moderator\'s removal of its thread) deletes exactly theirs', async () => {
    asRole('moderator');
    world.lockedComment = { author_id: AUTHOR, deleted_at: null };
    world.commentsRemoved = 2;
    await deleteComment(COMMENT, VIEWER, 'member');
    const purge = calls(/^DELETE FROM notifications/)[0];
    expect(sqlOf(purge)).toBe(`DELETE FROM notifications WHERE type IN ('circle_post', 'circle_reaction', 'circle_comment', 'circle_reply') AND link = ANY($1::text[]) RETURNING user_id`);
    expect(purge[1][0]).toEqual([`/circles/${C1}?post=${POST}&comment=gone-0`, `/circles/${C1}?post=${POST}&comment=gone-1`]);
  });

  it('a withdrawn comment\'s bells go too', async () => {
    world.lockedComment = { author_id: VIEWER, deleted_at: null, has_replies: true };
    await deleteComment(COMMENT, VIEWER, 'member');
    expect(calls(/^DELETE FROM notifications/)[0][1][0]).toEqual([`/circles/${C1}?post=${POST}&comment=${COMMENT}`]);
  });

  it('comment and reply bells link to the post and name the comment, deduped per post', async () => {
    await addComment(POST, VIEWER, 'Congrats!');
    const bell = calls(/^INSERT INTO notifications/)[0];
    expect((bell[1] as unknown[])[5]).toBe(`/circles/${C1}?post=${POST}&comment=${COMMENT}`);
    expect((bell[1] as unknown[])[8]).toBe(`/circles/${C1}?post=${POST}`);
    expect(sqlOf(bell)).toContain("(n.link = $9::text OR starts_with(n.link, $9::text || '&'))");
  });
});

describe('fix round 1: shares in other circles follow a removal or an edit of their original', () => {
  it('a removal and an edit tell the circles holding shares of the post', async () => {
    await deletePost(POST, VIEWER, 'member');
    expect(mockFanoutShares).toHaveBeenCalledWith(POST);
    mockFanoutShares.mockClear();
    world.lockedPost = { author_id: VIEWER, deleted_at: null };
    await editPost(POST, VIEWER, { content: 'new words' });
    expect(mockFanoutShares).toHaveBeenCalledWith(POST);
  });

  it('an edit that changed nothing tells nobody', async () => {
    await editPost(POST, VIEWER, { content: 'hello circle' });
    expect(mockFanoutShares).not.toHaveBeenCalled();
  });
});

describe('fix round 1: withdrawn comments in the thread', () => {
  it('a withdrawn comment is listed without words while a reply under it is still there; it cannot be answered, liked or edited', async () => {
    world.comments = [{
      id: COMMENT, author_id: AUTHOR, display_name: 'Ada', avatar_url: null, author_former: false, content: '',
      created_at: CREATED_AT, edited_at: null, withdrawn_at: new Date(), parent_comment_id: null, like_count: 0, liked_by_me: false,
    }];
    const { comments } = await listComments(POST, VIEWER, 'member');
    expect(comments[0]).toMatchObject({ withdrawn: true, content: '' });
    const list = sqlOf(calls(/FROM circle_post_comments c JOIN users u/)[0]);
    expect(list).toContain('AND (c.withdrawn_at IS NULL OR EXISTS (SELECT 1 FROM circle_post_comments wr WHERE wr.parent_comment_id = c.id AND wr.deleted_at IS NULL))');
    world.parent = { id: 'cm-top', author_id: AUTHOR, parent_comment_id: null };
    await addComment(POST, VIEWER, 'reply', 'cm-top');
    expect(sqlOf(calls(/^SELECT c\.id, c\.author_id, c\.parent_comment_id FROM circle_post_comments c/)[0])).toContain('c.deleted_at IS NULL AND c.withdrawn_at IS NULL');
    await likeComment(COMMENT, VIEWER, true);
    expect(sqlOf(calls(/^SELECT p\.circle_id, c\.post_id FROM circle_post_comments c/)[0])).toContain('c.withdrawn_at IS NULL');
    world.lockedComment = { author_id: VIEWER, deleted_at: null, withdrawn_at: new Date() };
    await expect(editComment(COMMENT, VIEWER, { content: 'x' })).rejects.toMatchObject({ statusCode: 404, message: 'This comment was removed.' });
  });
});
