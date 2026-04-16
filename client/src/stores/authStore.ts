import { create } from 'zustand';
import api from '@/lib/api';

interface AuthState {
  user: any | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  login: (email: string, clientUrl?: string, inviteCode?: string) => Promise<any>;
  verify: (token: string) => Promise<void>;
  setTokensAndLoad: (accessToken: string, refreshToken: string) => Promise<void>;
  checkSession: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  logout: () => Promise<void>;
  setTokens: (access: string, refresh: string) => void;
}

// ── Refresh mutex ──
// At 200+ participants, many concurrent requests can hit 401 simultaneously.
// Without a mutex, each one triggers a separate refresh call, causing token
// rotation races (server revokes token A while client B is still using it).
// The mutex ensures only ONE refresh runs; all others piggyback on its result.
let refreshPromise: Promise<void> | null = null;

// ── Proactive refresh timer ──
// Instead of waiting for a 401 (which then needs recovery), refresh the access
// token 2 minutes before it expires.  This eliminates nearly all 401s during
// normal usage and keeps sessions alive silently.
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

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: localStorage.getItem('rsn_access') || null,
  refreshToken: localStorage.getItem('rsn_refresh') || null,
  isAuthenticated: !!localStorage.getItem('rsn_access'),
  isLoading: true,

  login: async (email: string, clientUrl?: string, inviteCode?: string) => {
    const { data } = await api.post('/auth/magic-link', { email, clientUrl, inviteCode });
    return data;
  },

  verify: async (token: string) => {
    const { data } = await api.post('/auth/verify', { token });
    const { accessToken, refreshToken } = data.data;
    localStorage.setItem('rsn_access', accessToken);
    localStorage.setItem('rsn_refresh', refreshToken);
    set({ accessToken, refreshToken, isAuthenticated: true });
    scheduleProactiveRefresh(accessToken);
    await get().checkSession();
  },

  setTokensAndLoad: async (accessToken: string, refreshToken: string) => {
    localStorage.setItem('rsn_access', accessToken);
    localStorage.setItem('rsn_refresh', refreshToken);
    set({ accessToken, refreshToken, isAuthenticated: true });
    scheduleProactiveRefresh(accessToken);
    await get().checkSession();
  },

  checkSession: async () => {
    const token = get().accessToken;
    if (!token) {
      set({ isLoading: false, isAuthenticated: false, user: null });
      return;
    }
    try {
      const { data } = await api.get('/auth/session', { timeout: 15000 });
      set({ user: data.data.user, isAuthenticated: true, isLoading: false });
      // Schedule proactive refresh if we haven't already (e.g. app init)
      scheduleProactiveRefresh(token);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        // Token might be expired but refreshable — try refreshing before giving up.
        // This prevents transient 401s (server cold-start, Render restart) from
        // clearing auth state and forcing users to re-login unnecessarily.
        try {
          await get().refreshAccessToken();
          // Refresh succeeded — retry checkSession with new token
          const { data } = await api.get('/auth/session', { timeout: 15000 });
          set({ user: data.data.user, isAuthenticated: true, isLoading: false });
          scheduleProactiveRefresh(get().accessToken!);
        } catch {
          // Refresh also failed — token is genuinely dead, clear auth
          set({ isLoading: false, isAuthenticated: false, user: null });
          clearRefreshTimer();
        }
      } else {
        // Network errors, timeouts, 5xx — keep user logged in
        set({ isLoading: false });
      }
    }
  },

  refreshAccessToken: async () => {
    // Mutex: if a refresh is already in-flight, piggyback on it
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        // CRITICAL: Read from localStorage, NOT Zustand state.
        // Another tab may have already refreshed (token rotation) and stored
        // the new token in localStorage.  Zustand state is per-tab and can be stale.
        const refresh = localStorage.getItem('rsn_refresh') || get().refreshToken;
        if (!refresh) throw new Error('No refresh token');

        let tokens: { accessToken: string; refreshToken: string };
        try {
          const { data } = await api.post('/auth/refresh', { refreshToken: refresh });
          tokens = data.data;
        } catch (firstErr: any) {
          // If we got 401 "revoked", another tab may have rotated the token
          // between our localStorage read and the server call.  Re-read
          // localStorage and retry once — the other tab's new token might be
          // there now.
          if (firstErr?.response?.status === 401) {
            const retryRefresh = localStorage.getItem('rsn_refresh');
            if (retryRefresh && retryRefresh !== refresh) {
              const { data } = await api.post('/auth/refresh', { refreshToken: retryRefresh });
              tokens = data.data;
            } else {
              throw firstErr;
            }
          } else {
            throw firstErr;
          }
        }

        localStorage.setItem('rsn_access', tokens.accessToken);
        localStorage.setItem('rsn_refresh', tokens.refreshToken);
        set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
        scheduleProactiveRefresh(tokens.accessToken);
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  },

  logout: async () => {
    // Prevent multiple simultaneous logout calls
    const current = get();
    if (!current.accessToken && !current.refreshToken) return;

    // Call logout endpoint with current refresh token — server revokes only THIS token,
    // not all tokens for the user. Other devices/tabs keep their sessions.
    await api.post('/auth/logout', { refreshToken: current.refreshToken }).catch(() => {});

    clearRefreshTimer();
    localStorage.removeItem('rsn_access');
    localStorage.removeItem('rsn_refresh');
    set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, isLoading: false });
  },

  setTokens: (access: string, refresh: string) => {
    localStorage.setItem('rsn_access', access);
    localStorage.setItem('rsn_refresh', refresh);
    set({ accessToken: access, refreshToken: refresh, isAuthenticated: true });
    scheduleProactiveRefresh(access);
  },
}));

// ── Cross-Tab Auth Sync ──────────────────────────────────────────────────────
// When ANY tab logs in or out, ALL other tabs detect it and update their state.
// This uses the browser's 'storage' event which fires in all tabs EXCEPT the
// one that made the change. Works for 10+ tabs automatically.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    const store = useAuthStore.getState();

    // Another tab logged in — pick up the tokens
    if (event.key === 'rsn_access' && event.newValue && !store.isAuthenticated) {
      const refresh = localStorage.getItem('rsn_refresh');
      if (refresh) {
        store.setTokens(event.newValue, refresh);
        store.checkSession();
      }
    }

    // Another tab logged out — clear this tab too
    if (event.key === 'rsn_access' && !event.newValue && store.isAuthenticated) {
      clearRefreshTimer();
      useAuthStore.setState({
        user: null, accessToken: null, refreshToken: null,
        isAuthenticated: false, isLoading: false,
      });
    }

    // Auth completion signal (from VerifyPage)
    if (event.key === 'rsn_auth_completed_at' && event.newValue) {
      const access = localStorage.getItem('rsn_access');
      const refresh = localStorage.getItem('rsn_refresh');
      if (access && refresh && !store.isAuthenticated) {
        store.setTokens(access, refresh);
        store.checkSession();
      }
    }
  });
}
