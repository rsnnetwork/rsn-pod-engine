import axios from 'axios';
import { useAuthStore } from '@/stores/authStore';
import { API_BASE_URL } from '@/lib/runtimeEndpoints';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

// Attach JWT
api.interceptors.request.use((cfg) => {
  const token = useAuthStore.getState().accessToken;
  if (token && cfg.headers) {
    cfg.headers.Authorization = `Bearer ${token}`;
  }
  return cfg;
});

// Auto-refresh on 401 — NEVER auto-logout, only the user can log out manually
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    const isLogoutRequest = original?.url?.includes('/auth/logout');
    const isRefreshRequest = original?.url?.includes('/auth/refresh');

    // Don't retry logout or refresh requests to avoid 401 loops
    if (err.response?.status === 401 && !original._retry && !isLogoutRequest && !isRefreshRequest) {
      original._retry = true;
      try {
        await useAuthStore.getState().refreshAccessToken();
        const newToken = useAuthStore.getState().accessToken;
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch {
        // Refresh failed — do NOT auto-logout. Let the request fail
        // naturally. The user stays logged in and can retry or
        // manually log out when they choose to.
      }
    }
    return Promise.reject(err);
  },
);

export default api;
