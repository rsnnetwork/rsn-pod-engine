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
//
// 4 Sep 2026 (Ali): the wall behaves like a social feed. Reactions (one per
// member per post, five kinds), replies one level deep, likes on comments,
// share into another circle with attribution to the original post, and bells
// for the post author (reactions, comments) and the comment author (replies),
// deduped per post so a popular post never floods anyone.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

export const POST_RATE_PER_MIN = 6;
export const COMMENT_RATE_PER_MIN = 20;
export const MEDIA_HOST_PREFIX = 'https://res.cloudinary.com/';
export const MAX_MEDIA_ITEMS = 4;
export const REACTION_KINDS = ['like', 'love', 'applause', 'insightful', 'celebrate'] as const;
export type ReactionKind = typeof REACTION_KINDS[number];
/** A member reacting to the same post again within this window does not ring the bell again. */
export const REACTION_BELL_DEDUPE_MINUTES = 60;
/** Comments and replies on the same post within this window collapse into one bell entry. */
export const COMMENT_BELL_DEDUPE_MINUTES = 15;

export interface WallMediaItem { type: 'image' | 'video'; url: string; meta?: Record<string, unknown> | null }

export interface SharedFrom {
  id: string; circleId: string; circleName: string; authorName: string | null;
  content: string; media: WallMediaItem[];
}

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
  reactionCount: number;
  reactions: Partial<Record<ReactionKind, number>>;
  myReaction: ReactionKind | null;
  sharedFrom: SharedFrom | null;
}

export interface ReactionSummary {
  reactionCount: number;
  reactions: Partial<Record<ReactionKind, number>>;
  myReaction: ReactionKind | null;
}

// ── Guards ───────────────────────────────────────────────────────────────────

async function requireCircleMember(circleId: string, userId: string, what = 'post'): Promise<void> {
  const r = await query(
    `SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2`,
    [circleId, userId],
  );
  if (r.rows.length === 0) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, `Join this circle to ${what}`);
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

const postLink = (circleId: string, postId: string) => `/circles/${circleId}?post=${postId}`;
const excerpt = (content: string, fallback: string) => content.trim().slice(0, 120) || fallback;

/**
 * One bell entry, deduped per (recipient, type, link) inside a window, pushed
 * over the socket when it was actually inserted. Never throws: a bell must not
 * fail the reaction or comment it reports.
 */
async function bell(
  userId: string,
  type: 'circle_reaction' | 'circle_comment' | 'circle_reply',
  title: string,
  body: string,
  link: string,
  dedupeMinutes: number,
): Promise<void> {
  try {
    const r = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       SELECT gen_random_uuid(), $1, $2, $3, $4, $5
       WHERE NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = $1 AND n.type = $2 AND n.link = $5
           AND n.created_at > NOW() - make_interval(mins => $6::int))
       RETURNING id, created_at`,
      [userId, type, title, body, link, dedupeMinutes],
    );
    if (r.rows.length === 0) return;
    // Emit via dynamic import of the io instance (same pattern as pokes and invites).
    const { io } = await import('../../index');
    io.to(`user:${userId}`).emit('notification:new', {
      id: r.rows[0].id, type, title, body, link, isRead: false, createdAt: r.rows[0].created_at,
    });
  } catch (err) {
    logger.warn({ err, userId, type, link }, 'wall bell failed (non-fatal)');
  }
}

async function displayNameOf(userId: string): Promise<string> {
  const r = await query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.display_name?.trim() || 'A member';
}

// ── Posts ────────────────────────────────────────────────────────────────────

/** The post columns every read shares. $2 is always the viewer. */
const POST_SELECT = `
  SELECT p.id, p.circle_id, p.author_id, u.display_name, u.avatar_url,
         p.content, p.media, p.link_url, p.comment_count, p.pinned_at, p.created_at,
         (SELECT count(*)::int FROM circle_post_reactions r WHERE r.post_id = p.id) AS reaction_count,
         (SELECT COALESCE(json_object_agg(x.reaction, x.n), '{}'::json)
            FROM (SELECT reaction, count(*)::int AS n FROM circle_post_reactions WHERE post_id = p.id GROUP BY reaction) x) AS reactions,
         (SELECT r.reaction FROM circle_post_reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS my_reaction,
         (SELECT json_build_object('id', o.id, 'circleId', o.circle_id, 'circleName', oc.name,
                                   'authorName', ou.display_name, 'content', left(o.content, 600), 'media', o.media)
            FROM circle_posts o
            JOIN circles oc ON oc.id = o.circle_id
            JOIN users ou ON ou.id = o.author_id
           WHERE o.id = p.shared_from_post_id AND o.deleted_at IS NULL) AS shared_from
  FROM circle_posts p JOIN users u ON u.id = p.author_id`;

export async function createPost(
  circleId: string,
  userId: string,
  input: { clientId: string; content?: string; media?: unknown; sharedFromPostId?: string | null },
): Promise<WallPost> {
  const circle = await query(`SELECT id, name FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);
  await requireCircleMember(circleId, userId);
  await assertRate(userId, 'circle_posts', POST_RATE_PER_MIN, 'posting');

  const content = (input.content ?? '').trim();
  const media = validateMedia(input.media);
  const sharedFromPostId = input.sharedFromPostId ?? null;
  if (!content && media.length === 0 && !sharedFromPostId) {
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
      `INSERT INTO circle_posts (client_id, circle_id, author_id, content, media, link_url, shared_from_post_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (author_id, client_id) DO NOTHING
       RETURNING id, created_at`,
      [input.clientId, circleId, userId, content, JSON.stringify(media), linkUrl, sharedFromPostId],
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
        content.slice(0, 120) || (sharedFromPostId ? 'Shared a post' : 'Shared an attachment'),
        `/circles/${circleId}`],
    );
  } catch (err) {
    logger.warn({ err, circleId }, 'circle_post notifications failed (non-fatal)');
  }

  const post = await getPost(inserted.id, userId);
  return post!;
}

