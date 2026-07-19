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

import {
  validateMedia, extractLinkUrl, createPost, listPosts, deletePost, addComment,
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
      if (/SELECT circle_id FROM circle_posts/.test(sql)) return Promise.resolve({ rows: [{ circle_id: 'c1' }] });
      if (/FROM circle_members WHERE/.test(sql)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (/count\(\*\)::text AS c FROM circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ c: '0' }] });
      if (/INSERT INTO circle_post_comments/.test(sql)) return Promise.resolve({ rows: [{ id: 'cm1', created_at: new Date() }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await addComment('p1', 'u1', 'nice one');
    expect(mockQuery.mock.calls.some(c => /comment_count = comment_count \+ 1/.test(c[0] as string))).toBe(true);
  });
});
