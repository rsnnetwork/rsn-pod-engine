// Phase D — UI bug batch (10 May review items 5, 8, 10).
//
// D1 — test mode banner only fires when admin opted in (config.testMode
//      explicit boolean) OR when running in non-production. The auto-
//      heuristic is suppressed in production unless the host explicitly
//      sets it. Stefan #5: real participants saw "Test mode — multiple
//      accounts detected" because two of them shared an email domain.
// D2 — HCC participant list scrolls to the last row on every screen size.
//      Pinned by ensuring the inner grid uses min-h-0 (critical for nested
//      flexbox to shrink) and the participants <ul> has bottom padding.
// D3 — participant count format separates participants from hosts. A
//      single helper formatParticipantHeader is used in all three call
//      sites so future changes can't drift.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Phase D — UI bug batch', () => {
  describe('D1 — test mode banner gate (item 5)', () => {
    const src = readServer('services/session/session-state-snapshot.service.ts');

    it('heuristic only runs in non-production environments', () => {
      // Find the testMode block.
      const start = src.indexOf('let testMode = false');
      expect(start).toBeGreaterThan(-1);
      const end = src.indexOf('return {', start);
      const block = src.slice(start, end);
      // The explicit override branch is unchanged.
      expect(block).toMatch(/typeof\s*\(config as any\)\.testMode\s*===\s*['"]boolean['"]/);
      // The heuristic branch is gated on non-production.
      expect(block).toMatch(/process\.env\.NODE_ENV\s*===\s*['"]production['"]/);
      expect(block).toMatch(/!isProd/);
    });
  });

  describe('D2 — HCC scroll fix (item 8)', () => {
    const src = readClient('features/live/HostControlCenter.tsx');

    it('grid container has min-h-0 alongside flex-1 + overflow-y-auto', () => {
      // The participants/rooms grid sits inside a flex column; without
      // min-h-0 the grid keeps its natural height and the parent's
      // overflow-hidden clips the bottom rows.
      //
      // Bug 16 (18 May Stefan) — the lg:grid-cols-3 class is now applied
      // CONDITIONALLY (only when there are active rooms to render) so the
      // participants list takes the full width when the rooms pane would
      // otherwise be an empty third. The other utilities (flex-1, min-h-0,
      // overflow-y-auto) still apply unconditionally.
      expect(src).toMatch(/grid grid-cols-1/);
      expect(src).toMatch(/lg:grid-cols-3 lg:divide-x divide-gray-200/);
      expect(src).toMatch(/flex-1 min-h-0 overflow-y-auto/);
    });

    it('participants <ul> has bottom padding so the last row is not clipped', () => {
      // Without bottom padding, the final list item sits flush with the
      // scroll-container edge, which is the visual symptom Stefan reported.
      expect(src).toMatch(/<ul[^>]*divide-y[^>]*pb-12/);
    });
  });

  describe('D3 — participant count format (item 10)', () => {
    const src = readClient('features/live/Lobby.tsx');

    it('formatParticipantHeader helper splits participants / host / co-hosts (Bug 15)', () => {
      const fnStart = src.indexOf('function formatParticipantHeader');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Bug E (15 May Ali) — `hostsSet` from director + cohosts +
      // Phase M opt-ins (minus opt-outs), intersected with the present
      // roster.
      // Bug 15 (18 May Stefan) — separate counts pushed into a `parts`
      // array so each role appears as its own pill: "N participants ·
      // 1 host · M co-hosts". The legacy lump-sum "X + Y hosts" form
      // is gone.
      expect(fn).toMatch(/hostsSet/);
      expect(fn).toMatch(/actingAsHostOverrides/);
      // Director / co-host derivation.
      expect(fn).toMatch(/directorPresent/);
      expect(fn).toMatch(/coHostCount/);
      // Pluralised output strings — pin both branches so the pluralisation
      // doesn't quietly drift.
      expect(fn).toMatch(/co-host\$\{coHostCount\s*!==\s*1\s*\?\s*'s'\s*:\s*''\}/);
      expect(fn).toMatch(/participant\$\{participantCount\s*!==\s*1\s*\?\s*'s'\s*:\s*''\}/);
    });

    it('the top-bar count uses the helper with actingAsHostOverrides (no inline duplicate logic)', () => {
      // June-10 — the count moved to the top bar (TopBarParticipantCount in
      // LiveSessionPage); it still uses the single formatParticipantHeader
      // helper with the acting-as-host overrides (no re-implemented counting).
      const liveSrc = readClient('features/live/LiveSessionPage.tsx');
      const fnStart = liveSrc.indexOf('function TopBarParticipantCount');
      expect(fnStart).toBeGreaterThan(-1);
      const fn = liveSrc.slice(fnStart, fnStart + 900);
      expect(fn).toMatch(
        /formatParticipantHeader\(\s*roster,\s*hostUserId,\s*cohosts,\s*actingAsHostOverrides\s*\?\?\s*\{\},\s*null\s*\)/,
      );
      // No inline `+ host` string concatenation should remain in this fn.
      expect(fn).not.toMatch(/\?\s*['"][^'"]*\+\s*host['"]/);
    });

    it('PreLobbyWaitingRoom uses the helper too', () => {
      const fnStart = src.indexOf('function PreLobbyWaitingRoom');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(
        /formatParticipantHeader\(\s*participants,\s*hostUserId,\s*cohosts,\s*actingAsHostOverrides,\s*hostOnline\s*\)/,
      );
    });

    it('HostParticipantPanel header counts hosts separately from participants', () => {
      const fnStart = src.indexOf('function HostParticipantPanel');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Reads both buckets explicitly and labels them.
      expect(fn).toMatch(/totalHosts/);
      expect(fn).toMatch(/['"]Host['"]\s*:\s*['"]Hosts['"]/);
    });
  });
});
