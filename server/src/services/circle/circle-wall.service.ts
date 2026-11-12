// ─── Circle Wall Service ─────────────────────────────────────────────────────
//
// REASON v1 Phase 4 (20 Jul 2026). The feed inside a circle: text + images +
// external link shares (Stefan's wall answer), comments, pinning, moderation.
// First UGC system in the platform — the rules that matter:
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
//
// Shirley pilot S4 (11 Nov 2026): the circle wall is brought to the pod wall's standard (pod-wall.service.ts).
//   * D2: every circle's wall is read by its members only (and platform admins, who read and moderate every wall and
//     do not post). Someone outside an open circle is told to join; outside a closed one, CIRCLE_CLOSED_READ. Any read
//     or write that names a POST (one post, its comments, a reaction, a comment, a share) answers someone outside the
//     circle exactly as it answers a post that does not exist, so a post id never confirms anything to them.
//   * D3: the circle's owner and moderators (and platform admins) delete anyone's post or comment and pin and unpin.
//     Moderation is recorded in audit_log with a snapshot of the words (wall-moderation.ts). At most three pinned.
//   * Authors edit their own posts and comments while they are in the circle and it is not archived ("Edited").
//     D8: someone no longer in the circle may still delete their own words, and nothing else.
//   * An archived circle's wall is read-only: no new posts, comments, reactions, likes or edits. Moderation and taking
//     back your own words are never switched off.
//   * Every write tells the circle's members by entity tag (fanoutCircleWall: circle:<id>:wall, circle-wall-post:<id>),
//     so the screen never polls. A write that changed nothing (a retried post, the same reaction again) tells nobody.
//   * Every bell honours blocks both ways, the person still being in the circle, an open account and their group-bell
//     setting, and is pushed live. The new-post bell opens the post (?post=), at most one per member per circle per hour.

import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { fanoutCircleWall, fanoutCircleWallShares } from '../../realtime/fanout';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { FORMER_MEMBER_NAME, activeMemberSql } from '../users/active-member';
import { isPlatformAdmin } from './circle-managers';
import {
  EDIT_EMPTY_COMMENT, EDIT_EMPTY_POST, ONLY_OWN_EDITS, WALL_PINNED_MAX, commentBellLink, commentRemoved, editConflict,
  editStampHolds, pinsFull, postRemoved, purgeCommentBells, purgePostBells, recordModeration, tellBellOwners,
} from '../wall/wall-moderation';

/** What a reader outside a closed circle is told by every read of its wall (30 Oct review 7.5). */
export const CIRCLE_CLOSED_READ = 'This circle is closed. Ask to join to see its wall, members and events.';
/** S4 (D2): what someone outside an open circle is told by its feed. */
export const CIRCLE_WALL_MEMBERS_ONLY = 'Members talk here. Join this circle to read and post on its wall.';
/** A closed circle's posts are not carried into another circle, by anyone. */
export const CLOSED_POST_STAYS = 'Posts in a closed circle stay in it.';
export const CIRCLE_ARCHIVED_READ_ONLY = 'This circle is archived, so its wall is read-only.';
const JOIN_TO_POST = 'Join this circle to post on its wall.';
const POST_MISSING = 'That post could not be found';
const COMMENT_MISSING = 'That comment could not be found';
const ONLY_OWN_POSTS = 'You can only delete your own posts';
const ONLY_OWN_COMMENTS = 'You can only delete your own comments';
const ONLY_MODERATORS_PIN = "Only the circle's owner or a moderator can pin posts";
const NO_LONGER_IN = 'You are no longer in this circle. You can still delete your own posts and comments.';

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
const POST_MAX_CHARS = 8000;
const COMMENT_MAX_CHARS = 4000;
const COMMENTS_SHOWN = 400;
const BELL_EXCERPT_CHARS = 120;

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
  /** T2 (1 Nov 2026): the author's account was removed, suspended or banned; the post stays as "Former member". */
  authorClosed: boolean;
  content: string;
  media: WallMediaItem[];
  linkUrl: string | null;
  commentCount: number;
  pinnedAt: Date | null;
  createdAt: Date;
  /** S4: when its author last changed its words; null when never. */
  editedAt: Date | null;
  reactionCount: number;
  reactions: Partial<Record<ReactionKind, number>>;
  myReaction: ReactionKind | null;
  sharedFrom: SharedFrom | null;
  /** S4 fix round 1: a share whose original the viewer may not see; drawn as "This post isn't available". */
  sharedUnavailable: boolean;
}

export interface ReactionSummary {
  reactionCount: number;
  reactions: Partial<Record<ReactionKind, number>>;
  myReaction: ReactionKind | null;
}

/** What the viewer may do on this circle's wall; the screen draws only what this allows. */
export interface CircleWallViewer {
  /** Post, comment, reply, react, like and edit their own: a member of a circle that is not archived. */
  canPost: boolean;
  /** Delete anyone's post or comment, pin and unpin: the circle's owner or a moderator, or a platform admin. */
  canModerate: boolean;
}

export interface CircleWallFeed {
  pinned: WallPost[];
  posts: WallPost[];
  nextCursor: string | null;
  viewer: CircleWallViewer;
}

const postNotFound = (id: string) => new NotFoundError('Post', id, POST_MISSING);
const commentNotFound = (id: string) => new NotFoundError('Comment', id, COMMENT_MISSING);

// ── Who may do what ──────────────────────────────────────────────────────────

interface AccessRow {
  name: string;
  archived: boolean;
  join_policy: string | null;
  member_role: string | null;
  viewer_name: string | null;
}

interface CircleWallAccess {
  circleName: string;
  joinPolicy: string | null;
  archived: boolean;
  viewerName: string | null;
  /** In the circle (any role). */
  isMember: boolean;
  /** May read: in the circle, or a platform admin. */
  mayRead: boolean;
  canPost: boolean;
  canModerate: boolean;
}

