// ─── Pod Wall Service ────────────────────────────────────────────────────────
//
// COM-01 (26 Oct 2026). Stefan, back in the pod after an event: "We can't write in the pod itself. There's
// no wall, like a Facebook wall. There should be." A pod's discussion: text, pictures and links, comments
// with one level of replies, one reaction per member per post, likes on comments, a pinned strip.
//
// It is the circle wall's rules (circle-wall.service.ts: Cloudinary-only media, links extracted and never
// fetched, idempotent client ids, keyset pages, soft deletes with counters moved in the same transaction,
// per-minute caps, blocks respected at read in both directions, bells deduped per window) in tables of its
// own (migration 115), so a pod's posts cannot be reached from any circle route. The pod's own rules:
//   * Only ACTIVE members read and write, on every kind of pod, public ones too. Someone who cannot see a
//     private pod at all is told it does not exist (404); anyone else is told how to get in (403).
//     A platform admin reads and moderates without being a member, and does not post.
//   * A pod that is not open (archived, suspended, draft) can still be read but takes no new posts, comments,
//     replies, reactions or likes, from anyone, the director included. Moderation and your own words are
//     never switched off: the pod's director or host and platform admins still delete any post or comment
//     and pin and unpin, and an author still deletes their own posts and comments.
//   * The pod's director or host, and platform admins, delete any post or comment and pin, in any state of
//     the pod.
//   * Nothing leaves the pod: there is no sharing.
//   * Unlike the circle wall, every change reaches open screens by entity tag (fanoutPodWall: the active
//     members only), and every bell is pushed live over the socket and honours the member's group-bell
//     setting. No email.
//
// Services return data and never touch req/res. A write tells the pod once it has been saved: a retried
// submit, a refusal and a change that changed nothing (the same reaction sent again, a reaction cleared that
// was not there, a like of a comment already liked) tell nobody.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes, UserRole, hasRoleAtLeast } from '@rsn/shared';
import type {
  PodWallComment, PodWallCommentList, PodWallFeed, PodWallPost, WallCommentCreated, WallCommentLike, WallReactionSummary,
} from '@rsn/shared';
import { canViewPod } from '../pods/pod-access';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { fanoutPodWall } from '../../realtime/fanout';
import {
  BLOCK_FILTER, COMMENT_BELL_DEDUPE_MINUTES, COMMENT_RATE_PER_MIN, POST_RATE_PER_MIN,
  REACTION_BELL_DEDUPE_MINUTES, REACTION_KINDS, assertRate, extractLinkUrl, validateMedia,
} from '../circle/circle-wall.service';
import type { ReactionKind } from '../circle/circle-wall.service';

/** Who is asking: their id and their PLATFORM role. Their role in the pod is read from the pod. */
export interface WallViewer {
  userId: string;
  role: string;
}

const FEED_PAGE_SIZE = 20;
const FEED_MAX_PAGE_SIZE = 50;
/** The pinned strip shows the three posts pinned most recently; an older pin stays set but is not shown there. */
const PINNED_SHOWN = 3;
const POST_MAX_CHARS = 8000;
const COMMENT_MAX_CHARS = 4000;
const COMMENTS_SHOWN = 400;
const BELL_EXCERPT_CHARS = 120;

// ── The words people read ────────────────────────────────────────────────────

const NOT_A_MEMBER = 'Join this pod to read and post in its discussion';
const ADMIN_NOT_A_MEMBER = 'Join this pod to post in its discussion';
const POD_ARCHIVED = 'This pod is archived, so its discussion is read-only';
const POD_NOT_OPEN = 'This pod is not open for new activity right now';
const POD_MISSING = 'That pod could not be found';
const POST_MISSING = 'That post could not be found';
const COMMENT_MISSING = 'That comment could not be found';
const ONLY_OWN_POSTS = 'You can only delete your own posts';
const ONLY_OWN_COMMENTS = 'You can only delete your own comments';
const ONLY_MODERATORS_PIN = 'Only the pod\'s director or host can pin posts';
const FORMER_MEMBER = 'Former member';

const postNotFound = (id: string) => new NotFoundError('Post', id, POST_MISSING);
const commentNotFound = (id: string) => new NotFoundError('Comment', id, COMMENT_MISSING);

// ── Who may do what ──────────────────────────────────────────────────────────

interface AccessRow {
  name: string;
  status: string;
  member_role: string | null;
  member_status: string | null;
  viewer_name: string | null;
}

