// The pod page and its wall read the pod's status separately: the page from its own read of the pod, the wall from
// its feed (which says the status it found). When the two disagree, the pod is read again by its entity tag, once per
// disagreement (createPodStatusRecheck), so the badge, the buttons and the note under the wall settle on one status.

import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { E } from '@/realtime/entities';
import { invalidateEntities } from '@/realtime/invalidate-entities';
import { createPodStatusRecheck } from './pod-wall-config';

export function usePodStatusRecheck(podId: string, fromFeed: string | undefined, onPage: string | undefined): void {
  const queryClient = useQueryClient();
  // One checker per pod, so a disagreement already asked about is remembered while the pod stays the same.
  const recheck = useMemo(
    () => createPodStatusRecheck(() => { void invalidateEntities(queryClient, [E.pod(podId)]); }),
    [queryClient, podId],
  );
  useEffect(() => {
    recheck(fromFeed, onPage);
  }, [recheck, fromFeed, onPage]);
}
