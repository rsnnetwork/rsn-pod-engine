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

/** The query key's first element. */
export const SESSION_READ_KEY = 'auth-session';

export function sessionReadOptions(memberId: string, reread: () => Promise<unknown>, loaded: unknown) {
  return {
    queryKey: [SESSION_READ_KEY, memberId] as const,
    // A query's answer may not be undefined; what it holds is never read (the store is where the session is read).
    queryFn: async () => (await reread()) ?? null,
    initialData: loaded ?? null,
    initialDataUpdatedAt: Date.now(),
    staleTime: Infinity,
  };
}