interface WallAccess {
  podName: string;
  podStatus: string;
  viewerName: string | null;
  /** An active member of the pod. */
  isMember: boolean;
  /** The pod is open: not archived, suspended or a draft. */
  isOpen: boolean;
  /** An active member of an open pod: post, comment, reply, react and like. */
  canPost: boolean;
  /** The pod's director or host, or a platform admin: delete anyone's post or comment, and pin, whatever state the pod is in. */
  canModerate: boolean;
}

/**
 * The read gate every entry point passes first. One read gives the pod and the viewer's own row in it.
 * Only status 'active' is a member: an invited, pending, declined, left or removed row is not (canViewPod
 * admits any row, which is right for the pod's page and wrong for a discussion).
 */
async function resolveAccess(podId: string, viewer: WallViewer): Promise<WallAccess> {
  const r = await query<AccessRow>(
    `SELECT p.name, p.status, pm.role AS member_role, pm.status AS member_status,
            (SELECT u.display_name FROM users u WHERE u.id = $2) AS viewer_name
     FROM pods p
     LEFT JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = $2
     WHERE p.id = $1`,
    [podId, viewer.userId],
  );
  const pod = r.rows[0];
  if (!pod) throw new NotFoundError('Pod', podId, POD_MISSING);

  const isAdmin = hasRoleAtLeast(viewer.role as UserRole, UserRole.ADMIN);
  const isMember = pod.member_status === 'active';
  if (!isMember && !isAdmin) {
    // Whoever the pod's page hides the pod from is told it does not exist; anyone else is told how to get in.
    if (!(await canViewPod(viewer.userId, podId, viewer.role))) throw new NotFoundError('Pod', podId, POD_MISSING);
    throw new ForbiddenError(NOT_A_MEMBER);
  }

  const isOpen = pod.status === 'active';
  return {
    podName: pod.name,
    podStatus: pod.status,
    viewerName: pod.viewer_name,
    isMember,
    isOpen,
    canPost: isMember && isOpen,
    // Moderation is never switched off by the pod's state: a moderator can still clear what should not be there.
    canModerate: isAdmin || (isMember && (pod.member_role === 'director' || pod.member_role === 'host')),
  };
}

/** A pod that is not open takes no new posts, comments, replies, reactions or likes. Deleting and pinning are not those. */
function requireOpenPod(access: WallAccess): void {
  if (access.isOpen) return;
  if (access.podStatus === 'archived') throw new AppError(409, ErrorCodes.POD_ARCHIVED, POD_ARCHIVED);
  throw new AppError(409, ErrorCodes.POD_NOT_ACTIVE, POD_NOT_OPEN);
}

/** Post, comment, reply, react, like: members only. An admin who is not in the pod reads and moderates. */
function requireMemberOfOpenPod(access: WallAccess): void {
  if (!access.isMember) throw new ForbiddenError(ADMIN_NOT_A_MEMBER);
  requireOpenPod(access);
}

// ── What goes to the screen ──────────────────────────────────────────────────

interface PostRow {
  id: string;
  pod_id: string;
  author_id: string;
  display_name: string | null;
  avatar_url: string | null;
  author_closed: boolean;
  content: string;
  media: PodWallPost['media'] | null;
  link_url: string | null;
  comment_count: number;
  pinned_at: Date | null;
  created_at: Date;
  reaction_count: number | null;
  reactions: PodWallPost['reactions'] | null;
  my_reaction: ReactionKind | null;
}

interface CommentRow {
  id: string;
  author_id: string;
  display_name: string | null;
  avatar_url: string | null;
  author_closed: boolean;
  content: string;
  created_at: Date;
  parent_comment_id: string | null;
  like_count: number | null;
  liked_by_me: boolean | null;
}

const iso = (when: Date | string) => new Date(when).toISOString();

/** A closed account's posts stay, as "Former member" with no picture, and the screen draws no profile link. */
function authorOf(row: { display_name: string | null; avatar_url: string | null; author_closed: boolean }) {
  return row.author_closed
    ? { authorName: FORMER_MEMBER, authorAvatarUrl: null, authorClosed: true }
    : { authorName: row.display_name, authorAvatarUrl: row.avatar_url, authorClosed: false };
}

