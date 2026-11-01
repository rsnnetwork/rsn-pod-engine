// ─── Refresh the reads a set of entity tags names ────────────────────────────
//
// The one rule for which cached reads a tag refreshes: every query whose `meta.entities` shares at least one tag with
// the set. The server's `entity:changed` goes through it (useEntityChangedHandler), and so does a tab's own mutation
// whose answer the tab cannot count on hearing back over its socket (a read marked by REST before the socket is up).
// Every connect of the socket, the first one included, refreshes every tagged read once (subscribeEntitySync): a
// socket that was down heard nothing sent meanwhile, and a new tab heard nothing sent between its first reads and its
// socket's first connect.

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

/** True when the query declares any tag at all: it follows the server's changes, so a gap in hearing them matters. */
function isTagged(query: Pick<Query, 'meta'>): boolean {
  const tags = (query.meta as { entities?: unknown } | undefined)?.entities;
  return Array.isArray(tags) && tags.length > 0;
}

/** Invalidate every query that declares meta.entities: what a socket that was not listening may have missed. */
export function invalidateEveryTaggedRead(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ predicate: isTagged });
}

/** The two socket events the app's realtime cache follows. The app's socket.io client is one. */
export interface EntitySignals {
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'entity:changed', listener: (data: { entities?: string[] }) => void): unknown;
  off(event: 'connect', listener: () => void): unknown;
  off(event: 'entity:changed', listener: (data: { entities?: string[] }) => void): unknown;
}

/**
 * Keeps the cache in step with the server: entity:changed refreshes the reads its tags name, and every connect (the
 * first, and each one after a gap) refreshes every tagged read once. Returns the unsubscribe.
 */
export function subscribeEntitySync(socket: EntitySignals, client: QueryClient): () => void {
  const onChanged = (data: { entities?: string[] }) => {
    void invalidateEntities(client, Array.isArray(data?.entities) ? data.entities : []);
  };
  const onConnect = () => { void invalidateEveryTaggedRead(client); };
  socket.on('entity:changed', onChanged);
  socket.on('connect', onConnect);
  return () => {
    socket.off('entity:changed', onChanged);
    socket.off('connect', onConnect);
  };
}