/** The circle and the viewer's place in it, in one read. Null when there is no such circle. */
async function readAccess(circleId: string, viewerId: string, viewerRole?: string): Promise<CircleWallAccess | null> {
  const r = await query<AccessRow>(
    `SELECT c.name, (c.archived_at IS NOT NULL) AS archived, c.join_policy, m.role AS member_role,
            (SELECT u.display_name FROM users u WHERE u.id = $2) AS viewer_name
       FROM circles c
       LEFT JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $2
      WHERE c.id = $1`,
    [circleId, viewerId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const isAdmin = isPlatformAdmin(viewerRole);
  const isMember = !!row.member_role;
  return {
    circleName: row.name,
    joinPolicy: row.join_policy,
    archived: !!row.archived,
    viewerName: row.viewer_name,
    isMember,
    mayRead: isMember || isAdmin,
    canPost: isMember && !row.archived,
    canModerate: isAdmin || row.member_role === 'owner' || row.member_role === 'moderator',
  };
}

/**
 * The feed's gate (D2): the circle's members and platform admins read its wall; anyone else is told how to get in
 * (a closed circle in its own words). A circle that does not exist is a 404.
 */
async function resolveWallAccess(circleId: string, viewerId: string, viewerRole?: string): Promise<CircleWallAccess> {
  const access = await readAccess(circleId, viewerId, viewerRole);
  if (!access) throw new NotFoundError('Circle', circleId);
  if (access.mayRead) return access;
  if (access.joinPolicy === 'closed') throw new AppError(403, ErrorCodes.CIRCLE_CLOSED, CIRCLE_CLOSED_READ);
  throw new ForbiddenError(CIRCLE_WALL_MEMBERS_ONLY);
}

/** Every read of a circle's wall asks this first (kept for callers that name the circle). */
export async function assertMayReadWall(circleId: string, viewerId: string, viewerRole?: string): Promise<void> {
  await resolveWallAccess(circleId, viewerId, viewerRole);
}

/** Post, comment, reply, react, like, edit: a member of a circle that is not archived. */
function requireCanPost(access: CircleWallAccess): void {
  if (!access.isMember) throw new ForbiddenError(JOIN_TO_POST);
  if (access.archived) throw new AppError(409, ErrorCodes.CIRCLE_ARCHIVED, CIRCLE_ARCHIVED_READ_ONLY);
}

interface PostHead { circleId: string; authorId: string; content: string }

/**
 * A post as one viewer may reach it, with their access to its circle. Missing, in a circle the viewer is not in,
 * or by someone blocked either way: all answered the same 404, so a post id confirms nothing. Removed: "This post
 * was removed." (only someone who may read the circle gets that far).
 */
async function postInReach(postId: string, viewerId: string, viewerRole?: string): Promise<{ post: PostHead; access: CircleWallAccess }> {
  const r = await query<{ circle_id: string; author_id: string; content: string; deleted_at: Date | null; blocked: boolean }>(
    `SELECT p.circle_id, p.author_id, p.content, p.deleted_at,
            EXISTS (SELECT 1 FROM user_blocks b
                     WHERE (b.blocker_id = $2 AND b.blocked_id = p.author_id)
                        OR (b.blocker_id = p.author_id AND b.blocked_id = $2)) AS blocked
       FROM circle_posts p WHERE p.id = $1`,
    [postId, viewerId],
  );
  const row = r.rows[0];
  if (!row) throw postNotFound(postId);
  const access = await readAccess(row.circle_id, viewerId, viewerRole);
  if (!access?.mayRead || row.blocked) throw postNotFound(postId);
  if (row.deleted_at) throw postRemoved(postId);
  return { post: { circleId: row.circle_id, authorId: row.author_id, content: row.content }, access };
}

/** The viewer's role in a circle, read on the transaction's own client. */
async function roleInCircle(
  client: PoolClient,
  circleId: string,
  userId: string,
): Promise<string | null> {
  const r = await client.query<{ role: string }>(
    `SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, userId]);
  return r.rows[0]?.role ?? null;
}

const moderatesWith = (role: string | null, platformRole?: string) =>
  isPlatformAdmin(platformRole) || role === 'owner' || role === 'moderator';

/** The tables a wall counts a member's recent writes in. Named, never typed in, because the name is written into the SQL. */
export type RateCountedTable = 'circle_posts' | 'circle_post_comments' | 'pod_posts' | 'pod_post_comments';

export async function assertRate(userId: string, table: RateCountedTable, perMin: number, what: string): Promise<void> {
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
  // `any`: the items arrive as unchecked JSON; each one's shape is checked here before it is used.
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

// ── Bells ────────────────────────────────────────────────────────────────────

type CircleBellType = 'circle_post' | 'circle_reaction' | 'circle_comment' | 'circle_reply';

interface BellPayload { type: CircleBellType; title: string; body: string; link: string }
interface BellRow { id: string; user_id: string; created_at: Date }

/** The circle's page, where its wall is. Every bell about the wall links here or under it (`?post=`). */
const circleLink = (circleId: string) => `/circles/${circleId}`;
const postLink = (circleId: string, postId: string) => `/circles/${circleId}?post=${postId}`;
/** The first 120 characters, counted as characters so a picture or emoji is never cut in half. */
const excerpt = (text: string, fallback: string) =>
  Array.from(text.trim()).slice(0, BELL_EXCERPT_CHARS).join('') || fallback;

/** Pushes bells that were just written to their people: `notification:new` on their own room and their bell tag. */
async function pushBells(rows: BellRow[], bell: BellPayload): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  for (const row of rows) {
    try {
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id, type: bell.type, title: bell.title, body: bell.body, link: bell.link,
        isRead: false, createdAt: row.created_at,
      });
      await emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)]);
    } catch (err) {
      logger.warn({ err, userId: row.user_id, type: bell.type }, 'circle wall bell push failed (non-fatal)');
    }
  }
}

/**
 * A new post rings the circle's other members, once per member per circle per hour, in ONE statement: members whose
 * account is open, who have not switched group bells off, who are not blocked by the author or blocking them, and who
 * have not had a new-post bell for this circle in the hour (its link is the circle's page or under it). The bell opens
 * the post. Never throws: a bell must not fail the post it reports.
 */
async function ringCircleMembers(circleId: string, authorId: string, bell: Omit<BellPayload, 'type'>): Promise<void> {
  try {
    const inserted = await query<BellRow>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       SELECT gen_random_uuid(), m.user_id, 'circle_post', $3::text, $4::text, $5::text
       FROM circle_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = $1 AND m.user_id <> $2
         AND u.status = 'active'
         AND COALESCE((u.notification_prefs->>'group_bell')::boolean, true)
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = m.user_id AND b.blocked_id = $2)
              OR (b.blocker_id = $2 AND b.blocked_id = m.user_id))
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = m.user_id AND n.type = 'circle_post'
             AND (n.link = $6::text OR starts_with(n.link, $6::text || '?'))
             AND n.created_at > NOW() - INTERVAL '1 hour')
       RETURNING id, user_id, created_at`,
      [circleId, authorId, bell.title, bell.body, bell.link, circleLink(circleId)],
    );
    await pushBells(inserted.rows, { type: 'circle_post', ...bell });
  } catch (err) {
    logger.warn({ err, circleId }, 'circle_post bells failed (non-fatal)');
  }
}

/**
 * One bell to one person about something another member did, deduped per (person, type, post) inside a window: the
 * post's link, or a comment's link under it (S4 fix round 1: a comment's bell names the comment, so it can be removed
 * with it). They must still be in the circle, with an open account and group bells on, and not blocked by the actor or
 * blocking them. Never throws.
 */
async function ringOne(
  circleId: string,
  recipientId: string,
  actorId: string,
  bell: BellPayload & { postLink: string },
  dedupeMinutes: number,
): Promise<void> {
  try {
    const inserted = await query<BellRow>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       SELECT gen_random_uuid(), u.id, $3::text, $4::text, $5::text, $6::text
       FROM users u
       WHERE u.id = $1 AND u.status = 'active'
         AND COALESCE((u.notification_prefs->>'group_bell')::boolean, true)
         AND EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = $2 AND m.user_id = u.id)
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = u.id AND b.blocked_id = $7)
              OR (b.blocker_id = $7 AND b.blocked_id = u.id))
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = $3::text
             AND (n.link = $9::text OR starts_with(n.link, $9::text || '&'))
             AND n.created_at > NOW() - make_interval(mins => $8::int))
       RETURNING id, user_id, created_at`,
      [recipientId, circleId, bell.type, bell.title, bell.body, bell.link, actorId, dedupeMinutes, bell.postLink],
    );
    await pushBells(inserted.rows, { type: bell.type, title: bell.title, body: bell.body, link: bell.link });
  } catch (err) {
    logger.warn({ err, circleId, recipientId, type: bell.type }, 'circle wall bell failed (non-fatal)');
  }
}

const nameOf = (access: CircleWallAccess) => access.viewerName?.trim() || 'A member';

// ── Posts ────────────────────────────────────────────────────────────────────

/** The post columns every read shares. $2 is always the viewer. */
const POST_SELECT = `
  SELECT p.id, p.circle_id, p.author_id, u.display_name, u.avatar_url, (NOT ${activeMemberSql('u')}) AS author_former,
         p.content, p.media, p.link_url, p.comment_count, p.pinned_at, p.created_at, p.edited_at, p.shared_from_post_id,
         (SELECT count(*)::int FROM circle_post_reactions r WHERE r.post_id = p.id) AS reaction_count,
         (SELECT COALESCE(json_object_agg(x.reaction, x.n), '{}'::json)
            FROM (SELECT reaction, count(*)::int AS n FROM circle_post_reactions WHERE post_id = p.id GROUP BY reaction) x) AS reactions,
         (SELECT r.reaction FROM circle_post_reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS my_reaction,
         (SELECT json_build_object('id', o.id, 'circleId', o.circle_id, 'circleName', oc.name,
                                   'authorName', CASE WHEN ${activeMemberSql('ou')} THEN ou.display_name ELSE '${FORMER_MEMBER_NAME}' END,
                                   'content', left(o.content, 600), 'media', o.media)
            FROM circle_posts o
            JOIN circles oc ON oc.id = o.circle_id
            JOIN users ou ON ou.id = o.author_id
           WHERE o.id = p.shared_from_post_id AND o.deleted_at IS NULL
             AND (oc.join_policy <> 'closed'
                  OR EXISTS (SELECT 1 FROM circle_members om WHERE om.circle_id = o.circle_id AND om.user_id = $2))
             -- S4 fix round 1: blocks win on a share card too, either way (neither the words nor the name).
             AND NOT EXISTS (SELECT 1 FROM user_blocks ob
                              WHERE (ob.blocker_id = $2 AND ob.blocked_id = o.author_id)
                                 OR (ob.blocker_id = o.author_id AND ob.blocked_id = $2))) AS shared_from
  FROM circle_posts p JOIN users u ON u.id = p.author_id`;

export const BLOCK_FILTER = `
  AND NOT EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE (b.blocker_id = $2 AND b.blocked_id = p.author_id)
       OR (b.blocker_id = p.author_id AND b.blocked_id = $2))`;

interface OwnPostRow { id: string; circle_id: string; deleted_at: Date | null }

async function findOwnPost(userId: string, clientId: string): Promise<OwnPostRow | null> {
  const r = await query<OwnPostRow>(
    `SELECT id, circle_id, deleted_at FROM circle_posts WHERE author_id = $1 AND client_id = $2`,
    [userId, clientId],
  );
  return r.rows[0] ?? null;
}

/** A retried submit answers the post that was made the first time, and does nothing else. */
async function answerRetry(circleId: string, viewerId: string, first: OwnPostRow): Promise<WallPost> {
  if (first.circle_id !== circleId) throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'That post was already sent');
  if (first.deleted_at) throw postRemoved(first.id);
  const post = await readPost(first.id, viewerId);
  if (!post) throw postNotFound(first.id);
  return post;
}

export async function createPost(
  circleId: string,
  userId: string,
  input: { clientId: string; content?: string; media?: unknown; sharedFromPostId?: string | null },
): Promise<WallPost> {
  const access = await resolveWallAccess(circleId, userId);
  requireCanPost(access);

  const content = (input.content ?? '').trim();
  const media = validateMedia(input.media);
  const sharedFromPostId = input.sharedFromPostId ?? null;
  if (!content && media.length === 0 && !sharedFromPostId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Say something or attach something');
  }
  if (content.length > POST_MAX_CHARS) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Post too long (max ${POST_MAX_CHARS} characters)`);
  }

  // Before the rate cap: a retry posts nothing, so it must succeed even for a member at the cap, and rings nobody.
  const first = await findOwnPost(userId, input.clientId);
  if (first) return answerRetry(circleId, userId, first);
  await assertRate(userId, 'circle_posts', POST_RATE_PER_MIN, 'posting');

  const postId = await transaction(async (client) => {
    // UNIQUE(author_id, client_id) makes a retried submit return the original post instead of double-posting.
    const ins = await client.query<{ id: string }>(
      `INSERT INTO circle_posts (client_id, circle_id, author_id, content, media, link_url, shared_from_post_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (author_id, client_id) DO NOTHING
       RETURNING id`,
      [input.clientId, circleId, userId, content, JSON.stringify(media), extractLinkUrl(content), sharedFromPostId],
    );
    if (ins.rows.length === 0) return null;
    await client.query(`UPDATE circles SET post_count = post_count + 1 WHERE id = $1`, [circleId]);
    return ins.rows[0].id;
  });
  if (!postId) {
    // Its own twin, sent at the same moment, won the insert.
    const twin = await findOwnPost(userId, input.clientId);
    if (!twin) throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'That post was already sent');
    return answerRetry(circleId, userId, twin);
  }

  await ringCircleMembers(circleId, userId, {
    title: `New post in ${access.circleName}`,
    body: excerpt(content, sharedFromPostId ? 'Shared a post' : 'Shared an attachment'),
    link: postLink(circleId, postId),
  });
  await fanoutCircleWall(circleId);
  const post = await readPost(postId, userId);
  if (!post) throw postNotFound(postId);
  return post;
}