function mapPost(row: PostRow): PodWallPost {
  return {
    id: row.id,
    podId: row.pod_id,
    authorId: row.author_id,
    ...authorOf(row),
    content: row.content,
    media: row.media ?? [],
    linkUrl: row.link_url,
    commentCount: row.comment_count,
    pinnedAt: row.pinned_at ? iso(row.pinned_at) : null,
    createdAt: iso(row.created_at),
    reactionCount: row.reaction_count ?? 0,
    reactions: row.reactions ?? {},
    myReaction: row.my_reaction ?? null,
  };
}

function mapComment(row: CommentRow): PodWallComment {
  return {
    id: row.id,
    authorId: row.author_id,
    ...authorOf(row),
    content: row.content,
    createdAt: iso(row.created_at),
    parentCommentId: row.parent_comment_id ?? null,
    likeCount: row.like_count ?? 0,
    likedByMe: !!row.liked_by_me,
  };
}

/** The post columns every read shares. $2 is always the viewer. */
const POST_SELECT = `
  SELECT p.id, p.pod_id, p.author_id, u.display_name, u.avatar_url, (u.status = 'deactivated') AS author_closed,
         p.content, p.media, p.link_url, p.comment_count, p.pinned_at, p.created_at,
         (SELECT count(*)::int FROM pod_post_reactions r WHERE r.post_id = p.id) AS reaction_count,
         (SELECT COALESCE(json_object_agg(x.reaction, x.n), '{}'::json)
            FROM (SELECT reaction, count(*)::int AS n FROM pod_post_reactions WHERE post_id = p.id GROUP BY reaction) x) AS reactions,
         (SELECT r.reaction FROM pod_post_reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS my_reaction
  FROM pod_posts p JOIN users u ON u.id = p.author_id`;

/**
 * The comments (alias `c`) a viewer may see: the author is not blocked by the viewer or blocking them, and the
 * comment is either top-level or answers a comment that is still there and whose author is not blocked either
 * way either. A reply under a comment the viewer cannot see would hang from nothing, so it is hidden with it,
 * and cannot be answered or liked by that viewer. `viewer` is the SQL placeholder that holds the viewer's id.
 */
const commentVisibleTo = (viewer: '$2' | '$3') => `
  AND NOT EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE (b.blocker_id = ${viewer} AND b.blocked_id = c.author_id)
       OR (b.blocker_id = c.author_id AND b.blocked_id = ${viewer}))
  AND (c.parent_comment_id IS NULL OR EXISTS (
    SELECT 1 FROM pod_post_comments pc
    WHERE pc.id = c.parent_comment_id AND pc.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks pb
        WHERE (pb.blocker_id = ${viewer} AND pb.blocked_id = pc.author_id)
           OR (pb.blocker_id = pc.author_id AND pb.blocked_id = ${viewer}))))`;

