const RENDER_API_ORIGIN = 'https://rsn-api-h04m.onrender.com';

function isProductionHost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h.includes('vercel.app') || h.endsWith('rsn.network');
}

export const API_BASE_URL = isProductionHost()
  ? `${RENDER_API_ORIGIN}/api`
  : (import.meta.env.VITE_API_URL || '/api');

export const SOCKET_BASE_URL = isProductionHost()
  ? RENDER_API_ORIGIN
  : (import.meta.env.VITE_SERVER_URL || '/');
