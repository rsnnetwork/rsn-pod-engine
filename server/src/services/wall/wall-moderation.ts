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

import type { PoolClient } from 'pg';
import { ErrorCodes } from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';

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
