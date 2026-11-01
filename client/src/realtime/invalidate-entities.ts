// ─── Refresh the reads a set of entity tags names ────────────────────────────
//
// The one rule for which cached reads a tag refreshes: every query whose `meta.entities` shares at least one tag with
// the set. The server's `entity:changed` goes through it (useEntityChangedHandler), and so does a tab's own mutation
// whose answer the tab cannot count on hearing back over its socket (a read marked by REST before the socket is up).

import type { Query, QueryClient } from '@tanstack/react-query';

/** True when the query declares at least one of these tags in `meta.entities`. */
export function touchesEntities(query: Pick<Query, 'meta'>, entities: ReadonlySet<string>): boolean {
  const tags = (query.meta as { entities?: unknown } | undefined)?.entities;
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => typeof tag === 'string' && entities.has(tag));
}

/** Invalidate (and so refetch, where shown) every query that declares one of these tags. */
export function invalidateEntities(client: QueryClient, entities: readonly string[]): Promise<void> {
  if (entities.length === 0) return Promise.resolve();
  const set = new Set(entities);
  return client.invalidateQueries({ predicate: (query) => touchesEntities(query, set) });
}
