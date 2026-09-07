// ─── Auth-token housekeeping (7 Sep 2026) ───────────────────────────────────
//
// refresh_tokens and magic_links were never pruned, so both tables grow forever
// (every login rotates a refresh token; every link request inserts a row). None
// of it is useful once expired/used. A daily sweep keeps the tables small; it is
// safe because it only removes rows that can no longer authenticate anyone.

import { query } from '../../db';
import logger from '../../config/logger';

/** Delete auth tokens that can no longer be used. Returns the counts removed. */
export async function pruneExpiredAuthTokens(): Promise<{ refreshTokens: number; magicLinks: number }> {
  // Refresh tokens: gone 30 days past expiry (keeps a short forensic window).
  const rt = await query(
    `DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL '30 days'`,
  );
  // Magic links: single-use and short-TTL; nothing needs a used or long-expired
  // one after 7 days.
  const ml = await query(
    `DELETE FROM magic_links WHERE (used_at IS NOT NULL OR expires_at < NOW())
       AND created_at < NOW() - INTERVAL '7 days'`,
  );
  const counts = { refreshTokens: rt.rowCount ?? 0, magicLinks: ml.rowCount ?? 0 };
  if (counts.refreshTokens || counts.magicLinks) {
    logger.info(counts, 'pruned expired auth tokens');
  }
  return counts;
}
