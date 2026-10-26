// ─── Circle Wall ─────────────────────────────────────────────────────────────
//
// REASON v1 Phase 4 (20 Jul 2026). The feed inside a circle: text + images + external link shares, comments,
// pinning. Posting is members-only (the server enforces it; the UI mirrors it with a join prompt). Media rides
// the existing Cloudinary unsigned-upload path; link cards are rendered from the URL alone — the server never
// fetches external sites.
//
// 4 Sep 2026 (Ali): the wall behaves like a social feed now. Reactions (Like, Love, Applause, Insightful,
// Celebrate; one per member per post), replies one level deep, likes on comments, share (copy the link, or post
// it into another circle with attribution to the original), delete on own posts and comments (admins any), and
// a ?post= deep link that scrolls the post into view. Phone-first: every control is a 44px target and the
// reaction picker is a row that wraps.
//
// 26 Oct 2026: the feed itself moved to components/wall, because the pod now has a wall too (COM-01). This
// file is what is the circle's: its routes (/circles/...), its words, its polling and its Share to a circle.

import { useMemo } from 'react';
import Wall from '@/components/wall/Wall';
import type { WallConfig } from '@/components/wall/wall-types';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/lib/utils';
import ShareToCircle from './ShareToCircle';

const EMPTY = 'Nothing here yet — start the conversation.';

export default function CircleWall({ circleId, isMember, highlightPostId }: { circleId: string; isMember: boolean; highlightPostId?: string }) {
  const admin = isAdmin(useAuthStore((s) => s.user?.role));

  const config = useMemo<WallConfig>(() => ({
    testId: 'circle-wall',
    feedPath: `/circles/${circleId}/posts`,
    itemBase: '/circles',
    keys: {
      feed: ['circleWall', circleId],
      post: (postId) => ['circleWall', circleId, 'post', postId],
      comments: (postId) => ['wallComments', postId],
    },
    // The circle's routes send no entity tags, so none of its queries can be told of a change: the feed polls.
    entities: { feed: [], post: () => [], comments: () => [] },
    pollMs: 30_000,
    composer: 'open',
    openCommentsOnLink: false,
    copy: {
      placeholder: 'Share something with the circle…',
      cannotPost: 'Join this circle to post on its wall.',
      empty: EMPTY,
      emptyReadOnly: EMPTY,
      loadFailed: 'We could not load the wall just now.',
      reactNeedsMembership: 'Join this circle to react.',
      likeNeedsMembership: 'Join this circle to like comments.',
    },
    share: {
      href: (post) => `/circles/${post.circleId || circleId}?post=${post.id}`,
      renderTargetForm: ({ post, onDone }) => <ShareToCircle post={post} currentCircleId={circleId} onDone={onDone} />,
    },
  }), [circleId]);

  // A circle's page knows who may post (a member) and who moderates (an admin); its feed does not say.
  return <Wall key={circleId} config={config} fallbackViewer={{ canPost: isMember, canModerate: admin }} highlightPostId={highlightPostId} />;
}
