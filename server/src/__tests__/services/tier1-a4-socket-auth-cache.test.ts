// Tier-1 A4 — socket handshake reuses the HTTP auth 60-second user-status cache
//
// Before: the Socket.IO `io.use` middleware at index.ts ran a raw
// `SELECT status FROM users WHERE id = $1` on every handshake. During a
// lobby surge (200 users reconnecting in ~5 s after a deploy), the Neon
// pg pool (max=25) would saturate and legitimate sockets would see
// "Invalid token" errors that were actually connection timeouts.
//
// After: `isUserActive` is exported from `middleware/auth.ts` and both the
// HTTP auth middleware and the socket handshake share the same 60-second
// in-process cache. Repeat handshakes for the same user hit the cache in
// under 1 ms.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, relPath), 'utf8');
}

describe('Tier-1 A4 — shared socket/HTTP user-status cache', () => {
  describe('middleware/auth.ts exports isUserActive', () => {
    const src = readSource('../../middleware/auth.ts');

    it('exports isUserActive as a public async function', () => {
      expect(src).toMatch(/export async function isUserActive\(userId:\s*string\):\s*Promise<boolean>/);
    });

    it('retains the 60-second TTL cache', () => {
      expect(src).toMatch(/STATUS_CACHE_TTL_MS\s*=\s*60_000/);
      expect(src).toMatch(/statusCache\.get\(userId\)/);
    });

    it('retains the 5000-entry eviction guard so the cache stays bounded', () => {
      expect(src).toMatch(/statusCache\.size\s*>\s*5000/);
    });

    it('exports invalidateUserStatusCache for deactivation flows', () => {
      expect(src).toMatch(/export function invalidateUserStatusCache/);
    });
  });

  describe('index.ts socket handshake uses isUserActive (not raw DB SELECT)', () => {
    const src = readSource('../../index.ts');

    it('imports isUserActive from middleware/auth', () => {
      expect(src).toMatch(/import \{ isUserActive \} from '\.\/middleware\/auth'/);
    });

    it('io.use middleware calls isUserActive — not a raw SELECT', () => {
      const useStart = src.indexOf('io.use(async (socket, next)');
      const useEnd = src.indexOf('});', useStart);
      const block = src.slice(useStart, useEnd);
      expect(block).toMatch(/const active = await isUserActive\(payload\.sub\)/);
      // The old raw query pattern must be gone
      expect(block).not.toMatch(/SELECT status FROM users WHERE id = \$1/);
    });

    it('no longer imports dbQuery alias (was used only for the now-removed SELECT)', () => {
      // The only use of `dbQuery` was inside the socket auth middleware.
      // Removing it prevents dead imports and keeps the file tidy.
      expect(src).not.toMatch(/query as dbQuery/);
    });
  });
});
