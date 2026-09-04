// ─── Circle Wall (REASON v1 Phase 4, 20 Jul 2026) ────────────────────────────
//
// Pins the UGC rules: members-only posting, Cloudinary-only media, SSRF-free
// link extraction, idempotent post creation, transactional counters, rate
// limits, block filtering at read, keyset (never OFFSET) pagination, soft
// deletes with author/admin authz.

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
// The bells push over the socket through a dynamic import of the io instance.
const mockEmit = jest.fn();
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: (...a: unknown[]) => mockEmit(...a) }) }, __esModule: true }));

import {
  validateMedia, extractLinkUrl, createPost, listPosts, deletePost, addComment,
  reactToPost, likeComment, deleteComment, sharePost, getPost,
  MEDIA_HOST_PREFIX, POST_RATE_PER_MIN,
} from '../../../services/circle/circle-wall.service';

beforeEach(() => mockQuery.mockReset());

describe('validateMedia — Cloudinary-only, bounded', () => {
  it('accepts our CDN, rejects everything else', () => {
    expect(validateMedia([{ type: 'image', url: `${MEDIA_HOST_PREFIX}x/img.jpg` }])).toHaveLength(1);
    expect(() => validateMedia([{ type: 'image', url: 'https://evil.example/x.jpg' }])).toThrow();
    expect(() => validateMedia([{ type: 'script' as any, url: `${MEDIA_HOST_PREFIX}x` }])).toThrow();
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

function armCircle(opts: { member?: boolean; recentPosts?: number } = {}) {
  const { member = true, recentPosts = 0 } = opts;
  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT id, name FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c1', name: 'Founders' }] });
    if (/FROM circle_members WHERE/.test(sql)) return Promise.resolve({ rows: member ? [{ '?column?': 1 }] : [] });
    if (/count\(\*\)::text AS c FROM circle_posts/.test(sql)) return Promise.resolve({ rows: [{ c: String(recentPosts) }] });
    if (/INSERT INTO circle_posts/.test(sql)) return Promise.resolve({ rows: [{ id: 'p1', created_at: new Date() }] });
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM circle_posts p JOIN users/.test(sql)) {
      return Promise.resolve({
        rows: [{
          id: 'p1', circle_id: 'c1', author_id: 'u1', display_name: 'A', avatar_url: null,
          content: 'hi', media: [], link_url: null, comment_count: 0, pinned_at: null, created_at: new Date(),
        }],
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

describe('createPost', () => {
  it('a NON-member cannot post (403) — membership gates posting, never reading', async () => {
    armCircle({ member: false });
    await expect(createPost('c1', 'u1', { clientId: '5b3f7d1e-0000-4000-8000-000000000001', content: 'hi' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it(`rate limit: post ${POST_RATE_PER_MIN} in a minute → 429`, async () => {
    armCircle({ recentPosts: POST_RATE_PER_MIN });
    await expect(createPost('c1', 'u1', { clientId: '5b3f7d1e-0000-4000-8000-000000000002', content: 'hi' }))
      .rejects.toMatchObject({ statusCode: 429 });
  });

  it('empty post (no text, no media) rejected', async () => {
    armCircle();
    await expect(createPost('c1', 'u1', { clientId: '5b3f7d1e-0000-4000-8000-000000000003', content: '   ' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('insert is idempotent by (author, clientId) and bumps post_count in the same tx', async () => {
    armCircle();
    await createPost('c1', 'u1', { clientId: '5b3f7d1e-0000-4000-8000-000000000004', content: 'hello wall' });
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /ON CONFLICT \(author_id, client_id\) DO NOTHING/.test(s))).toBe(true);
    expect(sqls.some(s => /post_count = post_count \+ 1/.test(s))).toBe(true);
  });

  it('member notifications are ONE deduped INSERT...SELECT, excluding the author', async () => {
    armCircle();
    await createPost('c1', 'u1', { clientId: '5b3f7d1e-0000-4000-8000-000000000005', content: 'hello' });
    const notif = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect(notif[0]).toMatch(/SELECT gen_random_uuid\(\), m\.user_id/);
    expect(notif[0]).toMatch(/m\.user_id <> \$2/);
    expect(notif[0]).toMatch(/INTERVAL '1 hour'/);
  });
});

describe('listPosts — keyset, blocks, pinned strip', () => {
  it('uses keyset (created_at, id) tuple comparison — never OFFSET', async () => {
    armCircle();
    await listPosts('c1', 'viewer', { cursor: `${Date.now()}_5b3f7d1e-0000-4000-8000-00000000000a` });
    const feedSql = mockQuery.mock.calls.map(c => c[0] as string).find(s => /ORDER BY p\.created_at DESC/.test(s))!;
    expect(feedSql).toMatch(/\(p\.created_at, p\.id\) < /);
    expect(feedSql).not.toMatch(/OFFSET/i);
  });

  it('filters blocked authors in BOTH directions', async () => {
    armCircle();
    await listPosts('c1', 'viewer');
    const feedSql = mockQuery.mock.calls.map(c => c[0] as string).find(s => /ORDER BY p\.created_at DESC/.test(s))!;
    expect(feedSql).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
    expect(feedSql).toMatch(/b\.blocker_id = p\.author_id AND b\.blocked_id = \$2/);
  });

  it('rejects a malformed cursor', async () => {
    await expect(listPosts('c1', 'v', { cursor: 'OFFSET 40; DROP TABLE circles' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('deletePost — soft, author-or-admin', () => {
  function armDelete(authorId: string) {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT author_id, circle_id, deleted_at/.test(sql)) {
        return Promise.resolve({ rows: [{ author_id: authorId, circle_id: 'c1', deleted_at: null }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  }

  it('a stranger cannot delete someone else\'s post; the author can; soft only', async () => {
    armDelete('author-1');
    await expect(deletePost('p1', 'stranger', false)).rejects.toMatchObject({ statusCode: 403 });
    armDelete('author-1');
    await deletePost('p1', 'author-1', false);
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /SET deleted_at = NOW\(\)/.test(s))).toBe(true);
    expect(sqls.some(s => /DELETE FROM circle_posts/.test(s))).toBe(false);
    expect(sqls.some(s => /post_count = GREATEST\(post_count - 1, 0\)/.test(s))).toBe(true);
  });

  it('an admin can delete anyone\'s post', async () => {
    armDelete('author-1');
    await expect(deletePost('p1', 'some-admin', true)).resolves.toBeUndefined();
  });
});

describe('addComment', () => {
  it('commenting requires circle membership and bumps comment_count transactionally', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT circle_id, author_id, content FROM circle_posts/.test(sql)) return Promise.resolve({ rows: [{ circle_id: 'c1', author_id: 'u1', content: 'hi' }] });
      if (/FROM circle_members WHERE/.test(sql)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (/count\(\*\)::text AS c FROM circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ c: '0' }] });
      if (/INSERT INTO circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ id: 'cm1', created_at: new Date() }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await addComment('p1', 'u1', 'nice one');
    expect(mockQuery.mock.calls.some(c => /comment_count = comment_count \+ 1/.test(c[0] as string))).toBe(true);
  });
});

// ─── 4 Sep 2026: the wall as a social feed ───────────────────────────────────
//
// Ali: "a proper Facebook-style like/react, comment, share, reply to a comment,
// and delete for the poster." One reaction per member per post, replies one
// level deep, likes on comments, shares with attribution, and bells that never
// ring for the member's own action or twice for the same post in the window.

const sqlsCalled = () => mockQuery.mock.calls.map(c => c[0] as string);
const paramsOf = (re: RegExp) => mockQuery.mock.calls.find(c => re.test(c[0] as string))?.[1] as unknown[] | undefined;

function armSocial(opts: { member?: boolean; postAuthor?: string; parent?: { id: string; author_id: string; parent_comment_id: string | null } | null; bellInserted?: boolean } = {}) {
  const { member = true, postAuthor = 'author-1', parent = null, bellInserted = true } = opts;
  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT circle_id, author_id, content FROM circle_posts/.test(sql)) return Promise.resolve({ rows: [{ circle_id: 'c1', author_id: postAuthor, content: 'Launching our beta' }] });
    if (/FROM circle_members WHERE/.test(sql)) return Promise.resolve({ rows: member ? [{ '?column?': 1 }] : [] });
    if (/count\(\*\)::text AS c FROM circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ c: '0' }] });
    if (/SELECT id, author_id, parent_comment_id FROM circle_post_comments/.test(sql)) return Promise.resolve({ rows: parent ? [parent] : [] });
    if (/INSERT INTO circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ id: 'cm-new', created_at: new Date() }] });
    if (/SELECT display_name FROM users/.test(sql)) return Promise.resolve({ rows: [{ display_name: 'Wall Reactor' }] });
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: bellInserted ? [{ id: 'n1', created_at: new Date() }] : [] });
    if (/FROM circle_post_reactions WHERE post_id = \$1 GROUP BY reaction/.test(sql)) {
      return Promise.resolve({ rows: [{ reaction: 'love', n: 2, mine: true }, { reaction: 'like', n: 1, mine: false }] });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

const bells = () => mockQuery.mock.calls
  .filter(c => /INSERT INTO notifications/.test(c[0] as string))
  .map(c => c[1] as unknown[]);

beforeEach(() => mockEmit.mockReset());

describe('reactToPost — one reaction per member, members only, author told once an hour', () => {
  it('a non-member cannot react (403); an unknown reaction is rejected (400)', async () => {
    armSocial({ member: false });
    await expect(reactToPost('p1', 'u2', 'love')).rejects.toMatchObject({ statusCode: 403 });
    armSocial();
    await expect(reactToPost('p1', 'u2', 'angry' as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('setting a reaction upserts the one row and returns the live summary', async () => {
    armSocial();
    const out = await reactToPost('p1', 'u2', 'love');
    expect(sqlsCalled().some(s => /INSERT INTO circle_post_reactions/.test(s) && /ON CONFLICT \(post_id, user_id\) DO UPDATE SET reaction = EXCLUDED\.reaction/.test(s))).toBe(true);
    expect(out).toEqual({ reactionCount: 3, reactions: { love: 2, like: 1 }, myReaction: 'love' });
  });

  it('null removes the member\'s reaction and rings no bell', async () => {
    armSocial();
    await reactToPost('p1', 'u2', null);
    expect(sqlsCalled().some(s => /DELETE FROM circle_post_reactions WHERE post_id = \$1 AND user_id = \$2/.test(s))).toBe(true);
    expect(bells()).toHaveLength(0);
  });

  it('the post author is told, deduped per post inside the window, with the deep link', async () => {
    armSocial();
    await reactToPost('p1', 'u2', 'celebrate');
    const [params] = bells();
    expect(params).toEqual(['author-1', 'circle_reaction', 'Wall Reactor reacted to your post', 'Launching our beta', '/circles/c1?post=p1', 60]);
    const sql = sqlsCalled().find(s => /INSERT INTO notifications/.test(s))!;
    expect(sql).toMatch(/make_interval\(mins => \$6::int\)/);
    expect(mockEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({ type: 'circle_reaction', link: '/circles/c1?post=p1' }));
  });

  it('reacting to your own post rings nothing', async () => {
    armSocial({ postAuthor: 'u2' });
    await reactToPost('p1', 'u2', 'like');
    expect(bells()).toHaveLength(0);
  });

  it('a deduped bell (no row inserted) does not push over the socket', async () => {
    armSocial({ bellInserted: false });
    await reactToPost('p1', 'u2', 'like');
    expect(bells()).toHaveLength(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('addComment — replies one level deep, bells to the right people', () => {
  it('a plain comment tells the post author, not the commenter', async () => {
    armSocial();
    const out = await addComment('p1', 'u2', 'Congrats!');
    expect(out).toMatchObject({ id: 'cm-new', parentCommentId: null });
    expect(paramsOf(/INSERT INTO circle_post_comments/)).toEqual(['p1', 'u2', 'Congrats!', null]);
    expect(bells().map(b => [b[0], b[1]])).toEqual([['author-1', 'circle_comment']]);
    expect(bells()[0][2]).toBe('Wall Reactor commented on your post');
  });

  it('a reply attaches to its parent, tells the parent\'s author, and the post author too when different', async () => {
    armSocial({ parent: { id: 'cm-top', author_id: 'u3', parent_comment_id: null } });
    const out = await addComment('p1', 'u2', 'Agreed', 'cm-top');
    expect(out.parentCommentId).toBe('cm-top');
    expect(paramsOf(/INSERT INTO circle_post_comments/)).toEqual(['p1', 'u2', 'Agreed', 'cm-top']);
    expect(bells().map(b => [b[0], b[1]])).toEqual([['u3', 'circle_reply'], ['author-1', 'circle_comment']]);
  });

  it('a reply to a reply hangs under the top-level comment but the bell goes to the person replied to', async () => {
    armSocial({ parent: { id: 'cm-reply', author_id: 'author-1', parent_comment_id: 'cm-top' } });
    const out = await addComment('p1', 'u2', 'Thanks', 'cm-reply');
    expect(out.parentCommentId).toBe('cm-top');
    expect(paramsOf(/INSERT INTO circle_post_comments/)![3]).toBe('cm-top');
    // The post author is the one replied to: one bell, not two.
    expect(bells().map(b => [b[0], b[1]])).toEqual([['author-1', 'circle_reply']]);
  });

  it('replying to yourself on your own post rings nothing; a parent from another post is not found', async () => {
    armSocial({ postAuthor: 'u2', parent: { id: 'cm-top', author_id: 'u2', parent_comment_id: null } });
    await addComment('p1', 'u2', 'me again', 'cm-top');
    expect(bells()).toHaveLength(0);
    armSocial({ parent: null });
    await expect(addComment('p1', 'u2', 'orphan', 'cm-elsewhere')).rejects.toMatchObject({ statusCode: 404 });
    const lookup = sqlsCalled().find(s => /SELECT id, author_id, parent_comment_id FROM circle_post_comments/.test(s))!;
    expect(lookup).toMatch(/post_id = \$2/);
  });
});

describe('likeComment — members only, idempotent, no bell', () => {
  function armLike(member: boolean) {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT p\.circle_id FROM circle_post_comments c JOIN circle_posts p/.test(sql)) return Promise.resolve({ rows: [{ circle_id: 'c1' }] });
      if (/FROM circle_members WHERE/.test(sql)) return Promise.resolve({ rows: member ? [{ '?column?': 1 }] : [] });
      if (/count\(\*\)::int AS like_count/.test(sql)) return Promise.resolve({ rows: [{ like_count: 1, liked_by_me: true }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  }
  it('like inserts (ON CONFLICT DO NOTHING); unlike deletes; a stranger gets 403', async () => {
    armLike(true);
    expect(await likeComment('cm1', 'u2', true)).toEqual({ likeCount: 1, likedByMe: true });
    expect(sqlsCalled().some(s => /INSERT INTO circle_comment_likes/.test(s) && /ON CONFLICT DO NOTHING/.test(s))).toBe(true);
    armLike(true);
    await likeComment('cm1', 'u2', false);
    expect(sqlsCalled().some(s => /DELETE FROM circle_comment_likes/.test(s))).toBe(true);
    expect(bells()).toHaveLength(0);
    armLike(false);
    await expect(likeComment('cm1', 'stranger', true)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('deleteComment — replies go with the parent, count moves by all of them', () => {
  it('soft-deletes the comment and its replies in one statement and decrements by that many', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT author_id, post_id, deleted_at FROM circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ author_id: 'u2', post_id: 'p1', deleted_at: null }] });
      if (/SET deleted_at = NOW\(\)/.test(sql)) return Promise.resolve({ rows: [{ id: 'cm1' }, { id: 'r1' }, { id: 'r2' }], rowCount: 3 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await deleteComment('cm1', 'u2', false);
    const del = sqlsCalled().find(s => /SET deleted_at = NOW\(\)/.test(s))!;
    expect(del).toMatch(/\(id = \$1 OR parent_comment_id = \$1\)/);
    expect(paramsOf(/comment_count = GREATEST\(comment_count - \$2, 0\)/)).toEqual(['p1', 3]);
  });
});

describe('sharePost — attribution to the root, never into the same circle', () => {
  function armShare(src: { id: string; circle_id: string; shared_from_post_id: string | null } | null, root?: { id: string; circle_id: string }) {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT p\.id, p\.circle_id, p\.shared_from_post_id/.test(sql)) return Promise.resolve({ rows: src ? [src] : [] });
      if (/SELECT id, circle_id FROM circle_posts WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) return Promise.resolve({ rows: root ? [root] : [] });
      if (/SELECT id, name FROM circles/.test(sql)) return Promise.resolve({ rows: [{ id: 'c2', name: 'Circle B' }] });
      if (/FROM circle_members WHERE/.test(sql)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (/count\(\*\)::text AS c FROM circle_posts/.test(sql)) return Promise.resolve({ rows: [{ c: '0' }] });
      if (/INSERT INTO circle_posts/.test(sql)) return Promise.resolve({ rows: [{ id: 'p-share', created_at: new Date() }] });
      if (/FROM circle_posts p JOIN users u/.test(sql)) return Promise.resolve({ rows: [{ id: 'p-share', circle_id: 'c2', author_id: 'u2', display_name: 'R', avatar_url: null, content: '', media: [], link_url: null, comment_count: 0, pinned_at: null, created_at: new Date(), reaction_count: 0, reactions: {}, my_reaction: null, shared_from: { id: 'p1', circleId: 'c1', circleName: 'Circle A', authorName: 'A', content: 'hi', media: [] } }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  }

  it('a share carries the original post id; sharing a share points at the root', async () => {
    armShare({ id: 'p-mid', circle_id: 'c3', shared_from_post_id: 'p1' }, { id: 'p1', circle_id: 'c1' });
    const out = await sharePost('p-mid', 'u2', { circleId: 'c2', clientId: '5b3f7d1e-0000-4000-8000-000000000009', content: '' });
    expect(paramsOf(/INSERT INTO circle_posts/)![6]).toBe('p1');
    expect(out.sharedFrom).toMatchObject({ id: 'p1', circleName: 'Circle A' });
    // A share with no words of its own is still a valid post.
    expect(sqlsCalled().some(s => /INSERT INTO circle_posts/.test(s))).toBe(true);
  });

  it('refuses to share a post into the circle it already lives in, and a blocked source reads as not found', async () => {
    armShare({ id: 'p1', circle_id: 'c2', shared_from_post_id: null });
    await expect(sharePost('p1', 'u2', { circleId: 'c2', clientId: '5b3f7d1e-0000-4000-8000-00000000000b' })).rejects.toMatchObject({ statusCode: 400 });
    armShare(null);
    await expect(sharePost('p1', 'u2', { circleId: 'c2', clientId: '5b3f7d1e-0000-4000-8000-00000000000c' })).rejects.toMatchObject({ statusCode: 404 });
    const src = sqlsCalled().find(s => /SELECT p\.id, p\.circle_id, p\.shared_from_post_id/.test(s))!;
    expect(src).toMatch(/b\.blocker_id = \$2 AND b\.blocked_id = p\.author_id/);
  });
});

describe('getPost — one post for the deep link, blocks respected', () => {
  it('returns the mapped post with reaction fields, or null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', circle_id: 'c1', author_id: 'a', display_name: 'A', avatar_url: null, content: 'x', media: [], link_url: null, comment_count: 2, pinned_at: null, created_at: new Date(), reaction_count: 3, reactions: { love: 3 }, my_reaction: 'love', shared_from: null }] });
    const p = await getPost('p1', 'viewer');
    expect(p).toMatchObject({ id: 'p1', reactionCount: 3, reactions: { love: 3 }, myReaction: 'love', sharedFrom: null });
    expect(sqlsCalled()[0]).toMatch(/b\.blocker_id = p\.author_id AND b\.blocked_id = \$2/);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getPost('gone', 'viewer')).toBeNull();
  });
});