/** One post as its viewer sees it; null when it is gone or blocked either way. */
export async function getPost(postId: string, viewerId: string): Promise<WallPost | null> {
  const r = await query<any>(
    `${POST_SELECT}
     WHERE p.id = $1 AND p.deleted_at IS NULL
       ${BLOCK_FILTER}`,
    [postId, viewerId],
  );
  const row = r.rows[0];
  return row ? mapPost(row) : null;
}

function mapPost(row: any): WallPost {
  return {
    id: row.id, circleId: row.circle_id, authorId: row.author_id,
    authorName: row.display_name, authorAvatarUrl: row.avatar_url,
    content: row.content, media: row.media ?? [], linkUrl: row.link_url,
    commentCount: row.comment_count, pinnedAt: row.pinned_at, createdAt: row.created_at,
    reactionCount: row.reaction_count ?? 0,
    reactions: row.reactions ?? {},
    myReaction: row.my_reaction ?? null,
    sharedFrom: row.shared_from ?? null,
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
          `${POST_SELECT}
           WHERE p.circle_id = $1 AND p.deleted_at IS NULL AND p.pinned_at IS NOT NULL
             ${BLOCK_FILTER}
           ORDER BY p.pinned_at DESC LIMIT 3`,
          [circleId, viewerId],
        ),
    query<any>(
      `${POST_SELECT}
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

/**
 * Share a post into another circle: a new post there, by the sharer, carrying
 * the ORIGINAL post (sharing a share points at the root, so attribution never
 * drifts). The sharer must be a member of the target circle (createPost
 * enforces it) and must not be blocked either way by the original author.
 */
export async function sharePost(
  postId: string,
  userId: string,
  input: { circleId: string; clientId: string; content?: string },
): Promise<WallPost> {
  const src = await query<{ id: string; circle_id: string; shared_from_post_id: string | null }>(
    `SELECT p.id, p.circle_id, p.shared_from_post_id
     FROM circle_posts p
     WHERE p.id = $1 AND p.deleted_at IS NULL
       ${BLOCK_FILTER}`,
    [postId, userId],
  );
  if (src.rows.length === 0) throw new NotFoundError('Post', postId);

  let root = { id: src.rows[0].id, circleId: src.rows[0].circle_id };
  if (src.rows[0].shared_from_post_id) {
    const orig = await query<{ id: string; circle_id: string }>(
      `SELECT id, circle_id FROM circle_posts WHERE id = $1 AND deleted_at IS NULL`,
      [src.rows[0].shared_from_post_id],
    );
    if (orig.rows.length > 0) root = { id: orig.rows[0].id, circleId: orig.rows[0].circle_id };
  }
  if (root.circleId === input.circleId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'That post is already in this circle. Copy its link instead.');
  }
  return createPost(input.circleId, userId, {
    clientId: input.clientId, content: input.content ?? '', media: [], sharedFromPostId: root.id,
  });
}

// ── Reactions ────────────────────────────────────────────────────────────────

async function reactionSummary(postId: string, viewerId: string): Promise<ReactionSummary> {
  const r = await query<{ reaction: ReactionKind; n: number; mine: boolean }>(
    `SELECT reaction, count(*)::int AS n, bool_or(user_id = $2) AS mine
     FROM circle_post_reactions WHERE post_id = $1 GROUP BY reaction`,
    [postId, viewerId],
  );
  const reactions: Partial<Record<ReactionKind, number>> = {};
  let reactionCount = 0;
  let myReaction: ReactionKind | null = null;
  for (const row of r.rows) {
    reactions[row.reaction] = row.n;
    reactionCount += row.n;
    if (row.mine) myReaction = row.reaction;
  }
  return { reactionCount, reactions, myReaction };
}

/**
 * Set (or with null, remove) the member's one reaction on a post. Members
 * only, like commenting. The author hears about it once per post per hour.
 */
export async function reactToPost(
  postId: string,
  userId: string,
  reaction: ReactionKind | null,
): Promise<ReactionSummary> {
  if (reaction !== null && !REACTION_KINDS.includes(reaction)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Unknown reaction');
  }
  const post = await query<{ circle_id: string; author_id: string; content: string }>(
    `SELECT circle_id, author_id, content FROM circle_posts WHERE id = $1 AND deleted_at IS NULL`, [postId]);
  if (post.rows.length === 0) throw new NotFoundError('Post', postId);
  const { circle_id: circleId, author_id: authorId, content } = post.rows[0];
  await requireCircleMember(circleId, userId, 'react');

  if (reaction) {
    await query(
      `INSERT INTO circle_post_reactions (post_id, user_id, reaction) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = NOW()`,
      [postId, userId, reaction],
    );
    if (authorId !== userId) {
      const name = await displayNameOf(userId);
      await bell(authorId, 'circle_reaction', `${name} reacted to your post`,
        excerpt(content, 'Your post on the wall'), postLink(circleId, postId), REACTION_BELL_DEDUPE_MINUTES);
    }
  } else {
    await query(`DELETE FROM circle_post_reactions WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
  }
  return reactionSummary(postId, userId);
}

