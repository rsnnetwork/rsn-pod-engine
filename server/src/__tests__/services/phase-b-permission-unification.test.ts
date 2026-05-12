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

  describe('LiveSessionPage isHost gate includes super_admin', () => {
    const liveSrc = readClient('features/live/LiveSessionPage.tsx');

    // Phase I (10 May refined) — narrowed from `admin OR super_admin` to
    // `super_admin only`. Regular admins join events as participants, not
    // auto-hosts. This test was updated to pin the new narrow.
    it('isHost expression includes a super_admin disjunct (not admin+super_admin)', () => {
      expect(liveSrc).toMatch(
        /const\s+isHost\s*=\s*isOriginalHost\s*\|\|\s*isCohost\s*\|\|\s*isSuperAdmin/,
      );
      expect(liveSrc).toMatch(
        /const\s+isSuperAdmin\s*=\s*user\?\.role\s*===\s*['"]super_admin['"]/,
      );
      // The broad `isAdmin = admin || super_admin` form must NOT appear in
      // the isHost expression. (It can still exist elsewhere on the page
      // for admin-only UI bits, but it does not fold into isHost.)
      const isHostLine = liveSrc.match(/const\s+isHost\s*=[^;]+;/);
      expect(isHostLine).toBeTruthy();
      expect(isHostLine![0]).not.toMatch(/isAdmin/);
    });
  });
});
