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
// Fix wave 2 (2 Nov 2026): every read of a page load starts before its socket connects, so CX1 read each of them twice
// (one member's requests in n1-t11 went from 242 to 393, past production's 100 a minute). The server now sends a socket
// that joins the tags its member was sent in the last minute (server realtime/recent-entities.ts), which reads again
// exactly what changed. So the FIRST connect re-reads only reads that started more than REPLAY_TRUST_MS before it; a
// reconnect still re-reads every tagged read that started before it (after a gap, everything is read again).
// Fix round 1 (re-review of fix wave 2): a first read can still be ON ITS WAY when a tag naming it arrives (the replay, or
// any live change). query-core 5.90 hands such an invalidate the read already on its way, whose old answer then clears
// the invalidated flag, so the tag changed nothing. A matched first read on its way is read again once it lands. The
// replay (entity:changed with `replayed: true`) is folded into the connect re-read: it reads again only what that
// re-read did not just send, so a reconnect sends each read once.

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

/** A query whose first read is on its way: it has no data yet, so an invalidate cannot send it again. */
const firstReadOnItsWay = (query: Query) => query.state.fetchStatus === 'fetching' && query.state.data === undefined;

/** Read this query again once the read on its way has landed (or failed): its answer may be from before the change. */
function readAgainWhenItLands(client: QueryClient, query: Query): Promise<void> {
  const hash = query.queryHash;
  const again = () => client.invalidateQueries({ predicate: (q) => q.queryHash === hash });
  return (query.promise ?? Promise.resolve()).then(again, again);
}

/**
 * A change the server told of (entity:changed): every query that declares one of its tags is read again, and one whose
 * first read is on its way is read again once that read lands (fix round 1).
 */
function readChanged(client: QueryClient, entities: readonly string[]): Promise<void> {
  if (entities.length === 0) return Promise.resolve();
  const set = new Set(entities);
  const onTheirWay = client.getQueryCache().findAll({ predicate: (query) => touchesEntities(query, set) && firstReadOnItsWay(query) });
  return Promise.all([invalidateEntities(client, entities), ...onTheirWay.map((query) => readAgainWhenItLands(client, query))])
    .then(() => undefined);
}

/** True when the query declares any tag at all: it follows the server's changes, so a gap in hearing them matters. */
function isTagged(query: Pick<Query, 'meta'>): boolean {
  const tags = (query.meta as { entities?: unknown } | undefined)?.entities;
  return Array.isArray(tags) && tags.length > 0;
}

/** A flapping socket's connects are answered at most once at once and once more per this window. */
export const CONNECT_RESYNC_WINDOW_MS = 5000;
/**
 * How far back the server's replay to a joining socket is trusted on the first connect: half the minute the server
 * keeps (RECENT_ENTITIES_MS), which leaves room for a slow read and for the two clocks.
 */
export const REPLAY_TRUST_MS = 30_000;

/**
 * When each read of the cache last started, by query hash (a queryCache 'fetch' action). A query that holds data it did
 * not fetch (initialData), or that was in the cache before this subscription, counts from when its data was put there.
 */
type ReadStarts = Map<string, number>;

/**
 * Whether a connect should read this query again: it follows the server's changes, and its latest read started before
 * `readsFrom` (the connect itself after a reconnect; REPLAY_TRUST_MS before it on the first connect), so its answer may
 * be from before a change the socket missed and the server's replay does not cover.
 */
function mayHaveMissed(query: Pick<Query, 'meta' | 'queryHash'>, readsFrom: number, starts: ReadStarts): boolean {
  if (!isTagged(query)) return false;
  return (starts.get(query.queryHash) ?? Number.NEGATIVE_INFINITY) < readsFrom;
}

/**
 * Read again every tagged query whose latest read started before `readsFrom`: its answer may be from before a change
 * the socket missed. One on its way with data already is sent again (cancelRefetch). A first read still
 * on its way (no data yet) cannot be re-sent that way, and cancelling it would fail whoever awaits it, so it is read again
 * as soon as it lands. Reads that started after the connect are not touched. Each read sent here is noted as started at
 * `at`.
 */
