// Phase I — narrow auto-host capability to super_admin only.
//
// Pre-fix: globalUserRole >= ADMIN (i.e. admin OR super_admin) auto-resolved
// to 'pod_admin' in getEffectiveRole, which made canActAsHost return allowed=true
// and let any admin act as host on any event by default. Stefan's 10 May review
// item 18 asked for "super admin should have full controls" — specifically
// super_admin, not regular admin. RSN has one super_admin (Stefan) and ~2-3
// admins (Shraddha, Raja); the admins should join live events as regular
// participants and be promoted to cohost explicitly if intervention is needed.
//
// Post-fix: only super_admin auto-passes layer 1 of getEffectiveRole. Regular
// admins fall through to the pod/event-scoped layers; if they're not the
// event host or a cohost, they get 'participant' (matched and chatty like
// anyone else, no host UI).
//
// Pod management endpoints (which use hasRoleAtLeast(ADMIN) directly, NOT
// getEffectiveRole) are unaffected — admins still manage pods, users,
// sessions admin-side. This change touches only event-host capability.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase I — narrow auto-host capability to super_admin only', () => {
  describe('effective-role.service.ts — layer 1 only fires on SUPER_ADMIN', () => {
    const src = readServer('services/roles/effective-role.service.ts');

    it('layer 1 platform-admin shortcut is gated on UserRole.SUPER_ADMIN, not hasRoleAtLeast(ADMIN)', () => {
      const fnStart = src.indexOf('export async function getEffectiveRole');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // The narrow form: exactly SUPER_ADMIN, no hasRoleAtLeast(...ADMIN).
      expect(fn).toMatch(/globalUserRole\s*===\s*UserRole\.SUPER_ADMIN/);
      // Forbid the broad form anywhere in the function body.
      const layerOneStart = fn.indexOf('Layer 1');
      const layerOneEnd = fn.indexOf('Layer 2', layerOneStart);
      const layerOne = fn.slice(layerOneStart, layerOneEnd);
      expect(layerOne).not.toMatch(/hasRoleAtLeast\([^)]*UserRole\.ADMIN\)/);
    });
  });

  describe('routes/host.ts — verifyHostOrSuperAdmin narrowed', () => {
    const src = readServer('routes/host.ts');

    it('helper renamed to verifyHostOrSuperAdmin and gates on SUPER_ADMIN', () => {
      expect(src).toMatch(/async function verifyHostOrSuperAdmin\(/);
      // Body must check super_admin specifically — not hasRoleAtLeast(ADMIN).
      const fnStart = src.indexOf('async function verifyHostOrSuperAdmin');
      const fnEnd = src.indexOf('\n}', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/UserRole\.SUPER_ADMIN/);
      expect(fn).not.toMatch(/hasRoleAtLeast\([^)]*UserRole\.ADMIN\)/);
    });

    it('all six existing host routes call verifyHostOrSuperAdmin (not the old helper name)', () => {
      // Pin that callers all use the new name. If anyone forgets to rename a
      // call site, the route would reference an undefined function and tests
      // would fail at runtime — this is the static guard.
      const oldRefs = (src.match(/verifyHostOrAdmin\b/g) || []).length;
      expect(oldRefs).toBe(0);
      const newRefs = (src.match(/verifyHostOrSuperAdmin\b/g) || []).length;
      // 1 declaration + 7 call sites (start, pause, resume, end, broadcast, state, visibility)
      expect(newRefs).toBeGreaterThanOrEqual(7);
    });
  });

  describe('client LiveSessionPage — admin no longer in isHost gate', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');

    it('baseIsHost gate covers only formal roles (director + cohost); admin/super_admin reach host UI via Phase M opt-in', () => {
      // Phase M (12 May) layered an acting-as-host override on top of the
      // base form, so the literal `const isHost = isOriginalHost ||
      // isCohost || isSuperAdmin` line moved to `baseIsHost`. Bug D
      // (15 May Ali) tightened it further: even SUPER_ADMIN must now
      // explicitly pick "Join as host" before host UI surfaces. The Phase I
      // invariant (admin NOT in the role-derived host gate) continues to
      // hold and is in fact strengthened — super_admin no longer auto-
      // passes either; both reach host UI only via Phase M opt-in.
      expect(src).toMatch(/const\s+baseIsHost\s*=\s*isOriginalHost\s*\|\|\s*isCohost\s*;/);
      // Forbid the broad form — admin should no longer fold into the
      // role-derived host gate. (The old `const isAdmin = role === 'admin'
      // || role === 'super_admin'` expression must not appear in the
      // baseIsHost calculation, and neither does super_admin now.)
      const baseLine = src.match(/const\s+baseIsHost\s*=[^;]+;/);
      expect(baseLine).toBeTruthy();
      expect(baseLine![0]).not.toMatch(/isAdmin/);
      expect(baseLine![0]).not.toMatch(/isSuperAdmin/);
      // 23 May (Stefan + Ali) — acting-as-host removed; there is no longer a
      // Phase M opt-in pathway. The Phase I invariant is now absolute: admins
      // and super-admins are plain participants in events, isHost = baseIsHost.
      expect(src).toMatch(/const\s+isHost\s*=\s*baseIsHost\s*;/);
    });
  });
});
