// ─── Refresh the reads a set of entity tags names ────────────────────────────
//
// The one rule for which cached reads a tag refreshes: every query whose `meta.entities` shares at least one tag with
// the set. The server's `entity:changed` goes through it (useEntityChangedHandler), and so does a tab's own mutation
// whose answer the tab cannot count on hearing back over its socket (a read marked by REST before the socket is up).
// A connect of the socket, the first one included, refreshes the tagged reads (subscribeEntitySync): a socket that was
// down heard nothing sent meanwhile, and a new tab heard nothing sent between its first reads and its socket's first
// connect. Without storming (T16 fix round 1): connects are coalesced to one refresh at once and at most one more per
// window.
// Final fix wave CX1 (2 Nov 2026): which reads a connect refreshes is decided by when each STARTED, not when it answered.
// A read that started before the socket connected can carry what the server held before a change whose entity:changed
// went out before this socket was in its rooms, and land after that change: it is read again, and one still on its way
// is sent again. A read that started after the connect already reflects everything the socket could have missed, and is
// left alone, on its way or not. ("Answered in the last 2 s" was skipped before, and left such a page stale until a
// reload: T19's Script E 5b in WebKit, CLAUDE.md section 3's late-joiner race.)

import type { Query, QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query';

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

/**
 * When each read of the cache last started, by query hash (a queryCache 'fetch' action). A read this subscription never
 * saw start (one from before it) counts as started before any connect.
 */
type ReadStarts = Map<string, number>;

/**
 * Whether a connect at `connectedAt` should read this query again: it follows the server's changes, and its latest
 * read started before the socket was listening (so its answer may be from before a change the socket missed).
 */
function mayHaveMissed(query: Pick<Query, 'meta' | 'queryHash'>, connectedAt: number, starts: ReadStarts): boolean {
  if (!isTagged(query)) return false;
  return (starts.get(query.queryHash) ?? Number.NEGATIVE_INFINITY) < connectedAt;
}

/**
 * Read again every tagged query whose latest read started before the connect at `connectedAt`: its answer may be from
 * before a change the socket missed. One on its way with data already is sent again (cancelRefetch). A first read still
 * on its way (no data yet) cannot be re-sent that way, and cancelling it would fail whoever awaits it, so it is read again
 * as soon as it lands. Reads that started after the connect are not touched. Each read sent here is noted as started at
 * `at`.
 */
function resyncAfterConnect(client: QueryClient, connectedAt: number, at: number, starts: ReadStarts): Promise<void> {
  // Chosen once, before anything is sent: the cache asks the predicate again for the refetch that follows the invalidate.
  const missed = client.getQueryCache().findAll({ predicate: (query) => mayHaveMissed(query, connectedAt, starts) });
  const firstReads = missed.filter((query) => query.state.fetchStatus === 'fetching' && query.state.data === undefined);
  const atOnce = new Set(missed.filter((query) => !firstReads.includes(query)).map((query) => query.queryHash));
  for (const query of missed) starts.set(query.queryHash, at);
  const later = firstReads.map((query) => {
    const hash = query.queryHash;
    const again = () => client.invalidateQueries({ predicate: (q) => q.queryHash === hash });
    return (query.promise ?? Promise.resolve()).then(again, again);
  });
  return Promise.all([
    client.invalidateQueries({ predicate: (query) => atOnce.has(query.queryHash) }, { cancelRefetch: true }),
    ...later,
  ]).then(() => undefined);
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
 * first, and each one after a gap) refreshes the tagged reads that started before it (CX1). The first connect in a
 * quiet window is answered at once; any more within the window are answered together, once, when it ends, so a socket
 * reconnecting every second refreshes once per window, not once per connect; that one refresh reads again what started
 * before the latest of those connects. `now` is for tests. Returns the unsubscribe.
 */
export function subscribeEntitySync(
  socket: EntitySignals,
  client: QueryClient,
  { now = Date.now }: { now?: () => number } = {},
): () => void {
  const onChanged = (data: { entities?: string[] }) => {
    void invalidateEntities(client, Array.isArray(data?.entities) ? data.entities : []);
  };
  const starts: ReadStarts = new Map();
  const unwatch = client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type === 'removed') starts.delete(event.query.queryHash);
    else if (event.type === 'updated' && event.action.type === 'fetch') starts.set(event.query.queryHash, now());
  });
  let lastResync = Number.NEGATIVE_INFINITY;
  let lastConnect = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const resync = () => {
    lastResync = now();
    void resyncAfterConnect(client, lastConnect, lastResync, starts);
  };
  const onConnect = () => {
    lastConnect = now();
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
    unwatch();
    if (trailing) clearTimeout(trailing);
  };
}
