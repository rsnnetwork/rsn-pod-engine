const RENDER_API_ORIGIN = 'https://rsn-api-h04m.onrender.com';

function isVercelHost(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname.includes('vercel.app');
}

export const API_BASE_URL = isVercelHost()
  ? `${RENDER_API_ORIGIN}/api`
  : (import.meta.env.VITE_API_URL || '/api');

export const SOCKET_BASE_URL = isVercelHost()
  ? RENDER_API_ORIGIN
  : (import.meta.env.VITE_SERVER_URL || '/');
