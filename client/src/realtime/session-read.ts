// ─── The member's own session, as a read that follows the server (final sweep F1, 2 Nov 2026) ─────────────────────
//
// The session (GET /auth/session) lives in the auth store: the onboarding gate, the top bar's name and photo and the
// role checks read it there. The store loads it once, at sign-in and on boot, and the screen that changes it re-reads
// it. A member's other tabs and devices were never told, so a device held at the onboarding gate kept the member there
// after they finished on another one, until it was loaded again.
//
// These are the options of a query whose only job is to re-read the session into the store whenever a tag of the
// member's own (user:<id>) arrives, or the socket connects after a gap (the app's entity-tag pipeline does both). It
// starts from the session the boot check already loaded, so opening the app sends no second read, and it is never
// stale on its own (no re-read on mount or focus): only the server's word re-reads it.
//
// Fix round 1: a burst of tags (a For You swipe session sends one per tap) is one read. Each tag restarts the read, and
// the read waits until the tags have been quiet for a moment, but never longer than the longest wait from the first tag
// of the burst. Which answer is put in place is the store's to decide (rereadSession): never one older than a session
// already in place, whatever order the answers arrive in.

/** How long the tags must be quiet before the session is read. */
export const SESSION_READ_COALESCE_MS = 1000;
/** The longest a burst that never pauses holds the read back, from its first tag. */
export const SESSION_READ_MAX_WAIT_MS = 5000;
export interface SessionReadTiming { coalesceMs: number; maxWaitMs: number }

/** The query key's first element. */
export const SESSION_READ_KEY = 'auth-session';

/**
 * When the current burst of tags began: set by its first read, cleared once a read is sent (one session read per tab).
 * A start left behind by a read that was dropped without a successor (signed out, the page closed) is too old to count.
 */
let burstSince: number | null = null;

/** Resolves after `ms`, or rejects at once when the read is superseded (a new tag restarted it). */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

export function sessionReadOptions(
  memberId: string,
  reread: (signal: AbortSignal) => Promise<unknown>,
  loaded: unknown,
  timing: SessionReadTiming = { coalesceMs: SESSION_READ_COALESCE_MS, maxWaitMs: SESSION_READ_MAX_WAIT_MS },
) {
  return {
    queryKey: [SESSION_READ_KEY, memberId] as const,
    // A query's answer may not be undefined; what it holds is never read (the store is where the session is read).
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const now = Date.now();
      if (burstSince === null || now - burstSince > timing.maxWaitMs + timing.coalesceMs) burstSince = now;
      await wait(Math.max(0, Math.min(timing.coalesceMs, burstSince + timing.maxWaitMs - now)), signal);
      burstSince = null;
      return (await reread(signal)) ?? null;
    },
    initialData: loaded ?? null,
    initialDataUpdatedAt: Date.now(),
    staleTime: Infinity,
    // A read that fails is not tried again on a timer: the next tag, or the next connect after a gap, reads it again.
    retry: false,
  };
}
