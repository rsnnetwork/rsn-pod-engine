// ─── A read the server refused for its rate limit (429) is read again once the limit allows ──────────────────────────
//
// Review I2 (11 Nov 2026): the server allows each member a number of requests a minute (one fixed window). A read refused
// inside the window failed for good: its own retries (1, 2 and 4 s) all fell inside the same window, and nothing read it
// again until the next change named it, a refocus or a remount. On the preview an organiser's event page kept
// "Registration open" over a cancelled event that way. So the cache is watched: a tagged read (meta.entities, one that
// follows the server's changes) whose final attempt was refused with 429 is read again ONCE after the window has had time
// to reset: the reset the server names when the browser can read it (Retry-After, RateLimit-Reset), else
// RATE_LIMIT_FALLBACK_MS, plus a little jitter so a page's reads do not all come back in the same instant. One waiting
// re-read per query. Refused again, it waits again, at most RATE_LIMIT_MAX_TRIES times in a row; any read that succeeds
// starts the count again, and a query that leaves the cache drops its wait. Nothing here retries in a loop.

import type { Query, QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query';

/** When the server's reset cannot be read (the browser shows a cross-origin response only its safelisted headers). */
export const RATE_LIMIT_FALLBACK_MS = 20_000;
/** Up to this much is added to each wait, so the reads of one page come back spread out. */
export const RATE_LIMIT_JITTER_MS = 5_000;
/** A reset the server names is waited for, but never longer than this. */
export const RATE_LIMIT_MAX_WAIT_MS = 120_000;
/** Re-reads in a row for one query while it keeps being refused (about a minute and a half at the fallback). */
export const RATE_LIMIT_MAX_TRIES = 4;

type HeaderBag = Record<string, unknown> & { get?: (name: string) => unknown };

interface RefusedResponse { status?: number; headers?: HeaderBag }

function responseOf(err: unknown): RefusedResponse | undefined {
  return (err as { response?: RefusedResponse } | null | undefined)?.response;
}

/** The server refused the request for its rate limit. */
export function isRateLimited(err: unknown): boolean {
  return responseOf(err)?.status === 429;
}

function header(headers: HeaderBag | undefined, name: string): string | null {
  if (!headers) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Seconds (`Retry-After: 30`, `RateLimit-Reset: 30`) or an HTTP date (`Retry-After: <date>`), as milliseconds from now. */
function waitNamedBy(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at - now;
}

/**
 * How long to wait before reading again after a 429: the reset the server named, if the browser let the page read it,
 * else the fallback; at least a second, at most RATE_LIMIT_MAX_WAIT_MS, plus up to RATE_LIMIT_JITTER_MS.
 */
export function rateLimitWaitMs(err: unknown, { now = Date.now(), random = Math.random }: { now?: number; random?: () => number } = {}): number {
  const headers = responseOf(err)?.headers;
  const named = waitNamedBy(header(headers, 'retry-after'), now) ?? waitNamedBy(header(headers, 'ratelimit-reset'), now);
  const base = named === null ? RATE_LIMIT_FALLBACK_MS : Math.min(Math.max(named, 1000), RATE_LIMIT_MAX_WAIT_MS);
  return Math.round(base + random() * RATE_LIMIT_JITTER_MS);
}

/** Retry a failed read once, as the app's default, but never a 429: its re-read waits for the window (below). */
export function retryOnceUnlessRateLimited(failureCount: number, err: unknown): boolean {
  return !isRateLimited(err) && failureCount < 1;
}

function isTagged(query: Pick<Query, 'meta'>): boolean {
  const tags = (query.meta as { entities?: unknown } | undefined)?.entities;
  return Array.isArray(tags) && tags.length > 0;
}

/**
 * Watch the cache: a tagged read refused with 429 (its last attempt) is read again once the limit allows. Returns the
 * unwatch. `random` and the timers are for tests.
 */
export function watchRateLimitedReads(client: QueryClient, { random = Math.random }: { random?: () => number } = {}): () => void {
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  const tries = new Map<string, number>();

  const drop = (hash: string) => {
    const timer = waiting.get(hash);
    if (timer) clearTimeout(timer);
    waiting.delete(hash);
  };

  const readLater = (query: Query, err: unknown) => {
    const hash = query.queryHash;
    if (waiting.has(hash)) return;
    const done = tries.get(hash) ?? 0;
    if (done >= RATE_LIMIT_MAX_TRIES) return;
    tries.set(hash, done + 1);
    waiting.set(hash, setTimeout(() => {
      waiting.delete(hash);
      // Only a read that is still on a screen is sent; one nobody shows is marked stale and read when it is shown.
      void client.invalidateQueries({ predicate: (q) => q.queryHash === hash }, { cancelRefetch: false });
    }, rateLimitWaitMs(err, { random })));
  };

  const unwatch = client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    const hash = event.query.queryHash;
    if (event.type === 'removed') { drop(hash); tries.delete(hash); return; }
    if (event.type !== 'updated') return;
    if (event.action.type === 'success') { tries.delete(hash); return; }
    if (event.action.type === 'error' && isRateLimited(event.action.error) && isTagged(event.query)) readLater(event.query, event.action.error);
  });

  return () => {
    unwatch();
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
  };
}
