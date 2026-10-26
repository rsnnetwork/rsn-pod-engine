// What the circle wall and the pod wall have in common, as types. Nothing here is a value.
//
// The two walls answer almost the same shapes (@rsn/shared, types/wall.ts). They differ in where they read
// and write, in whether the server names what the viewer may do, in which entity tags their queries declare,
// and in a few words; a WallConfig carries those differences, so one set of components draws both.

import type { ReactNode } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import type {
  PodWallViewer, WallComment as SharedWallComment, WallMediaItem, WallPostBase, WallReactionKind,
} from '@rsn/shared';

export type ReactionKey = WallReactionKind;
export type { WallMediaItem };

/** A circle post that was shared on from another circle, with its original's author and words. */
export interface SharedFrom {
  id: string;
  circleId: string;
  circleName: string;
  authorName: string | null;
  content: string;
  media: WallMediaItem[];
}

/** A post on either wall. `podId` and `authorClosed` are the pod wall's, `circleId` and `sharedFrom` the circle wall's. */
export interface WallPost extends WallPostBase {
  podId?: string;
  circleId?: string;
  authorClosed?: boolean;
  sharedFrom?: SharedFrom | null;
}

export interface WallComment extends SharedWallComment {
  authorClosed?: boolean;
}

/** What the viewer may do: post (comment, reply, react, like) and moderate (delete anyone's, pin). The server decides on the pod wall. */
export type WallViewer = PodWallViewer;

export interface WallFeedPage {
  pinned: WallPost[];
  posts: WallPost[];
  nextCursor: string | null;
  /** Only the pod wall's feed names it; the circle wall's page decides from the member's place in the circle. */
  viewer?: WallViewer;
}

export interface WallCommentList {
  comments: WallComment[];
  truncated: boolean;
}

/** The words a wall says. A sentence left out is a thing that wall does not do. */
export interface WallCopy {
  /** The composer's placeholder. */
  placeholder: string;
  /** Where the composer would be, for someone who cannot post. */
  cannotPost: string;
  /** Nothing posted yet, and the viewer can post. */
  empty: string;
  /** Nothing posted yet, and the viewer cannot post. */
  emptyReadOnly: string;
  /** The feed could not be loaded. */
  loadFailed: string;
  /** Said instead of the posts when the server answers 403: the viewer is not a member. */
  notMember?: string;
  /** If set, someone who cannot post still sees Like, and is told this when they tap it. If not, the button is not drawn. */
  reactNeedsMembership?: string;
  /** The same, for liking a comment. */
  likeNeedsMembership?: string;
}

/** Sharing a post out of the wall. The pod wall has none: pod content stays in the pod. */
export interface WallShare {
  /** The address of one post, for Copy link. */
  href: (post: WallPost) => string;
  /** The form that posts it into another place; without it the menu offers Copy link only. */
  renderTargetForm?: (props: { post: WallPost; onDone: () => void }) => ReactNode;
}

export interface WallConfig {
  /** The root's data-testid. */
  testId: string;
  /** Where a page of the feed is read, and where a new post is made. */
  feedPath: string;
  /** Where one post lives (`${itemBase}/posts/:id`, with /react and /comments under it) and one comment (`${itemBase}/comments/:id`). */
  itemBase: string;
  /** The React Query keys. Each wall's are its own. */
  keys: {
    feed: QueryKey;
    post: (postId: string) => QueryKey;
    comments: (postId: string) => QueryKey;
  };
  /** The entity tags each query declares in meta.entities. Empty: the wall's routes tell no one, so it is not live. */
  entities: {
    feed: string[];
    post: (postId: string) => string[];
    comments: (postId: string) => string[];
  };
  /** Refetch the feed this often (ms). Only a wall whose routes send no entity tags needs it. */
  pollMs?: number;
  /** open: the composer is always a box. collapsible: one line until it is tapped. */
  composer: 'open' | 'collapsible';
  /** Show this many posts at first, then this many more at a time. Unset: everything that is loaded. */
  visibleAtFirst?: number;
  /** A link that names a post opens its comments, when it has any (the bell says someone commented). */
  openCommentsOnLink: boolean;
  copy: WallCopy;
  /** Where an author's name and picture lead. Unset: they lead nowhere. */
  authorHref?: (authorId: string) => string;
  share?: WallShare;
}
