// Phase 8 (1 May 2026 spec) — Host action receipts + immediate dashboard refresh
//
// Stefan item 10: 'Host controls (partially working) ... Missing: clarity of
// effect, confirmation of action, visibility of system state.' Pre-Phase-8,
// the host clicked an action and had to scan the dashboard to figure out
// whether it landed. The 1-second dashboard coalesce made the lag worse.
//
// Phase 8 adds:
// - emitHostActionConfirmed helper that fires host:action_confirmed to the
//   host's userRoom with { action, summary, target?, timestamp }.
// - emitHostDashboardForce that bypasses the coalesce (host's own action
//   should refresh their dashboard with no perceptible delay).
// - Wiring on the high-impact host actions (move_to_room, remove_from_room,
//   broadcast, bulk-create-breakouts, extend_round, extend_breakout_room).
// - Client subscription in HostRoundDashboard that renders each receipt as
//   a 3-second toast.

import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

describe('Phase 8 — host action receipts', () => {
  describe('matching-flow.ts exports the helpers', () => {
    const src = readServer('services/orchestration/handlers/matching-flow.ts');

    it('exports emitHostDashboardForce that bypasses the coalesce', () => {
      expect(src).toMatch(/export async function emitHostDashboardForce\(/);
      const fnStart = src.indexOf('export async function emitHostDashboardForce(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Cancels any pending coalesce timer + sets lastEmit to now
      expect(fn).toMatch(/clearTimeout\(state\.pendingTimer\)/);
      expect(fn).toMatch(/state\.lastEmit = Date\.now\(\)/);
      expect(fn).toMatch(/emitHostDashboardImmediate\(io, sessionId\)/);
    });

    it('exports emitHostActionConfirmed that emits to the host userRoom only', () => {
      expect(src).toMatch(/export function emitHostActionConfirmed\(/);
      const fnStart = src.indexOf('export function emitHostActionConfirmed(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/io\.to\(userRoom\(hostUserId\)\)\.emit\(['"]host:action_confirmed['"]/);
      expect(fn).toMatch(/timestamp/);
    });
  });

  describe('host actions wire receipts on high-impact handlers', () => {
    const hostActions = readServer('services/orchestration/handlers/host-actions.ts');
    const breakoutBulk = readServer('services/orchestration/handlers/breakout-bulk.ts');

    it('handleHostRemoveFromRoom emits remove_from_room receipt', () => {
      expect(hostActions).toMatch(/action:\s*['"]remove_from_room['"]/);
    });

    it('handleHostMoveToRoom emits move_to_room receipt', () => {
      expect(hostActions).toMatch(/action:\s*['"]move_to_room['"]/);
    });

    it('handleHostBroadcast emits broadcast receipt', () => {
      expect(hostActions).toMatch(/action:\s*['"]broadcast['"]/);
    });

    it('handleHostExtendRound emits extend_round receipt', () => {
      expect(hostActions).toMatch(/action:\s*['"]extend_round['"]/);
    });

    it('handleHostExtendBreakoutRoom emits extend_breakout_room receipt', () => {
      expect(hostActions).toMatch(/action:\s*['"]extend_breakout_room['"]/);
    });

    it('handleHostCreateBreakoutBulk emits create_breakout_bulk receipt', () => {
      expect(breakoutBulk).toMatch(/action:\s*['"]create_breakout_bulk['"]/);
    });
  });

  describe('Lobby compact header (Stefan: too much top space)', () => {
    const src = readClient('features/live/Lobby.tsx');
    const liveSrc = readClient('features/live/LiveSessionPage.tsx');

    it('the steady-state Main Room heading + "Click Match People" copy is gone from above the tiles', () => {
      // June-10 — the redundant "Main Room · Click Match People" heading was
      // removed from LobbyStatusOverlay; the top bar already shows the room
      // state, so above the tiles only the density toggle remains.
      expect(src).not.toMatch(/Click Match People/);
    });

    it('outer lobby container uses p-3 sm:p-6 + gap-3 sm:gap-4 (was p-6 gap-6)', () => {
      expect(src).toMatch(/p-3 sm:p-6 gap-3 sm:gap-4/);
    });

    it('the participant count moved to the top bar with the compact h-3 icon', () => {
      // June-10 — the count line left LobbyStatusOverlay and now renders in the
      // top bar (TopBarParticipantCount), still compact (text-xs + h-3 icon).
      const idx = liveSrc.indexOf('function TopBarParticipantCount');
      expect(idx).toBeGreaterThan(-1);
      const fn = liveSrc.slice(idx, idx + 1400);
      expect(fn).toMatch(/text-xs text-gray-500[\s\S]+?Users className="h-3 w-3"/);
    });
  });

  describe('client HostRoundDashboard subscribes to host:action_confirmed', () => {
    const src = readClient('features/live/HostRoundDashboard.tsx');

    it('registers a socket.on listener for host:action_confirmed', () => {
      expect(src).toMatch(/socket\.on\(['"]host:action_confirmed['"]/);
    });

    it('keeps an in-memory log of the last 5 receipts (FIFO)', () => {
      expect(src).toMatch(/setActionLog\(prev =>[\s\S]*?slice\(0,\s*5\)/);
    });

    it('auto-fades each receipt after ~3 seconds', () => {
      expect(src).toMatch(/setTimeout\([\s\S]*?setActionLog\(prev =>[\s\S]*?\.filter\(/);
      // The timeout duration is 3000ms.
      expect(src).toMatch(/3000\)/);
    });

    it('renders the receipt stack as a fixed-position toast group', () => {
      expect(src).toMatch(/fixed top-4 right-4 z-50/);
    });
  });
});
