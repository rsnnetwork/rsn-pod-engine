// Tier-1 A2 — batch incrementRoundsCompleted in endRound
//
// Before: endRound issued 3 × N sequential `UPDATE session_participants
// SET rounds_completed = rounds_completed + 1 WHERE user_id = $2` calls
// (one per participant per match). 100 matches = 300 round-trips = 1.5–4.5 s
// wall time on Neon pooler, during which rating:window_open was already
// ticking on the client.
//
// After: one UPDATE joined against a VALUES subquery bumps every
// participant's counter by their exact pre-batch count. Same net effect,
// one server round-trip.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, relPath), 'utf8');
}

describe('Tier-1 A2 — batch incrementRoundsCompleted', () => {
  describe('session.service exposes the batch function', () => {
    const src = readSource('../../../services/session/session.service.ts');

    it('exports incrementRoundsCompletedBatch with Map signature', () => {
      expect(src).toMatch(/export async function incrementRoundsCompletedBatch\([\s\S]*?userCounts:\s*Map<string,\s*number>/);
    });

    it('uses a single UPDATE with VALUES clause (one query for N users)', () => {
      const fnStart = src.indexOf('export async function incrementRoundsCompletedBatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/UPDATE session_participants sp/);
      expect(fn).toMatch(/FROM \(VALUES \$\{valuePlaceholders\.join/);
      expect(fn).toMatch(/sp\.rounds_completed \+ v\.cnt/);
    });

    it('short-circuits on empty input', () => {
      const fnStart = src.indexOf('export async function incrementRoundsCompletedBatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/userCounts\.size === 0/);
    });

    it('preserves the original single-user function for backward compatibility', () => {
      // Callers outside endRound still use the simple form (e.g. manual
      // round-end paths or tests). Don't delete it.
      expect(src).toMatch(/export async function incrementRoundsCompleted\(sessionId:\s*string,\s*userId:\s*string\)/);
    });
  });

  describe('round-lifecycle.endRound uses the batch call, not per-match awaits', () => {
    const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
    const fnStart = src.indexOf('export async function endRound(');
    const fnEnd = src.indexOf('\nexport async function', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd);

    it('calls incrementRoundsCompletedBatch exactly once', () => {
      const matches = (fn.match(/incrementRoundsCompletedBatch/g) || []).length;
      expect(matches).toBe(1);
    });

    it('no longer calls incrementRoundsCompleted (singular) inside endRound', () => {
      // The old per-match sequential awaits are gone. Matches on the word
      // incrementRoundsCompleted that are NOT followed by "Batch" are bugs.
      const singular = fn.match(/incrementRoundsCompleted(?!Batch)/g) || [];
      expect(singular.length).toBe(0);
    });

    it('builds a Map<userId, count> from all matches including participantC', () => {
      expect(fn).toMatch(/roundUserCounts/);
      expect(fn).toMatch(/participantAId,\s*match\.participantBId,\s*match\.participantCId/);
    });
  });
});
