import { create } from 'zustand';
import api from '@/lib/api';

interface AuthState {
  user: any | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  login: (email: string, clientUrl?: string) => Promise<any>;
  verify: (token: string) => Promise<void>;
  checkSession: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  logout: () => void;
  setTokens: (access: string, refresh: string) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: localStorage.getItem('rsn_access') || null,
  refreshToken: localStorage.getItem('rsn_refresh') || null,
  isAuthenticated: !!localStorage.getItem('rsn_access'),
  isLoading: true,

  login: async (email: string, clientUrl?: string) => {
    const { data } = await api.post('/auth/magic-link', { email, clientUrl });
    return data;
  },

  verify: async (token: string) => {
    const { data } = await api.post('/auth/verify', { token });
    const { accessToken, refreshToken } = data.data;
    localStorage.setItem('rsn_access', accessToken);
    localStorage.setItem('rsn_refresh', refreshToken);
    set({ accessToken, refreshToken, isAuthenticated: true });
    await get().checkSession();
  },

  checkSession: async () => {
    const token = get().accessToken;
    if (!token) {
      set({ isLoading: false, isAuthenticated: false, user: null });
      return;
    }
    try {
      const { data } = await api.get('/auth/session');
      set({ user: data.data.user, isAuthenticated: true, isLoading: false });
    } catch {
      set({ isLoading: false, isAuthenticated: false, user: null });
    }
  },

  refreshAccessToken: async () => {
    const refresh = get().refreshToken;
    if (!refresh) throw new Error('No refresh token');
    const { data } = await api.post('/auth/refresh', { refreshToken: refresh });
    const { accessToken, refreshToken: newRefresh } = data.data;
    localStorage.setItem('rsn_access', accessToken);
    localStorage.setItem('rsn_refresh', newRefresh);
    set({ accessToken, refreshToken: newRefresh });
  },

  logout: () => {
    // Call logout endpoint before clearing tokens so the auth header is still present
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('rsn_access');
    localStorage.removeItem('rsn_refresh');
    set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, isLoading: false });
  },

  setTokens: (access: string, refresh: string) => {
    localStorage.setItem('rsn_access', access);
    localStorage.setItem('rsn_refresh', refresh);
    set({ accessToken: access, refreshToken: refresh, isAuthenticated: true });
  },
}));
