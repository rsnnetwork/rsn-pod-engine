// T1-6 — Encounter history session-scoped query + crossEventMemory flag (Issue 11)
//
// Pre-fix: getEncounterHistoryForUsers pulled ALL encounters across ALL events.
// This means a pair who met in Event A would be penalised as "already met"
// in Event B even though they hadn't met in Event B yet. Plus when round 2
// matching ran in the same session, encounters from round 1 (just written
// to encounter_history) double-counted alongside the engine's `usedPairs` Set.
//
// Post-fix:
//   - Optional `sessionId` parameter — when provided, encounters whose
//     last_session_id matches it are filtered out (within-session uniqueness
//     stays in `usedPairs`, cross-event memory stays accurate)
//   - Optional `crossEventMemory` parameter — when false, returns empty
//     list (every pair treated as a first meeting). Pod owners can opt
//     out for repeat-attendance pods. Default true.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../services/matching/matching.service.ts'),
    'utf8',
  );
}

describe('T1-6 — getEncounterHistoryForUsers scope + flag', () => {
  const src = readSource();

  describe('signature widened to accept options', () => {
    it('signature is (userIds, options?: { sessionId?, crossEventMemory? })', () => {
      expect(src).toMatch(/async function getEncounterHistoryForUsers\(\s*userIds:\s*string\[\],\s*options:\s*\{\s*sessionId\?:\s*string;\s*crossEventMemory\?:\s*boolean\s*\}\s*=\s*\{\}/);
    });
  });

  describe('crossEventMemory=false short-circuits to empty', () => {
    it('returns [] without querying when flag is false', () => {
      expect(src).toMatch(/options\.crossEventMemory\s*===\s*false/);
      expect(src).toMatch(/return \[\]/);
    });
  });

  describe('sessionId scoping', () => {
    it('appends "AND last_session_id != $N" to the WHERE clause when sessionId is set', () => {
      const fnStart = src.indexOf('async function getEncounterHistoryForUsers');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/last_session_id IS NULL OR last_session_id != \$2/);
    });

    it('omits the extra clause when sessionId is not provided (back-compat)', () => {
      const fnStart = src.indexOf('async function getEncounterHistoryForUsers');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/let extraWhere = ['"]['"]/);
      expect(fn).toMatch(/if \(options\.sessionId\)/);
    });
  });

  describe('callers pass sessionId + crossEventMemory', () => {
    it('generateSessionSchedule passes options', () => {
      const fnStart = src.indexOf('export async function generateSessionSchedule');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/getEncounterHistoryForUsers\(userIds,\s*\{\s*sessionId,\s*crossEventMemory,?\s*\}\)/);
      expect(fn).toMatch(/sessionConfig\.crossEventMemory\s*!==\s*false/);
    });

    it('generateSingleRound passes options', () => {
      const fnStart = src.indexOf('export async function generateSingleRound');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/getEncounterHistoryForUsers\(userIds,\s*\{\s*sessionId,\s*crossEventMemory,?\s*\}\)/);
      expect(fn).toMatch(/sessionConfig\.crossEventMemory\s*!==\s*false/);
    });
  });

  describe('default behavior preserved (no options = old behavior)', () => {
    it('default crossEventMemory undefined → not strictly false → uses cross-event memory', () => {
      // The check is `!== false` so undefined is treated as ENABLED — preserves
      // existing behavior for any caller that doesn't pass the option.
      const fnStart = src.indexOf('async function getEncounterHistoryForUsers');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/crossEventMemory\s*===\s*false/);
    });
  });
});
