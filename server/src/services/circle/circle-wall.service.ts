// ─── Circle Wall Service ─────────────────────────────────────────────────────
//
// REASON v1 Phase 4 (20 Jul 2026). The feed inside a circle: text + images +
// external link shares (Stefan's wall answer), comments, pinning, moderation.
// First UGC system in the platform — the rules that matter:
//   * POSTING is circle-members-only; READING is any authenticated member.
//   * Blocks respected at read time (either direction) — the wall must not be
//     a harassment bypass around the DM/poke block system.
//   * Media = Cloudinary URLs only, validated here (host allowlist).
//   * link_url = first http(s) URL extracted from the content server-side; NO
//     fetching of it (SSRF) — the client renders a card from the URL itself.
//   * Rate limits: 6 posts/min, 20 comments/min per user.
//   * Keyset pagination (created_at, id) — never OFFSET.
//   * Soft delete only; counters move in the same transaction.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

export const POST_RATE_PER_MIN = 6;
export const COMMENT_RATE_PER_MIN = 20;
export const MEDIA_HOST_PREFIX = 'https://res.cloudinary.com/';
export const MAX_MEDIA_ITEMS = 4;

export interface WallMediaItem { type: 'image' | 'video'; url: string; meta?: Record<string, unknown> | null }

export interface WallPost {
  id: string;
  circleId: string;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  content: string;
  media: WallMediaItem[];
  linkUrl: string | null;
  commentCount: number;
  pinnedAt: Date | null;
  createdAt: Date;
}

// ── Guards ───────────────────────────────────────────────────────────────────

async function requireCircleMember(circleId: string, userId: string): Promise<void> {
  const r = await query(
    `SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2`,
    [circleId, userId],
  );
  if (r.rows.length === 0) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Join this circle to post');
  }
}

async function assertRate(userId: string, table: string, perMin: number, what: string): Promise<void> {
  const r = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM ${table}
     WHERE author_id = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
    [userId],
  );
  if (parseInt(r.rows[0].c, 10) >= perMin) {
    throw new AppError(429, ErrorCodes.VALIDATION_ERROR, `You're ${what} too fast — give it a moment`);
  }
}

export function validateMedia(media: unknown): WallMediaItem[] {
  if (media == null) return [];
  if (!Array.isArray(media)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'media must be an array');
  }
  if (media.length > MAX_MEDIA_ITEMS) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `At most ${MAX_MEDIA_ITEMS} attachments`);
  }
  return media.map((m: any) => {
    if (!m || (m.type !== 'image' && m.type !== 'video') || typeof m.url !== 'string') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Unsupported attachment');
    }
    // Defence-in-depth (same rule as DM attachments): only our Cloudinary
    // account's CDN — a hostile client can't smuggle arbitrary endpoints.
    if (!m.url.startsWith(MEDIA_HOST_PREFIX)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Attachments must be uploaded through the app');
    }
    return { type: m.type, url: m.url, meta: m.meta ?? null };
  });
}

