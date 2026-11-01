// ─── Realtime predicate invalidator (client-side) ────────────────────────────
//
// Replaces NotificationBell's hard-coded list of query keys with predicate
// invalidation driven by each query's own meta.entities. Mount once at the
// app root; the socket layer subscribes globally.
//
// Contract: when a server emits `entity:changed` with `{ entities: [...] }`,
// every query whose `meta.entities` shares at least one string with the
// payload gets invalidated. Queries without meta.entities are untouched.
// On every connect of the socket (the first, and each reconnect after a gap)
// every query that declares meta.entities is invalidated once, so nothing sent
// while this tab was not listening stays unseen (P1 item 17, 1 Nov 2026).
//
// See: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// for the full migration plan.

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';
import { subscribeEntitySync } from './invalidate-entities';

export function useEntityChangedHandler(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeEntitySync(getSocket(), queryClient);
  }, [queryClient]);
}
