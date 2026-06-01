// Phase 2 — Platform-spec spec, 29 April 2026.
//
// Bug reported by Stefan during the 28 April test event: with 7 participants
// and 3 algorithm-generated pairs in preview, host used Manual Match Edit
// (handleHostForceMatch) to add a new pair using participants who were
// ALREADY in two of the existing scheduled pairs. Pre-fix, the handler
// silently cancelled both existing pairs and created the new one, leaving
// the other 4 participants reshuffled with no warning. The host was confused
// about which pairings were live and the round started with broken state.
//
// User's required fix:
//   "the system explicitly must stops hosts and tells that why host can do
//    this action because one person cannot be in two rooms ... what the
//    host can do is like host can swap people"
//
// These tests pin the new behavior:
//   1. handleHostForceMatch calls validateMatchAssignment before any DB write
//   2. The validator is called with conflictingStatuses ['scheduled', 'active']
//      (catches preview-pair conflicts) AND sessionWideActiveCheck (catches
//      manual-breakout conflicts in any round number)
//   3. On conflict, handler emits a structured error with the conflicting
//      user's display name resolved (via the same email-prefix fallback
//      chain as Phase 1) — host sees "Alice and Bob are already in another
//      room. Use Swap to move them between pairs..."
//   4. The original silent cancel-and-recreate behavior is GONE — no
//      `UPDATE matches SET status = 'cancelled' WHERE id = ANY(...)` in the
//      handler body.
//   5. The validator's new sessionWideActiveCheck option queries across all
//      rounds for active matches — pinned to enforce the "one user one room
//      at any moment" invariant.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase 2 — handleHostForceMatch hard-block + sessionWideActiveCheck', () => {
  describe('handleHostForceMatch validates BEFORE writing', () => {
    const src = readSource('services/orchestration/handlers/matching-flow.ts');
    const fnStart = src.indexOf('export async function handleHostForceMatch');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('calls validateMatchAssignment with conflictingStatuses ["scheduled","active"]', () => {
      expect(fn).toMatch(/validateMatchAssignment\s*\(\s*\{[\s\S]+?conflictingStatuses:\s*\[\s*['"]scheduled['"]\s*,\s*['"]active['"]\s*\]/);
    });

    it('passes sessionWideActiveCheck: true so manual breakouts in other rounds are caught', () => {
      expect(fn).toMatch(/sessionWideActiveCheck:\s*true/);
    });

    it('emits PARTICIPANT_ALREADY_MATCHED on conflict with structured payload', () => {
      expect(fn).toMatch(/code:\s*['"]PARTICIPANT_ALREADY_MATCHED['"]/);
      // The error includes the conflicting user IDs so the client UI can
      // highlight them — not just a vague "conflict" message.
      expect(fn).toMatch(/conflictingUserIds:\s*validation\.conflictingUserIds/);
    });

    it('returns BEFORE the INSERT when validation fails (no silent recreate)', () => {
      const validationStart = fn.indexOf('const validation = await validateMatchAssignment');
      const insertStart = fn.indexOf('INSERT INTO matches');
      expect(validationStart).toBeGreaterThan(-1);
      expect(insertStart).toBeGreaterThan(validationStart);
      const between = fn.slice(validationStart, insertStart);
      // The conflict branch must `return` before reaching the INSERT
      expect(between).toMatch(/if\s*\(!validation\.valid\)/);
      expect(between).toMatch(/return;/);
    });

    it('the silent cancel-and-recreate of pre-fix behavior is removed', () => {
      // Pre-fix the handler executed:
      //   UPDATE matches SET status = 'cancelled' WHERE id = ANY($1)
      // Post-fix this is gone — the validator hard-blocks instead.
      expect(fn).not.toMatch(/UPDATE matches SET status = 'cancelled'/);
    });

    it('error message tells the host to use Swap (per user spec)', () => {
      expect(fn).toMatch(/Use Swap/);
    });

    it('uses email-prefix fallback for the conflict-user display names', () => {
      // Same fallback chain as Phase 1's matching-flow nameMap — so the
      // error message never says "Alice and User are already in another room".
      expect(fn).toMatch(/conflictName/);
      expect(fn).toMatch(/email/);
    });
  });

  describe('match-validator.service supports sessionWideActiveCheck', () => {
    const src = readSource('services/matching/match-validator.service.ts');

    it('declares sessionWideActiveCheck on MatchValidationInput', () => {
      expect(src).toMatch(/sessionWideActiveCheck\??:\s*boolean/);
    });

    it('queries across ALL rounds for active matches when the flag is on', () => {
      // The session-wide query has NO `round_number = $2` clause —
      // that's the difference from the per-round check.
      const fnStart = src.indexOf('export async function validateMatchAssignment');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const sessionWideStart = fn.indexOf('sessionWideQuery');
      expect(sessionWideStart).toBeGreaterThan(-1);
      // Find the SQL string that follows
      const queryStart = fn.indexOf('`', sessionWideStart);
      const queryEnd = fn.indexOf('`', queryStart + 1);
      const sql = fn.slice(queryStart, queryEnd);
      expect(sql).toMatch(/m\.session_id\s*=\s*\$1/);
      expect(sql).toMatch(/m\.status\s*=\s*'active'/);
      // Critically: the session-wide query does NOT filter by round_number.
      expect(sql).not.toMatch(/round_number\s*=/);
    });

    it('avoids duplicate conflictingUserIds when both per-round and session-wide flag the same user', () => {
      // The session-wide branch checks alreadyFlagged before pushing.
      const fnStart = src.indexOf('export async function validateMatchAssignment');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const sessionWideStart = fn.indexOf('sessionWideActiveCheck');
      const sessionWideBody = fn.slice(sessionWideStart);
      expect(sessionWideBody).toMatch(/alreadyFlagged/);
    });

    it('does not break existing per-round-only callers (default sessionWideActiveCheck=false)', () => {
      // The flag defaults to false in the destructured input, so the
      // existing swap/exclude callers (which don't pass the flag) keep
      // their old behavior.
      const fnStart = src.indexOf('export async function validateMatchAssignment');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/sessionWideActiveCheck\s*=\s*false/);
    });
  });

  describe('per-round swap and exclude paths still work (no regression)', () => {
    const src = readSource('services/orchestration/handlers/matching-flow.ts');

    it('handleHostSwapMatch still uses validator with conflictingStatuses', () => {
      const fnStart = src.indexOf('export async function handleHostSwapMatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/validateMatchAssignment/);
      expect(fn).toMatch(/conflictingStatuses:\s*\[\s*['"]scheduled['"]\s*,\s*['"]active['"]\s*\]/);
    });

    it('handleHostExcludeFromRound still uses validator with conflictingStatuses', () => {
      const fnStart = src.indexOf('export async function handleHostExcludeFromRound');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/validateMatchAssignment/);
      expect(fn).toMatch(/conflictingStatuses:\s*\[\s*['"]scheduled['"]\s*,\s*['"]active['"]\s*\]/);
    });
  });
});
