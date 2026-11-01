// ─── The pod's discussion (COM-01, 26 Oct 2026) ──────────────────────────────
//
// Stefan, back in the pod after an event: "We can't write in the pod itself. There's no wall." Active members
// of a pod read and write here, between events: posts, comments with replies, reactions, a pinned strip, and
// moderation by the pod's director or host. It is the circle wall's feed (components/wall) on the pod's
// routes (/pods/:podId/wall/...), configured in pod-wall-config.ts.
//
// Everyone who is not an active member of the pod (a visitor to a public pod, someone with a request still
// waiting, someone who left or was removed) is told so instead of being shown posts.

import { useMemo } from 'react';
import Wall, { WallNotMember } from '@/components/wall/Wall';
import { useAuthStore } from '@/stores/authStore';
import { podWallConfig } from './pod-wall-config';

// The page reads the pod's status from its own query, which the archive's tags refresh once the archive is saved
// (H2b item 20): the wall no longer has to notice a status the page has not heard yet (P1 item 16).
export default function PodWall({ podId, podStatus, isMember, isActiveMember, highlightPostId }: {
  podId: string;
  podStatus: string | undefined;
  /** May read the wall: an active member, or a platform admin (who reads and moderates, and does not post). */
  isMember: boolean;
  /** An active member of the pod. */
  isActiveMember: boolean;
  /** The post a ?post= link names. */
  highlightPostId?: string;
}) {
  const me = useAuthStore((s) => s.user?.id);
  const config = useMemo(
    () => podWallConfig({ podId, me, podStatus, isActiveMember }),
    [podId, me, podStatus, isActiveMember],
  );

  if (!isMember) return <WallNotMember config={config} />;
  return <Wall key={podId} config={config} highlightPostId={highlightPostId} />;
}
