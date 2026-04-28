// Tier-1 A1 — emitHostDashboard coalesce + display-name cache
//
// Scaling fix for 100–200 concurrent users. The dashboard emit is the hottest
// fan-out path (every match transition + 5s interval during ROUND_ACTIVE + 5s
// interval during LOBBY_OPEN when manual rooms are live). Two optimisations:
//
//   1. Coalesce repeated calls within a 1-second window to one leading emit
//      plus one trailing emit (same pattern as lodash throttle with leading
//      + trailing edges).
//   2. Cache display names per-session on ActiveSession.displayNameCache.
//      Names don't change during an event, so subsequent emits skip the
//      `SELECT ... FROM users WHERE id = ANY(...)` round-trip.
//
// Cleanup is wired into completeSession (round-lifecycle.ts) and the 4-hour
// TTL sweeper (orchestration.service.ts).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, relPath), 'utf8');
}

describe('Tier-1 A1 — dashboard coalesce + name cache', () => {
  describe('ActiveSession interface carries the cache field', () => {
    it('session-state.ts declares displayNameCache on ActiveSession', () => {
      const src = readSource('../../../services/orchestration/state/session-state.ts');
      expect(src).toMatch(/displayNameCache\?:\s*Map<string,\s*string>/);
    });
  });

  describe('matching-flow.ts wraps emitHostDashboard with 1-second coalesce', () => {
    const src = readSource('../../../services/orchestration/handlers/matching-flow.ts');

    it('declares DASHBOARD_COALESCE_MS = 1000', () => {
      expect(src).toMatch(/DASHBOARD_COALESCE_MS\s*=\s*1000/);
    });

    it('maintains a per-session dashboard emit state map', () => {
      expect(src).toMatch(/dashboardEmitState\s*=\s*new Map<string,\s*DashboardEmitState>/);
    });

    it('exports clearDashboardCoalesce for session cleanup', () => {
      expect(src).toMatch(/export function clearDashboardCoalesce\(sessionId:\s*string\)/);
    });

    it('emitHostDashboard delegates to emitHostDashboardImmediate (inner worker)', () => {
      // The public export remains emitHostDashboard with identical signature
      expect(src).toMatch(/export async function emitHostDashboard\(io:\s*SocketServer,\s*sessionId:\s*string\):\s*Promise<void>/);
      // The actual work moved to an internal function
      expect(src).toMatch(/async function emitHostDashboardImmediate\(io:\s*SocketServer,\s*sessionId:\s*string\):\s*Promise<void>/);
    });

    it('leading-edge emit fires immediately when outside the coalesce window', () => {
      // Look for the "elapsed >= DASHBOARD_COALESCE_MS" branch that calls
      // emitHostDashboardImmediate without delay.
      const fnStart = src.indexOf('export async function emitHostDashboard(');
      const fnEnd = src.indexOf('async function emitHostDashboardImmediate(');
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/elapsed\s*>=\s*DASHBOARD_COALESCE_MS/);
      expect(fn).toMatch(/return emitHostDashboardImmediate/);
    });

    it('trailing-edge emit is scheduled via setTimeout when within the window', () => {
      const fnStart = src.indexOf('export async function emitHostDashboard(');
      const fnEnd = src.indexOf('async function emitHostDashboardImmediate(');
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/setTimeout\([\s\S]*?emitHostDashboardImmediate/);
      // Must dedupe — if pendingTimer already set, don't queue another
      expect(fn).toMatch(/if\s*\(\s*!state\.pendingTimer\s*\)/);
    });
  });

  describe('emitHostDashboardImmediate uses ActiveSession.displayNameCache', () => {
    const src = readSource('../../../services/orchestration/handlers/matching-flow.ts');
    const fnStart = src.indexOf('async function emitHostDashboardImmediate(');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('reads from activeSession.displayNameCache', () => {
      expect(fn).toMatch(/activeSession\.displayNameCache/);
    });

    it('only queries DB for ids missing from the cache', () => {
      // The handler collects missing ids into an array and queries only them
      expect(fn).toMatch(/missingIds/);
      // Query shape uses ANY($1) with the missing-ids array
      expect(fn).toMatch(/SELECT id,\s*display_name[\s\S]*?ANY\(\$1\)/);
    });

    it('negative-caches unknown ids to avoid repeated lookups', () => {
      // If the DB didn't return a row for a user we still insert a label so
      // the next emit doesn't re-query that id. Phase 1 (29 April 2026)
      // changed the negative-cache value from the literal "User" — which
      // produced "User × User" / "Not matched: User, User" in the host UI
      // when several users had missing names — to a userId-derived label
      // that's distinguishable per person.
      expect(fn).toMatch(/if\s*\(!cache\.has\(uid\)\)\s*cache\.set\(uid,\s*`Participant \$\{uid\.slice\(0,\s*6\)\}`\)/);
    });

    it('positive-cache uses email-prefix fallback when display_name is missing', () => {
      // The query selects email alongside displayName so the fallback chain
      // can produce a useful label (displayName → email-prefix → short userId)
      // instead of collapsing every nameless user to the literal "User".
      expect(fn).toMatch(/SELECT id,\s*display_name[^,]*,\s*email/);
      expect(fn).toMatch(/fallbackNameFor/);
    });
  });

  describe('coalesce state is cleaned up when a session ends', () => {
    it('round-lifecycle.completeSession calls clearDashboardCoalesce in finally block', () => {
      const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
      const fnStart = src.indexOf('export async function completeSession(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/clearDashboardCoalesce\(sessionId\)/);
      // Must be in the finally block, after activeSessions.delete
      const deleteIdx = fn.indexOf('activeSessions.delete(sessionId)');
      const clearIdx = fn.indexOf('clearDashboardCoalesce(sessionId)');
      expect(clearIdx).toBeGreaterThan(deleteIdx);
    });

    it('orchestration.service TTL sweeper clears coalesce state on stale-session eviction', () => {
      const src = readSource('../../../services/orchestration/orchestration.service.ts');
      expect(src).toMatch(/TTL exceeded[\s\S]*?clearDashboardCoalesce\(sessionId\)/);
    });
  });
});