// ── Comments ─────────────────────────────────────────────────────────────────

export async function addComment(
  postId: string,
  userId: string,
  content: string,
  parentCommentId?: string | null,
): Promise<{ id: string; createdAt: Date; parentCommentId: string | null }> {
  const post = await query<{ circle_id: string; author_id: string; content: string }>(
    `SELECT circle_id, author_id, content FROM circle_posts WHERE id = $1 AND deleted_at IS NULL`, [postId]);
  if (post.rows.length === 0) throw new NotFoundError('Post', postId);
  const { circle_id: circleId, author_id: postAuthorId, content: postContent } = post.rows[0];
  await requireCircleMember(circleId, userId, 'comment');
  await assertRate(userId, 'circle_post_comments', COMMENT_RATE_PER_MIN, 'commenting');

  const trimmed = content.trim();
  if (!trimmed) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment cannot be empty');
  if (trimmed.length > 4000) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment too long');

  // One level of replies: a reply to a reply hangs under the top-level comment,
  // but the bell goes to the person actually replied to.
  let attachTo: string | null = null;
  let repliedToAuthor: string | null = null;
  if (parentCommentId) {
    const parent = await query<{ id: string; author_id: string; parent_comment_id: string | null }>(
      `SELECT id, author_id, parent_comment_id FROM circle_post_comments
       WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL`,
      [parentCommentId, postId],
    );
    if (parent.rows.length === 0) throw new NotFoundError('Comment', parentCommentId);
    attachTo = parent.rows[0].parent_comment_id ?? parent.rows[0].id;
    repliedToAuthor = parent.rows[0].author_id;
  }

  const made = await transaction(async (client) => {
    const ins = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO circle_post_comments (post_id, author_id, content, parent_comment_id)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [postId, userId, trimmed, attachTo],
    );
    await client.query(
      `UPDATE circle_posts SET comment_count = comment_count + 1 WHERE id = $1`, [postId]);
    return { id: ins.rows[0].id, createdAt: ins.rows[0].created_at, parentCommentId: attachTo };
  });

  const link = postLink(circleId, postId);
  const name = await displayNameOf(userId);
  if (repliedToAuthor && repliedToAuthor !== userId) {
    await bell(repliedToAuthor, 'circle_reply', `${name} replied to your comment`,
      excerpt(trimmed, 'See the reply'), link, COMMENT_BELL_DEDUPE_MINUTES);
  }
  if (postAuthorId !== userId && postAuthorId !== repliedToAuthor) {
    await bell(postAuthorId, 'circle_comment', `${name} commented on your post`,
      excerpt(trimmed, excerpt(postContent, 'See the comment')), link, COMMENT_BELL_DEDUPE_MINUTES);
  }
  return made;
}