async function readPost(postId: string, viewerId: string): Promise<WallPost | null> {
  const r = await query<any>(
    `${POST_SELECT}
     WHERE p.id = $1 AND p.deleted_at IS NULL
       ${BLOCK_FILTER}`,
    [postId, viewerId],
  );
  const row = r.rows[0];
  return row ? mapPost(row) : null;
}

/**
 * One post as its viewer sees it (backs a ?post= link). Null when it is gone, blocked either way, or in a circle the
 * viewer is not in: all the same answer, so a link confirms nothing to someone outside (D2).
 */
export async function getPost(postId: string, viewerId: string, viewerRole?: string): Promise<WallPost | null> {
  const post = await readPost(postId, viewerId);
  if (!post) return null;
  const access = await readAccess(post.circleId, viewerId, viewerRole);
  return access?.mayRead ? post : null;
}

/** An author whose account is not active keeps their words, as "Former member" with no picture (T2). */
function authorOf(row: { display_name: string | null; avatar_url: string | null; author_former: boolean | null }) {
  return row.author_former
    ? { authorName: FORMER_MEMBER_NAME, authorAvatarUrl: null, authorClosed: true }
    : { authorName: row.display_name, authorAvatarUrl: row.avatar_url, authorClosed: false };
}

// `any`: a row of POST_SELECT, whose JSON columns (reactions, shared_from) pg hands back already parsed.
function mapPost(row: any): WallPost {
  return {
    id: row.id, circleId: row.circle_id, authorId: row.author_id,
    ...authorOf(row),
    content: row.content, media: row.media ?? [], linkUrl: row.link_url,
    commentCount: row.comment_count, pinnedAt: row.pinned_at, createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    reactionCount: row.reaction_count ?? 0,
    reactions: row.reactions ?? {},
    myReaction: row.my_reaction ?? null,
    sharedFrom: row.shared_from ?? null,
    // A share whose original this viewer may not see (removed, in a closed circle they are outside, or by someone
    // blocked either way): the card says only "This post isn't available", the same for every reason.
    sharedUnavailable: !!row.shared_from_post_id && !row.shared_from,
  };
}

