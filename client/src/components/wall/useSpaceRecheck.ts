// When a wall write is refused because the space itself changed (the pod was archived, suspended or put back to a
// draft; the circle was archived), the space's own reads are read again (12 Nov 2026, prod smoke: a page that never heard
// the archive kept saying "This pod is not open for new activity right now." under the archived wall, because the pod's
// status on screen was still the old one and nothing read the pod again).
//
// It goes through the same rule the app-wide handler uses for the server's entity:changed (invalidateEntities: every
// query whose meta.entities names one of the space's tags), so the pod's page, its status, its note and its controls
// all correct themselves. Nothing is written into the cache by hand. The feed itself is read again by the caller, as
// before (a 409 refreshes the wall).

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateEntities } from '@/realtime/invalidate-entities';
import { isSpaceClosed } from './wall-logic';
import type { WallConfig } from './wall-types';

/** A handler for a failed wall write: when the server says the space is closed, the space's own reads are read again. */
export function useSpaceRecheck(config: WallConfig): (err: unknown) => void {
  const queryClient = useQueryClient();
  const tags = config.spaceEntities;
  return useCallback((err: unknown) => {
    if (isSpaceClosed(err)) void invalidateEntities(queryClient, tags);
  }, [queryClient, tags]);
}
