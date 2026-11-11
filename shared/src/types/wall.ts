// ─── Wall Types ──────────────────────────────────────────────────────────────
//
// What a wall sends, as the screen reads it: the circle wall (/circles/:id/posts…) and the pod wall
// (/pods/:podId/wall/…). The two walls answer the same shapes wherever they match, so one screen can draw
// either; a pod's posts add `podId` and `authorClosed`, a circle's add `circleId` and `sharedFrom`.
// Dates are ISO strings, as they arrive over JSON. Types only: nothing here is a value.

export type WallReactionKind = 'like' | 'love' | 'applause' | 'insightful' | 'celebrate';

export interface WallMediaItem {
  type: 'image' | 'video';
  url: string;
  meta?: Record<string, unknown> | null;
}

/** The reactions on a post: the total, how many of each kind, and the viewer's own. */
export interface WallReactionSummary {
  reactionCount: number;
  reactions: Partial<Record<WallReactionKind, number>>;
  myReaction: WallReactionKind | null;
}

/** What a post carries on either wall. */
export interface WallPostBase extends WallReactionSummary {
  id: string;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  content: string;
  media: WallMediaItem[];
  /** The first web address in the text. It is never fetched; the screen draws a card from it. */
  linkUrl: string | null;
  commentCount: number;
  pinnedAt: string | null;
  createdAt: string;
  /** When its author last changed its words (S4, 11 Nov 2026); null when never. The screen says "Edited". */
  editedAt: string | null;
}

/** A comment, or a reply to one (`parentCommentId` set; replies go one level deep). */
export interface WallComment {
  id: string;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  content: string;
  createdAt: string;
  parentCommentId: string | null;
  likeCount: number;
  likedByMe: boolean;
  /** When its author last changed its words (S4); null when never. */
  editedAt: string | null;
}

/** The answer to adding a comment or a reply. */
export interface WallCommentCreated {
  id: string;
  createdAt: string;
  parentCommentId: string | null;
}

/** The answer to liking or unliking a comment. */
export interface WallCommentLike {
  likeCount: number;
  likedByMe: boolean;
}

// ── The pod wall ─────────────────────────────────────────────────────────────

/**
 * A post on a pod's wall. When its author's account has been closed the post stays: `authorName` is
 * "Former member", `authorAvatarUrl` is null and `authorClosed` is true, so the screen draws no profile link.
 */
export interface PodWallPost extends WallPostBase {
  podId: string;
  authorClosed: boolean;
}

export interface PodWallComment extends WallComment {
  authorClosed: boolean;
}

/**
 * What the viewer may do on a wall right now; the server decides, the screen only shows it. Both walls' feeds send it
 * (the circle wall's since S4: `canModerate` is the circle's owner, a moderator or a platform admin; `canPost` is a
 * member of a circle that is not archived). On the pod wall:
 * A pod that is not open (archived, suspended or still a draft) takes no new posts, comments, replies,
 * reactions or likes from anyone, so `canPost` is false there. Moderation and your own words are never
 * switched off: `canModerate` stays true for the pod's director, host and platform admins whatever the pod's
 * state, and a member can always delete their own post or comment (`authorId` is the viewer's).
 */
export interface PodWallViewer {
  /** Post, comment, reply, react and like: an active member of an open pod. */
  canPost: boolean;
  /** Delete anyone's post or comment, and pin or unpin: the pod's director or host, or a platform admin. */
  canModerate: boolean;
}

/**
 * GET /pods/:podId/wall/posts/:postId/comments: a post's comments and replies together, oldest first, at most
 * 400. When the post has more than that `truncated` is true and the newest are not in the list; the screen
 * should say so.
 */
export interface PodWallCommentList {
  comments: PodWallComment[];
  truncated: boolean;
}

/** The answer to an author's edit of their post or comment (S4). `changed` is false when the words were the same. */
export interface WallEditResult {
  changed: boolean;
  editedAt: string | null;
}

/** The answer to deleting a post or a comment. `alreadyRemoved`: someone else removed it a moment before (S4). */
export interface WallDeleteResult {
  ok: true;
  alreadyRemoved: boolean;
}

/** GET /pods/:podId/wall/posts. `pinned` is on the first page only; at most three are shown. */
export interface PodWallFeed {
  pinned: PodWallPost[];
  posts: PodWallPost[];
  nextCursor: string | null;
  viewer: PodWallViewer;
}
