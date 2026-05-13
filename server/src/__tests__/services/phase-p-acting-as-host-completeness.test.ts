// Phase P — Ali's 13 May clarification on top of Phase M (12 May item 1).
//
// Original spec said "admins/super admins should have a toggle: Join as
// host." Ali clarified the operating rules:
//
//   • Only super_admin (Stefan) + admins (Shraddha, Raja Ali) get the toggle.
//   • The toggle is hidden when the user is the EVENT DIRECTOR (creator) —
//     they are permanently the host of their own event.
//   • The system must read state accurately: opt-ins count as hosts in
//     badges + counts + matching exclusion; opt-outs count as participants.
//   • Conflicts between the 12 May PDF and this clarification → clarification
//     wins.
//
// Phase P closes the four gaps Phase M left:
//   A. Director can opt out — must be blocked at REST + role resolver +
//      snapshot + UI.
//   B. Non-director admin/super_admin have no entry path to choose — adds
//      a lobby banner with two prominent buttons.
//   C. HCC role badges ignore opt-ins/opt-outs — derives role with the
//      override layer now.
//   D. Snapshot lacked a hosts count — exposes hostsRegistered +
//      hostsConnected so Lobby + dashboards count "N hosts + M participants"
//      honestly.

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

describe('Phase P — acting-as-host completeness (Ali 13 May clarification)', () => {
  // ─── Gap A — Director can never opt out ─────────────────────────────────
  describe('Gap A — Director cannot demote themselves', () => {
    it('REST endpoint refuses if userId === session.hostUserId', () => {
      const src = readServer('routes/host.ts');
      const routeIdx = src.indexOf("'/:id/host/acting-as-host'");
      expect(routeIdx).toBeGreaterThan(-1);
      const block = src.slice(routeIdx, routeIdx + 1500);
      // Director check must precede the setActingAsHost call.
      const directorCheckIdx = block.search(
        /session\.hostUserId\s*===\s*userId/,
      );
      const setIdx = block.indexOf('setActingAsHost');
      expect(directorCheckIdx).toBeGreaterThan(-1);
      expect(setIdx).toBeGreaterThan(-1);
      expect(directorCheckIdx).toBeLessThan(setIdx);
      // ForbiddenError must be the rejection path.
      expect(block).toMatch(/ForbiddenError/);
    });

    it('getEffectiveRole short-circuits to event_host for the director, ignoring acting_as_host', () => {
      const src = readServer('services/roles/effective-role.service.ts');
      const fnStart = src.indexOf('export async function getEffectiveRole');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

      // isDirector boolean is computed from sessions.host_user_id === userId.
      expect(fn).toMatch(/isDirector\s*=\s*sessRow\.rows\[0\]\?\.host_user_id\s*===\s*userId/);

      // The director short-circuit must run BEFORE the actingOverride === false
      // check, otherwise a stale FALSE row would mis-classify the director.
      const directorIdx = fn.indexOf('if (isDirector)');
      const optOutIdx = fn.indexOf('actingOverride === false');
      expect(directorIdx).toBeGreaterThan(-1);
      expect(optOutIdx).toBeGreaterThan(-1);
      expect(directorIdx).toBeLessThan(optOutIdx);
      // Director returns event_host.
      expect(fn).toMatch(/if\s*\(\s*isDirector\s*\)[\s\S]{0,200}return\s+['"]event_host['"]/);
    });

    it('snapshot filters director out of actingAsHostOverrides map', () => {
      const src = readServer('services/session/session-state-snapshot.service.ts');
      // The accumulator loop skips the director row.
      expect(src).toMatch(/if\s*\(\s*r\.user_id\s*===\s*session\.hostUserId\s*\)\s*continue/);
    });

    it('HostControlCenter hides the join-as toggle when currentUserId === hostUserId', () => {
      const src = readClient('features/live/HostControlCenter.tsx');
      // Wide window covers the button's onClick handler + className + title
      // attribute before the data-testid; what matters is the guard comes
      // first in the JSX expression.
      expect(src).toMatch(
        /\{\s*currentUserId\s*&&\s*currentUserId\s*!==\s*hostUserId\s*&&[\s\S]{0,2000}data-testid="hcc-join-as-toggle"/,
      );
    });
  });

  // ─── Gap B — Lobby entry banner for non-director admin/super_admin ──────
  describe('Gap B — Lobby pre-event Join-as banner', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');

    it('canToggleActingAsHost = (admin OR super_admin) AND NOT director', () => {
      expect(src).toMatch(
        /isAdminOrSuperAdmin\s*=\s*user\?\.role\s*===\s*['"]admin['"]\s*\|\|\s*user\?\.role\s*===\s*['"]super_admin['"]/,
      );
      expect(src).toMatch(/isDirector\s*=[\s\S]{0,80}session\?\.hostUserId\s*===\s*user\?\.id/);
      expect(src).toMatch(
        /canToggleActingAsHost\s*=\s*isAdminOrSuperAdmin\s*&&\s*!isDirector/,
      );
    });

    it('showJoinAsBanner gates on canToggleActingAsHost AND override === undefined', () => {
      expect(src).toMatch(
        /showJoinAsBanner\s*=[\s\S]{0,80}canToggleActingAsHost[\s\S]{0,80}myActingAsHost\s*===\s*undefined/,
      );
    });

    it('renders join-as-banner with both host + participant buttons', () => {
      expect(src).toMatch(/data-testid="join-as-banner"/);
      expect(src).toMatch(/data-testid="join-as-banner-host"/);
      expect(src).toMatch(/data-testid="join-as-banner-participant"/);
      // The two buttons POST the right values to the REST endpoint.
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/acting-as-host[`'"]\s*,\s*\{\s*value:\s*true\s*\}/,
      );
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/acting-as-host[`'"]\s*,\s*\{\s*value:\s*false\s*\}/,
      );
    });
  });

  // ─── Gap C — HCC role classification respects override ─────────────────
  describe('Gap C — HCC role classification', () => {
    const src = readServer('services/orchestration/handlers/host-participants-view.ts');

    it('SELECT pulls sp.acting_as_host (and NULL::boolean on synthetic rows)', () => {
      expect(src).toMatch(/sp\.acting_as_host/);
      expect(src).toMatch(/NULL::boolean\s+AS\s+acting_as_host/);
    });

    it('role precedence: director → host, opt-out → participant, opt-in → cohost, is_cohost → cohost, else participant', () => {
      // Pin the structural precedence — checks in the right order so a
      // future refactor can't accidentally promote opt-out into cohost.
      const directorIdx = src.search(/r\.user_id\s*===\s*opts\.hostUserId[\s\S]{0,80}role\s*=\s*['"]host['"]/);
      const optOutIdx = src.search(/r\.acting_as_host\s*===\s*false[\s\S]{0,80}role\s*=\s*['"]participant['"]/);
      const optInIdx = src.search(/r\.acting_as_host\s*===\s*true[\s\S]{0,80}role\s*=\s*['"]cohost['"]/);
      const isCohostIdx = src.search(/r\.is_cohost[\s\S]{0,80}role\s*=\s*['"]cohost['"]/);
      expect(directorIdx).toBeGreaterThan(-1);
      expect(optOutIdx).toBeGreaterThan(-1);
      expect(optInIdx).toBeGreaterThan(-1);
      expect(isCohostIdx).toBeGreaterThan(-1);
      // Director check must come first in the if/else ladder.
      expect(directorIdx).toBeLessThan(optOutIdx);
      expect(optOutIdx).toBeLessThan(optInIdx);
      expect(optInIdx).toBeLessThan(isCohostIdx);
    });
  });

  // ─── Gap D — Snapshot hostsRegistered + hostsConnected counts ───────────
  describe('Gap D — Snapshot exposes hosts count split', () => {
    const src = readServer('services/session/session-state-snapshot.service.ts');

    it('SessionStateSnapshot.participantCounts declares hostsRegistered + hostsConnected', () => {
      expect(src).toMatch(/hostsRegistered:\s*number/);
      expect(src).toMatch(/hostsConnected:\s*number/);
    });

    it('builds the hostsRegisteredSet from director + cohosts ± overrides, then re-adds director as defence', () => {
      // Director added at the start.
      expect(src).toMatch(/hostsRegisteredSet\.add\(session\.hostUserId\)/);
      // Cohorts loop.
      expect(src).toMatch(/for\s*\(\s*const cohostId of cohosts\s*\)\s*hostsRegisteredSet\.add\(cohostId\)/);
      // Override loop applies add for true, delete for false.
      expect(src).toMatch(/if\s*\(\s*value\s*===\s*true\s*\)\s*hostsRegisteredSet\.add\(uid\)/);
      expect(src).toMatch(/if\s*\(\s*value\s*===\s*false\s*\)\s*hostsRegisteredSet\.delete\(uid\)/);
      // Director re-added at the end — defence so an override can never
      // remove the director from the host set.
      const overrideLoopIdx = src.indexOf('for (const [uid, value] of Object.entries(actingAsHostOverrides))');
      const reAddIdx = src.indexOf('hostsRegisteredSet.add(session.hostUserId)', overrideLoopIdx);
      expect(overrideLoopIdx).toBeGreaterThan(-1);
      expect(reAddIdx).toBeGreaterThan(overrideLoopIdx);
    });

    it('hostsConnectedSet is the intersection with connectedParticipants', () => {
      expect(src).toMatch(/hostsConnectedSet\s*=\s*new\s+Set/);
      expect(src).toMatch(/hostsRegisteredSet\.has\(p\.userId\)/);
    });

    it('participantCounts return object includes hostsRegistered + hostsConnected fields', () => {
      // The string `participantCounts: {` appears twice — once in the
      // interface declaration (with `hostsRegistered: number`) and once
      // in the returned object literal (with `hostsRegistered:
      // hostsRegisteredSet.size`). The interface match comes first; the
      // return match is later. Find the LAST occurrence to anchor on
      // the actual return.
      const allOccurrences: number[] = [];
      let from = 0;
      while (from < src.length) {
        const i = src.indexOf('participantCounts: {', from);
        if (i === -1) break;
        allOccurrences.push(i);
        from = i + 1;
      }
      expect(allOccurrences.length).toBeGreaterThanOrEqual(2);
      const returnIdx = allOccurrences[allOccurrences.length - 1];
      const block = src.slice(returnIdx, returnIdx + 600);
      expect(block).toMatch(/hostsRegistered:\s*hostsRegisteredSet\.size/);
      expect(block).toMatch(/hostsConnected:\s*hostsConnectedSet\.size/);
    });
  });

  // ─── Audit — propagation to Lobby + ParticipantList ─────────────────────
  describe('Audit — client surfaces also honour acting_as_host', () => {
    it('Lobby HostParticipantPanel header counts use hostsSet (director + cohosts ± overrides)', () => {
      const src = readClient('features/live/Lobby.tsx');
      // hostsSet derivation reads from the store + applies overrides.
      expect(src).toMatch(/hostsSet/);
      expect(src).toMatch(/for\s*\(\s*const \[uid, v\] of Object\.entries\(actingAsHostOverrides\)\s*\)/);
      // Participants filter uses hostsSet (not the old hostUserId + cohosts check).
      expect(src).toMatch(/participants\.filter\(p\s*=>\s*!hostsSet\.has\(p\.userId\)\)/);
    });

    it('ParticipantList badges use isActingCohost helper that respects overrides', () => {
      const src = readClient('features/live/ParticipantList.tsx');
      expect(src).toMatch(/isActingCohost\s*=\s*\(uid: string\):\s*boolean/);
      // Helper returns false for director (they have the Host badge).
      expect(src).toMatch(/uid\s*===\s*hostUserId[\s\S]{0,80}return\s+false/);
      // Helper honours opt-out and opt-in.
      expect(src).toMatch(/override\s*===\s*false[\s\S]{0,40}return\s+false/);
      expect(src).toMatch(/override\s*===\s*true[\s\S]{0,40}return\s+true/);
      // Helper is the source of `isCohost` in the per-row badge.
      expect(src).toMatch(/const\s+isCohost\s*=\s*isActingCohost\(p\.userId\)/);
    });
  });

  // ─── Cross-reference — Phase M's invariants still hold ──────────────────
  describe('Cross-reference — Phase M invariants intact', () => {
    it('migration 060 still adds the nullable BOOLEAN column', () => {
      const sql = readServer('db/migrations/060_acting_as_host.sql');
      expect(sql).toMatch(/ADD\s+COLUMN\s+acting_as_host\s+BOOLEAN\s*;/i);
    });

    it('getAllHostIds still applies opt-in / opt-out from Phase M', () => {
      const src = readServer('services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function getAllHostIds');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      expect(fn).toMatch(/optedIn/);
      expect(fn).toMatch(/optedOut/);
      expect(fn).toMatch(/baseHosts\.add\(/);
      expect(fn).toMatch(/baseHosts\.delete\(/);
    });
  });
});
