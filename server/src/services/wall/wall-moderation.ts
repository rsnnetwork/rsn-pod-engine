// ─── What both walls share about editing and moderation (Shirley pilot S4, 11 Nov 2026) ─────────────────────────
//
// A circle's wall and a pod's wall follow the same rules here, so each is written once:
//   * At most WALL_PINNED_MAX posts are pinned on a wall. The strip shows them newest pin first. Pinning one more is
//     refused in words ("unpin one first") rather than silently unpinning the oldest, so nothing an owner chose moves
//     without them. Re-pinning a pinned post moves it to the front and does not count twice.
//   * Every moderation (a moderator removing someone else's post or comment, any pin or unpin) is written to audit_log
//     in the same transaction as the change, with who, what, when and a snapshot of the words as they were, so a
//     removal can be looked at afterwards. If the record cannot be written, the change is not made.
//   * An author's edit is refused when the words changed elsewhere since the editor opened them (expectedEditedAt),
//     so two tabs never overwrite each other without a word.

//   * S4 fix round 1: when a post or a comment is removed (by a moderator or by its author), the bells that carry its
//     words are deleted in the same transaction, and the people they were for are told (their bell tag) once it has
//     committed, so a removed post's words do not stay in anyone's bell list. A comment's bells name the comment in
//     their link (`?post=<id>&comment=<id>`) so they can be found; the page reads only `post`.

import type { PoolClient } from 'pg';
import { ErrorCodes } from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';
import logger from '../../config/logger';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';

/** The most posts a wall keeps pinned. */
export const WALL_PINNED_MAX = 3;

export const PINS_FULL = `A wall can have at most ${WALL_PINNED_MAX} pinned posts. Unpin one first.`;
export const POST_REMOVED = 'This post was removed.';
export const COMMENT_REMOVED = 'This comment was removed.';
export const ONLY_OWN_EDITS = 'You can only edit your own words.';
export const EDIT_CONFLICT = 'This changed since you opened it. Copy your text, close the editor and try again.';
export const EDIT_EMPTY_POST = 'Say something or keep an attachment.';
export const EDIT_EMPTY_COMMENT = 'A comment cannot be empty.';

export const postRemoved = (postId: string) => new NotFoundError('Post', postId, POST_REMOVED);
export const commentRemoved = (commentId: string) => new NotFoundError('Comment', commentId, COMMENT_REMOVED);
export const pinsFull = () => new AppError(409, ErrorCodes.WALL_PINS_FULL, PINS_FULL);

export type WallSpace = 'circle' | 'pod';

export type ModerationAction = 'wall_post_removed' | 'wall_comment_removed' | 'wall_post_pinned' | 'wall_post_unpinned';

/** The words as they were when a moderator acted, kept with the record. */
export interface ModerationSnapshot {
  postId: string;
  commentId?: string;
  authorId: string;
  content: string;
  media?: unknown;
  createdAt: Date | string;
  editedAt: Date | string | null;
  /** How many replies went with a removed comment. */
  repliesRemoved?: number;
}

/**
 * One audit_log row for a moderation, written on the transaction's own client so it commits or rolls back with the
 * change. entity_type is the space ('circle' or 'pod') and entity_id the space's id, so a space's moderation history is
 * one indexed read (idx_audit_entity).
 */
export async function recordModeration(
  client: PoolClient,
  input: { actorId: string; action: ModerationAction; space: WallSpace; spaceId: string; snapshot: ModerationSnapshot },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)`,
    [input.actorId, input.action, input.space, input.spaceId, JSON.stringify({ wall: input.space, ...input.snapshot })],
  );
}

/**
 * Whether the edit stamp the editor saw is still the row's. `expected` undefined: the editor did not say, so nothing is
 * compared. Compared in milliseconds, as the stamp travels over JSON.
 */
export function editStampHolds(current: Date | null, expected: string | null | undefined): boolean {
  if (expected === undefined) return true;
  if (expected === null || current === null) return expected === null && current === null;
  const at = new Date(expected).getTime();
  return !Number.isNaN(at) && at === new Date(current).getTime();
}

export const editConflict = () => new AppError(409, ErrorCodes.WALL_EDIT_CONFLICT, EDIT_CONFLICT);

// ── Bells that carry removed words ──────────────────────────────────────────────────────────────────────────────

/** Every bell type a wall rings, by space. The new-post bell carries the post's words; the others a comment's or the post's. */
export const WALL_BELL_TYPES: Record<WallSpace, string[]> = {
  circle: ['circle_post', 'circle_reaction', 'circle_comment', 'circle_reply'],
  pod: ['pod_post', 'pod_reaction', 'pod_comment', 'pod_reply'],
};

/** A comment's or reply's bell link: the post's, naming the comment, so its bells can be found when it is removed. */
/**
 * The space's bell types as SQL literals, from the fixed list above (nothing a member types reaches it), so the planner
 * can use idx_notifications_wall_link (migration 149), whose predicate names the same types.
 */
const bellTypesSql = (space: WallSpace) => WALL_BELL_TYPES[space].map((t) => `'${t}'`).join(', ');

/** A link as a LIKE prefix: its own %, _ and backslash are escaped (a wall link has none, but a prefix must not widen). */
const likePrefix = (link: string) => link.replace(/[\\%_]/g, (c) => `\\${c}`);

export const commentBellLink = (postLink: string, commentId: string) => `${postLink}&comment=${commentId}`;

/**
 * Deletes, on the removal's own transaction, every wall bell about a removed post (its link is the post's, or the post's
 * with a comment named after it). Answers who had one, to be told once the removal commits.
 */
export async function purgePostBells(client: PoolClient, space: WallSpace, postLink: string): Promise<string[]> {
  const r = await client.query<{ user_id: string }>(
    `DELETE FROM notifications
      WHERE type IN (${bellTypesSql(space)}) AND (link = $1 OR link LIKE $2)
      RETURNING user_id`,
    [postLink, `${likePrefix(postLink)}&%`],
  );
  return [...new Set(r.rows.map((row) => row.user_id))];
}

/** The same for removed comments: the bells whose link names one of them. */
export async function purgeCommentBells(client: PoolClient, space: WallSpace, links: string[]): Promise<string[]> {
  if (links.length === 0) return [];
  const r = await client.query<{ user_id: string }>(
    `DELETE FROM notifications WHERE type IN (${bellTypesSql(space)}) AND link = ANY($1::text[]) RETURNING user_id`,
    [links],
  );
  return [...new Set(r.rows.map((row) => row.user_id))];
}

/** After the removal has committed: each person whose bell was deleted is sent their own bell tag. Never throws. */
export async function tellBellOwners(userIds: string[]): Promise<void> {
  const io = getRealtimeIo();
  if (!io || userIds.length === 0) return;
  for (const userId of userIds) {
    try {
      await emitEntities(io, [userId], [E.userNotifications(userId)]);
    } catch (err) {
      logger.warn({ err, userId }, 'wall bell removal: telling the bell failed (non-fatal)');
    }
  }
}