/** Keyset feed: newest first; cursor = "<epoch_ms>_<id>". The pinned strip (newest pin first) rides on the first page. */
export async function listPosts(
  circleId: string,
  viewerId: string,
  opts: { cursor?: string; limit?: number } = {},
  viewerRole?: string,
): Promise<CircleWallFeed> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const params: unknown[] = [circleId, viewerId];
  let keyset = '';
  if (opts.cursor) {
    const m = /^(\d+)_([0-9a-f-]{36})$/i.exec(opts.cursor);
    if (!m) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Bad cursor');
    params.push(new Date(Number(m[1])), m[2]);
    keyset = `AND (p.created_at, p.id) < ($3, $4::uuid)`;
  }
  const access = await resolveWallAccess(circleId, viewerId, viewerRole);

  const [pinned, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve({ rows: [] as any[] })
      : query<any>(
          `${POST_SELECT}
           WHERE p.circle_id = $1 AND p.deleted_at IS NULL AND p.pinned_at IS NOT NULL
             ${BLOCK_FILTER}
           ORDER BY p.pinned_at DESC LIMIT ${WALL_PINNED_MAX}`,
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
    viewer: { canPost: access.canPost, canModerate: access.canModerate },
  };
}

interface LockedPost {
  author_id: string;
  circle_id: string;
  content: string;
  media: unknown;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  pinned_at: Date | null;
}

const LOCK_POST = `SELECT author_id, circle_id, content, media, created_at, edited_at, deleted_at, pinned_at
                     FROM circle_posts WHERE id = $1 FOR UPDATE`;

/**
 * The author deletes their own post (D8: also once they are no longer in the circle); the circle's owner, its
 * moderators and platform admins delete any. Anyone else outside the circle is answered as if there were no such post.
 * A moderator's removal of someone else's post is recorded with its words. A post someone removed a moment before
 * answers alreadyRemoved to whoever could have removed it, and tells nobody again. S4 fix round 1: every bell that
 * carries the post's words (its new-post, reaction, comment and reply bells) is deleted in the same transaction, and
 * the people they were for are told; the circles holding shares of it are told too, so their cards say it is gone.
 */
