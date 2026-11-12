// ─── Circle Wall ─────────────────────────────────────────────────────────────
//
// REASON v1 Phase 4 (20 Jul 2026). The feed inside a circle: text + images + external link shares, comments,
// pinning. Media rides the existing Cloudinary unsigned-upload path; link cards are rendered from the URL alone — the
// server never fetches external sites.
//
// 4 Sep 2026 (Ali): the wall behaves like a social feed. Reactions (Like, Love, Applause, Insightful, Celebrate; one
// per member per post), replies one level deep, likes on comments, share (copy the link, or post it into another
// circle with attribution to the original), and a ?post= deep link that scrolls the post into view. Phone-first:
// every control is a 44px target and the reaction picker is a row that wraps.
//
// 26 Oct 2026: the feed itself moved to components/wall, because the pod now has a wall too (COM-01).
//
// Shirley pilot S4 (11 Nov 2026): the circle wall is the pod wall's equal. Its members read it (D2): anyone else
// (an open circle's visitor included) is told to join instead of being shown posts. The server says what the viewer
// may do (its owner and moderators moderate and pin; authors edit), and tells the circle's members of every change by
// entity tag, so the wall no longer polls (circle-wall-config.ts).

import { useMemo } from 'react';
import Wall, { WallNotMember } from '@/components/wall/Wall';
import type { WallConfig } from '@/components/wall/wall-types';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/lib/utils';
import ShareToCircle from './ShareToCircle';
import { circleWallConfig } from './circle-wall-config';

export default function CircleWall({ circleId, isMember, canManage, highlightPostId }: {
  circleId: string;
  isMember: boolean;
  /** The circle's owner or a moderator, or a platform admin (the page's own answer), until the feed says. */
  canManage: boolean;
  highlightPostId?: string;
}) {
  const me = useAuthStore((s) => s.user?.id);
  const admin = isAdmin(useAuthStore((s) => s.user?.role));

  const config = useMemo<WallConfig>(() => ({
    ...circleWallConfig({ circleId, me, isMember }),
    reportKind: 'circle_post',
    share: {
      href: (post) => `/circles/${post.circleId || circleId}?post=${post.id}`,
      renderTargetForm: ({ post, onDone }) => <ShareToCircle post={post} currentCircleId={circleId} onDone={onDone} />,
    },
  }), [circleId, me, isMember]);

  // D2: not a member and not a platform admin: no posts, and no request for them.
  if (!isMember && !admin) return <WallNotMember config={config} />;
  return <Wall key={circleId} config={config} fallbackViewer={{ canPost: isMember, canModerate: canManage }} highlightPostId={highlightPostId} />;
}
