// What makes the pod's wall the pod's: where it reads and writes, the entity tags its queries declare, the
// words it says. Pure on purpose (no React, axios, store or router), so a test can run it:
// server/src/__tests__/client/pod-wall-client.test.ts. The components that draw it are in components/wall.
//
// The server (routes/pod-wall.ts, services/pod/pod-wall.service.ts) tells a pod's ACTIVE members, by entity tag,
// whenever its wall changes, so this wall never polls. A query is refetched only when a tag it declares is,
// letter for letter, a tag the server sends; ENTITIES.md says which route sends which.

import { E } from '../../realtime/entities';
import type { WallConfig } from '../../components/wall/wall-types';
import { personHref } from '../reason/human/profile-text';

export interface PodWallInput {
  podId: string;
  /** The signed-in member's id: their blocks decide which authors are left out of the wall. */
  me: string | undefined;
  podStatus: string | undefined;
  /** An active member of the pod. A platform admin who is not one reads and moderates, and does not post. */
  isActiveMember: boolean;
}

/**
 * What stands where the composer would, for someone who cannot post. The pod being closed is the first reason.
 * An active member of a pod that still reads as open is refused only because the pod is not open (the server
 * allows every active member to post to an open pod), so that is what it says.
 */
export function podCannotPostNote(podStatus: string | undefined, isActiveMember: boolean): string {
  if (podStatus === 'archived') return 'This pod is archived, so its discussion is read-only.';
  if (!isActiveMember && (podStatus === undefined || podStatus === 'active')) {
    return 'You can read and moderate this discussion. Join the pod to post.';
  }
  return 'This pod is not open for new activity right now.';
}

/**
 * Two reads of the same pod that disagree: the wall says an active member cannot post, and the pod page still
 * reads the pod as open. The archive route (DELETE /api/pods/:id) tells the pod's screens a moment before it
 * saves the new status, so a page that refetches the pod at once reads the old one while the wall, a slower
 * read, already knows. The pod is read again to settle it.
 */
export function podStatusLooksStale(canPost: boolean | undefined, isActiveMember: boolean, podStatus: string | undefined): boolean {
  return canPost === false && isActiveMember && podStatus === 'active';
}

export function podWallConfig({ podId, me, podStatus, isActiveMember }: PodWallInput): WallConfig {
  const blocks = me ? [E.userBlocks(me)] : [];
  // The feed answers more than the posts. Its viewer flags depend on the pod's status (pod:<id>) and on the
  // viewer's role and place in the pod (pod:<id>:members), and which authors it leaves out on their blocks.
  const feed = [E.podWall(podId), E.pod(podId), E.podMembers(podId), ...blocks];
  return {
    testId: 'pod-wall',
    feedPath: `/pods/${podId}/wall/posts`,
    itemBase: `/pods/${podId}/wall`,
    keys: {
      feed: ['podWall', podId],
      post: (postId) => ['podWall', podId, 'post', postId],
      comments: (postId) => ['podWall', podId, 'comments', postId],
    },
    entities: {
      feed,
      post: (postId) => [...feed, E.podWallPost(postId)],
      comments: (postId) => [E.podWallPost(postId), ...blocks],
    },
    composer: 'collapsible',
    visibleAtFirst: 10,
    openCommentsOnLink: true,
    copy: {
      placeholder: 'Write something to the pod…',
      cannotPost: podCannotPostNote(podStatus, isActiveMember),
      empty: 'Nothing here yet. Start the conversation.',
      emptyReadOnly: 'Nothing has been posted in this pod yet.',
      loadFailed: 'We could not load the discussion just now.',
      notMember: 'Members talk here. Join the pod to read and post.',
    },
    authorHref: (authorId) => personHref(authorId, 'Pods'),
  };
}
