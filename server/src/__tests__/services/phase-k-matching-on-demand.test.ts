// Phase K — 12 May items 3 and 4: matching only generates when the host
// presses "Match People", and the result always reflects the live eligible
// set (including late joiners). The Phase 2.5B pre-plan is invalidated
// when eligibility has shifted since the plan was generated.
//
// Items collapsed into one phase:
//   Item 3 — "Matching should ONLY generate on Match People"
//   Item 4 — "Late joiner logic: include newly arrived users, preserve
//             already completed rounds"
//
// Both stem from the same root cause: handleHostGenerateMatches was
// surfacing the Phase 2.5B pre-plan unconditionally, so a host pressing
// Match People after late joiners had arrived saw a preview that excluded
// them. The fix detects eligibility divergence and falls through to the
// on-the-fly engine run when the pre-plan is stale.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Phase K — matching on-demand + late-joiner correctness', () => {
  const src = readSource('services/orchestration/handlers/matching-flow.ts');
  const fnStart = src.indexOf('export async function handleHostGenerateMatches');
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

  it('handler is declared', () => {
    expect(fnStart).toBeGreaterThan(-1);
  });

  describe('Pre-plan staleness detection', () => {
    it('builds eligibleIds Set from the live eligible-participants query', () => {
      // The set is constructed from the result of getEligibleParticipants —
      // which Phase A1 made the single source of truth for live eligibility.
      // getEligibleParticipants returns string[], so the Set is built from
      // the array directly (no .map(p => p.userId)).
      expect(fn).toMatch(/eligibleIds\s*=\s*new\s+Set<string>\(\s*eligible\s*\)/);
    });

    it('builds plannedIds Set by walking every scheduled match (A, B, and trio C)', () => {
      expect(fn).toMatch(/plannedIds\s*=\s*new\s+Set/);
      expect(fn).toMatch(/plannedIds\.add\(m\.participantAId\)/);
      expect(fn).toMatch(/plannedIds\.add\(m\.participantBId\)/);
      expect(fn).toMatch(/m\.participantCId/);
    });

    it('only considers scheduled matches when building plannedIds', () => {
      // Active / completed / cancelled rows must NOT participate in the
      // staleness check — they represent prior-round history, not the
      // pre-plan for the upcoming round.
      expect(fn).toMatch(/m\.status\s*!==?\s*['"]scheduled['"]/);
    });

    it('compares the two sets by size AND by every-member-in-the-other', () => {
      // Equal-size alone is insufficient; the members themselves must match.
      // The standard pattern is `sameSize && [...a].every(id => b.has(id))`.
      expect(fn).toMatch(/eligibleIds\.size\s*===\s*plannedIds\.size/);
      expect(fn).toMatch(
        /\[\.\.\.eligibleIds\]\.every\(\s*id\s*=>\s*plannedIds\.has\(id\)\s*\)/,
      );
    });
  });

  describe('Fresh pre-plan path (Phase 2.5B perf win preserved)', () => {
    it('when eligibility matches the plan, surfaces the pre-plan and early-returns', () => {
      // The Phase 2.5B optimisation — skip the engine when the pre-plan is
      // still accurate — is retained. We pin the early-return path uses
      // sendMatchPreview and exits without re-running the engine.
      // 23 May (#10) — also gated on the plan not repeating a prior round.
      // 26 May (#A) — and gated off for platform_wide (the pre-plan lacks the
      // cross-event hard-exclusion), via canSurfacePrePlan.
      expect(fn).toMatch(/canSurfacePrePlan\s*=\s*sameMembers\s*&&\s*!planRepeatsPriorRound\s*&&\s*matchingPolicy\s*!==\s*'platform_wide'/);
      // The "no engine re-run" log message marks the fresh-pre-plan branch.
      expect(fn).toMatch(/no\s+engine\s+re-run/i);
      // sendMatchPreview is called in this branch (and the legacy path).
      const sameMembersIdx = fn.indexOf('if (canSurfacePrePlan)');
      const fallthroughIdx = fn.indexOf('Phase K / #10 — pre-plan stale');
      expect(sameMembersIdx).toBeGreaterThan(-1);
      expect(fallthroughIdx).toBeGreaterThan(sameMembersIdx);
      const branch = fn.slice(sameMembersIdx, fallthroughIdx);
      expect(branch).toMatch(/sendMatchPreview\(/);
      expect(branch).toMatch(/return\s*;/);
    });
  });

  describe('Stale pre-plan path (items 3 + 4 main fix)', () => {
    it('logs the divergence with addedLateJoiners and removedLeavers for audit trail', () => {
      expect(fn).toMatch(/addedLateJoiners/);
      expect(fn).toMatch(/removedLeavers/);
      expect(fn).toMatch(/Phase K \/ #10 — pre-plan stale/);
    });

    it("DELETEs the pre-plan scoped to status='scheduled' (preserves completed rounds — item 4)", () => {
      // The completed/active rows must NEVER be wiped — item 4 says
      // "preserve already completed rounds". Pin the status='scheduled'
      // filter so a future PR cannot accidentally broaden the DELETE.
      const staleIdx = fn.indexOf('Phase K / #10 — pre-plan stale');
      expect(staleIdx).toBeGreaterThan(-1);
      const afterStaleBlock = fn.slice(staleIdx);
      expect(afterStaleBlock).toMatch(
        /DELETE\s+FROM\s+matches\s+WHERE\s+session_id\s*=\s*\$1\s+AND\s+round_number\s*=\s*\$2\s+AND\s+status\s*=\s*['"]scheduled['"]/i,
      );
    });

    it('falls through to the legacy on-the-fly engine path after wiping the stale plan', () => {
      // After the stale-pre-plan DELETE, control must reach
      // generateSingleRound — that's the engine run on the current eligible
      // set, which includes late joiners.
      const staleIdx = fn.indexOf('Phase K / #10 — pre-plan stale');
      const generateIdx = fn.indexOf(
        'matchingService.generateSingleRound',
        staleIdx,
      );
      expect(staleIdx).toBeGreaterThan(-1);
      expect(generateIdx).toBeGreaterThan(staleIdx);
    });

    it('no early return between the stale-plan DELETE and the legacy engine run', () => {
      // The "fall through" comment marks the intent — pin that no `return`
      // statement sits between the DELETE and generateSingleRound.
      const deleteIdx = fn.search(/DELETE\s+FROM\s+matches[\s\S]{0,200}status\s*=\s*['"]scheduled['"]/i);
      const generateIdx = fn.indexOf(
        'matchingService.generateSingleRound',
        deleteIdx,
      );
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(generateIdx).toBeGreaterThan(deleteIdx);
      const between = fn.slice(deleteIdx, generateIdx);
      // Allow comments and other non-control-flow code, but reject `return`.
      // (A return inside the if(sameMembers) branch is above deleteIdx, so
      // doesn't appear in `between`.)
      expect(between).not.toMatch(/^\s*return\s*;/m);
    });
  });

  describe('Architectural invariants — call order', () => {
    it('getEligibleParticipants is called BEFORE the pre-plan check', () => {
      // The staleness comparison needs eligibleIds in scope; the
      // getEligibleParticipants call must precede the existingPlanned fetch.
      const eligibleIdx = fn.indexOf('getEligibleParticipants(');
      const planFetchIdx = fn.indexOf(
        'matchingService.getMatchesByRound(',
      );
      expect(eligibleIdx).toBeGreaterThan(-1);
      expect(planFetchIdx).toBeGreaterThan(eligibleIdx);
    });

    it('verifyHost runs before any state read or DELETE', () => {
      const verifyIdx = fn.indexOf('verifyHost(socket');
      const eligibleIdx = fn.indexOf('getEligibleParticipants(');
      const deleteIdx = fn.search(/DELETE\s+FROM\s+matches/i);
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(eligibleIdx);
      if (deleteIdx > -1) expect(verifyIdx).toBeLessThan(deleteIdx);
    });
  });
});
