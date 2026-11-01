// ─── Refresh the reads a set of entity tags names ────────────────────────────
//
// The one rule for which cached reads a tag refreshes: every query whose `meta.entities` shares at least one tag with
// the set. The server's `entity:changed` goes through it (useEntityChangedHandler), and so does a tab's own mutation
// whose answer the tab cannot count on hearing back over its socket (a read marked by REST before the socket is up).
// A connect of the socket, the first one included, refreshes the tagged reads (subscribeEntitySync): a socket that was
// down heard nothing sent meanwhile, and a new tab heard nothing sent between its first reads and its socket's first
// connect. Without storming (T16 fix round 1): connects are coalesced to one refresh at once and at most one more per
// window, a read on its way is never cancelled, and a read that answered in the last moments is not read again.

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

/** A flapping socket's connects are answered at most once at once and once more per this window. */
export const CONNECT_RESYNC_WINDOW_MS = 5000;
/** A read that answered this recently already has what a connect could have missed (a page load's own first reads). */
export const RECENTLY_READ_MS = 2000;

/**
 * Whether a connect at `at` should read this query again: it follows the server's changes, it is not on its way now
 * (that answer is about to land, and cancelling it would only send it again), and it did not answer in the last moments.
 */
function mayHaveMissed(query: Pick<Query, 'meta' | 'state'>, at: number): boolean {
  if (!isTagged(query) || query.state.fetchStatus === 'fetching') return false;
  return at - query.state.dataUpdatedAt >= RECENTLY_READ_MS;
}

/** Invalidate the tagged queries a connect at `at` may have missed, never cancelling a read in flight. */
function resyncAfterConnect(client: QueryClient, at: number): Promise<void> {
  return client.invalidateQueries({ predicate: (query) => mayHaveMissed(query, at) }, { cancelRefetch: false });
}

/** The two socket events the app's realtime cache follows. The app's socket.io client is one. */
export interface EntitySignals {
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'entity:changed', listener: (data: { entities?: string[] }) => void): unknown;
  off(event: 'connect', listener: () => void): unknown;
  off(event: 'entity:changed', listener: (data: { entities?: string[] }) => void): unknown;
}

/**
 * Keeps the cache in step with the server: entity:changed refreshes the reads its tags name, at once; a connect (the
 * first, and each one after a gap) refreshes the tagged reads that may have missed something. The first connect in a
 * quiet window is answered at once; any more within the window are answered together, once, when it ends, so a socket
 * reconnecting every second refreshes once per window, not once per connect. `now` is for tests. Returns the
 * unsubscribe.
 */
export function subscribeEntitySync(
  socket: EntitySignals,
  client: QueryClient,
  { now = Date.now }: { now?: () => number } = {},
): () => void {
  const onChanged = (data: { entities?: string[] }) => {
    void invalidateEntities(client, Array.isArray(data?.entities) ? data.entities : []);
  };
  let lastResync = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const resync = () => {
    lastResync = now();
    void resyncAfterConnect(client, lastResync);
  };
  const onConnect = () => {
    if (trailing) return;
    const since = now() - lastResync;
    if (since >= CONNECT_RESYNC_WINDOW_MS) {
      resync();
      return;
    }
    trailing = setTimeout(() => { trailing = null; resync(); }, CONNECT_RESYNC_WINDOW_MS - since);
  };
  socket.on('entity:changed', onChanged);
  socket.on('connect', onConnect);
  return () => {
    socket.off('entity:changed', onChanged);
    socket.off('connect', onConnect);
    if (trailing) clearTimeout(trailing);
  };
}