// A feed cursor is "<epoch_ms>_<post id>" of the last post served; the next page is everything older by
// (created_at, id). Posts are stamped to the millisecond when they are made (see createPost), so a cursor
// names its post exactly and a page never skips a post made in the same millisecond.
const CURSOR_PATTERN = /^(\d{1,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parseCursor(cursor: string): { createdAt: Date; id: string } {
  const m = CURSOR_PATTERN.exec(cursor);
  const createdAt = m ? new Date(Number(m[1])) : null;
  if (!m || !createdAt || Number.isNaN(createdAt.getTime())) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Bad cursor');
  }
  return { createdAt, id: m[2] };
}

const cursorOf = (row: { created_at: Date; id: string }) => `${new Date(row.created_at).getTime()}_${row.id}`;

// ── Reading ──────────────────────────────────────────────────────────────────

/** Newest first, a keyset page at a time; the pinned strip rides on the first page only. */
export async function listPosts(
  podId: string,
  viewer: WallViewer,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PodWallFeed> {
  const access = await resolveAccess(podId, viewer);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? FEED_PAGE_SIZE), 1), FEED_MAX_PAGE_SIZE);

  const params: unknown[] = [podId, viewer.userId];
  let keyset = '';
  if (opts.cursor) {
    const at = parseCursor(opts.cursor);
    params.push(at.createdAt, at.id);
    keyset = 'AND (p.created_at, p.id) < ($3, $4::uuid)';
  }
  params.push(limit + 1);

  const [pinned, page] = await Promise.all([
    opts.cursor
      ? Promise.resolve({ rows: [] as PostRow[] })
      : query<PostRow>(
          `${POST_SELECT}
           WHERE p.pod_id = $1 AND p.deleted_at IS NULL AND p.pinned_at IS NOT NULL
             ${BLOCK_FILTER}
           ORDER BY p.pinned_at DESC LIMIT ${PINNED_SHOWN}`,
          [podId, viewer.userId],
        ),
    query<PostRow>(
      `${POST_SELECT}
       WHERE p.pod_id = $1 AND p.deleted_at IS NULL
         ${BLOCK_FILTER}
         ${keyset}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
      params,
    ),
  ]);

  const rows = page.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    pinned: pinned.rows.map(mapPost),
    posts: rows.map(mapPost),
    nextCursor: page.rows.length > limit && last ? cursorOf(last) : null,
    viewer: { canPost: access.canPost, canModerate: access.canModerate },
  };
}

/** One post as its viewer sees it. Gone, in another pod, or hidden by a block: not found. */
async function loadPost(podId: string, postId: string, viewerId: string): Promise<PodWallPost> {
  const r = await query<PostRow>(
    `${POST_SELECT}
     WHERE p.id = $1 AND p.pod_id = $3 AND p.deleted_at IS NULL
       ${BLOCK_FILTER}`,
    [postId, viewerId, podId],
  );
  if (!r.rows[0]) throw postNotFound(postId);
  return mapPost(r.rows[0]);
}

export async function getPost(podId: string, postId: string, viewer: WallViewer): Promise<PodWallPost> {
  await resolveAccess(podId, viewer);
  return loadPost(podId, postId, viewer.userId);
}

/** What a reaction, a comment or a bell needs of a post the viewer can see: who wrote it and what it says. */
async function loadPostHead(podId: string, postId: string, viewerId: string): Promise<{ authorId: string; content: string }> {
  const r = await query<{ author_id: string; content: string }>(
    `SELECT p.author_id, p.content FROM pod_posts p
     WHERE p.id = $1 AND p.pod_id = $3 AND p.deleted_at IS NULL
       ${BLOCK_FILTER}`,
    [postId, viewerId, podId],
  );
  if (!r.rows[0]) throw postNotFound(postId);
  return { authorId: r.rows[0].author_id, content: r.rows[0].content };
}

// ── Bells ────────────────────────────────────────────────────────────────────

type PodBellType = 'pod_post' | 'pod_comment' | 'pod_reply' | 'pod_reaction';

interface BellPayload {
  type: PodBellType;
  title: string;
  body: string;
  link: string;
}

interface BellRow {
  id: string;
  user_id: string;
  created_at: Date;
}

/** The pod's page, where the wall is. A new-post bell links here, so one bell serves every post of the hour. */
const podLink = (podId: string) => `/pods/${podId}`;
/** One post, for the bells about it and for a `?post=` link. */
const postLink = (podId: string, postId: string) => `/pods/${podId}?post=${postId}`;

/** The first 120 characters, counted as characters so a picture or emoji is never cut in half. */
const excerpt = (text: string, fallback: string) =>
  Array.from(text.trim()).slice(0, BELL_EXCERPT_CHARS).join('') || fallback;

/**
 * Pushes bells that were just written to the people they were written for: `notification:new` on their own
 * room, which moves the bell's count and list, and their own bell tag, which refreshes anything that lists
 * their notifications. One person's failure never stops the next.
 */
async function pushBells(rows: BellRow[], bell: BellPayload): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  for (const row of rows) {
    try {
      // The room name is the one every other bell uses (userRoom in session-state).
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id, type: bell.type, title: bell.title, body: bell.body, link: bell.link,
        isRead: false, createdAt: row.created_at,
      });
      await emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)]);
    } catch (err) {
      logger.warn({ err, userId: row.user_id, type: bell.type }, 'pod wall bell push failed (non-fatal)');
    }
  }
}

/**
 * A new post rings every other active member of the pod, once per member per pod per hour, in ONE statement:
 * the pod's active members who have not switched group bells off, whose account is open, who are not blocked
 * by the author or blocking them, and who have not been rung for this pod in the last hour. Never throws: a
 * bell must not fail the post it reports.
 */
async function ringPodMembers(podId: string, authorId: string, bell: Omit<BellPayload, 'type'>): Promise<void> {
  try {
    const inserted = await query<BellRow>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       SELECT gen_random_uuid(), pm.user_id, 'pod_post', $3::text, $4::text, $5::text
       FROM pod_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.pod_id = $1 AND pm.status = 'active' AND pm.user_id <> $2
         AND u.status = 'active'
         AND COALESCE((u.notification_prefs->>'group_bell')::boolean, true)
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = pm.user_id AND b.blocked_id = $2)
              OR (b.blocker_id = $2 AND b.blocked_id = pm.user_id))
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = pm.user_id AND n.type = 'pod_post' AND n.link = $5::text
             AND n.created_at > NOW() - INTERVAL '1 hour')
       RETURNING id, user_id, created_at`,
      [podId, authorId, bell.title, bell.body, bell.link],
    );
    await pushBells(inserted.rows, { type: 'pod_post', ...bell });
  } catch (err) {
    logger.warn({ err, podId }, 'pod_post bells failed (non-fatal)');
  }
}

