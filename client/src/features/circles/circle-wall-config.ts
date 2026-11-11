// What makes a circle's wall the circle's: where it reads and writes, the entity tags its queries declare, the words
// it says. Pure on purpose (no React, axios, store or router), so a test can run it:
// server/src/__tests__/client/circle-wall-client.test.ts. The components that draw it are in components/wall; the
// share-into-another-circle form (React) is added by CircleWall.tsx.
//
// Shirley pilot S4 (11 Nov 2026): the server tells a circle's members, by entity tag, whenever its wall changes
// (fanoutCircleWall: circle:<id>:wall, circle-wall-post:<id>), so this wall no longer polls every 30 seconds. Every
// circle's wall is read by its members only (D2): anyone else is shown `notMember` instead of posts. A link that names
// a post (a bell, a shared address) opens its comments.

import { E } from '../../realtime/entities';
import type { WallConfig } from '../../components/wall/wall-types';

export interface CircleWallInput {
  circleId: string;
  /** The signed-in member's id: their blocks decide which authors are left out of the wall. */
  me: string | undefined;
  /** In the circle. A platform admin who is not reads and moderates, and does not post. */
  isMember: boolean;
}

const EMPTY = 'Nothing here yet. Start the conversation.';
export const CIRCLE_WALL_NOT_MEMBER = 'Members talk here. Join this circle to read and post on its wall.';

/** What stands where the composer would, for someone who may read but not post. */
export function circleCannotPostNote(isMember: boolean): string {
  return isMember
    ? 'This circle is archived, so its wall is read-only.'
    : 'You can read and moderate this wall. Join the circle to post.';
}

export function circleWallConfig({ circleId, me, isMember }: CircleWallInput): WallConfig {
  const blocks = me ? [E.userBlocks(me)] : [];
  // The feed answers more than the posts: what the viewer may do depends on the circle (archived or not) and on the
  // viewer's place and role in it, and which authors it leaves out on their blocks.
  const feed = [E.circleWall(circleId), E.circle(circleId), E.circleMembers(circleId), ...blocks];
  return {
    testId: 'circle-wall',
    feedPath: `/circles/${circleId}/posts`,
    itemBase: '/circles',
    keys: {
      feed: ['circleWall', circleId],
      post: (postId) => ['circleWall', circleId, 'post', postId],
      comments: (postId) => ['circleWall', circleId, 'comments', postId],
    },
    entities: {
      feed,
      post: (postId) => [...feed, E.circleWallPost(postId)],
      comments: (postId) => [E.circleWallPost(postId), ...blocks],
    },
    composer: 'open',
    openCommentsOnLink: true,
    copy: {
      placeholder: 'Share something with the circle…',
      cannotPost: circleCannotPostNote(isMember),
      empty: EMPTY,
      emptyReadOnly: 'Nothing has been posted in this circle yet.',
      loadFailed: 'We could not load the wall just now.',
      notMember: CIRCLE_WALL_NOT_MEMBER,
    },
  };
}
