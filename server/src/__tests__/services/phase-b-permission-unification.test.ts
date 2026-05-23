// Phase B — permission model unification (10 May review items 7, 18).
//
// Pins the rule set so it cannot drift again:
//   • Co-hosts and admins can assign / remove other co-hosts (verifyHost).
//   • Only the original event host can transfer ownership (handlePromoteCohost
//     keeps the strict `session.hostUserId === hostId` check).
//   • The client `isHost` gate in LiveSessionPage includes admin/super_admin
//     so super-admins (Stefan) can open Host Control Center even when they
//     aren't the original host or a cohost of that specific event.

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

describe('Phase B — permission model unification', () => {
  const hostActionsSrc = readServer('services/orchestration/handlers/host-actions.ts');

  describe('handleAssignCohost uses verifyHost (allows cohost + admin)', () => {
    it('does not gate on session.hostUserId === hostId', () => {
      const fnStart = hostActionsSrc.indexOf('export async function handleAssignCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = hostActionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = hostActionsSrc.slice(fnStart, fnEnd);
      // The strict original-host-only check is gone.
      expect(fn).not.toMatch(/session\.hostUserId\s*!==\s*hostId/);
      // verifyHost is the new gate.
      expect(fn).toMatch(/await\s+verifyHost\(socket,\s*sessionId\)/);
    });
  });

  describe('handleRemoveCohost uses verifyHost (allows cohost + admin)', () => {
    it('does not gate on session.hostUserId === hostId', () => {
      const fnStart = hostActionsSrc.indexOf('export async function handleRemoveCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = hostActionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = hostActionsSrc.slice(fnStart, fnEnd);
      expect(fn).not.toMatch(/session\.hostUserId\s*!==\s*hostId/);
      expect(fn).toMatch(/await\s+verifyHost\(socket,\s*sessionId\)/);
    });
  });

  describe('handlePromoteCohost stays original-host-only (ownership transfer)', () => {
    it('still gates on session.hostUserId === hostId', () => {
      const fnStart = hostActionsSrc.indexOf('export async function handlePromoteCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = hostActionsSrc.indexOf('\nexport ', fnStart + 1);
      const fn = hostActionsSrc.slice(fnStart, fnEnd);
      // Ownership transfer is irreversible — the original host keeps that
      // power exclusively. Cohost-rank actions go through verifyHost; this
      // one intentionally does not.
      expect(fn).toMatch(/session\.hostUserId\s*!==\s*hostId/);
      expect(fn).toMatch(/Only the original host can transfer ownership/);
    });
  });

  describe('LiveSessionPage isHost gate composes baseIsHost + Phase M override', () => {
    const liveSrc = readClient('features/live/LiveSessionPage.tsx');

    // Phase I (10 May refined) — narrowed from `admin OR super_admin` to
    // `super_admin only`. Regular admins join events as participants, not
    // auto-hosts. Phase M (12 May) layered an acting-as-host override on
    // top of baseIsHost so super_admins / admins flip role per event.
    // Bug D (15 May Ali) — even SUPER_ADMIN no longer auto-passes the
    // role-derived host gate. baseIsHost is now strictly formal roles
    // (director + session_cohosts), and admin/super_admin reach the host
    // UI only via Phase M opt-in (explicit "Join as host" click). The
    // narrow-admin invariant from Phase I still holds in the new shape:
    // the broad `admin || super_admin` form never folds in.
    it('baseIsHost is the formal role-derived disjunction (no admin, no super_admin auto-pass)', () => {
      expect(liveSrc).toMatch(
        /const\s+baseIsHost\s*=\s*isOriginalHost\s*\|\|\s*isCohost\s*;/,
      );
      // 23 May (Stefan + Ali) — acting-as-host removed; no Phase M opt-in
      // pathway remains. isHost is now just baseIsHost.
      expect(liveSrc).toMatch(/const\s+isHost\s*=\s*baseIsHost\s*;/);
      // The broad `isAdmin = admin || super_admin` form must NOT appear
      // in the baseIsHost expression (Phase I narrow still holds — under
      // its new, stricter Bug D shape).
      const baseLine = liveSrc.match(/const\s+baseIsHost\s*=[^;]+;/);
      expect(baseLine).toBeTruthy();
      expect(baseLine![0]).not.toMatch(/isAdmin/);
      expect(baseLine![0]).not.toMatch(/isSuperAdmin/);
    });
  });
});
