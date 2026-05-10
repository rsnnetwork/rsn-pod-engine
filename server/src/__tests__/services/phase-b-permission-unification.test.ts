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

  describe('LiveSessionPage isHost gate includes admin and super_admin', () => {
    const liveSrc = readClient('features/live/LiveSessionPage.tsx');

    it('isHost expression includes an admin/super_admin disjunct', () => {
      // Match the form `const isHost = isOriginalHost || isCohost || isAdmin`
      expect(liveSrc).toMatch(
        /const\s+isHost\s*=\s*isOriginalHost\s*\|\|\s*isCohost\s*\|\|\s*isAdmin/,
      );
      // And isAdmin is derived from the user role.
      expect(liveSrc).toMatch(
        /const\s+isAdmin\s*=\s*user\?\.role\s*===\s*['"]admin['"]\s*\|\|\s*user\?\.role\s*===\s*['"]super_admin['"]/,
      );
    });
  });
});
