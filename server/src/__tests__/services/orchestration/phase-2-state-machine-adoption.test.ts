// ─── Phase 2 — State Machine Adoption (5 May 2026 spec) ─────────────────────
//
// Pins the architectural fact that every participant-state mutation routes
// through the chokepoint (`transitionParticipant`) when the session is live.
//
// Sub-phase 2A: identity.service.ts (deleteUser) and session.service.ts
// (registerParticipant re-register path) sync the in-memory state machine
// after their DB writes. Direct DB writes are kept for atomicity / bulk
// efficiency, but the chokepoint is called with persistToDb:false so reads
// observe the same state without waiting for the reconciler.
//
// Subsequent sub-phases (2B participant-flow, 2C round-lifecycle, 2D rooms,
// 2E reconciler, 2F CI grep guard) extend this file.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase 2 — State machine adoption', () => {
  describe('Sub-phase 2A — identity.service.ts deleteUser syncs the chokepoint', () => {
    const src = readServer('services/identity/identity.service.ts');

    it('captures live sessions BEFORE the bulk DB update', () => {
      const fnStart = src.indexOf('export async function deleteUser(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // The pre-update SELECT must appear before the bulk UPDATE.
      const selectIdx = fn.indexOf("SELECT session_id FROM session_participants");
      const updateIdx = fn.indexOf("UPDATE session_participants SET status = 'removed'");
      expect(selectIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(selectIdx).toBeLessThan(updateIdx);
    });

    it('calls transitionParticipant with REMOVED state and persistToDb:false', () => {
      const fnStart = src.indexOf('export async function deleteUser(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/transitionParticipant\([\s\S]*?ParticipantState\.REMOVED[\s\S]*?persistToDb:\s*false/);
    });

    it('only fires the chokepoint for sessions currently in activeSessions', () => {
      const fnStart = src.indexOf('export async function deleteUser(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/activeSessions\.has\(/);
    });
  });

  describe('Sub-phase 2A — session.service.ts registerParticipant syncs the chokepoint', () => {
    const src = readServer('services/session/session.service.ts');

    it('calls transitionParticipant with REGISTERED state after the transaction commits', () => {
      const fnStart = src.indexOf('export async function registerParticipant(');
      const fnEnd = src.indexOf('\n}\n\nexport async function unregisterParticipant', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/transitionParticipant\([\s\S]*?ParticipantState\.REGISTERED[\s\S]*?persistToDb:\s*false/);
    });

    it('only fires the chokepoint when the session is live', () => {
      const fnStart = src.indexOf('export async function registerParticipant(');
      const fnEnd = src.indexOf('\n}\n\nexport async function unregisterParticipant', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/activeSessions\.has\(sessionId\)/);
    });

    it('keeps the in-transaction direct UPDATE for atomicity (re-register path)', () => {
      // The re-register UPDATE inside the transaction is preserved; we only
      // ADD a post-transaction in-memory sync. The pin guards against
      // accidental removal of the in-tx UPDATE which would break atomicity.
      expect(src).toMatch(
        /UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE/,
      );
    });
  });

  describe('Sub-phase 2B — participant-flow.ts uses chokepoint helpers', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');

    it('imports transitionParticipant + setPresence from the state module', () => {
      expect(src).toMatch(/from\s+['"]\.\.\/state\/participant-state-machine['"]/);
      expect(src).toMatch(/transitionParticipant/);
      expect(src).toMatch(/setPresence/);
    });

    it('Fix A reset path goes through transitionParticipant', () => {
      const fnStart = src.indexOf('// ── FIX A:');
      const fnEnd = src.indexOf('// Notify others — include isHost flag', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/transitionParticipant\([\s\S]*?ParticipantState\.IN_MAIN_ROOM/);
      // The pre-fix raw UPDATE is gone.
      expect(fn).not.toMatch(/UPDATE session_participants SET status = 'in_lobby'/);
    });

    it('zero direct presenceMap.set/.delete calls remain in this file', () => {
      // Only the helper definition itself in the state module mutates
      // presenceMap; this file consumes the wrapper.
      const matches = src.match(/presenceMap\.(set|delete)\b/g) || [];
      expect(matches).toHaveLength(0);
    });
  });

  describe('Sub-phase 2C — round-lifecycle.ts uses chokepoint helpers', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');

    it('imports transitionParticipant from the state module', () => {
      expect(src).toMatch(/transitionParticipant/);
      expect(src).toMatch(/ParticipantState/);
    });

    it('round-end loops transition each user to IN_MAIN_ROOM via the chokepoint', () => {
      expect(src).toMatch(
        /for\s*\(\s*const\s+userId\s+of\s+roundUserCounts\.keys\(\)[\s\S]*?transitionParticipant\([\s\S]*?ParticipantState\.IN_MAIN_ROOM/,
      );
    });

    it('redundant is_no_show=TRUE bulk + single UPDATEs were removed', () => {
      expect(src).not.toMatch(/UPDATE session_participants SET is_no_show = TRUE/);
    });

    it('zero direct UPDATE session_participants SET (status|is_no_show) writes remain', () => {
      const matches = src.match(/UPDATE session_participants SET\s+(status|is_no_show)/g) || [];
      expect(matches).toHaveLength(0);
    });
  });

  describe('Sub-phase 2D — roomParticipants mutations centralised', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');

    it('handleRoomJoined uses setRoomAssignment instead of mutating directly', () => {
      // Bound the slice to the function's own body — the next `export` keyword
      // marks the start of the setRoomAssignment helper that legitimately
      // contains a roomParticipants.set inside its OWN definition.
      const fnStart = src.indexOf('export async function handleRoomJoined(');
      const nextExport = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/setRoomAssignment\(/);
      expect(fn).not.toMatch(/activeSession\.roomParticipants\.set\(/);
    });

    it('handleDisconnect uses clearRoomParticipant', () => {
      // The disconnect loop body should call clearRoomParticipant, not
      // mutate roomParticipants directly with a ?.delete() chain.
      expect(src).not.toMatch(/activeSession\.roomParticipants\?\.delete\(/);
      expect(src).toMatch(/clearRoomParticipant\(sessionId, userId\)/);
    });
  });

  describe('Sub-phase 2E — periodic state reconciler', () => {
    const src = readServer('services/orchestration/state/participant-state-machine.ts');

    it('exports reconcileSessionStates', () => {
      expect(src).toMatch(/export async function reconcileSessionStates\(/);
    });

    it('exports startGlobalReconciler + stopGlobalReconciler', () => {
      expect(src).toMatch(/export function startGlobalReconciler\(/);
      expect(src).toMatch(/export function stopGlobalReconciler\(/);
    });

    it('reconciler converges DB to in-memory authoritative state (memory wins)', () => {
      const fnStart = src.indexOf('export async function reconcileSessionStates(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/UPDATE session_participants SET status = \$1/);
      expect(fn).toMatch(/drift detected/);
    });

    it('runs on a 30-second interval', () => {
      expect(src).toMatch(/RECONCILER_INTERVAL_MS\s*=\s*30_000/);
    });

    it('orchestration.service.ts wires startGlobalReconciler at boot', () => {
      const orch = readServer('services/orchestration/orchestration.service.ts');
      expect(orch).toMatch(/startGlobalReconciler\(\)/);
    });
  });

  describe('Sub-phase 2F — CI grep guard', () => {
    // Whole-tree pin: no NEW direct UPDATE session_participants SET (status|is_no_show)
    // in any file outside the state module + tests + the legitimate fallback in
    // session.service.ts (updateParticipantStatus has a documented fallback when
    // the session isn't live; identity.service.ts and session.service.ts:registerParticipant
    // keep an in-transaction direct write for atomicity, paired with a chokepoint
    // sync afterwards). This test asserts that any future commit adding a new
    // bypass MUST include an explicit allow-list comment, not silently slip in.

    const ALLOWLIST_FILES = [
      // The state module IS the chokepoint — the only legal site for the SQL.
      'services/orchestration/state/participant-state-machine.ts',
      // Bulk DB write in deleteUser is intentional: covers ended sessions
      // efficiently. Live sessions get an in-memory sync via transitionParticipant
      // after the bulk write (Sub-phase 2A).
      'services/identity/identity.service.ts',
      // updateParticipantStatus has a documented fallback when session is not
      // active; registerParticipant has an in-transaction direct UPDATE for
      // atomicity (paired with post-tx chokepoint sync). Phase 2A pinned both.
      'services/session/session.service.ts',
    ];

    function listTsFiles(dir: string, acc: string[] = []): string[] {
      const entries = nodeFs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = nodePath.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__') continue;
          listTsFiles(full, acc);
        } else if (e.isFile() && e.name.endsWith('.ts')) {
          acc.push(full);
        }
      }
      return acc;
    }

    it('zero direct UPDATE session_participants SET status writes outside the allow-list', () => {
      const root = nodePath.join(__dirname, '../../../services');
      const files = listTsFiles(root);
      const offenders: string[] = [];
      for (const f of files) {
        const rel = nodePath.relative(nodePath.join(__dirname, '../../../'), f).replace(/\\/g, '/');
        if (ALLOWLIST_FILES.includes(rel)) continue;
        const text = nodeFs.readFileSync(f, 'utf8');
        if (/UPDATE session_participants SET\s+(status|is_no_show)/.test(text)) {
          offenders.push(rel);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('zero direct presenceMap.set/.delete outside the state module + the wrapper', () => {
      const root = nodePath.join(__dirname, '../../../services');
      const files = listTsFiles(root);
      const offenders: string[] = [];
      for (const f of files) {
        const rel = nodePath.relative(nodePath.join(__dirname, '../../../'), f).replace(/\\/g, '/');
        if (rel === 'services/orchestration/state/participant-state-machine.ts') continue;
        const text = nodeFs.readFileSync(f, 'utf8');
        if (/presenceMap\.(set|delete)\b/.test(text)) {
          offenders.push(rel);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