/**
 * One bell to one person about something another member did, deduped per (person, type, link) inside a
 * window. They must still be an active member who has not switched group bells off, with an open account, and
 * not be blocked by the actor or blocking them. Never throws.
 */
async function ringOne(
  podId: string,
  recipientId: string,
  actorId: string,
  bell: BellPayload,
  dedupeMinutes: number,
): Promise<void> {
  try {
    const inserted = await query<BellRow>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       SELECT gen_random_uuid(), u.id, $3::text, $4::text, $5::text, $6::text
       FROM users u
       WHERE u.id = $1 AND u.status = 'active'
         AND COALESCE((u.notification_prefs->>'group_bell')::boolean, true)
         AND EXISTS (
           SELECT 1 FROM pod_members pm
           WHERE pm.pod_id = $2 AND pm.user_id = u.id AND pm.status = 'active')
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = u.id AND b.blocked_id = $7)
              OR (b.blocker_id = $7 AND b.blocked_id = u.id))
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = $3::text AND n.link = $6::text
             AND n.created_at > NOW() - make_interval(mins => $8::int))
       RETURNING id, user_id, created_at`,
      [recipientId, podId, bell.type, bell.title, bell.body, bell.link, actorId, dedupeMinutes],
    );
    await pushBells(inserted.rows, bell);
  } catch (err) {
    logger.warn({ err, podId, recipientId, type: bell.type }, 'pod wall bell failed (non-fatal)');
  }
}

const nameOf = (access: WallAccess) => access.viewerName?.trim() || 'A member';

// ── Posts ────────────────────────────────────────────────────────────────────

interface OwnPostRow {
  id: string;
  pod_id: string;
  deleted_at: Date | null;
}

async function findOwnPost(userId: string, clientId: string): Promise<OwnPostRow | null> {
  const r = await query<OwnPostRow>(
    `SELECT id, pod_id, deleted_at FROM pod_posts WHERE author_id = $1 AND client_id = $2`,
    [userId, clientId],
  );
  return r.rows[0] ?? null;
}

/** A retried submit answers the post that was made the first time, and does nothing else. */
async function answerRetry(podId: string, viewerId: string, first: OwnPostRow): Promise<PodWallPost> {
  if (first.pod_id !== podId) throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'That post was already sent');
  if (first.deleted_at) throw postNotFound(first.id);
  return loadPost(podId, first.id, viewerId);
}

/**
 * Post to the pod. The client id makes a retried submit (a double tap, a dropped connection) answer the first
 * post and ring nobody a second time. The post is stamped to the millisecond so a feed cursor names it
 * exactly.
 */
export async function createPost(
  podId: string,
  viewer: WallViewer,
  input: { clientId: string; content?: string; media?: unknown },
): Promise<PodWallPost> {
  const access = await resolveAccess(podId, viewer);
  requireMemberOfOpenPod(access);

  const content = (input.content ?? '').trim();
  const media = validateMedia(input.media);
  if (!content && media.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Say something or attach something');
  }
  if (content.length > POST_MAX_CHARS) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Post too long (max ${POST_MAX_CHARS} characters)`);
  }

  // Before the rate cap: a retry posts nothing, so it must succeed even for a member at the cap.
  const first = await findOwnPost(viewer.userId, input.clientId);
  if (first) return answerRetry(podId, viewer.userId, first);
  await assertRate(viewer.userId, 'pod_posts', POST_RATE_PER_MIN, 'posting');

  const inserted = await query<{ id: string }>(
    `INSERT INTO pod_posts (client_id, pod_id, author_id, content, media, link_url, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, date_trunc('milliseconds', NOW()))
     ON CONFLICT (author_id, client_id) DO NOTHING
     RETURNING id`,
    [input.clientId, podId, viewer.userId, content, JSON.stringify(media), extractLinkUrl(content)],
  );
  const postId = inserted.rows[0]?.id;
  if (!postId) {
    // Its own twin, sent at the same moment, won the insert.
    const twin = await findOwnPost(viewer.userId, input.clientId);
    if (!twin) throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'That post was already sent');
    return answerRetry(podId, viewer.userId, twin);
  }

  await ringPodMembers(podId, viewer.userId, {
    title: `New post in ${access.podName}`,
    body: excerpt(content, 'Shared an attachment'),
    link: podLink(podId),
  });
  await fanoutPodWall(podId);
  return loadPost(podId, postId, viewer.userId);
}

