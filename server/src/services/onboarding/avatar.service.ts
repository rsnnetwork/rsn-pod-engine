// ─── LinkedIn Avatar Capture + Serving ───────────────────────────────────────
//
// LinkedIn's own CDN photo URLs expire (they're signed, time-limited). We
// download the photo exactly once and serve it back from our own endpoint
// (GET /users/:id/avatar) so a member's avatar keeps working long after the
// LinkedIn URL has rotted. Called from the enrichment orchestrator's
// found/partial branch (task A7) — fire-and-forget-safe from that caller's
// point of view: this function itself never throws, always resolving to a
// boolean so a photo failure can never take down enrichment.
//
// Policy D2 (locked): a successful capture ALWAYS overwrites users.avatar_url
// to the serving endpoint, even if a Google/OAuth avatar_url is already set —
// LinkedIn wins. The overwrite is skipped only by virtue of never running the
// UPDATE at all when the download fails; no separate "should I overwrite"
// check is needed since we never touch avatar_url on failure.

import { query } from '../../db';
import config from '../../config';
import logger from '../../config/logger';

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * The URL we write to users.avatar_url on a successful capture.
 *
 * MUST be absolute. The production client (app.rsn.network) is a Vercel
 * static deploy with only a catch-all SPA rewrite — there is no `/api/*`
 * proxy at that origin. A relative `/api/users/:id/avatar` resolves against
 * the Vercel origin instead of the API, so `<img src>` gets back `index.html`
 * and renders a broken image. The client only ever reaches the API through
 * an absolute base URL in its fetch layer, so we store the same shape here.
 *
 * `config.apiBaseUrl` defaults to '' only if API_BASE_URL is explicitly set
 * empty (its normal dev default is http://localhost:3001) — in that edge
 * case we fall back to the relative path, which is harmless for local/dev
 * use since same-origin `/api` works fine there.
 */
export function avatarUrlFor(userId: string): string {
  const relative = `/api/users/${userId}/avatar`;
  const base = config.apiBaseUrl.replace(/\/+$/, '');
  return base ? `${base}${relative}` : relative;
}

/** Read the previously-captured avatar for the public serving route. Null
 *  when the user has no row, or has a row but nothing captured yet. */
export async function getAvatarBlob(userId: string): Promise<{ blob: Buffer; contentType: string } | null> {
  const r = await query<{ avatar_blob: Buffer | null; avatar_blob_type: string | null }>(
    `SELECT avatar_blob, avatar_blob_type FROM users WHERE id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row || !row.avatar_blob || !row.avatar_blob_type) return null;
  return { blob: row.avatar_blob, contentType: row.avatar_blob_type };
}

/**
 * Download `photoUrl`, validate it, and store it as the user's avatar.
 * Guards (any violation → false, logged, nothing written — avatar_url is
 * left exactly as it was):
 *   - 10s network timeout
 *   - response must be a 2xx
 *   - Content-Type must start with "image/"
 *   - max 2MB, enforced while reading the stream (a lying or absent
 *     Content-Length header must not be able to bypass this)
 *
 * Never throws — every failure path is caught and mapped to `false`.
 */
export async function captureAvatar(userId: string, photoUrl: string): Promise<boolean> {
  try {
    const res = await fetch(photoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      logger.warn({ userId, status: res.status }, 'avatar: download failed (non-2xx)');
      return false;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      // Reject without reading the body, but release the underlying
      // connection rather than leaving it dangling for the caller to GC.
      await res.body?.cancel().catch(() => {});
      logger.warn({ userId, contentType }, 'avatar: rejected non-image content-type');
      return false;
    }

    if (!res.body) {
      logger.warn({ userId }, 'avatar: response carried no body');
      return false;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AVATAR_BYTES) {
        await reader.cancel().catch(() => {});
        logger.warn({ userId, total }, 'avatar: exceeded max size mid-stream');
        return false;
      }
      chunks.push(Buffer.from(value));
    }

    const blob = Buffer.concat(chunks);
    const avatarUrl = avatarUrlFor(userId);
    await query(
      `UPDATE users SET avatar_blob = $2, avatar_blob_type = $3, avatar_url = $4, updated_at = NOW() WHERE id = $1`,
      [userId, blob, contentType, avatarUrl],
    );
    return true;
  } catch (err) {
    // Covers network errors, DNS failures, and AbortSignal.timeout() firing
    // (surfaces as a TimeoutError/AbortError) — all mapped the same way.
    logger.warn({ err, userId }, 'avatar: capture failed');
    return false;
  }
}
