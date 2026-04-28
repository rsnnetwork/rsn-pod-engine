// Architectural test: every match status transition must refresh the host dashboard.
//
// Bug context: live event 2026-04-17 — host saw "ghost manual breakout room" cards
// in dashboard EVEN AFTER match.status='completed'. Root cause: the 5-second polling
// interval only ran during ROUND_ACTIVE, so during LOBBY_OPEN (when manual breakouts
// run before/between rounds) the dashboard never refreshed and ghost cards persisted
// indefinitely.
//
// Architectural rule: every UPDATE matches SET status site (active → completed/
// cancelled/no_show/reassigned) MUST trigger emitHostDashboard(sessionId), and a
// LOBBY_OPEN dashboard interval must run while active manual matches exist.
//
// Forward-compat with phase 2 Redis: emit-at-transition lets the Redis adapter
// replace polling with pub/sub without changing call sites.

const fs = require('fs');
const path = require('path');

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, relPath), 'utf8');
}

describe('Architectural: dashboard refresh on every match status transition', () => {
  // ────────────────────────────────────────────────────────────────────────
  // Static audit: every UPDATE matches SET status site followed by emit
  // ────────────────────────────────────────────────────────────────────────

  describe('participant-flow.ts — leave + disconnect transitions emit dashboard', () => {
    it('handleLeaveConversation emits emitHostDashboard after match status change', () => {
      const src = readSource('../../../services/orchestration/handlers/participant-flow.ts');
      // Phase 3 (29 April 2026 spec) refactor: the literal `UPDATE matches
      // SET status = 'completed'` was replaced by a call to
      // demoteParticipantFromMatch, which handles all room sizes (3-person
      // trio with 1 leaver: NULLs the leaver's slot and keeps match active;
      // 1/0 remaining: marks terminal). The architectural invariant is
      // unchanged — every transition still emits the dashboard — but the
      // test anchors on the new helper call instead of the inline SQL.
      const fnStart = src.indexOf('export async function handleLeaveConversation');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/demoteParticipantFromMatch/);
      expect(fn).toMatch(/emitHostDashboard\(/);
    });

    it('disconnect timeout (cancelled/completed) emits emitHostDashboard after UPDATE matches', () => {
      const src = readSource('../../../services/orchestration/handlers/participant-flow.ts');
      // The disconnect handler's terminalStatus block
      const blockStart = src.indexOf("'Match ended by disconnect'");
      expect(blockStart).toBeGreaterThan(-1);
      // emit must exist within the same callback
      const block = src.slice(blockStart, blockStart + 1500);
      expect(block).toMatch(/emitHostDashboard\(/);
    });
  });

  describe('round-lifecycle.ts — no-show and endRound transitions emit dashboard', () => {
    it('detectNoShows (both absent) emits emitHostDashboard after UPDATE matches', () => {
      const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
      // detectNoShows function — both branches set status='no_show'.
      const fnStart = src.indexOf('export async function detectNoShows');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\n}', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // At least one emitHostDashboard call inside the function
      expect(fn).toMatch(/emitHostDashboard\(/);
    });

    it('endRound emits emitHostDashboard after batch UPDATE matches', () => {
      const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
      const fnStart = src.indexOf('export async function endRound');
      expect(fnStart).toBeGreaterThan(-1);
      // endRound runs to ROUND_RATING transition. Find next "export"
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport);
      expect(fn).toMatch(/UPDATE matches SET status = 'completed'/);
      expect(fn).toMatch(/emitHostDashboard\(/);
    });

    it('transitionToRound cancel-on-room-creation-failure: covered by L409 emitHostDashboard', () => {
      const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
      const fnStart = src.indexOf('export async function transitionToRound');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport);
      // Both UPDATE sites are within transitionToRound and the function calls
      // emitHostDashboard once at the end (after starting the round timer).
      expect(fn).toMatch(/emitHostDashboard\(/);
    });
  });

  describe('host-actions.ts — every match transition emits dashboard', () => {
    it('handleHostRemoveFromRoom emits emitHostDashboard after match status change', () => {
      const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
      // Phase 3 (29 April 2026 spec) refactor: handleHostRemoveFromRoom now
      // calls demoteParticipantFromMatch instead of issuing the inline
      // UPDATE for terminal cases. For trio (3-person room with 1 removed),
      // the helper keeps the match active and the handler returns early.
      // For non-trio (terminal status), the helper UPDATEs and the original
      // emitHostDashboard cleanup-path runs. Both paths trigger
      // _emitHostDashboard; the test anchors on the function body.
      const fnStart = src.indexOf('export async function handleHostRemoveFromRoom');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/demoteParticipantFromMatch/);
      expect(fn).toMatch(/_emitHostDashboard\(data\.sessionId\)/);
    });

    it('handleHostMoveToRoom emits emitHostDashboard after UPDATE matches', () => {
      const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function handleHostMoveToRoom');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\n}', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Two UPDATE matches (current + target) — single emitHostDashboard at end
      expect(fn).toMatch(/_emitHostDashboard\(sessionId\)/);
    });

    it('handleHostCreateBreakout emits emitHostDashboard after UPDATE matches', () => {
      const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function handleHostCreateBreakout');
      expect(fnStart).toBeGreaterThan(-1);
      // Don't end at \n} since this fn has nested setTimeouts — bound to next export.
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      // Reassign UPDATE inside the loop + final emitHostDashboard at L1680
      expect(fn).toMatch(/UPDATE matches SET status = 'reassigned'/);
      expect(fn).toMatch(/_emitHostDashboard\(sessionId\)/);
    });

    it('handleHostExtendBreakoutRoom emits emitHostDashboard (Change 4.6)', () => {
      const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function handleHostExtendBreakoutRoom');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/_emitHostDashboard\(sessionId\)/);
    });

    it('per-room timer expiry callback emits emitHostDashboard', () => {
      const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
      // The fireCallback in handleHostCreateBreakout
      const cbIdx = src.indexOf('Host breakout room timer expired');
      expect(cbIdx).toBeGreaterThan(-1);
      const block = src.slice(cbIdx - 1000, cbIdx);
      expect(block).toMatch(/_emitHostDashboard\(sessionId\)/);
    });
  });

  describe('breakout-bulk.ts — every match transition emits dashboard (already shipped)', () => {
    it('bulk per-room timer expiry callback emits emitHostDashboard', () => {
      const src = readSource('../../../services/orchestration/handlers/breakout-bulk.ts');
      const cbIdx = src.indexOf('Bulk breakout room timer expired');
      expect(cbIdx).toBeGreaterThan(-1);
      const block = src.slice(cbIdx - 1500, cbIdx);
      expect(block).toMatch(/_emitHostDashboard\(sessionId\)/);
    });

    it('handleHostEndBreakoutAll emits emitHostDashboard once at end (not per-room)', () => {
      const src = readSource('../../../services/orchestration/handlers/breakout-bulk.ts');
      const fnStart = src.indexOf('export async function handleHostEndBreakoutAll');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      // Match the single emit at the end (after the for loop)
      const matches = fn.match(/_emitHostDashboard\(sessionId\)/g) || [];
      expect(matches.length).toBeGreaterThan(0);
      // One emit at end of fn — not inside the for-each-manual loop.
      // The for-loop body iterates m of manuals and the only emitHostDashboard
      // appears AFTER the closing brace of the for loop.
      const forIdx = fn.indexOf('for (const m of manuals)');
      const lastEmitIdx = fn.lastIndexOf('_emitHostDashboard');
      expect(lastEmitIdx).toBeGreaterThan(forIdx);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // LOBBY_OPEN dashboard interval — defensive safety net
  // ────────────────────────────────────────────────────────────────────────

  describe('LOBBY_OPEN dashboard interval — manual rooms refresh defensively', () => {
    it('host-actions exports ensureManualDashboardInterval helper', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/host-actions');
      expect(typeof mod.ensureManualDashboardInterval).toBe('function');
    });

    it('host-actions exports manualDashboardIntervals map for inspection', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/host-actions');
      expect(mod.manualDashboardIntervals).toBeInstanceOf(Map);
    });

    it('handleHostCreateBreakout calls ensureManualDashboardInterval after creating manual room', () => {
      const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function handleHostCreateBreakout');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/ensureManualDashboardInterval/);
    });

    it('handleHostCreateBreakoutBulk calls ensureManualDashboardInterval after creating manual rooms', () => {
      const src = readSource('../../../services/orchestration/handlers/breakout-bulk.ts');
      const fnStart = src.indexOf('export async function handleHostCreateBreakoutBulk');
      expect(fnStart).toBeGreaterThan(-1);
      const nextExport = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/ensureManualDashboardInterval/);
    });

    it('ensureManualDashboardInterval is idempotent — calling twice returns same interval', async () => {
      const { ensureManualDashboardInterval, manualDashboardIntervals } =
        await import('../../../services/orchestration/handlers/host-actions');
      // Cleanup any state from previous tests
      for (const [, h] of manualDashboardIntervals) clearInterval(h as NodeJS.Timeout);
      manualDashboardIntervals.clear();

      const io: any = { to: () => ({ emit: jest.fn() }) };
      ensureManualDashboardInterval(io as any, 'test-session-A');
      const handle1 = manualDashboardIntervals.get('test-session-A');
      ensureManualDashboardInterval(io as any, 'test-session-A');
      const handle2 = manualDashboardIntervals.get('test-session-A');
      expect(handle1).toBe(handle2);

      // Cleanup
      if (handle1) clearInterval(handle1 as NodeJS.Timeout);
      manualDashboardIntervals.clear();
    });

    it('ensureManualDashboardInterval is per-session — different sessions get different handles', async () => {
      const { ensureManualDashboardInterval, manualDashboardIntervals } =
        await import('../../../services/orchestration/handlers/host-actions');
      for (const [, h] of manualDashboardIntervals) clearInterval(h as NodeJS.Timeout);
      manualDashboardIntervals.clear();

      const io: any = { to: () => ({ emit: jest.fn() }) };
      ensureManualDashboardInterval(io as any, 'session-X');
      ensureManualDashboardInterval(io as any, 'session-Y');
      expect(manualDashboardIntervals.size).toBe(2);

      for (const [, h] of manualDashboardIntervals) clearInterval(h as NodeJS.Timeout);
      manualDashboardIntervals.clear();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Forward-compat — every UPDATE matches SET status site is accounted for
  // ────────────────────────────────────────────────────────────────────────

  describe('audit — every UPDATE matches SET status site is paired with a dashboard refresh', () => {
    // This test enumerates ALL files that have UPDATE matches SET status and
    // requires that the file ALSO contains a dashboard refresh mechanism
    // (either direct emitHostDashboard call OR delegates to one — e.g.
    // round-lifecycle.ts uses emitHostDashboard helper internally).
    const files = [
      'breakout-bulk.ts',
      'host-actions.ts',
      'matching-flow.ts', // pre-round preview cancel — no active matches yet, but emits via sendMatchPreview
      'participant-flow.ts',
      'round-lifecycle.ts',
    ];

    for (const file of files) {
      it(`${file} pairs every UPDATE matches SET status with a dashboard mechanism`, () => {
        const src = readSource(`../../../services/orchestration/handlers/${file}`);
        const updateCount = (src.match(/UPDATE matches SET status/g) || []).length;
        if (updateCount === 0) return; // no UPDATEs in this file
        // Either direct emit, helper call, or delegation to the preview re-send
        const hasDashboard = /emitHostDashboard|sendMatchPreview/.test(src);
        expect(hasDashboard).toBe(true);
      });
    }
  });
});