/**
 * The author deletes their own post; the pod's director or host and platform admins delete any. The pod's
 * state never matters: taking back your own words, and clearing what should not be there, are not switched
 * off by an archived, suspended or draft pod.
 */
export async function deletePost(podId: string, postId: string, viewer: WallViewer): Promise<void> {
  const access = await resolveAccess(podId, viewer);
  await transaction(async (client) => {
    const r = await client.query<{ author_id: string; deleted_at: Date | null }>(
      `SELECT author_id, deleted_at FROM pod_posts WHERE id = $1 AND pod_id = $2 FOR UPDATE`,
      [postId, podId],
    );
    const post = r.rows[0];
    if (!post || post.deleted_at) throw postNotFound(postId);
    if (!access.canModerate && post.author_id !== viewer.userId) throw new ForbiddenError(ONLY_OWN_POSTS);
    await client.query(`UPDATE pod_posts SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [postId, viewer.userId]);
  });
  await fanoutPodWall(podId, [E.podWallPost(postId)]);
}

/**
 * Pin or unpin: the pod's director or host, and platform admins, in any state of the pod. The feed shows the
 * last three pinned. Pinning a post that is already pinned moves it to the front of the strip; unpinning one
 * that is not pinned changes nothing and tells nobody.
 */
export async function setPinned(podId: string, postId: string, viewer: WallViewer, pinned: boolean): Promise<void> {
  const access = await resolveAccess(podId, viewer);
  if (!access.canModerate) throw new ForbiddenError(ONLY_MODERATORS_PIN);
  const r = await query<{ was_pinned: boolean }>(
    `UPDATE pod_posts p SET pinned_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END
     FROM pod_posts prev
     WHERE p.id = $1 AND p.pod_id = $2 AND p.deleted_at IS NULL AND prev.id = p.id
     RETURNING (prev.pinned_at IS NOT NULL) AS was_pinned`,
    [postId, podId, pinned],
  );
  const updated = r.rows[0];
  if (!updated) throw postNotFound(postId);
  if (pinned || updated.was_pinned) await fanoutPodWall(podId, [E.podWallPost(postId)]);
}

// ── Reactions ────────────────────────────────────────────────────────────────

async function reactionSummary(postId: string, viewerId: string): Promise<WallReactionSummary> {
  const r = await query<{ reaction: ReactionKind; n: number; mine: boolean }>(
    `SELECT reaction, count(*)::int AS n, bool_or(user_id = $2) AS mine
     FROM pod_post_reactions WHERE post_id = $1 GROUP BY reaction`,
    [postId, viewerId],
  );
  const reactions: WallReactionSummary['reactions'] = {};
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
 * Set (or with null, clear) the member's one reaction on a post. The author hears about it once an hour
 * per post, and not about their own. Sending the reaction the member already has, or clearing one that is
 * not there, changes nothing: the counts are answered, and nobody is told or rung.
 */
export async function reactToPost(
  podId: string,
  postId: string,
  viewer: WallViewer,
  reaction: ReactionKind | null,
): Promise<WallReactionSummary> {
  if (reaction !== null && !REACTION_KINDS.includes(reaction)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Unknown reaction');
  }
  const access = await resolveAccess(podId, viewer);
  requireMemberOfOpenPod(access);
  const post = await loadPostHead(podId, postId, viewer.userId);

  let changed: boolean;
  if (reaction) {
    // The update is skipped when the row already says this, and a statement that wrote no row returns none.
    const set = await query<{ id: string }>(
      `INSERT INTO pod_post_reactions (post_id, user_id, reaction) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = NOW()
         WHERE pod_post_reactions.reaction IS DISTINCT FROM EXCLUDED.reaction
       RETURNING id`,
      [postId, viewer.userId, reaction],
    );
    changed = set.rows.length > 0;
    if (changed && post.authorId !== viewer.userId) {
      await ringOne(podId, post.authorId, viewer.userId, {
        type: 'pod_reaction',
        title: `${nameOf(access)} reacted to your post`,
        body: excerpt(post.content, 'Your post on the wall'),
        link: postLink(podId, postId),
      }, REACTION_BELL_DEDUPE_MINUTES);
    }
  } else {
    const cleared = await query<{ id: string }>(
      `DELETE FROM pod_post_reactions WHERE post_id = $1 AND user_id = $2 RETURNING id`,
      [postId, viewer.userId],
    );
    changed = cleared.rows.length > 0;
  }
  if (changed) await fanoutPodWall(podId, [E.podWallPost(postId)]);
  return reactionSummary(postId, viewer.userId);
}

// ── Comments ─────────────────────────────────────────────────────────────────

/**
 * A post's comments and replies together, oldest first, without the authors the viewer is blocked from
 * either way and without the replies under a comment the viewer cannot see. At most 400 are shown: when the
 * post has more, `truncated` is true so the screen can say the newest are not in the list.
 */
export async function listComments(podId: string, postId: string, viewer: WallViewer): Promise<PodWallCommentList> {
  await resolveAccess(podId, viewer);
  await loadPostHead(podId, postId, viewer.userId);
  const r = await query<CommentRow>(
    `SELECT c.id, c.author_id, u.display_name, u.avatar_url, (u.status = 'deactivated') AS author_closed,
            c.content, c.created_at, c.parent_comment_id,
            (SELECT count(*)::int FROM pod_comment_likes l WHERE l.comment_id = c.id) AS like_count,
            EXISTS (SELECT 1 FROM pod_comment_likes l WHERE l.comment_id = c.id AND l.user_id = $2) AS liked_by_me
     FROM pod_post_comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = $1 AND c.deleted_at IS NULL
       ${commentVisibleTo('$2')}
     ORDER BY c.created_at ASC, c.id ASC LIMIT $3`,
    // One more than is shown, to know whether there is more.
    [postId, viewer.userId, COMMENTS_SHOWN + 1],
  );
  return { comments: r.rows.slice(0, COMMENTS_SHOWN).map(mapComment), truncated: r.rows.length > COMMENTS_SHOWN };
}

/**
 * Comment on a post, or reply to a comment (a reply to a reply hangs under the top-level comment, but the bell
 * goes to the person actually answered). The comment and the post's count move in one transaction.
 */
export async function addComment(
  podId: string,
  postId: string,
  viewer: WallViewer,
  input: { content: string; parentCommentId?: string | null },
): Promise<WallCommentCreated> {
  const access = await resolveAccess(podId, viewer);
  requireMemberOfOpenPod(access);
  const post = await loadPostHead(podId, postId, viewer.userId);

  const content = input.content.trim();
  if (!content) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Comment cannot be empty');
  if (content.length > COMMENT_MAX_CHARS) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Comment too long (max ${COMMENT_MAX_CHARS} characters)`);
  }
  await assertRate(viewer.userId, 'pod_post_comments', COMMENT_RATE_PER_MIN, 'commenting');

  let attachTo: string | null = null;
  let repliedToAuthor: string | null = null;
  if (input.parentCommentId) {
    const parent = await query<{ id: string; author_id: string; parent_comment_id: string | null }>(
      `SELECT c.id, c.author_id, c.parent_comment_id FROM pod_post_comments c
       WHERE c.id = $1 AND c.post_id = $2 AND c.deleted_at IS NULL
         ${commentVisibleTo('$3')}`,
      [input.parentCommentId, postId, viewer.userId],
    );
    const answered = parent.rows[0];
    if (!answered) throw commentNotFound(input.parentCommentId);
    attachTo = answered.parent_comment_id ?? answered.id;
    repliedToAuthor = answered.author_id;
  }

  const made = await transaction(async (client) => {
    const ins = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO pod_post_comments (post_id, author_id, content, parent_comment_id)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [postId, viewer.userId, content, attachTo],
    );
    await client.query(`UPDATE pod_posts SET comment_count = comment_count + 1 WHERE id = $1`, [postId]);
    return ins.rows[0];
  });

  const link = postLink(podId, postId);
  const name = nameOf(access);
  if (repliedToAuthor && repliedToAuthor !== viewer.userId) {
    await ringOne(podId, repliedToAuthor, viewer.userId, {
      type: 'pod_reply', title: `${name} replied to your comment`, body: excerpt(content, 'See the reply'), link,
    }, COMMENT_BELL_DEDUPE_MINUTES);
  }
  if (post.authorId !== viewer.userId && post.authorId !== repliedToAuthor) {
    await ringOne(podId, post.authorId, viewer.userId, {
      type: 'pod_comment',
      title: `${name} commented on your post`,
      body: excerpt(content, excerpt(post.content, 'See the comment')),
      link,
    }, COMMENT_BELL_DEDUPE_MINUTES);
  }
  await fanoutPodWall(podId, [E.podWallPost(postId)]);
  return { id: made.id, createdAt: iso(made.created_at), parentCommentId: attachTo };
}