export async function deletePost(postId: string, userId: string, viewerRole?: string): Promise<{ alreadyRemoved: boolean }> {
  const done = await transaction(async (client) => {
    const r = await client.query<LockedPost>(LOCK_POST, [postId]);
    const post = r.rows[0];
    if (!post) throw postNotFound(postId);
    const own = post.author_id === userId;
    if (!own) {
      const role = await roleInCircle(client, post.circle_id, userId);
      if (!moderatesWith(role, viewerRole)) {
        if (role === null) throw postNotFound(postId);
        throw post.deleted_at ? postRemoved(postId) : new ForbiddenError(ONLY_OWN_POSTS);
      }
    }
    if (post.deleted_at) return { circleId: post.circle_id, alreadyRemoved: true, rung: [] as string[] };
    await client.query(`UPDATE circle_posts SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [postId, userId]);
    await client.query(`UPDATE circles SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1`, [post.circle_id]);
    if (!own) {
      await recordModeration(client, {
        actorId: userId, action: 'wall_post_removed', space: 'circle', spaceId: post.circle_id,
        snapshot: { postId, authorId: post.author_id, content: post.content, media: post.media, createdAt: post.created_at, editedAt: post.edited_at },
      });
    }
    const rung = await purgePostBells(client, 'circle', postLink(post.circle_id, postId));
    return { circleId: post.circle_id, alreadyRemoved: false, rung };
  });
  if (!done.alreadyRemoved) {
    await tellBellOwners(done.rung);
    await fanoutCircleWall(done.circleId, [E.circleWallPost(postId)]);
    await fanoutCircleWallShares(postId);
  }
  return { alreadyRemoved: done.alreadyRemoved };
}

/**
 * Pin or unpin (the circle's owner, a moderator or a platform admin), archived or not. At most WALL_PINNED_MAX posts are
 * pinned, newest pin first: a pin past that is refused until one is unpinned. The post is locked first and the circle
 * row after it (the order a delete takes them in), and the pinned count is read under the circle's lock, so two pins at
 * once cannot pass the limit and a pin and an unpin at once each tell the circle. Re-pinning a pinned post moves it to
 * the front; unpinning one that is not pinned changes nothing and tells nobody. Every pin and unpin is recorded.
 */
export async function pinPost(postId: string, userId: string, viewerRole: string | undefined, pin: boolean): Promise<void> {
  const done = await transaction(async (client) => {
    const r = await client.query<LockedPost>(LOCK_POST, [postId]);
    const post = r.rows[0];
    if (!post) throw postNotFound(postId);
    const role = await roleInCircle(client, post.circle_id, userId);
    if (!moderatesWith(role, viewerRole)) {
      if (role === null) throw postNotFound(postId);
      throw new ForbiddenError(ONLY_MODERATORS_PIN);
    }
    if (post.deleted_at) throw postRemoved(postId);
    if (!pin && post.pinned_at === null) return { circleId: post.circle_id, changed: false };
    if (pin && post.pinned_at === null) {
      await client.query(`SELECT id FROM circles WHERE id = $1 FOR NO KEY UPDATE`, [post.circle_id]);
      const held = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM circle_posts WHERE circle_id = $1 AND deleted_at IS NULL AND pinned_at IS NOT NULL`,
        [post.circle_id],
      );
      if ((held.rows[0]?.n ?? 0) >= WALL_PINNED_MAX) throw pinsFull();
    }
    await client.query(
      `UPDATE circle_posts SET pinned_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END WHERE id = $1`,
      [postId, pin],
    );
    await recordModeration(client, {
      actorId: userId, action: pin ? 'wall_post_pinned' : 'wall_post_unpinned', space: 'circle', spaceId: post.circle_id,
      snapshot: { postId, authorId: post.author_id, content: post.content, createdAt: post.created_at, editedAt: post.edited_at },
    });
    return { circleId: post.circle_id, changed: true };
  });
  if (done.changed) await fanoutCircleWall(done.circleId, [E.circleWallPost(postId)]);
}

/**
 * The author changes the words of their post while they are in the circle and it is not archived. Pictures and a
 * shared post stay as they were; the same rules as posting (not empty unless something else is kept, at most 8000,
 * the link card read again). Words that are the same change nothing and tell nobody. A post removed a moment before is
 * "This post was removed."; `expectedEditedAt` refuses an edit made over another one. No bell rings for an edit.
 */
export async function editPost(
  postId: string,
  userId: string,
  input: { content: string; expectedEditedAt?: string | null },
): Promise<{ changed: boolean; editedAt: Date | null }> {
  const content = input.content.trim();
  if (content.length > POST_MAX_CHARS) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Post too long (max ${POST_MAX_CHARS} characters)`);
  }
  const done = await transaction(async (client) => {
    const r = await client.query<{
      author_id: string; circle_id: string; content: string; media: unknown[] | null; shared_from_post_id: string | null;
      edited_at: Date | null; deleted_at: Date | null; archived: boolean; is_member: boolean;
    }>(
      `SELECT p.author_id, p.circle_id, p.content, p.media, p.shared_from_post_id, p.edited_at, p.deleted_at,
              (c.archived_at IS NOT NULL) AS archived,
              EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = p.circle_id AND m.user_id = $2) AS is_member
         FROM circle_posts p JOIN circles c ON c.id = p.circle_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [postId, userId],
    );
    const post = r.rows[0];
    if (!post) throw postNotFound(postId);
    if (post.author_id !== userId) {
      if (!post.is_member) throw postNotFound(postId);
      throw new ForbiddenError(ONLY_OWN_EDITS);
    }
    if (post.deleted_at) throw postRemoved(postId);
    if (!post.is_member) throw new ForbiddenError(NO_LONGER_IN);
    if (post.archived) throw new AppError(409, ErrorCodes.CIRCLE_ARCHIVED, CIRCLE_ARCHIVED_READ_ONLY);
    if (!editStampHolds(post.edited_at, input.expectedEditedAt)) throw editConflict();
    if (!content && (post.media ?? []).length === 0 && !post.shared_from_post_id) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, EDIT_EMPTY_POST);
    }
    if (content === post.content) return { circleId: post.circle_id, changed: false, editedAt: post.edited_at };
    const w = await client.query<{ edited_at: Date }>(
      `UPDATE circle_posts SET content = $2, link_url = $3, edited_at = NOW() WHERE id = $1 RETURNING edited_at`,
      [postId, content, extractLinkUrl(content)],
    );
    return { circleId: post.circle_id, changed: true, editedAt: w.rows[0].edited_at };
  });
  if (done.changed) {
    await fanoutCircleWall(done.circleId, [E.circleWallPost(postId)]);
    await fanoutCircleWallShares(postId);
  }
  return { changed: done.changed, editedAt: done.editedAt };
}

/**
 * Share a post into another circle: a new post there, by the sharer, carrying
 * the ORIGINAL post (sharing a share points at the root, so attribution never
 * drifts). The sharer must be in the circle they share from (D2: only its members
 * read it) and in the target circle (createPost enforces it), and must not be
 * blocked either way by the author of the post they share or of its original.
 */
