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

  login: (email: string, clientUrl?: string, inviteCode?: string) => Promise<any>;
  verify: (token: string) => Promise<void>;
  setTokensAndLoad: (accessToken: string, refreshToken: string) => Promise<void>;
  checkSession: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  logout: () => Promise<void>;
  setTokens: (access: string, refresh: string) => void;
  /** Adopt whatever tokens are in storage into memory WITHOUT writing them
   *  back (used by cross-tab sync). Returns false if none present. */
  adoptStoredTokens: () => boolean;
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

// Distinguishes a DEFINITIVE rejection (refresh token truly dead → log out)
// from a TRANSIENT failure (endpoint unreachable / 5xx → keep the session).
class RefreshError extends Error {
  definitive: boolean;
  constructor(message: string, definitive: boolean) {
    super(message);
    this.definitive = definitive;
  }
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
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
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
    set({ accessToken, refreshToken, isAuthenticated: true });
    scheduleProactiveRefresh(accessToken);
  };

  return {
    user: null,
    accessToken: initial?.access ?? null,
    refreshToken: initial?.refresh ?? null,
    isAuthenticated: !!initial,
    isLoading: true,
    isSessionChecked: false,

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
      const token = get().accessToken;
      if (!token) {
        set({ isLoading: false, isAuthenticated: false, user: null, isSessionChecked: true });
        return;
      }
      const epochAtStart = authEpoch;
      // 9 Sep 2026: a TRANSIENT failure of the boot check (429 rate-limit, 5xx,
      // network) must not read as "logged out". ProtectedRoute gates on `user`,
      // so giving up here bounced a real member to /login when the check was
      // merely rate-limited (a household/office shares one IP). Retry with
      // backoff — honouring Retry-After — before falling through.
      const TRANSIENT_DELAYS = [2000, 5000, 10000];
      for (let attempt = 0; ; attempt++) {
        try {
          const { data } = await api.get('/auth/session', { timeout: 15000 });
          set({ user: data.data.user, isAuthenticated: true, isLoading: false, isSessionChecked: true });
          scheduleProactiveRefresh(get().accessToken!);
          return;
        } catch (err: any) {
          const status: number | undefined = err?.response?.status;
          if (status === 401) {
            // Token might be expired but refreshable — try refreshing before giving up.
            try {
              await get().refreshAccessToken();
              const { data } = await api.get('/auth/session', { timeout: 15000 });
              set({ user: data.data.user, isAuthenticated: true, isLoading: false, isSessionChecked: true });
              scheduleProactiveRefresh(get().accessToken!);
            } catch (refreshErr: any) {
              const definitive = refreshErr instanceof RefreshError ? refreshErr.definitive : true;
              // Only clear auth when the refresh token was DEFINITIVELY rejected
              // AND no newer session was installed while we were checking (the
              // boot-vs-verify race). Otherwise keep whatever we have.
              if (definitive && authEpoch === epochAtStart) {
                clearStoredTokens();
                clearRefreshTimer();
                set({
                  isLoading: false, isAuthenticated: false, user: null,
                  accessToken: null, refreshToken: null, isSessionChecked: true,
                });
              } else {
                set({ isLoading: false, isSessionChecked: true });
              }
            }
            return;
          }
          const transient = status === 429 || (typeof status === 'number' && status >= 500) || status === undefined;
          if (transient && attempt < TRANSIENT_DELAYS.length && authEpoch === epochAtStart) {
            const retryAfter = Number(err?.response?.headers?.['retry-after']);
            const wait = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : TRANSIENT_DELAYS[attempt];
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          // Out of retries, or a non-transient error — keep the cached token
          // and stop the socket layer waiting; the next check will try again.
          set({ isLoading: false, isSessionChecked: true });
          return;
        }
      }
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
          } catch (firstErr: any) {
            const status = firstErr?.response?.status;
            if (status === 401) {
              // Another tab may have rotated the token between our read and the
              // call. Re-read storage and retry ONCE with whatever is newest.
              const newest = readStoredTokens()?.refresh;
              if (newest && newest !== refresh) {
                const { data } = await api.post('/auth/refresh', { refreshToken: newest });
                tokens = data.data;
              } else {
                throw new RefreshError('Refresh token rejected', true);
              }
            } else {
              // Network / timeout / 5xx — transient. Do NOT log the user out.
              throw new RefreshError('Refresh endpoint unreachable', false);
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
