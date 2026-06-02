// Bug 25 (18 May Ali) — cancelled match previews must survive in the DB
// as an audit trail. Pre-fix `handleHostCancelPreview` ran a HARD DELETE
// on `status IN ('scheduled', 'cancelled')`, so when the host clicked
// "Cancel preview" the engine's proposed pairs for that round were
// destroyed and could not be debugged later. Stefan's 18 May test event
// (b4d3478c) had a round 4 preview with "met 1x" badges, host cancelled,
// and zero forensic data remained to answer "what did the engine actually
// propose for round 4?".
//
// Fix: cancel-preview switches to soft-delete (UPDATE status='cancelled',
// ended_at=NOW() WHERE status='scheduled'). Migration 060 widens the
// unique pair-per-round index from migration 057 to exclude
// cancelled+no_show so a future regenerate of the same round can re-INSERT
// the same pair without a uniqueness collision. The two other DELETE
// sites in matching-flow.ts that previously also wiped cancelled rows
// ('scheduled', 'cancelled' clean-up before legacy regenerate, and the
// no-eligible-pairs cleanup) narrow to scheduled-only so the audit row
// from a prior cancel survives subsequent attempts on the same round.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readMigration(name: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../db/migrations', name),
    'utf8',
  );
}

describe('Bug 25 — preview audit trail (soft-delete on cancel)', () => {
  const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');
  const mig060 = readMigration('060_cancelled_excluded_from_unique_pair.sql');

  describe('handleHostCancelPreview soft-deletes instead of wiping', () => {
    const fnStart = flowSrc.indexOf('export async function handleHostCancelPreview(');
    const fnEnd = flowSrc.indexOf('\n// ─── Host Confirm Matches', fnStart);
    const fn = flowSrc.slice(fnStart, fnEnd);

    it('runs an UPDATE that flips scheduled rows to cancelled with ended_at', () => {
      expect(fn).toMatch(
        /UPDATE\s+matches[\s\S]*?SET\s+status\s*=\s*'cancelled'[\s\S]*?ended_at\s*=\s*NOW\(\)/,
      );
      expect(fn).toMatch(
        /WHERE\s+session_id\s*=\s*\$1\s+AND\s+round_number\s*=\s*\$2\s+AND\s+status\s*=\s*'scheduled'/,
      );
    });

    it('does NOT hard-DELETE the round on cancel (audit must survive)', () => {
      expect(fn).not.toMatch(/DELETE\s+FROM\s+matches/);
    });
  });

  describe('legacy regenerate paths preserve cancelled audit rows', () => {
    it('handleHostGenerateMatches legacy DELETE targets scheduled only', () => {
      const fnStart = flowSrc.indexOf('export async function handleHostGenerateMatches(');
      const fnEnd = flowSrc.indexOf('\n// ─── Host Confirm Round', fnStart);
      const fn = flowSrc.slice(fnStart, fnEnd);
      // After the Phase K stale-plan check, the legacy on-the-fly path
      // clears prior 'scheduled' rows. Pre-fix this also cleared
      // 'cancelled' rows, which destroyed audit history from earlier
      // cancel-preview clicks on the same round.
      const legacyDelete = fn.match(
        /Legacy path[\s\S]*?await query\(\s*`([^`]+)`/,
      );
      expect(legacyDelete).not.toBeNull();
      const sql = legacyDelete![1];
      expect(sql).toMatch(/DELETE FROM matches/);
      expect(sql).toMatch(/status\s*=\s*'scheduled'/);
      expect(sql).not.toMatch(/'cancelled'/);
    });

    it('no-eligible-pairs cleanup targets scheduled only', () => {
      // When generateSingleRound returns zero matches the handler
      // cleans up the (empty) round so the next attempt starts fresh.
      // Same rule: keep any audit rows from prior cancels intact.
      const noEligibleIdx = flowSrc.indexOf('NO_ELIGIBLE_PAIRS');
      expect(noEligibleIdx).toBeGreaterThan(-1);
      const window = flowSrc.slice(noEligibleIdx - 600, noEligibleIdx);
      expect(window).toMatch(/DELETE FROM matches[\s\S]*?status\s*=\s*'scheduled'/);
      expect(window).not.toMatch(/DELETE FROM matches[\s\S]*?'cancelled'/);
    });
  });

  describe('migration 060 — unique pair index excludes cancelled+no_show', () => {
    it('drops and recreates idx_matches_unique_pair_per_round', () => {
      expect(mig060).toMatch(/DROP INDEX IF EXISTS idx_matches_unique_pair_per_round/);
      expect(mig060).toMatch(/CREATE UNIQUE INDEX idx_matches_unique_pair_per_round/);
    });

    it('predicate excludes cancelled and no_show', () => {
      expect(mig060).toMatch(
        /status\s+NOT\s+IN\s*\(\s*'cancelled'\s*,\s*'no_show'\s*\)/,
      );
    });

    it('keeps the LEAST/GREATEST unordered-pair shape from migration 057', () => {
      expect(mig060).toMatch(/LEAST\(participant_a_id, participant_b_id\)/);
      expect(mig060).toMatch(/GREATEST\(participant_a_id, participant_b_id\)/);
    });

    it('stays scoped to 2-person matches (mirrors 057)', () => {
      expect(mig060).toMatch(
        /participant_b_id IS NOT NULL[\s\S]*?participant_c_id IS NULL/,
      );
    });
  });
});
