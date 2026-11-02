import { create } from 'zustand';
import api from '@/lib/api';

interface AuthState {
  user: any | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  // Bug 32 (19 May Ali) — true once checkSession() has finished its first
  // pass (success OR failure). App.tsx gates the socket handshake on this
  // so we never connect with a stale localStorage token that hasn't been
  // validated yet. Without this flag the socket enters its retry-backoff
  // state on a 401 handshake and refuses to honour subsequent connect()
  // calls until the natural reconnect timer fires.
  isSessionChecked: boolean;
  /** Why the last session ended when the SERVER refused the account itself
   *  (ACCOUNT_CLOSED, USER_SUSPENDED). The login page says it in words. */
  signOutReason: string | null;
  /** True while the session check waits out an answer that is no refusal (a 429, a 5xx, no connection) with no member
   *  in place yet: the protected page says it is retrying instead of sending anyone to sign in. */
  sessionRetrying: boolean;

  login: (email: string, clientUrl?: string, inviteCode?: string) => Promise<any>;
  verify: (token: string) => Promise<void>;
  setTokensAndLoad: (accessToken: string, refreshToken: string) => Promise<void>;
  checkSession: () => Promise<void>;
  /** Try again (the waiting screen's button): ask for the session at once and start the waits again from the first.
   *  Resolves once that answer is in. Does nothing when no check is waiting. */
  retrySessionNow: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  logout: () => Promise<void>;
  setTokens: (access: string, refresh: string) => void;
  /** Adopt whatever tokens are in storage into memory WITHOUT writing them
   *  back (used by cross-tab sync). Returns false if none present. */
  adoptStoredTokens: () => boolean;
  /** End a session the server will never honour again, and keep the reason. */
  endBlockedSession: (reason: string) => void;
}

// ── Token storage (7 Sep 2026 — Stefan's test logout bug) ────────────────────
// Tokens used to live in two localStorage keys (rsn_access, rsn_refresh) written
// as two separate setItem calls. A second tab's `storage` listener fired on the
// access-key change, read the not-yet-updated refresh key, and wrote the STALE
// refresh back over the fresh one via setTokens(). Every refresh then 401'd
// ("Invalid refresh token") and the user was silently logged out ~15 min into
// the session. Now the pair lives under ONE key as a single atomic JSON write —
// no torn (new-access / old-refresh) pair is observable — and cross-tab
// listeners ADOPT into memory only, never writing tokens back.
const TOKENS_KEY = 'rsn_tokens';
const LEGACY_ACCESS = 'rsn_access';
const LEGACY_REFRESH = 'rsn_refresh';
const AUTH_PING = 'rsn_auth_completed_at';

interface StoredTokens {
  access: string;
  refresh: string;
}

function readStoredTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (raw) {
      const t = JSON.parse(raw);
      if (t && typeof t.access === 'string' && typeof t.refresh === 'string') {
        return { access: t.access, refresh: t.refresh };
      }
    }
  } catch {
    /* malformed — fall through to legacy */
  }
  // Migrate the pre-fix two-key layout on first read.
  const access = localStorage.getItem(LEGACY_ACCESS);
  const refresh = localStorage.getItem(LEGACY_REFRESH);
  if (access && refresh) {
    const t = { access, refresh };
    try {
      localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
    } catch {
      /* ignore quota errors */
    }
    return t;
  }
  return null;
}

function writeStoredTokens(t: StoredTokens): void {
  // Canonical key first — its `storage` event is the one other tabs act on,
  // and it is a single atomic value so no half-updated pair can be read.
  localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  // Mirror to the legacy keys so a rollback to the previous bundle keeps
  // working. New bundles never READ these for auth.
  localStorage.setItem(LEGACY_ACCESS, t.access);
  localStorage.setItem(LEGACY_REFRESH, t.refresh);
}

function clearStoredTokens(): void {
  localStorage.removeItem(TOKENS_KEY);
  localStorage.removeItem(LEGACY_ACCESS);
  localStorage.removeItem(LEGACY_REFRESH);
}

// Bumped whenever a NEW session is installed (verify / setTokens / refresh /
// cross-tab adopt). checkSession() captures it at the start; if it has changed
// by the time an in-flight check FAILS, a newer login superseded this check and
// the failure must NOT clear auth. This closes the boot-checkSession-vs-verify
// race that bounced Stefan to /login on the first click.
let authEpoch = 0;

