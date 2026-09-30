// server/src/services/identity/client-origin.ts
// ─── Where a sign-in link may point ──────────────────────────────────────────
//
// 29 Sep 2026: the magic-link request carries the page's own address so the
// email opens the same site the member asked from (the app, or the preview
// site). Before this ANY http(s) address was accepted, so anyone could make RSN
// email a member a genuine sign-in link, carrying a live token, that opened on
// a site they controlled.
//
// 30 Sep 2026: the list is exact, never a pattern. A sign-in link may open only:
//   - the CLIENT_URL origin (the main app, wherever it is configured to live),
//   - https://app.rsn.network and https://preview.rsn.network,
//   - http://localhost and http://127.0.0.1, in development only.
// Anything else falls back to the main app. Not "any *.rsn.network host":
// rsn.network itself is a separate site, not the app, and api.rsn.network is the
// API, whose request logs would record a live token. No other site takes
// sign-ins. Vercel *.vercel.app hosts are not allowed either: anyone can create
// a Vercel project whose name ends in "-rsnnetwork", so no pattern there is ours.

export interface ClientOriginConfig {
  clientUrl: string;
  isDev: boolean;
}

// Our sign-in sites besides CLIENT_URL, by exact origin (scheme, host and port).
const OUR_SITES: readonly string[] = ['https://app.rsn.network', 'https://preview.rsn.network'];

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
  if (OUR_SITES.includes(origin.origin)) return true;

  const host = origin.hostname.toLowerCase();
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
