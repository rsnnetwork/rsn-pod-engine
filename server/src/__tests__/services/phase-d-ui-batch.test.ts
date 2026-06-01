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
      expect(src).toMatch(/grid grid-cols-1 lg:grid-cols-3[^"']*flex-1[^"']*min-h-0[^"']*overflow-y-auto/);
    });

    it('participants <ul> has bottom padding so the last row is not clipped', () => {
      // Without bottom padding, the final list item sits flush with the
      // scroll-container edge, which is the visual symptom Stefan reported.
      expect(src).toMatch(/<ul[^>]*divide-y[^>]*pb-12/);
    });
  });

  describe('D3 — participant count format (item 10)', () => {
    const src = readClient('features/live/Lobby.tsx');

    it('formatParticipantHeader helper exists and excludes co-hosts from participant count', () => {
      const fnStart = src.indexOf('function formatParticipantHeader');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Participant count subtracts both host AND cohosts.
      expect(fn).toMatch(/cohostsPresent/);
      expect(fn).toMatch(/participants\.length\s*\n?\s*-\s*\(hostInList\s*\?\s*1\s*:\s*0\)\s*\n?\s*-\s*cohostsPresent/);
      // Output uses "+ N hosts" not "+ host" lump.
      expect(fn).toMatch(/totalHosts === 1\s*\?\s*['"]host['"]\s*:\s*['"]hosts['"]/);
    });

    it('LobbyStatusOverlay uses the helper (no inline duplicate logic)', () => {
      const fnStart = src.indexOf('function LobbyStatusOverlay');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/formatParticipantHeader\(participants,\s*hostUserId,\s*cohosts,\s*hostOnline\)/);
      // No inline `+ host` string concatenation should remain in this fn.
      expect(fn).not.toMatch(/\?\s*['"][^'"]*\+\s*host['"]/);
    });

    it('PreLobbyWaitingRoom uses the helper too', () => {
      const fnStart = src.indexOf('function PreLobbyWaitingRoom');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/formatParticipantHeader\(participants,\s*hostUserId,\s*cohosts,\s*hostOnline\)/);
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