function resyncAfterConnect(client: QueryClient, readsFrom: number, at: number, starts: ReadStarts): Promise<void> {
  // Chosen once, before anything is sent: the cache asks the predicate again for the refetch that follows the invalidate.
  return readAgain(client, client.getQueryCache().findAll({ predicate: (query) => mayHaveMissed(query, readsFrom, starts) }), at, starts);
}

/**
 * Read these queries again, each noted as started at `at`: one with data on its way is sent again (cancelRefetch), a
 * first read on its way is read again once it lands.
 */
function readAgain(client: QueryClient, queries: Query[], at: number, starts: ReadStarts): Promise<void> {
  const firstReads = queries.filter(firstReadOnItsWay);
  const atOnce = new Set(queries.filter((query) => !firstReads.includes(query)).map((query) => query.queryHash));
  for (const query of queries) starts.set(query.queryHash, at);
  return Promise.all([
    client.invalidateQueries({ predicate: (query) => atOnce.has(query.queryHash) }, { cancelRefetch: true }),
    ...firstReads.map((query) => readAgainWhenItLands(client, query)),
  ]).then(() => undefined);
}

/** The two socket events the app's realtime cache follows. The app's socket.io client is one. */
export interface EntitySignals {
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'entity:changed', listener: (data: EntityChange) => void): unknown;
  off(event: 'connect', listener: () => void): unknown;
  off(event: 'entity:changed', listener: (data: EntityChange) => void): unknown;
}

/** What entity:changed carries. `replayed`: the server's replay to a socket that has just joined (fix wave 2). */
export interface EntityChange { entities?: string[]; replayed?: boolean }

/**
 * Keeps the cache in step with the server: entity:changed refreshes the reads its tags name, at once (the server's
 * replay to a joining socket comes this way too); a reconnect refreshes the tagged reads that started before it (CX1),
 * and the first connect only those older than the replay covers (fix wave 2). The first connect in a quiet window is
 * answered at once; any more within the window are answered together, once, when it ends, so a socket reconnecting
 * every second refreshes once per window, not once per connect; that one refresh reads again what started before the
 * latest of those connects. `now` is for tests. Returns the unsubscribe.
 */
export function subscribeEntitySync(
  socket: EntitySignals,
  client: QueryClient,
  { now = Date.now }: { now?: () => number } = {},
): () => void {
  const onChanged = (data: EntityChange) => {
    const entities = Array.isArray(data?.entities) ? data.entities : [];
    if (data?.replayed && connects > 0) { replayed(entities); return; }
    void readChanged(client, entities);
  };
  const starts: ReadStarts = new Map();
  const heldSince = (query: Query) => query.state.dataUpdatedAt || now();
  for (const query of client.getQueryCache().getAll()) starts.set(query.queryHash, heldSince(query));
  const unwatch = client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type === 'removed') starts.delete(event.query.queryHash);
    else if (event.type === 'added') starts.set(event.query.queryHash, heldSince(event.query));
    else if (event.type === 'updated' && event.action.type === 'fetch') starts.set(event.query.queryHash, now());
  });
  let lastResync = Number.NEGATIVE_INFINITY;
  let lastConnect = Number.NEGATIVE_INFINITY;
  let connects = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const resync = () => {
    lastResync = now();
    // Only the first connect leans on the server's replay; after a reconnect everything that started before it is read.
    const readsFrom = connects === 1 ? lastConnect - REPLAY_TRUST_MS : lastConnect;
    void resyncAfterConnect(client, readsFrom, lastResync, starts);
  };
  // The replay that follows a connect: what the connect re-read has not just sent. A re-read still waiting for its window
  // reads everything that started before the connect anyway; otherwise only the named reads that started before it.
  const replayed = (entities: string[]) => {
    if (trailing || entities.length === 0) return;
    const set = new Set(entities);
    const named = client.getQueryCache().findAll({
      predicate: (query) => touchesEntities(query, set) && (starts.get(query.queryHash) ?? Number.NEGATIVE_INFINITY) < lastConnect,
    });
    void readAgain(client, named, now(), starts);
  };
  const onConnect = () => {
    lastConnect = now();
    connects += 1;
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
