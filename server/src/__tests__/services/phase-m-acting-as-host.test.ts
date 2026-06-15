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

  describe('Server — getAllHostIds (acting-as-host removed 23 May Stefan + Ali)', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function getAllHostIds');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

    it('returns the director, formally-assigned cohosts, AND super_admins (Stefan 9 Jun)', () => {
      expect(fn).toMatch(/SELECT\s+user_id\s+FROM\s+session_cohosts\s+WHERE\s+session_id\s*=\s*\$1/i);
      // Stefan's rule — a super_admin is ALWAYS in the host set (excluded from
      // matching, counted as host), scoped to this session's participants.
      expect(fn).toMatch(/u\.role\s*=\s*'super_admin'/);
      expect(fn).toMatch(/superAdminResult\.rows\.map/);
      expect(fn).toMatch(/\[\s*hostUserId,/);
    });

    it('no longer applies acting-as-host opt-in / opt-out overrides', () => {
      // 23 May — the self-select picker was removed, so the host set is
      // role-derived only. Pin the ABSENCE of the override logic so it can't
      // silently creep back and re-exclude admins from matching.
      expect(fn).not.toMatch(/optedIn/);
      expect(fn).not.toMatch(/optedOut/);
      expect(fn).not.toMatch(/acting_as_host/);
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
      // SEC-1 (13 Jun audit C1) widened the handler with the platform-admin
      // opt-in gate before setActingAsHost, pushing emitPermissionsUpdated to
      // ~offset 1672. Window grown 1500 → 2200 so the call still lands.
      const slice = src.slice(routeIdx, routeIdx + 2200);
      // Phase 5: notifyPermissionsUpdated wrapper deleted from
      // orchestration.service.ts; routes now call emitPermissionsUpdated
      // directly from server/src/realtime/fanout.ts.
      expect(slice).toMatch(/emitPermissionsUpdated\(/);
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
      // Bug 26 + 28 (19 May) — return shape grew (tileDemotedUserIds,
      // bonusRoundsAdded). Widen the slice so the actingAsHostOverrides
      // pin still lands.
      const returnSlice = src.slice(returnIdx, returnIdx + 2400);
      expect(returnSlice).toMatch(/actingAsHostOverrides[,\s}]/);
    });
  });

  describe('Server — emitPermissionsUpdated helper (Phase 5 relocation)', () => {
    // Phase 5 relocated the helper out of orchestration.service.ts (which
    // also dual-emitted the deleted legacy 'permissions:updated' event)
    // into server/src/realtime/fanout.ts. The surviving 'permissions:updated'
    // bespoke event still fires from emitPermissionsUpdated because
    // useSessionSocket hydrates Zustand from the snapshot on receipt.
    const src = readServer('realtime/fanout.ts');

    it('exports emitPermissionsUpdated for REST handlers to emit permissions:updated', () => {
      expect(src).toMatch(/export async function emitPermissionsUpdated\(/);
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

    it('isHost is role-derived only — acting-as-host picker removed (23 May Stefan + Ali)', () => {
      // Non-directors always join as participants; the per-user override no
      // longer factors into isHost.
      expect(src).toMatch(/const\s+isHost\s*=\s*baseIsHost\s*;/);
    });

    it('the join-as picker, banners, and must-pick blocker are pinned off', () => {
      // The role flags are forced to constants so no popup / blocker ever
      // renders and the event content always shows.
      expect(src).toMatch(/const\s+canToggleActingAsHost\s*=\s*false\s*;/);
      expect(src).toMatch(/const\s+showJoinAsBanner\s*=\s*false\s*;/);
      expect(src).toMatch(/const\s+mustPickRole\s*=\s*false\s*;/);
    });

    it('Bug D — mirror banner persists for users currently opted in (acting as host)', () => {
      // The opt-in user gets a "Switch to participant" banner so they can
      // flip back without leaving the event. Symmetric to the opt-out
      // revert banner. Bug D mandate: toggle remains visible throughout.
      expect(src).toMatch(
        /canToggleActingAsHost\s*&&\s*myActingAsHost\s*===\s*true[\s\S]{0,300}data-testid="acting-as-participant-banner"/,
      );
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

    it('renders the banner when toggle-eligible AND user has opted out', () => {
      // Bug 4 (13 May) — banner is wrapped in an IIFE that derives
      // `inBreakout` from phase before rendering. Bug D (15 May) widened
      // the condition to (canToggleActingAsHost || baseIsHost) so formal
      // cohosts who opt out also see the path back. Pin both arms.
      expect(src).toMatch(
        /\(canToggleActingAsHost\s*\|\|\s*baseIsHost\)\s*&&\s*myActingAsHost\s*===\s*false[\s\S]{0,300}data-testid="acting-as-host-revert-banner"/,
      );
    });

    it('the banner button POSTs value:true to switch back to host', () => {
      // Bug D (15 May) — Switch back to host is now an EXPLICIT opt-in
      // (value:true), not a clear-to-default (value:null). This keeps the
      // toggle behaviour symmetric with the mirror banner ("Switch to
      // participant" posts value:false), so the user's choice persists
      // throughout the event and across reconnects.
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/acting-as-host[`'"]\s*,\s*\{\s*value:\s*true\s*\}/,
      );
    });
  });
});
