// T0-1 wiring — verify the validator is called from every match-write handler
//
// Source-pattern tests pin that each of the four handlers imports and uses
// `validateMatchAssignment` before any INSERT/UPDATE on `matches`. This
// catches accidental removals during future refactors.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../services/orchestration/handlers', relPath),
    'utf8',
  );
}

describe('T0-1 wiring — validator called from every match-write handler', () => {
  describe('host-actions.ts handleHostCreateBreakout', () => {
    const src = readSource('host-actions.ts');

    it('imports validateMatchAssignment from match-validator.service', () => {
      expect(src).toMatch(/import \{ validateMatchAssignment \} from '\.\.\/\.\.\/matching\/match-validator\.service'/);
    });

    it('calls validateMatchAssignment inside handleHostCreateBreakout BEFORE the transaction', () => {
      // Phase 4A (5 May spec) refactored the function — reassign + insert
      // now run inside transaction(). The validator pin asserts validation
      // happens BEFORE the transaction begins (and before LiveKit room create).
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      const validatorIdx = fn.indexOf('validateMatchAssignment(');
      const transactionIdx = fn.indexOf('await transaction(async (client)');
      expect(validatorIdx).toBeGreaterThan(-1);
      expect(transactionIdx).toBeGreaterThan(-1);
      expect(validatorIdx).toBeLessThan(transactionIdx);
    });

    it('skips conflict check at this site (Phase 4A transaction reassigns existing matches)', () => {
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const transactionIdx = src.indexOf('await transaction(async (client)', fnStart);
      const block = src.slice(fnStart, transactionIdx);
      expect(block).toMatch(/skipConflictCheck:\s*true/);
    });

    it('emits INVALID_MATCH_ASSIGNMENT on validation failure', () => {
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/code:\s*'INVALID_MATCH_ASSIGNMENT'/);
    });
  });

  describe('breakout-bulk.ts handleHostCreateBreakoutBulk', () => {
    const src = readSource('breakout-bulk.ts');

    it('imports validateMatchAssignment', () => {
      expect(src).toMatch(/import \{ validateMatchAssignment \} from '\.\.\/\.\.\/matching\/match-validator\.service'/);
    });

    it('calls validator inside the per-room loop, BEFORE INSERT INTO matches', () => {
      // Find the per-room INSERT
      const insertIdx = src.indexOf("INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, timer_visibility, is_manual)");
      const validatorIdx = src.lastIndexOf('validateMatchAssignment(', insertIdx);
      expect(insertIdx).toBeGreaterThan(-1);
      expect(validatorIdx).toBeGreaterThan(-1);
      expect(validatorIdx).toBeLessThan(insertIdx);
    });

    it('skips conflict check (per-room reassign loop above clears conflicts)', () => {
      // The validator call here should pass skipConflictCheck: true
      const insertIdx = src.indexOf("INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, timer_visibility, is_manual)");
      const validatorIdx = src.lastIndexOf('validateMatchAssignment(', insertIdx);
      const block = src.slice(validatorIdx, insertIdx);
      expect(block).toMatch(/skipConflictCheck:\s*true/);
    });
  });

  describe('matching-flow.ts handleHostSwapMatch', () => {
    const src = readSource('matching-flow.ts');

    it('imports validateMatchAssignment', () => {
      expect(src).toMatch(/import \{ validateMatchAssignment \} from '\.\.\/\.\.\/matching\/match-validator\.service'/);
    });

    it('validates BOTH resulting matches (newA + newB) before UPDATE', () => {
      const fnStart = src.indexOf('export async function handleHostSwapMatch(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Should reference matchA and matchB inside the validation loop
      expect(fn).toMatch(/validateMatchAssignment/);
      expect(fn).toMatch(/excludeMatchId:\s*check\.matchId/);
      expect(fn).toMatch(/conflictingStatuses:\s*\[['"]scheduled['"]\s*,\s*['"]active['"]\]/);
    });

    it('returns early on validation failure with INVALID_MATCH_ASSIGNMENT', () => {
      const fnStart = src.indexOf('export async function handleHostSwapMatch(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/code:\s*'INVALID_MATCH_ASSIGNMENT'/);
    });
  });

  describe('matching-flow.ts handleHostExcludeFromRound', () => {
    const src = readSource('matching-flow.ts');

    it('validates the resulting pair after trio→pair shrink', () => {
      const fnStart = src.indexOf('export async function handleHostExcludeFromRound(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Both trio branches (C-excluded and A-or-B-excluded) call validator
      const validationCount = (fn.match(/validateMatchAssignment\(/g) || []).length;
      expect(validationCount).toBeGreaterThanOrEqual(2);
    });

    it('does NOT validate the pair-DELETE branch (DELETE is always safe)', () => {
      const fnStart = src.indexOf('export async function handleHostExcludeFromRound(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Find the DELETE branch
      const deleteIdx = fn.indexOf('DELETE FROM matches WHERE id = $1');
      expect(deleteIdx).toBeGreaterThan(-1);
      // Look at the immediate neighborhood of the DELETE — no validator call
      const around = fn.slice(Math.max(0, deleteIdx - 200), deleteIdx);
      expect(around).not.toMatch(/validateMatchAssignment\(/);
    });
  });
});
