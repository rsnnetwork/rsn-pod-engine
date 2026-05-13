// Phase M — 12 May item 1: per-event "Join as host" / "Join as participant"
// toggle. Stefan's spec asked for admins/super_admins to be able to switch
// their auto-host role on a per-event basis. Phase I (May 12) had already
// narrowed auto-host to super_admin only; Phase M adds the explicit toggle
// so super_admin (today: always host) can attend as a participant, and
// regular admins (today: always participant) can opt in to host if needed.
//
// The override lives on session_participants.acting_as_host (BOOLEAN
// nullable). NULL = role default; TRUE = explicit opt-in; FALSE = opt-out.
// Both client and server read it; the snapshot exposes the map on cold-
// start; the REST endpoint is the single mutation point.

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

describe('Phase M — acting-as-host toggle (item 1)', () => {
  describe('Migration 060 — acting_as_host column on session_participants', () => {
    const sql = readServer('db/migrations/060_acting_as_host.sql');

    it('adds a nullable BOOLEAN column (NULL = use role default)', () => {
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+session_participants\s+ADD\s+COLUMN\s+acting_as_host\s+BOOLEAN\s*;/i,
      );
      // Forbid NOT NULL — the migration MUST allow NULL so existing rows
      // continue to use role default semantics without a backfill.
      expect(sql).not.toMatch(/acting_as_host\s+BOOLEAN\s+NOT\s+NULL/i);
    });

    it('wraps the change in a single transaction (atomic apply on live DB)', () => {
      expect(sql).toMatch(/BEGIN;[\s\S]+COMMIT;/);
    });
  });

  describe('Server — session service helpers', () => {
    const src = readServer('services/session/session.service.ts');

    it('exports getActingAsHostOverride for single-user lookup', () => {
      expect(src).toMatch(/export async function getActingAsHostOverride\(/);
      expect(src).toMatch(
        /SELECT\s+acting_as_host\s+FROM\s+session_participants\s+WHERE\s+session_id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i,
      );
    });

    it('exports getActingAsHostOverrides for bulk lookup (snapshot path)', () => {
      expect(src).toMatch(/export async function getActingAsHostOverrides\(/);
      // The query must filter on acting_as_host IS NOT NULL — NULL rows
      // mean "follow role default" and aren't part of the override map.
      expect(src).toMatch(/acting_as_host\s+IS\s+NOT\s+NULL/i);
    });

    it('exports setActingAsHost to update the override', () => {
      expect(src).toMatch(/export async function setActingAsHost\(/);
      expect(src).toMatch(
        /UPDATE\s+session_participants\s+SET\s+acting_as_host\s*=\s*\$3\s+WHERE\s+session_id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i,
      );
    });
  });

  describe('Server — getEffectiveRole respects the override', () => {
    const src = readServer('services/roles/effective-role.service.ts');

    it('reads acting_as_host before the role-based layers', () => {
      // The override read MUST occur before Layer 1 (super_admin) so the
      // opt-out works even for super_admin. Pin both that the read exists
      // and that it happens early in the function body.
      const fnStart = src.indexOf('export async function getEffectiveRole');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

      const readIdx = fn.search(/SELECT\s+acting_as_host\s+FROM\s+session_participants/i);
      const layer1Idx = fn.indexOf('Layer 1');
      expect(readIdx).toBeGreaterThan(-1);
      expect(layer1Idx).toBeGreaterThan(-1);
      expect(readIdx).toBeLessThan(layer1Idx);
    });

    it('returns participant on explicit opt-out (acting_as_host === false)', () => {
      const fnStart = src.indexOf('export async function getEffectiveRole');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      // Window expanded to 600 chars to accommodate the explanatory
      // comment between the guard and the return; the structural pin
      // (false → participant) still holds.
      expect(fn).toMatch(/actingOverride\s*===\s*false[\s\S]{0,600}return\s+['"]participant['"]/);
    });

    it('promotes to cohost as opt-in floor when explicit opt-in (acting_as_host === true)', () => {
      // Opt-in path: if a user has a session_participants row AND
      // acting_as_host = true AND their natural role would be 'participant',
      // promote to 'cohost' so canActAsHost accepts them.
      const fnStart = src.indexOf('export async function getEffectiveRole');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      expect(fn).toMatch(/actingOverride\s*===\s*true[\s\S]{0,600}return\s+['"]cohost['"]/);
    });
  });

  describe('Server — getAllHostIds applies overrides', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function getAllHostIds');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

    it('queries session_participants for explicit overrides', () => {
      expect(fn).toMatch(
        /SELECT\s+user_id,\s+acting_as_host\s+FROM\s+session_participants[\s\S]{0,200}IS\s+NOT\s+NULL/i,
      );
    });

    it('excludes opted-out users (acting_as_host === false) from the host set', () => {
      // Pin: a Set tracks opt-outs; the final result deletes them.
      expect(fn).toMatch(/optedOut/);
      expect(fn).toMatch(/baseHosts\.delete\(/);
    });

    it('includes opted-in users (acting_as_host === true) in the host set', () => {
      expect(fn).toMatch(/optedIn/);
      expect(fn).toMatch(/baseHosts\.add\(/);
    });
  });

  describe('Server — REST endpoint POST /sessions/:id/host/acting-as-host', () => {
    const src = readServer('routes/host.ts');

    it('declares the route with zod validation for { value: boolean|null }', () => {
      expect(src).toMatch(/['"]\/:id\/host\/acting-as-host['"]/);
      expect(src).toMatch(/actingAsHostSchema\s*=\s*z\.object/);
      expect(src).toMatch(/value:\s*z\.union\(\[z\.boolean\(\),\s*z\.null\(\)\]\)/);
    });

    it('delegates to sessionService.setActingAsHost using the caller\'s own userId', () => {
      // The endpoint MUST use req.user.userId — not req.body.userId — so a
      // user cannot toggle someone else's override. The spec scopes this
      // toggle to the caller themselves. Window widened to 1500 chars to
      // include the Phase P director-check guard inserted before the
      // setActingAsHost call.
      const routeIdx = src.indexOf("'/:id/host/acting-as-host'");
      expect(routeIdx).toBeGreaterThan(-1);
      const slice = src.slice(routeIdx, routeIdx + 1500);
      expect(slice).toMatch(/sessionService\.setActingAsHost\(\s*sessionId,\s*userId,\s*req\.body\.value/);
      expect(slice).toMatch(/userId\s*=\s*req\.user!.userId/);
    });

    it('notifies the caller via permissions:updated so their snapshot resyncs', () => {
      const routeIdx = src.indexOf("'/:id/host/acting-as-host'");
      const slice = src.slice(routeIdx, routeIdx + 1500);
      expect(slice).toMatch(/orchestrationService\.notifyPermissionsUpdated/);
    });
  });

  describe('Server — snapshot exposes actingAsHostOverrides', () => {
    const src = readServer('services/session/session-state-snapshot.service.ts');

    it('SessionStateSnapshot interface declares actingAsHostOverrides', () => {
      expect(src).toMatch(/actingAsHostOverrides:\s*Record<string,\s*boolean>/);
    });

    it('snapshot pulls every non-NULL override and includes in the returned shape', () => {
      // The snapshot piggybacks acting_as_host on the existing
      // session_participants SELECT (T1-4 registered count). Pin both
      // shapes — the SELECT must request the column, and the JS-side
      // filter must drop nulls into the map.
      expect(src).toMatch(/sp\.acting_as_host/);
      expect(src).toMatch(/actingAsHostOverrides\[r\.user_id\]\s*=\s*r\.acting_as_host/);
      // The returned object must include actingAsHostOverrides among
      // its top-level fields (alongside hostVisibilityModes).
      const returnIdx = src.indexOf('return {');
      expect(returnIdx).toBeGreaterThan(-1);
      const returnSlice = src.slice(returnIdx, returnIdx + 1200);
      expect(returnSlice).toMatch(/actingAsHostOverrides[,\s}]/);
    });
  });

  describe('Server — notifyPermissionsUpdated helper', () => {
    const src = readServer('services/orchestration/orchestration.service.ts');

    it('exports notifyPermissionsUpdated for REST handlers to emit permissions:updated', () => {
      expect(src).toMatch(/export async function notifyPermissionsUpdated\(/);
      expect(src).toMatch(/['"]permissions:updated['"]/);
    });
  });

  describe('Client — sessionStore has actingAsHostOverrides record + setter', () => {
    const src = readClient('stores/sessionStore.ts');

    it('declares the record type on the live state', () => {
      expect(src).toMatch(/actingAsHostOverrides:\s*Record<string,\s*boolean>/);
    });

    it('exposes setActingAsHostOverrides bulk setter', () => {
      expect(src).toMatch(/setActingAsHostOverrides:\s*\(overrides/);
    });

    it('applyFullState pulls actingAsHostOverrides from the snapshot', () => {
      expect(src).toMatch(/actingAsHostOverrides:\s*snapshot\.actingAsHostOverrides/);
    });

    it('reset() clears actingAsHostOverrides to {}', () => {
      // Pin so a future PR doesn't accidentally leak override state
      // across sessions on the same client.
      expect(src).toMatch(/actingAsHostOverrides:\s*\{\}/);
    });
  });

  describe('Client — LiveSessionPage isHost factors in myActingAsHost', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');

    it('reads actingAsHostOverrides from the store and resolves the current user\'s value', () => {
      expect(src).toMatch(/actingAsHostOverrides\s*=\s*useSessionStore\(/);
      expect(src).toMatch(/myActingAsHost[\s\S]{0,80}actingAsHostOverrides\[user\.id\]/);
    });

    it('isHost composes baseIsHost with the Phase M override', () => {
      // FALSE override → false; TRUE override → true; else → baseIsHost.
      expect(src).toMatch(/const\s+isHost\s*=[\s\S]{0,180}myActingAsHost[\s\S]{0,80}baseIsHost/);
    });
  });

  describe('Client — HostControlCenter toggle button', () => {
    const src = readClient('features/live/HostControlCenter.tsx');

    it('imports auth store so the toggle uses the viewer\'s own userId', () => {
      expect(src).toMatch(/import\s+\{\s*useAuthStore\s*\}\s+from\s+['"]@\/stores\/authStore['"]/);
      expect(src).toMatch(/authUser\s*=\s*useAuthStore/);
    });

    it('setMyActingAsHost handler posts to the REST endpoint', () => {
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/acting-as-host[`'"]\s*,\s*\{\s*value\s*\}/,
      );
    });

    it('renders the toggle button with the join-as-toggle test id', () => {
      expect(src).toMatch(/data-testid="hcc-join-as-toggle"/);
    });
  });

  describe('Client — LiveSessionPage revert banner for opted-out users', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');

    it('renders the banner only when baseIsHost AND user has opted out', () => {
      expect(src).toMatch(
        /baseIsHost\s*&&\s*myActingAsHost\s*===\s*false[\s\S]{0,80}data-testid="acting-as-host-revert-banner"/,
      );
    });

    it('the banner button POSTs value:null to revert to role default', () => {
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/acting-as-host[`'"]\s*,\s*\{\s*value:\s*null\s*\}/,
      );
    });
  });
});
