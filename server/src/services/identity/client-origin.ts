// server/src/services/identity/client-origin.ts
// ─── Where a sign-in link may point ──────────────────────────────────────────
//
// 29 Sep 2026: the magic-link request carries the page's own address so the
// email opens the same site the member asked from (the app, a preview on
// preview.rsn.network). Before this ANY http(s) address was accepted, so anyone
// could make RSN email a member a genuine sign-in link, carrying a live token,
// that opened on a site they controlled. Only our own domain qualifies now.
// Vercel *.vercel.app hosts are deliberately NOT allowed: anyone can create a
// Vercel project whose name ends in "-rsnnetwork", so no pattern there is ours.

export interface ClientOriginConfig {
  clientUrl: string;
  isDev: boolean;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isAllowedClientOrigin(origin: URL, cfg: ClientOriginConfig): boolean {
  const main = parse(cfg.clientUrl);
  if (main && origin.origin === main.origin) return true;

  const host = origin.hostname.toLowerCase();
  if (origin.protocol === 'https:' && (host === 'rsn.network' || host.endsWith('.rsn.network'))) {
    return true;
  }
  if (cfg.isDev && origin.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
    return true;
  }
  return false;
}

/** The site a sign-in email opens: the asking page's origin if it is ours, else the main app. */
export function resolveClientBaseUrl(requested: string | undefined, cfg: ClientOriginConfig): string {
  const fallback = cfg.clientUrl.replace(/\/$/, '');
  if (!requested) return fallback;
  const parsed = parse(requested);
  if (!parsed || !isAllowedClientOrigin(parsed, cfg)) return fallback;
  return parsed.origin;
}