/** First http(s) URL in the text becomes the link card. Never fetched. */
export function extractLinkUrl(content: string): string | null {
  const m = /https?:\/\/[^\s<>"')]+/i.exec(content);
  return m ? m[0].slice(0, 2000) : null;
}

// ── Posts ────────────────────────────────────────────────────────────────────

export async function createPost(
  circleId: string,
  userId: string,
  input: { clientId: string; content?: string; media?: unknown },
): Promise<WallPost> {
  const circle = await query(`SELECT id, name FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);
  await requireCircleMember(circleId, userId);
  await assertRate(userId, 'circle_posts', POST_RATE_PER_MIN, 'posting');

  const content = (input.content ?? '').trim();
  const media = validateMedia(input.media);
  if (!content && media.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Say something or attach something');
  }
  if (content.length > 8000) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Post too long (max 8000 characters)');
  }
  const linkUrl = extractLinkUrl(content);

  const inserted = await transaction(async (client) => {
    // UNIQUE(author_id, client_id) makes a retried submit return the original
    // post instead of double-posting.
    const ins = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO circle_posts (client_id, circle_id, author_id, content, media, link_url)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (author_id, client_id) DO NOTHING
       RETURNING id, created_at`,
      [input.clientId, circleId, userId, content, JSON.stringify(media), linkUrl],
    );
    if (ins.rows.length > 0) {
      await client.query(`UPDATE circles SET post_count = post_count + 1 WHERE id = $1`, [circleId]);
      return ins.rows[0];
    }
    const existing = await client.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM circle_posts WHERE author_id = $1 AND client_id = $2`,
      [userId, input.clientId],
    );
    return existing.rows[0];
  });

  // Bell the other circle members — ONE statement, deduped per member per
  // circle per hour so a busy wall never becomes a notification firehose.
  try {
    await query(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       SELECT gen_random_uuid(), m.user_id, 'circle_post', $3, $4, $5
       FROM circle_members m
       WHERE m.circle_id = $1 AND m.user_id <> $2
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = m.user_id AND n.type = 'circle_post' AND n.link = $5
             AND n.created_at > NOW() - INTERVAL '1 hour')`,
      [circleId, userId,
        `New post in ${circle.rows[0].name}`,
        content.slice(0, 120) || 'Shared an attachment',
        `/circles/${circleId}`],
    );
  } catch (err) {
    logger.warn({ err, circleId }, 'circle_post notifications failed (non-fatal)');
  }

  const post = await getPost(inserted.id, userId);
  return post!;
}