/** Like or unlike a comment. No bell: a like on a comment is a nod, not news. */
export async function likeComment(
  podId: string,
  commentId: string,
  viewer: WallViewer,
  liked: boolean,
): Promise<WallCommentLike> {
  const access = await resolveAccess(podId, viewer);
  requireMemberOfOpenPod(access);
  const target = await query<{ post_id: string }>(
    `SELECT c.post_id FROM pod_post_comments c JOIN pod_posts p ON p.id = c.post_id
     WHERE c.id = $1 AND p.pod_id = $3 AND c.deleted_at IS NULL AND p.deleted_at IS NULL
       ${BLOCK_FILTER}
       ${commentVisibleTo('$2')}`,
    [commentId, viewer.userId, podId],
  );
  const postId = target.rows[0]?.post_id;
  if (!postId) throw commentNotFound(commentId);

  // A statement that wrote no row (already liked, or never liked) returns none: nothing changed.
  const written = liked
    ? await query<{ id: string }>(
      `INSERT INTO pod_comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`,
      [commentId, viewer.userId],
    )
    : await query<{ id: string }>(
      `DELETE FROM pod_comment_likes WHERE comment_id = $1 AND user_id = $2 RETURNING id`,
      [commentId, viewer.userId],
    );
  // A like shows in the thread only. The feed does not change, so no member refetches theirs.
  if (written.rows.length > 0) await fanoutPodWall(podId, [E.podWallPost(postId)], { wall: false });

  const n = await query<{ like_count: number; liked_by_me: boolean | null }>(
    `SELECT count(*)::int AS like_count, bool_or(user_id = $2) AS liked_by_me
     FROM pod_comment_likes WHERE comment_id = $1`,
    [commentId, viewer.userId],
  );
  return { likeCount: n.rows[0]?.like_count ?? 0, likedByMe: !!n.rows[0]?.liked_by_me };
}