// Which failed auth answers end a session, and how long to wait before asking again (fix wave 3, 2 Nov 2026).
//
// Only a refusal ends a session: the server saying no to the refresh token (401 or 403). An answer that says nothing
// about the session (429, the member used up their minute; 408; a 5xx; a request that never reached the server) keeps
// the member signed in, and the question is asked again after a wait that grows, or as long as Retry-After says when the
// answer carries one (it is only readable when the server exposes it to the page).

/** The waits between tries, the last one repeated. */
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];
/** The longest a Retry-After is waited for. */
const MAX_RETRY_AFTER_MS = 60_000;
/** Each fixed wait is moved by up to a fifth either way, so a member's tabs do not all ask again at the same moment. */
const RETRY_JITTER = 0.2;

/** The status of a failed request, or undefined when it never got an answer (network, timeout). */
function statusOf(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** True for a request the page itself called off: nothing failed, so nothing is tried again. */
function wasCancelled(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_CANCELED';
}

/** A failure that says nothing about the session: wait, and ask again. */
function isPassingFailure(err: unknown): boolean {
  if (wasCancelled(err)) return false;
  const status = statusOf(err);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/** The server refused the refresh token itself. */
function isRefreshRefusal(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/** How long to wait before try `attempt + 1`: Retry-After (seconds or a date) when given, else the growing wait, jittered. */
function retryWaitMs(err: unknown, attempt: number, now: number = Date.now()): number {
  const raw = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers?.['retry-after'];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const seconds = Number(raw);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 1000), MAX_RETRY_AFTER_MS);
  }
  const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return Math.round(wait * (1 - RETRY_JITTER + Math.random() * 2 * RETRY_JITTER));
}

// Only the newest session check may change the store (429 fix round 1, 2 Nov 2026). Each check takes the next number as
// it starts; one that finds a newer number after any await exits without a word. A newer check also ends the older one's
// wait at once, so its timer is not left behind to wake later.
let checksStarted = 0;

/** The wait the newest check is in, if it is waiting. */
let pendingWait: { timer: ReturnType<typeof setTimeout>; end: () => void } | null = null;

/** Ends the wait in progress now (a newer check, Try again): its check wakes and, superseded, exits. */
function endPendingWait(): void {
  if (!pendingWait) return;
  const { timer, end } = pendingWait;
  pendingWait = null;
  clearTimeout(timer);
  end();
}

function waitBeforeAskingAgain(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingWait?.timer === timer) pendingWait = null;
      resolve();
    }, ms);
    pendingWait = { timer, end: resolve };
  });
}

/** Set by Try again just before it starts a check: that check calls it once its first answer is in. */
let whenAnswered: (() => void) | null = null;

// Distinguishes a DEFINITIVE rejection (refresh token truly dead → log out)
// from a TRANSIENT failure (endpoint unreachable / 5xx → keep the session).
class RefreshError extends Error {
  definitive: boolean;
  /** Set when the account itself was refused, not just the token. */
  accountBlocked: string | null;
  /** The failed request behind a passing failure: its Retry-After says how long to wait. */
  cause: unknown;
  constructor(message: string, definitive: boolean, accountBlocked: string | null = null, cause: unknown = null) {
    super(message);
    this.definitive = definitive;
    this.accountBlocked = accountBlocked;
    this.cause = cause;
  }
}

/** How many passing failures a check with a member already in place waits out before it gives up, keeping the member. */
const RETRIES_WITH_A_MEMBER = 3;

/** A failed refresh request, as a RefreshError: definitive only when the server refused the token (401 or 403). */
function refreshErrorFrom(err: unknown): RefreshError {
  const blocked = blockedCodeOf(err);
  if (blocked) return new RefreshError('Account cannot sign in', true, blocked);
  if (isRefreshRefusal(err)) return new RefreshError('Refresh token rejected', true);
  // Rate-limited, 5xx, network or timeout: passing. Do NOT log the user out.
  return new RefreshError('Refresh endpoint unreachable', false, null, err);
}

// 23 Sep 2026 (Shradha): a closed account was signed in, refused on the very
// next request, and bounced to /login after ~17s of spinner with no reason.
// These codes mean the ACCOUNT cannot sign in, so retrying is pointless.
const ACCOUNT_BLOCKED_CODES = new Set(['ACCOUNT_CLOSED', 'USER_SUSPENDED']);