export interface WallComment {
  id: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  content: string; createdAt: Date; parentCommentId: string | null;
  likeCount: number; likedByMe: boolean;
}

export async function listComments(postId: string, viewerId: string): Promise<WallComment[]> {
  const r = await query<any>(
    `SELECT c.id, c.author_id, u.display_name, u.avatar_url, c.content, c.created_at, c.parent_comment_id,
            (SELECT count(*)::int FROM circle_comment_likes l WHERE l.comment_id = c.id) AS like_count,
            EXISTS (SELECT 1 FROM circle_comment_likes l WHERE l.comment_id = c.id AND l.user_id = $2) AS liked_by_me
     FROM circle_post_comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = $1 AND c.deleted_at IS NULL
       AND (c.parent_comment_id IS NULL OR EXISTS (
         SELECT 1 FROM circle_post_comments pc WHERE pc.id = c.parent_comment_id AND pc.deleted_at IS NULL))
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = $2 AND b.blocked_id = c.author_id)
            OR (b.blocker_id = c.author_id AND b.blocked_id = $2))
     ORDER BY c.created_at ASC LIMIT 400`,
    [postId, viewerId],
  );
  return r.rows.map((row: any) => ({
    id: row.id, authorId: row.author_id, authorName: row.display_name,
    authorAvatarUrl: row.avatar_url, content: row.content, createdAt: row.created_at,
    parentCommentId: row.parent_comment_id ?? null,
    likeCount: row.like_count ?? 0, likedByMe: !!row.liked_by_me,
  }));
}

/** Like or unlike a comment. Members only. No bell: a like on a comment is a nod, not news. */
export async function likeComment(
  commentId: string,
  userId: string,
  liked: boolean,
): Promise<{ likeCount: number; likedByMe: boolean }> {
  const c = await query<{ circle_id: string }>(
    `SELECT p.circle_id FROM circle_post_comments c JOIN circle_posts p ON p.id = c.post_id
     WHERE c.id = $1 AND c.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [commentId],
  );
  if (c.rows.length === 0) throw new NotFoundError('Comment', commentId);
  await requireCircleMember(c.rows[0].circle_id, userId, 'like comments');
  if (liked) {
    await query(
      `INSERT INTO circle_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [commentId, userId],
    );
  } else {
    await query(`DELETE FROM circle_comment_likes WHERE comment_id = $1 AND user_id = $2`, [commentId, userId]);
  }
  const n = await query<{ like_count: number; liked_by_me: boolean }>(
    `SELECT count(*)::int AS like_count, bool_or(user_id = $2) AS liked_by_me
     FROM circle_comment_likes WHERE comment_id = $1`,
    [commentId, userId],
  );
  return { likeCount: n.rows[0]?.like_count ?? 0, likedByMe: !!n.rows[0]?.liked_by_me };
}

/** Author or admin soft-deletes a comment; its replies go with it, and the count moves by all of them. */
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
    const gone = await client.query<{ id: string }>(
      `UPDATE circle_post_comments SET deleted_at = NOW()
       WHERE (id = $1 OR parent_comment_id = $1) AND deleted_at IS NULL
       RETURNING id`,
      [commentId],
    );
    await client.query(
      `UPDATE circle_posts SET comment_count = GREATEST(comment_count - $2, 0) WHERE id = $1`,
      [c.post_id, Math.max(gone.rowCount ?? 1, 1)],
    );
  });
}