/**
 * Delete a comment: its author, the pod's director or host, or a platform admin, in any state of the pod (see
 * deletePost). Its replies go with it, and the post's count drops by all of them. Answers the post, which
 * names the thread to tell.
 */
export async function deleteComment(podId: string, commentId: string, viewer: WallViewer): Promise<{ postId: string }> {
  const access = await resolveAccess(podId, viewer);
  const postId = await transaction(async (client) => {
    const r = await client.query<{ author_id: string; post_id: string; deleted_at: Date | null }>(
      `SELECT c.author_id, c.post_id, c.deleted_at
       FROM pod_post_comments c JOIN pod_posts p ON p.id = c.post_id
       WHERE c.id = $1 AND p.pod_id = $2 AND p.deleted_at IS NULL
       FOR UPDATE OF c`,
      [commentId, podId],
    );
    const comment = r.rows[0];
    if (!comment || comment.deleted_at) throw commentNotFound(commentId);
    if (!access.canModerate && comment.author_id !== viewer.userId) throw new ForbiddenError(ONLY_OWN_COMMENTS);
    const gone = await client.query<{ id: string }>(
      `UPDATE pod_post_comments SET deleted_at = NOW()
       WHERE (id = $1 OR parent_comment_id = $1) AND deleted_at IS NULL
       RETURNING id`,
      [commentId],
    );
    await client.query(
      `UPDATE pod_posts SET comment_count = GREATEST(comment_count - $2, 0) WHERE id = $1`,
      [comment.post_id, Math.max(gone.rowCount ?? 1, 1)],
    );
    return comment.post_id;
  });
  await fanoutPodWall(podId, [E.podWallPost(postId)]);
  return { postId };
}