async function getPost(postId: string, viewerId: string): Promise<WallPost | null> {
  const r = await query<any>(
    `SELECT p.id, p.circle_id, p.author_id, u.display_name, u.avatar_url,
            p.content, p.media, p.link_url, p.comment_count, p.pinned_at, p.created_at
     FROM circle_posts p JOIN users u ON u.id = p.author_id
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [postId],
  );
  const row = r.rows[0];
  if (!row) return null;
  void viewerId;
  return mapPost(row);
}

function mapPost(row: any): WallPost {
  return {
    id: row.id, circleId: row.circle_id, authorId: row.author_id,
    authorName: row.display_name, authorAvatarUrl: row.avatar_url,
    content: row.content, media: row.media ?? [], linkUrl: row.link_url,
    commentCount: row.comment_count, pinnedAt: row.pinned_at, createdAt: row.created_at,
  };
}

const BLOCK_FILTER = `
  AND NOT EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE (b.blocker_id = $2 AND b.blocked_id = p.author_id)
       OR (b.blocker_id = p.author_id AND b.blocked_id = $2))`;

/** Keyset feed: newest first; cursor = "<epoch_ms>_<id>". Pinned served separately. */
export async function listPosts(
  circleId: string,
  viewerId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ pinned: WallPost[]; posts: WallPost[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const params: unknown[] = [circleId, viewerId];
  let keyset = '';
  if (opts.cursor) {
    const m = /^(\d+)_([0-9a-f-]{36})$/i.exec(opts.cursor);
    if (!m) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Bad cursor');
    params.push(new Date(Number(m[1])), m[2]);
    keyset = `AND (p.created_at, p.id) < ($3, $4::uuid)`;
  }

  const [pinned, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve({ rows: [] as any[] })
      : query<any>(
          `SELECT p.id, p.circle_id, p.author_id, u.display_name, u.avatar_url,
                  p.content, p.media, p.link_url, p.comment_count, p.pinned_at, p.created_at
           FROM circle_posts p JOIN users u ON u.id = p.author_id
           WHERE p.circle_id = $1 AND p.deleted_at IS NULL AND p.pinned_at IS NOT NULL
             ${BLOCK_FILTER}
           ORDER BY p.pinned_at DESC LIMIT 3`,
          [circleId, viewerId],
        ),
    query<any>(
      `SELECT p.id, p.circle_id, p.author_id, u.display_name, u.avatar_url,
              p.content, p.media, p.link_url, p.comment_count, p.pinned_at, p.created_at
       FROM circle_posts p JOIN users u ON u.id = p.author_id
       WHERE p.circle_id = $1 AND p.deleted_at IS NULL
         ${BLOCK_FILTER}
         ${keyset}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${limit + 1}`,
      params,
    ),
  ]);

  const rows = page.rows.slice(0, limit);
  const hasMore = page.rows.length > limit;
  const last = rows[rows.length - 1];
  return {
    pinned: pinned.rows.map(mapPost),
    posts: rows.map(mapPost),
    nextCursor: hasMore && last ? `${new Date(last.created_at).getTime()}_${last.id}` : null,
  };
}

/** Author soft-deletes their own post; admins delete any (checked in route). */
export async function deletePost(postId: string, userId: string, isAdmin: boolean): Promise<void> {
  await transaction(async (client) => {
    const r = await client.query<{ author_id: string; circle_id: string; deleted_at: Date | null }>(
      `SELECT author_id, circle_id, deleted_at FROM circle_posts WHERE id = $1 FOR UPDATE`,
      [postId],
    );
    const post = r.rows[0];
    if (!post || post.deleted_at) throw new NotFoundError('Post', postId);
    if (!isAdmin && post.author_id !== userId) {
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You can only delete your own posts');
    }
    await client.query(`UPDATE circle_posts SET deleted_at = NOW() WHERE id = $1`, [postId]);
    await client.query(
      `UPDATE circles SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1`,
      [post.circle_id],
    );
  });
}

export async function pinPost(postId: string, pin: boolean): Promise<void> {
  const r = await query(
    `UPDATE circle_posts SET pinned_at = ${pin ? 'NOW()' : 'NULL'}
     WHERE id = $1 AND deleted_at IS NULL`,
    [postId],
  );
  if (r.rowCount === 0) throw new NotFoundError('Post', postId);
}

// ── Comments ─────────────────────────────────────────────────────────────────

export async function addComment(
  postId: string,
  userId: string,
  content: string,
): Promise<{ id: string; createdAt: Date }> {
  const post = await query<{ circle_id: string }>(
    `SELECT circle_id FROM circle_posts WHERE id = $1 AND deleted_at IS NULL`, [postId]);
  if (post.rows.length === 0) throw new NotFoundError('Post', postId);
  await requireCircleMember(post.rows[0].circle_id, userId);
  await assertRate(userId, 'circle_post_comments', COMMENT_RATE_PER_MIN, 'commenting');

  const trimmed = content.trim();
  if (!trimmed) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment cannot be empty');
  if (trimmed.length > 4000) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment too long');

  return transaction(async (client) => {
    const ins = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO circle_post_comments (post_id, author_id, content)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [postId, userId, trimmed],
    );
    await client.query(
      `UPDATE circle_posts SET comment_count = comment_count + 1 WHERE id = $1`, [postId]);
    return { id: ins.rows[0].id, createdAt: ins.rows[0].created_at };
  });
}

export async function listComments(postId: string, viewerId: string): Promise<Array<{
  id: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  content: string; createdAt: Date;
}>> {
  const r = await query<any>(
    `SELECT c.id, c.author_id, u.display_name, u.avatar_url, c.content, c.created_at
     FROM circle_post_comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = $1 AND c.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = $2 AND b.blocked_id = c.author_id)
            OR (b.blocker_id = c.author_id AND b.blocked_id = $2))
     ORDER BY c.created_at ASC LIMIT 200`,
    [postId, viewerId],
  );
  return r.rows.map((row: any) => ({
    id: row.id, authorId: row.author_id, authorName: row.display_name,
    authorAvatarUrl: row.avatar_url, content: row.content, createdAt: row.created_at,
  }));
}

export async function deleteComment(commentId: string, userId: string, isAdmin: boolean): Promise<void> {
  await transaction(async (client) => {
    const r = await client.query<{ author_id: string; post_id: string; deleted_at: Date | null }>(
      `SELECT author_id, post_id, deleted_at FROM circle_post_comments WHERE id = $1 FOR UPDATE`,
      [commentId],
    );
    const c = r.rows[0];
    if (!c || c.deleted_at) throw new NotFoundError('Comment', commentId);
    if (!isAdmin && c.author_id !== userId) {
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You can only delete your own comments');
    }
    await client.query(`UPDATE circle_post_comments SET deleted_at = NOW() WHERE id = $1`, [commentId]);
    await client.query(
      `UPDATE circle_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1`,
      [c.post_id],
    );
  });
}
