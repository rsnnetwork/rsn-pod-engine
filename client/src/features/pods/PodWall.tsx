// ─── The pod's discussion (COM-01, 26 Oct 2026) ──────────────────────────────
//
// Stefan, back in the pod after an event: "We can't write in the pod itself. There's no wall." Active members
// of a pod read and write here, between events: posts, comments with replies, reactions, a pinned strip, and
// moderation by the pod's director or host. It is the circle wall's feed (components/wall) on the pod's
// routes (/pods/:podId/wall/...), configured in pod-wall-config.ts.
//
// Everyone who is not an active member of the pod (a visitor to a public pod, someone with a request still
// waiting, someone who left or was removed) is told so instead of being shown posts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Wall, { WallNotMember } from '@/components/wall/Wall';
import type { WallViewer } from '@/components/wall/wall-types';
import { useAuthStore } from '@/stores/authStore';
import { podStatusLooksStale, podWallConfig } from './pod-wall-config';

export default function PodWall({ podId, podStatus, isMember, isActiveMember, highlightPostId, onPodStatusStale }: {
  podId: string;
  podStatus: string | undefined;
  /** May read the wall: an active member, or a platform admin (who reads and moderates, and does not post). */
  isMember: boolean;
  /** An active member of the pod. */
  isActiveMember: boolean;
  /** The post a ?post= link names. */
  highlightPostId?: string;
  /** The wall knows the pod is closed and the page's copy of the pod says it is open: read the pod again. */
  onPodStatusStale: () => void;
}) {
  const me = useAuthStore((s) => s.user?.id);
  const config = useMemo(
    () => podWallConfig({ podId, me, podStatus, isActiveMember }),
    [podId, me, podStatus, isActiveMember],
  );

  // What the server's feed says the viewer may do. When it says an active member cannot post but the pod
  // reads as open, the two disagree (see podStatusLooksStale) and the page is asked to read the pod again,
  // once per change: the effect runs only when what it reads changes, so an answer that stays the same
  // cannot ask twice.
  const [canPost, setCanPost] = useState<boolean | undefined>(undefined);
  const onViewerChange = useCallback((viewer: WallViewer) => setCanPost(viewer.canPost), []);
  const stale = useRef(onPodStatusStale);
  useEffect(() => { stale.current = onPodStatusStale; });
  useEffect(() => {
    if (podStatusLooksStale(canPost, isActiveMember, podStatus)) stale.current();
  }, [canPost, isActiveMember, podStatus]);

  if (!isMember) return <WallNotMember config={config} />;
  return <Wall key={podId} config={config} highlightPostId={highlightPostId} onViewerChange={onViewerChange} />;
}
