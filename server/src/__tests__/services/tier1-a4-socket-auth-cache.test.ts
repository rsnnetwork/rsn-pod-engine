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

/** The names a file imports from one module, whichever import statement they are in (one line or several). */
function importedFrom(source: string, module: string): string[] {
  const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const statement = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g');
  return [...source.matchAll(statement)]
    .flatMap((found) => found[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]))
    .filter(Boolean);
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

    // 7 Oct 2026: the handshake's check moved out of index.ts into this function, where it is tested by
    // what it does (middleware/socket-auth.test.ts). It still asks isUserActive, the shared cache.
    it('the handshake check asks isUserActive, the shared cache, before it lets a member in', () => {
      const check = src.slice(src.indexOf('export async function authenticateSocketToken'));
      expect(check).toMatch(/const active = await isUserActive\(payload\.sub\)/);
      expect(check).not.toMatch(/SELECT status FROM users WHERE id = \$1/);
    });
  });

  describe('index.ts socket handshake uses the shared check (not raw DB SELECT)', () => {
    const src = readSource('../../index.ts');

    it('imports the handshake check from middleware/auth', () => {
      expect(importedFrom(src, './middleware/auth')).toContain('authenticateSocketToken');
    });

    it('io.use middleware calls it — not a raw SELECT, and no token check of its own to turn round', () => {
      const useStart = src.indexOf('io.use(async (socket, next)');
      const useEnd = src.indexOf('});', useStart);
      const block = src.slice(useStart, useEnd);
      expect(block).toMatch(/await authenticateSocketToken\(token\)/);
      // The old raw query pattern must be gone
      expect(block).not.toMatch(/SELECT status FROM users WHERE id = \$1/);
      // And the handshake verifies nothing itself: the one check is the tested function.
      expect(block).not.toMatch(/jwt\.verify/);
    });

    it('no longer imports dbQuery alias (was used only for the now-removed SELECT)', () => {
      // The only use of `dbQuery` was inside the socket auth middleware.
      // Removing it prevents dead imports and keeps the file tidy.
      expect(src).not.toMatch(/query as dbQuery/);
    });
  });
});