function blockedCodeOf(err: any): string | null {
  const code = err?.response?.data?.error?.code;
  return typeof code === 'string' && ACCOUNT_BLOCKED_CODES.has(code) ? code : null;
}

/** The account-level refusal carried by a failed refresh, if that is what it was. */
export function accountBlockedReason(err: unknown): string | null {
  return err instanceof RefreshError ? err.accountBlocked : null;
}

// ── Refresh mutex ──
// At 200+ participants, many concurrent requests can hit 401 simultaneously.
// Without a mutex, each one triggers a separate refresh call, causing token
// rotation races (server revokes token A while client B is still using it).
// The mutex ensures only ONE refresh runs; all others piggyback on its result.
let refreshPromise: Promise<void> | null = null;

// ── Proactive refresh timer ──
// Refresh the access token 2 minutes before it expires so normal usage never
// sees a 401. Backgrounded tabs throttle/freeze setTimeout, so a visibilitychange
// handler (bottom of file) is the safety net when the tab returns to the fore.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Decode the JWT payload (no verification — that's server-side) to read exp. */
function getTokenExpiryMs(token: string): number | null {
  try {
    // A JWT payload is base64url, which atob cannot read when it holds a "-" or a "_".
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Whose session a token holds: the `sub` of its payload. Decoded, not verified (the server does that): it is only compared. */
function tokenSubject(token: string): string | null {
  try {
    // A JWT payload is base64url, which atob cannot read when it holds a "-" or a "_".
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

function scheduleProactiveRefresh(accessToken: string) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const expiresAt = getTokenExpiryMs(accessToken);
  if (!expiresAt) return;

  // Refresh 2 minutes before expiry (for a 15-min token, this fires at ~13 min)
  const refreshIn = expiresAt - Date.now() - 2 * 60 * 1000;
  if (refreshIn <= 0) return; // already expired or about to — interceptor will handle it

  refreshTimer = setTimeout(() => {
    useAuthStore.getState().refreshAccessToken().catch(() => {
      // Proactive refresh failed — that's OK, the 401 interceptor is the safety net
    });
  }, refreshIn);
}

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => {
  const initial = readStoredTokens();

  /** Install a freshly-issued pair: single atomic write, bump the epoch, update
   *  memory, and (re)arm the proactive refresh. The ONLY path that writes
   *  tokens to storage. */
  const installTokens = (accessToken: string, refreshToken: string) => {
    writeStoredTokens({ access: accessToken, refresh: refreshToken });
    authEpoch += 1;
    set({ accessToken, refreshToken, isAuthenticated: true, signOutReason: null });
    scheduleProactiveRefresh(accessToken);
  };

  return {
    user: null,
    accessToken: initial?.access ?? null,
    refreshToken: initial?.refresh ?? null,
    isAuthenticated: !!initial,
    isLoading: true,
    isSessionChecked: false,
    signOutReason: null,
    sessionRetrying: false,

    login: async (email: string, clientUrl?: string, inviteCode?: string) => {
      const { data } = await api.post('/auth/magic-link', { email, clientUrl, inviteCode });
      return data;
    },

    verify: async (token: string) => {
      const { data } = await api.post('/auth/verify', { token });
      const { accessToken, refreshToken } = data.data;
      installTokens(accessToken, refreshToken);
      await get().checkSession();
    },

    setTokensAndLoad: async (accessToken: string, refreshToken: string) => {
      installTokens(accessToken, refreshToken);
      await get().checkSession();
    },

    adoptStoredTokens: () => {
      const t = readStoredTokens();
      if (!t) return false;
      // No write — the tokens are already in storage (another tab put them
      // there). Just bring them into this tab's memory and re-arm the timer.
      authEpoch += 1;
      set({ accessToken: t.access, refreshToken: t.refresh, isAuthenticated: true });
      scheduleProactiveRefresh(t.access);
      return true;
    },

    checkSession: async () => {
      // The newest check (429 fix round 1): an older one still waiting is ended now, and exits when it wakes.
      endPendingWait();
      checksStarted += 1;
      const generation = checksStarted;
      const isNewest = () => generation === checksStarted;
      let tellAnswered = whenAnswered;
      whenAnswered = null;
      const token = get().accessToken;
      if (!token) {
        set({ isLoading: false, isAuthenticated: false, user: null, isSessionChecked: true, sessionRetrying: false });
        return;
      }
      const member = tokenSubject(token);
      let epochAtStart = authEpoch;
      /** Whose session is in place now. A change of tokens that kept the same member (a refresh: this check's own, the
       *  401 interceptor's, the proactive one) is still this session (429 fix round 1); no tokens is a sign-out, and
       *  another member's tokens are a sign-in that took over. */
      const sessionNow = (): 'this' | 'gone' | 'another' => {
        const now = get().accessToken;
        if (!now) return 'gone';
        if (authEpoch === epochAtStart) return 'this';
        if (member === null || tokenSubject(now) !== member) return 'another';
        epochAtStart = authEpoch;
        return 'this';
      };
      // Only a refusal ends the session (fix wave 3, 2 Nov 2026; the failure rules above): the refresh token refused (by
      // this check's refresh or by the 401 interceptor's), or a 401 on a token the server has just issued. An answer that
      // says nothing about the session (a 429 when the member used up their minute, a 5xx, no connection) is waited out
      // and asked again. With no member in place yet (the boot check, a sign-in) it is asked until it lands: giving up
      // after three tries (9 Sep 2026) left the store with no member, and the protected page sent a member whose session
      // was fine to /login. With a member already in place (a check after a save) it still gives up after three tries,
      // and keeps that member.
      let refreshNext = false;
      let refreshed = false;
      let passingFailures = 0;
      const stopWaiting = () => set({ isLoading: false, isSessionChecked: true, sessionRetrying: false });
      const endSessionHere = () => {
        clearStoredTokens();
        clearRefreshTimer();
        set({
          isLoading: false, isAuthenticated: false, user: null, sessionRetrying: false,
          accessToken: null, refreshToken: null, isSessionChecked: true,
        });
      };
      /** A refusal ends the session, unless another member's session took over while it was on its way. */
      const refused = (blocked: string | null) => {
        if (sessionNow() === 'another') stopWaiting();
        else if (blocked) get().endBlockedSession(blocked);
        else endSessionHere();
      };
      for (;;) {
        // Before anything is sent: a newer check, a sign-out, or another member's sign-in while this one waited, ends it.
        if (!isNewest()) return;
        if (sessionNow() !== 'this') {
          stopWaiting();
          return;
        }
        let failure: unknown;
        if (refreshNext) {
          // The token was refused, as an expired one is: refresh it, then read the session again.
          try {
            await get().refreshAccessToken();
            refreshNext = false;
            refreshed = true;
            // Installing the new pair moved the epoch on; it is this check's own session.
            epochAtStart = authEpoch;
            continue;
          } catch (refreshErr: unknown) {
            failure = refreshErr;
          }
        } else {
          try {
            const { data } = await api.get('/auth/session', { timeout: 15000 });
            if (!isNewest()) return;
            set({ user: data.data.user, isAuthenticated: true, isLoading: false, isSessionChecked: true, sessionRetrying: false });
            scheduleProactiveRefresh(get().accessToken!);
            return;
          } catch (err: unknown) {
            failure = err;
          }
        }
        if (!isNewest()) return;
        if (failure instanceof RefreshError) {
          // A refresh failed: this check's own, or the 401 interceptor's after the session read was refused (429 fix
          // round 1). Refused (401 or 403, no refresh token, a closed account) ends the session; anything else is the
          // request behind it, a passing failure.
          if (failure.definitive) {
            refused(failure.accountBlocked);
            return;
          }
          failure = failure.cause;
        } else if (statusOf(failure) === 401) {
          // A token the server issued a moment ago is refused: the session itself was revoked.
          if (refreshed) {
            refused(null);
            return;
          }
          refreshNext = true;
          continue;
        }
        if (!isPassingFailure(failure)) {
          // Neither a refusal nor a passing failure (a 404, a 400): keep the cached token and stop the socket layer
          // waiting; the next check will try again.
          stopWaiting();
          return;
        }
        // A passing failure, of the session read or of a refresh: wait and ask again, while this is still the session
        // in place (a sign-out or another member's sign-in takes over).
        if (sessionNow() !== 'this' || (get().user && passingFailures >= RETRIES_WITH_A_MEMBER)) {
          stopWaiting();
          return;
        }
        if (!get().user) set({ sessionRetrying: true });
        const wait = retryWaitMs(failure, passingFailures);
        passingFailures += 1;
        tellAnswered?.();
        tellAnswered = null;
        await waitBeforeAskingAgain(wait);
      }
    },

    retrySessionNow: () => {
      // Only a check that is waiting is asked again at once; one whose answer is on its way already is asking.
      if (!pendingWait) return Promise.resolve();
      return new Promise<void>((answered) => {
        whenAnswered = answered;
        void get().checkSession().finally(answered);
      });
    },

    refreshAccessToken: async () => {
      // Mutex: if a refresh is already in-flight, piggyback on it
      if (refreshPromise) return refreshPromise;

      refreshPromise = (async () => {
        try {
          // Read the freshest token from storage (another tab may have rotated
          // it), falling back to in-memory state.
          const refresh = readStoredTokens()?.refresh || get().refreshToken;
          if (!refresh) throw new RefreshError('No refresh token', true);

          let tokens: { accessToken: string; refreshToken: string };
          try {
            const { data } = await api.post('/auth/refresh', { refreshToken: refresh });
            tokens = data.data;
          } catch (firstErr: unknown) {
            // Another tab may have rotated the token between our read and the
            // call. Re-read storage and retry ONCE with whatever is newest.
            const newest = readStoredTokens()?.refresh;
            if (statusOf(firstErr) !== 401 || blockedCodeOf(firstErr) || !newest || newest === refresh) {
              throw refreshErrorFrom(firstErr);
            }
            try {
              const { data } = await api.post('/auth/refresh', { refreshToken: newest });
              tokens = data.data;
            } catch (secondErr: unknown) {
              // A rate-limited or failed retry says nothing about the newer token (fix wave 3): it was read as a refusal.
              throw refreshErrorFrom(secondErr);
            }
          }

          installTokens(tokens.accessToken, tokens.refreshToken);
        } finally {
          refreshPromise = null;
        }
      })();

      return refreshPromise;
    },

    logout: async () => {
      const current = get();
      if (!current.accessToken && !current.refreshToken) return;

      // Server revokes only THIS token; other devices/tabs keep their sessions.
      await api.post('/auth/logout', { refreshToken: current.refreshToken }).catch(() => {});

      clearRefreshTimer();
      clearStoredTokens();
      set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, isLoading: false });
    },

    setTokens: (access: string, refresh: string) => {
      installTokens(access, refresh);
    },

    endBlockedSession: (reason: string) => {
      clearRefreshTimer();
      clearStoredTokens();
      set({
        user: null, accessToken: null, refreshToken: null, isAuthenticated: false,
        isLoading: false, isSessionChecked: true, signOutReason: reason,
      });
    },
  };
});