export async function sharePost(
  postId: string,
  userId: string,
  input: { circleId: string; clientId: string; content?: string },
): Promise<WallPost> {
  const { post: src } = await postInReach(postId, userId);
  await assertNotClosed(src.circleId);
  const srcRow = await query<{ id: string; shared_from_post_id: string | null }>(
    `SELECT p.id, p.shared_from_post_id
     FROM circle_posts p
     WHERE p.id = $1 AND p.deleted_at IS NULL
       ${BLOCK_FILTER}`,
    [postId, userId],
  );
  if (srcRow.rows.length === 0) throw postNotFound(postId);

  let root = { id: postId, circleId: src.circleId };
  if (srcRow.rows[0].shared_from_post_id) {
    // S4 fix round 1: the ORIGINAL's author is checked against the sharer too, both ways: a share of a share must not
    // carry a blocked person's words on (answered as a post that is not there, as for the share itself).
    const orig = await query<{ id: string; circle_id: string; blocked: boolean }>(
      `SELECT o.id, o.circle_id,
              EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = $2 AND b.blocked_id = o.author_id)
                          OR (b.blocker_id = o.author_id AND b.blocked_id = $2)) AS blocked
         FROM circle_posts o WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [srcRow.rows[0].shared_from_post_id, userId],
    );
    if (orig.rows[0]?.blocked) throw postNotFound(postId);
    if (orig.rows.length > 0) root = { id: orig.rows[0].id, circleId: orig.rows[0].circle_id };
    if (root.circleId !== src.circleId) await assertNotClosed(root.circleId);
  }
  if (root.circleId === input.circleId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'That post is already in this circle. Copy its link instead.');
  }
  return createPost(input.circleId, userId, {
    clientId: input.clientId, content: input.content ?? '', media: [], sharedFromPostId: root.id,
  });
}

/** T14: nothing posted in a closed circle is carried out of it, by anyone (into a closed circle, createPost asks membership). */
async function assertNotClosed(circleId: string): Promise<void> {
  const r = await query<{ join_policy: string | null }>(`SELECT join_policy FROM circles WHERE id = $1`, [circleId]);
  if (r.rows[0]?.join_policy === 'closed') throw new AppError(403, ErrorCodes.CIRCLE_CLOSED, CLOSED_POST_STAYS);
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
 * Set (or with null, remove) the member's one reaction on a post. Members of a circle that is not archived only, on a
 * post they can see (blocks both ways). The author hears about it once per post per hour, unless they block the member
 * or are blocked by them, or have left. Sending the reaction the member already has, or clearing one that is not
 * there, changes nothing: nobody is told or rung.
 */
export async function reactToPost(
  postId: string,
  userId: string,
  reaction: ReactionKind | null,
): Promise<ReactionSummary> {
  if (reaction !== null && !REACTION_KINDS.includes(reaction)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Unknown reaction');
  }
  const { post, access } = await postInReach(postId, userId);
  requireCanPost(access);

  let changed: boolean;
  if (reaction) {
    const set = await query<{ post_id: string }>(
      `INSERT INTO circle_post_reactions (post_id, user_id, reaction) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = NOW()
         WHERE circle_post_reactions.reaction IS DISTINCT FROM EXCLUDED.reaction
       RETURNING post_id`,
      [postId, userId, reaction],
    );
    changed = set.rows.length > 0;
    if (changed && post.authorId !== userId) {
      await ringOne(post.circleId, post.authorId, userId, {
        type: 'circle_reaction',
        title: `${nameOf(access)} reacted to your post`,
        body: excerpt(post.content, 'Your post on the wall'),
        link: postLink(post.circleId, postId),
        postLink: postLink(post.circleId, postId),
      }, REACTION_BELL_DEDUPE_MINUTES);
    }
  } else {
    const cleared = await query<{ post_id: string }>(
      `DELETE FROM circle_post_reactions WHERE post_id = $1 AND user_id = $2 RETURNING post_id`, [postId, userId]);
    changed = cleared.rows.length > 0;
  }
  if (changed) await fanoutCircleWall(post.circleId, [E.circleWallPost(postId)]);
  return reactionSummary(postId, userId);
}

// ── Comments ─────────────────────────────────────────────────────────────────

/**
 * The comments (alias `c`) a viewer may see: the author is not blocked either way, and the comment is top-level or
 * answers a comment that is still there and whose author is not blocked either way either (the pod wall's rule).
 */
const commentVisibleTo = (viewer: '$2' | '$3') => `
  AND NOT EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE (b.blocker_id = ${viewer} AND b.blocked_id = c.author_id)
       OR (b.blocker_id = c.author_id AND b.blocked_id = ${viewer}))
  AND (c.parent_comment_id IS NULL OR EXISTS (
    SELECT 1 FROM circle_post_comments pc
    WHERE pc.id = c.parent_comment_id AND pc.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks pb
        WHERE (pb.blocker_id = ${viewer} AND pb.blocked_id = pc.author_id)
           OR (pb.blocker_id = pc.author_id AND pb.blocked_id = ${viewer}))))`;

/**
 * Comment on a post, or reply to a comment (a reply to a reply hangs under the top-level comment, but the bell goes to
 * the person actually answered). Members of a circle that is not archived, on a post and a comment they can see.
 */
export async function addComment(
  postId: string,
  userId: string,
  content: string,
  parentCommentId?: string | null,
): Promise<{ id: string; createdAt: Date; parentCommentId: string | null }> {
  const { post, access } = await postInReach(postId, userId);
  requireCanPost(access);

  const trimmed = content.trim();
  if (!trimmed) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment cannot be empty');
  if (trimmed.length > COMMENT_MAX_CHARS) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment too long');
  await assertRate(userId, 'circle_post_comments', COMMENT_RATE_PER_MIN, 'commenting');

  let attachTo: string | null = null;
  let repliedToAuthor: string | null = null;
  if (parentCommentId) {
    const parent = await query<{ id: string; author_id: string; parent_comment_id: string | null }>(
      `SELECT c.id, c.author_id, c.parent_comment_id FROM circle_post_comments c
       WHERE c.id = $1 AND c.post_id = $2 AND c.deleted_at IS NULL AND c.withdrawn_at IS NULL
         ${commentVisibleTo('$3')}`,
      [parentCommentId, postId, userId],
    );
    if (parent.rows.length === 0) throw commentNotFound(parentCommentId);
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

  const ofPost = postLink(post.circleId, postId);
  const link = commentBellLink(ofPost, made.id);
  const name = nameOf(access);
  if (repliedToAuthor && repliedToAuthor !== userId) {
    await ringOne(post.circleId, repliedToAuthor, userId, {
      type: 'circle_reply', title: `${name} replied to your comment`, body: excerpt(trimmed, 'See the reply'), link, postLink: ofPost,
    }, COMMENT_BELL_DEDUPE_MINUTES);
  }
  if (post.authorId !== userId && post.authorId !== repliedToAuthor) {
    await ringOne(post.circleId, post.authorId, userId, {
      type: 'circle_comment',
      title: `${name} commented on your post`,
      body: excerpt(trimmed, excerpt(post.content, 'See the comment')),
      link,
      postLink: ofPost,
    }, COMMENT_BELL_DEDUPE_MINUTES);
  }
  await fanoutCircleWall(post.circleId, [E.circleWallPost(postId)]);
  return made;
}

export interface WallComment {
  id: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  /** T2: as on a post. */
  authorClosed: boolean;
  content: string; createdAt: Date; parentCommentId: string | null;
  likeCount: number; likedByMe: boolean;
  /** S4: when its author last changed its words; null when never. */
  editedAt: Date | null;
  /** S4 fix round 1: its author deleted it while it had replies: no words, "This comment was deleted", replies stay. */
  withdrawn: boolean;
}

/**
 * A post's comments and replies, oldest first, without authors blocked either way and without replies under a comment
 * the viewer cannot see. At most 400: `truncated` says there are more. Someone outside the circle: as if no such post.
 * A withdrawn comment is listed (with no words) only while a reply under it is still there.
 */
export async function listComments(
  postId: string,
  viewerId: string,
  viewerRole?: string,
): Promise<{ comments: WallComment[]; truncated: boolean }> {
  await postInReach(postId, viewerId, viewerRole);
  const r = await query<any>(
    `SELECT c.id, c.author_id, u.display_name, u.avatar_url, (NOT ${activeMemberSql('u')}) AS author_former,
            c.content, c.created_at, c.edited_at, c.withdrawn_at, c.parent_comment_id,
            (SELECT count(*)::int FROM circle_comment_likes l WHERE l.comment_id = c.id) AS like_count,
            EXISTS (SELECT 1 FROM circle_comment_likes l WHERE l.comment_id = c.id AND l.user_id = $2) AS liked_by_me
     FROM circle_post_comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = $1 AND c.deleted_at IS NULL
       AND (c.withdrawn_at IS NULL OR EXISTS (
         SELECT 1 FROM circle_post_comments wr WHERE wr.parent_comment_id = c.id AND wr.deleted_at IS NULL))
       ${commentVisibleTo('$2')}
     ORDER BY c.created_at ASC, c.id ASC LIMIT $3`,
    [postId, viewerId, COMMENTS_SHOWN + 1],
  );
  // `any`: a row of the SELECT above.
  // Fix round 2: a withdrawn comment is a neutral placeholder: no author id, name or picture, no words, no likes.
  const comments = r.rows.slice(0, COMMENTS_SHOWN).map((row: any): WallComment => (row.withdrawn_at ? {
    id: row.id, authorId: '', authorName: null, authorAvatarUrl: null, authorClosed: false,
    content: '', createdAt: row.created_at, parentCommentId: row.parent_comment_id ?? null,
    likeCount: 0, likedByMe: false, editedAt: null, withdrawn: true,
  } : {
    id: row.id, authorId: row.author_id, ...authorOf(row),
    content: row.content, createdAt: row.created_at,
    parentCommentId: row.parent_comment_id ?? null,
    likeCount: row.like_count ?? 0, likedByMe: !!row.liked_by_me,
    editedAt: row.edited_at ?? null,
    withdrawn: false,
  }));
  return { comments, truncated: r.rows.length > COMMENTS_SHOWN };
}

/** Like or unlike a comment the member can see. Members of a circle that is not archived. No bell: a like is a nod. */
export async function likeComment(
  commentId: string,
  userId: string,
  liked: boolean,
): Promise<{ likeCount: number; likedByMe: boolean }> {
  const c = await query<{ circle_id: string; post_id: string }>(
    `SELECT p.circle_id, c.post_id FROM circle_post_comments c JOIN circle_posts p ON p.id = c.post_id
     WHERE c.id = $1 AND c.deleted_at IS NULL AND c.withdrawn_at IS NULL AND p.deleted_at IS NULL
       ${BLOCK_FILTER}
       ${commentVisibleTo('$2')}`,
    [commentId, userId],
  );
  const target = c.rows[0];
  if (!target) throw commentNotFound(commentId);
  const access = await readAccess(target.circle_id, userId);
  if (!access?.mayRead) throw commentNotFound(commentId);
  requireCanPost(access);
  const written = liked
    ? await query<{ comment_id: string }>(
      `INSERT INTO circle_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING comment_id`,
      [commentId, userId],
    )
    : await query<{ comment_id: string }>(
      `DELETE FROM circle_comment_likes WHERE comment_id = $1 AND user_id = $2 RETURNING comment_id`, [commentId, userId]);
  // A like shows in the thread only, so no member's feed is read again.
  if (written.rows.length > 0) await fanoutCircleWall(target.circle_id, [E.circleWallPost(target.post_id)], { wall: false });
  const n = await query<{ like_count: number; liked_by_me: boolean }>(
    `SELECT count(*)::int AS like_count, bool_or(user_id = $2) AS liked_by_me
     FROM circle_comment_likes WHERE comment_id = $1`,
    [commentId, userId],
  );
  return { likeCount: n.rows[0]?.like_count ?? 0, likedByMe: !!n.rows[0]?.liked_by_me };
}

/** The author changes the words of their comment or reply: the rules of editPost, at most 4000, never empty. */
export async function editComment(
  commentId: string,
  userId: string,
  input: { content: string; expectedEditedAt?: string | null },
): Promise<{ changed: boolean; editedAt: Date | null; postId: string }> {
  const content = input.content.trim();
  if (!content) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, EDIT_EMPTY_COMMENT);
  if (content.length > COMMENT_MAX_CHARS) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment too long');
  const done = await transaction(async (client) => {
    const r = await client.query<{
      author_id: string; post_id: string; circle_id: string; content: string; edited_at: Date | null;
      deleted_at: Date | null; withdrawn_at: Date | null; post_deleted_at: Date | null; archived: boolean; is_member: boolean;
    }>(
      `SELECT c.author_id, c.post_id, p.circle_id, c.content, c.edited_at, c.deleted_at, c.withdrawn_at,
              p.deleted_at AS post_deleted_at,
              (ci.archived_at IS NOT NULL) AS archived,
              EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = p.circle_id AND m.user_id = $2) AS is_member
         FROM circle_post_comments c
         JOIN circle_posts p ON p.id = c.post_id
         JOIN circles ci ON ci.id = p.circle_id
        WHERE c.id = $1
        FOR UPDATE OF c`,
      [commentId, userId],
    );
    const comment = r.rows[0];
    if (!comment) throw commentNotFound(commentId);
    if (comment.author_id !== userId) {
      if (!comment.is_member) throw commentNotFound(commentId);
      throw new ForbiddenError(ONLY_OWN_EDITS);
    }
    if (comment.post_deleted_at) throw postRemoved(comment.post_id);
    if (comment.deleted_at || comment.withdrawn_at) throw commentRemoved(commentId);
    if (!comment.is_member) throw new ForbiddenError(NO_LONGER_IN);
    if (comment.archived) throw new AppError(409, ErrorCodes.CIRCLE_ARCHIVED, CIRCLE_ARCHIVED_READ_ONLY);
    if (!editStampHolds(comment.edited_at, input.expectedEditedAt)) throw editConflict();
    if (content === comment.content) {
      return { circleId: comment.circle_id, postId: comment.post_id, changed: false, editedAt: comment.edited_at };
    }
    const w = await client.query<{ edited_at: Date }>(
      `UPDATE circle_post_comments SET content = $2, edited_at = NOW() WHERE id = $1 RETURNING edited_at`,
      [commentId, content],
    );
    return { circleId: comment.circle_id, postId: comment.post_id, changed: true, editedAt: w.rows[0].edited_at };
  });
  if (done.changed) await fanoutCircleWall(done.circleId, [E.circleWallPost(done.postId)], { wall: false });
  return { changed: done.changed, editedAt: done.editedAt, postId: done.postId };
}

/**
 * Delete a comment: its author (D8: also once they are no longer in the circle), the circle's owner or a moderator, or
 * a platform admin, archived or not. Each row records who removed it, and the bells that carry its words are deleted in
 * the same transaction (their people are told once it commits).
 *   * A moderator removes the comment and its replies, and the post's count drops by every live one of them; the
 *     removal of someone else's words is recorded with them.
 *   * Its author (S4 fix round 1, controller ruling) never takes other people's words with theirs: a top-level comment
 *     that still has replies is withdrawn (its words cleared, "This comment was deleted", the replies stay); any other
 *     is removed alone. An author's own deletion is not a moderation and is not recorded.
 * A comment removed or withdrawn a moment before answers alreadyRemoved to whoever could have removed it. Anyone else
 * outside the circle: as if there were no such comment.
 */
export async function deleteComment(
  commentId: string,
  userId: string,
  viewerRole?: string,
): Promise<{ postId: string; alreadyRemoved: boolean }> {
  const done = await transaction(async (client) => {
    const r = await client.query<{
      author_id: string; post_id: string; circle_id: string; content: string; created_at: Date;
      edited_at: Date | null; deleted_at: Date | null; withdrawn_at: Date | null; has_replies: boolean;
    }>(
      `SELECT c.author_id, c.post_id, p.circle_id, c.content, c.created_at, c.edited_at, c.deleted_at, c.withdrawn_at,
              EXISTS (SELECT 1 FROM circle_post_comments rr WHERE rr.parent_comment_id = c.id AND rr.deleted_at IS NULL) AS has_replies
         FROM circle_post_comments c JOIN circle_posts p ON p.id = c.post_id
        WHERE c.id = $1 AND p.deleted_at IS NULL
        FOR UPDATE OF c`,
      [commentId],
    );
    const comment = r.rows[0];
    if (!comment) throw commentNotFound(commentId);
    const own = comment.author_id === userId;
    // Fix round 2: a withdrawn comment's thread is a moderator's to clear, the comment's own author included when they
    // moderate (their withdrawal was theirs; removing the replies is moderation).
    let moderates = false;
    if (!own || comment.withdrawn_at) {
      const role = await roleInCircle(client, comment.circle_id, userId);
      moderates = moderatesWith(role, viewerRole);
      if (!own && !moderates) {
        if (role === null) throw commentNotFound(commentId);
        throw comment.deleted_at ? commentRemoved(commentId) : new ForbiddenError(ONLY_OWN_COMMENTS);
      }
    }
    const moderation = !own || (!!comment.withdrawn_at && moderates);
    const ofPost = postLink(comment.circle_id, comment.post_id);
    const nothing = { circleId: comment.circle_id, postId: comment.post_id, alreadyRemoved: true, rung: [] as string[] };
    if (comment.deleted_at || (comment.withdrawn_at && !moderation)) return nothing;

    if (!moderation && comment.has_replies) {
      await client.query(
        `UPDATE circle_post_comments SET content = '', withdrawn_at = NOW(), deleted_by = $2 WHERE id = $1`,
        [commentId, userId],
      );
      if (!comment.withdrawn_at) {
        await client.query(`UPDATE circle_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1`, [comment.post_id]);
      }
      const rung = await purgeCommentBells(client, 'circle', [commentBellLink(ofPost, commentId)]);
      return { ...nothing, alreadyRemoved: false, rung };
    }

    // Its author's comment with no replies, or a moderator's removal of a comment and its thread.
    const gone = await client.query<{ id: string; withdrawn_at: Date | null }>(
      `UPDATE circle_post_comments SET deleted_at = NOW(), deleted_by = $2
       WHERE (id = $1 OR ($3::boolean AND parent_comment_id = $1)) AND deleted_at IS NULL
       RETURNING id, withdrawn_at`,
      [commentId, userId, moderation],
    );
    // A withdrawn comment was already taken off the count when it was withdrawn.
    const counted = gone.rows.filter((row) => !row.withdrawn_at).length;
    if (counted > 0) {
      await client.query(
        `UPDATE circle_posts SET comment_count = GREATEST(comment_count - $2, 0) WHERE id = $1`,
        [comment.post_id, counted],
      );
    }
    if (moderation) {
      await recordModeration(client, {
        actorId: userId, action: 'wall_comment_removed', space: 'circle', spaceId: comment.circle_id,
        snapshot: {
          postId: comment.post_id, commentId, authorId: comment.author_id, content: comment.content,
          createdAt: comment.created_at, editedAt: comment.edited_at, repliesRemoved: Math.max(gone.rows.length - 1, 0),
        },
      });
    }
    const rung = await purgeCommentBells(client, 'circle', gone.rows.map((row) => commentBellLink(ofPost, row.id)));
    return { ...nothing, alreadyRemoved: false, rung };
  });
  if (!done.alreadyRemoved) {
    await tellBellOwners(done.rung);
    await fanoutCircleWall(done.circleId, [E.circleWallPost(done.postId)]);
  }
  return { postId: done.postId, alreadyRemoved: done.alreadyRemoved };
}
