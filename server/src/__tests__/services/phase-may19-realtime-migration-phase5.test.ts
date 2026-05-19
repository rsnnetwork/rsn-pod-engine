// Realtime architecture migration — Phase 5 decommission pin.
//
// Phase 5 lands the final cut: every REST route + service in the server
// emits state changes via the entity-tag pipeline ONLY. The legacy layer
// (notifyPodChanged / notifySessionListChanged / notifyAdminListChanged /
// notifyPodMembershipChanged / notifyUserChanged / notifyUserBlocksChanged /
// notifyOwnNotificationsChanged / notifyDmReactionChanged /
// notifyDmReadReceipt / notifyGroupChanged / notifyPermissionsUpdated)
// is removed from orchestration.service.ts. The client-side
// `useLegacyInvalidationBridge` hook is deleted. Two bespoke events
// survive — `permissions:updated` and `roster:changed` — because the
// useSessionSocket hook hydrates Zustand off them (the entity-tag handler
// can invalidate React-Query but cannot push into Zustand).
//
// This file pins the final post-decommission contract:
//   1. Bridge file does not exist
//   2. App.tsx no longer imports or mounts the bridge
//   3. orchestration.service.ts no longer exports any notify* helper
//   4. realtime/fanout.ts exports the entity-only fanout helpers
//   5. emit.ts caches the io reference (setRealtimeIo / getRealtimeIo)
//   6. Routes call fanoutXxx() helpers, NOT orchestrationService.notifyXxx()
//   7. emitPermissionsUpdated still emits both surviving bespoke events
//
// Source: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// §4 Phase 5.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs
    .readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readClient(rel: string): string {
  return nodeFs
    .readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

function clientPath(rel: string): string {
  return nodePath.join(__dirname, '../../../../client/src', rel);
}

describe('Realtime migration Phase 5 — legacy layer decommissioned', () => {
  // ── Bridge file deleted ─────────────────────────────────────────────────

  describe('client — useLegacyInvalidationBridge deleted', () => {
    it('useLegacyInvalidationBridge.ts no longer exists', () => {
      expect(nodeFs.existsSync(clientPath('realtime/useLegacyInvalidationBridge.ts'))).toBe(false);
    });

    it('App.tsx no longer imports or mounts useLegacyInvalidationBridge', () => {
      const src = readClient('App.tsx');
      // An import statement or a function call — both must be gone. A
      // historical commit-message comment mentioning the name is fine.
      expect(src).not.toMatch(
        /import\s*\{[^}]*\buseLegacyInvalidationBridge\b[^}]*\}/,
      );
      expect(src).not.toMatch(/useLegacyInvalidationBridge\s*\(/);
    });

    it('App.tsx still mounts useEntityChangedHandler (the surviving handler)', () => {
      const src = readClient('App.tsx');
      expect(src).toMatch(/useEntityChangedHandler\(\);/);
    });
  });

  // ── orchestration.service.ts legacy notify* helpers deleted ─────────────

  describe('server — orchestration.service.ts no longer exports notify* helpers', () => {
    const src = readServer('services/orchestration/orchestration.service.ts');
    const legacyHelpers = [
      'notifyPodChanged',
      'notifySessionListChanged',
      'notifyAdminListChanged',
      'notifyPodMembershipChanged',
      'notifyUserChanged',
      'notifyUserBlocksChanged',
      'notifyOwnNotificationsChanged',
      'notifyDmReactionChanged',
      'notifyDmReadReceipt',
      'notifyGroupChanged',
      'notifyPermissionsUpdated',
    ];

    for (const name of legacyHelpers) {
      it(`${name} is no longer exported`, () => {
        const re = new RegExp(`export\\s+async\\s+function\\s+${name}\\b`);
        expect(src).not.toMatch(re);
      });
    }

    it('still wires setRealtimeIo(io) at init so fanout helpers can emit', () => {
      expect(src).toMatch(/setRealtimeIo\(io\)/);
    });

    it('imports setRealtimeIo from ../../realtime/emit', () => {
      expect(src).toMatch(/import\s*\{\s*setRealtimeIo\s*\}\s*from\s*['"]\.\.\/\.\.\/realtime\/emit['"]/);
    });
  });

  // ── realtime/fanout.ts module exists with the expected exports ──────────

  describe('server — realtime/fanout.ts exports the entity-only fanout helpers', () => {
    const src = readServer('realtime/fanout.ts');
    const helpers = [
      'fanoutPodEntities',
      'fanoutPodMembershipForUser',
      'fanoutSessionEntities',
      'fanoutAdminEntities',
      'fanoutOwnNotifications',
      'fanoutUserBlocks',
      'fanoutUserEntity',
      'fanoutDmConversation',
      'fanoutGroupEntities',
      'emitPermissionsUpdated',
    ];

    for (const name of helpers) {
      it(`exports ${name}`, () => {
        const re = new RegExp(`export\\s+async\\s+function\\s+${name}\\b`);
        expect(src).toMatch(re);
      });
    }

    it('imports emitEntities + getRealtimeIo from ./emit', () => {
      expect(src).toMatch(/from\s*['"]\.\/emit['"]/);
      expect(src).toMatch(/emitEntities/);
      expect(src).toMatch(/getRealtimeIo/);
    });

    it('imports the E entity builder', () => {
      expect(src).toMatch(/from\s*['"]\.\/entities['"]/);
      expect(src).toMatch(/import\s*\{\s*E\s*\}/);
    });
  });

  // ── emit.ts caches the io reference ────────────────────────────────────

  describe('server — realtime/emit.ts caches the io for route-level fanout', () => {
    const src = readServer('realtime/emit.ts');

    it('exports setRealtimeIo', () => {
      expect(src).toMatch(/export\s+function\s+setRealtimeIo\(\s*io:\s*SocketServer\s*\):\s*void/);
    });

    it('exports getRealtimeIo', () => {
      expect(src).toMatch(/export\s+function\s+getRealtimeIo\(\s*\):\s*SocketServer\s*\|\s*null/);
    });
  });

  // ── emitPermissionsUpdated still emits the two surviving bespoke events ─

  describe('server — emitPermissionsUpdated preserves the two surviving bespoke events', () => {
    const src = readServer('realtime/fanout.ts');
    // Slice to the helper body.
    const start = src.indexOf('export async function emitPermissionsUpdated');
    const body = src.slice(start, start + 4000);

    it('emits permissions:updated to the affected user room', () => {
      expect(body).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]permissions:updated['"]/);
    });

    it('emits roster:changed to the session room', () => {
      expect(body).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]roster:changed['"]/);
    });

    it('also emits the entity tags (session + sessionParticipants + user) for React-Query cache', () => {
      expect(body).toMatch(/E\.session\(sessionId\)/);
      expect(body).toMatch(/E\.sessionParticipants\(sessionId\)/);
      expect(body).toMatch(/E\.user\(userId\)/);
    });

    it('calls emitHostDashboardForce for the HCC live-refresh side-effect', () => {
      expect(body).toMatch(/emitHostDashboardForce\(io,\s*sessionId\)/);
    });
  });

  // ── Routes call fanout helpers, never the deleted notify* wrappers ─────

  describe('server — REST routes use fanout helpers, not orchestrationService.notifyXxx', () => {
    const routeFiles = [
      'routes/admin.ts',
      'routes/dm.ts',
      'routes/groups.ts',
      'routes/host.ts',
      'routes/invites.ts',
      'routes/join-requests.ts',
      'routes/notifications.ts',
      'routes/pods.ts',
      'routes/pokes.ts',
      'routes/reports.ts',
      'routes/sessions.ts',
      'routes/users.ts',
    ];
    // Each of these names is a now-deleted legacy helper. None of the
    // routes should reference them.
    const deletedHelperNames = [
      'notifyPodChanged',
      'notifySessionListChanged',
      'notifyAdminListChanged',
      'notifyPodMembershipChanged',
      'notifyUserChanged',
      'notifyUserBlocksChanged',
      'notifyOwnNotificationsChanged',
      'notifyDmReactionChanged',
      'notifyDmReadReceipt',
      'notifyGroupChanged',
      'notifyPermissionsUpdated',
    ];

    for (const rel of routeFiles) {
      it(`${rel} contains no orchestrationService.notify* references`, () => {
        const src = readServer(rel);
        for (const name of deletedHelperNames) {
          const re = new RegExp(`orchestrationService\\.${name}\\b`);
          expect(src).not.toMatch(re);
        }
      });
    }
  });

  // ── No route or service references legacy bespoke socket event names ───

  describe('server — no remaining io.emit() of deleted bespoke event names', () => {
    // These bespoke event names are the legacy contract that Phase 5
    // removes. The two survivors (permissions:updated, roster:changed)
    // live ONLY in emitPermissionsUpdated and are pinned in their own
    // section above.
    const deletedBespokeEvents = [
      'pod:membership_updated',
      'session:list_changed',
      'admin:list_changed',
      'notification:list_changed',
      'user:changed',
      'user:blocks_changed',
      'group:changed',
    ];
    const routeFiles = [
      'routes/admin.ts',
      'routes/dm.ts',
      'routes/groups.ts',
      'routes/host.ts',
      'routes/invites.ts',
      'routes/join-requests.ts',
      'routes/notifications.ts',
      'routes/pods.ts',
      'routes/pokes.ts',
      'routes/reports.ts',
      'routes/sessions.ts',
      'routes/users.ts',
    ];
    const orchSrc = readServer('services/orchestration/orchestration.service.ts');

    for (const rel of routeFiles) {
      it(`${rel} no longer emits any deleted bespoke event`, () => {
        const src = readServer(rel);
        for (const ev of deletedBespokeEvents) {
          const re = new RegExp(`['"]${ev}['"]`);
          expect(src).not.toMatch(re);
        }
      });
    }

    it('orchestration.service.ts no longer emits any deleted bespoke event', () => {
      for (const ev of deletedBespokeEvents) {
        const re = new RegExp(`emit\\(\\s*['"]${ev}['"]`);
        expect(orchSrc).not.toMatch(re);
      }
    });
  });
});