// ── Cross-Tab Auth Sync ──────────────────────────────────────────────────────
// When ANY tab logs in or out, ALL other tabs detect it via the browser's
// 'storage' event (fires in every tab EXCEPT the one that made the change).
// Listeners ADOPT the tokens into memory — they never write them back, which is
// what corrupted the pair before the 7 Sep 2026 fix.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    const store = useAuthStore.getState();

    // Another tab logged in (canonical key set, or the completion ping fired)
    if (
      (event.key === TOKENS_KEY || event.key === AUTH_PING) &&
      event.newValue &&
      !store.isAuthenticated
    ) {
      if (store.adoptStoredTokens()) {
        store.checkSession();
      }
    }

    // Another tab logged out (canonical key removed)
    if (event.key === TOKENS_KEY && !event.newValue && store.isAuthenticated) {
      clearRefreshTimer();
      useAuthStore.setState({
        user: null, accessToken: null, refreshToken: null,
        isAuthenticated: false, isLoading: false,
      });
    }
  });

  // Backgrounded tabs throttle/freeze the proactive setTimeout, so an access
  // token can be long expired by the time the user returns. Refresh on focus
  // if the token is expired or within 2 min of expiry — this is what keeps a
  // returning user signed in instead of hitting a 401 storm.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const s = useAuthStore.getState();
      if (!s.isAuthenticated || !s.accessToken) return;
      const exp = getTokenExpiryMs(s.accessToken);
      if (exp && exp - Date.now() < 2 * 60 * 1000) {
        s.refreshAccessToken().catch(() => {});
      }
    });
  }
}
