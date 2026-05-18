// ─── Realtime predicate invalidator (client-side) ────────────────────────────
//
// Replaces NotificationBell's hard-coded list of query keys with predicate
// invalidation driven by each query's own meta.entities. Mount once at the
// app root; the socket layer subscribes globally.
//
// Contract: when a server emits `entity:changed` with `{ entities: [...] }`,
// every query whose `meta.entities` shares at least one string with the
// payload gets invalidated. Queries without meta.entities are untouched.
//
// See: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// for the full migration plan.

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';

export function useEntityChangedHandler(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (data: { entities?: string[] }) => {
      const incoming = Array.isArray(data?.entities) ? data.entities : [];
      if (incoming.length === 0) return;
      const incomingSet = new Set(incoming);

      queryClient.invalidateQueries({
        predicate: (query) => {
          const tags = (query.meta as { entities?: string[] } | undefined)?.entities;
          if (!tags || !Array.isArray(tags) || tags.length === 0) return false;
          for (const tag of tags) {
            if (incomingSet.has(tag)) return true;
          }
          return false;
        },
      });
    };

    socket.on('entity:changed', handler);
    return () => {
      socket.off('entity:changed', handler);
    };
  }, [queryClient]);
}
