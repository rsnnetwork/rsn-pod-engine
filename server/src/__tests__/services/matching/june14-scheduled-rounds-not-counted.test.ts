// ─── June-14 — pre-planned 'scheduled' future rounds must NOT count as met ────
//
// Ali's 6-round / bonus-round test: after a round, the FIRST "Match People" press
// surfaced an already-met pair ("Met 1×") while fresh pairs were still available;
// fresh pairs only appeared on Re-match. Root cause: generateSessionSchedule
// pre-plans EVERY future round as status='scheduled' at Start, and the live
// no-repeat exclusion (matching.service generateSingleRound) + the pre-plan
// "repeats a prior round?" guard (matching-flow priorRoundPairKeys) both swept
// those scheduled future rounds in via `status NOT IN ('cancelled','no_show')`.
// For a small pool the pre-plan covers ALL possible pairings, so every live round
// found zero fresh candidates → the fallback ladder was forced to L4 (repeats),
// and the very first round was even tagged a repeat. Behaviourally reproduced
// (round 2 landed at fallbackLevel 4 with a fresh matching available; 0 after the
// fix). Fix: both queries count only PLAYED rounds — status IN ('completed',
// 'active'). The preview met-count was already scoped to prior rounds, which is
// why the "Met 1×" label read correctly while the engine produced repeats.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('June-14 — no-repeat set excludes pre-planned scheduled rounds', () => {
  it('matching.service excludedPairs counts only played rounds (completed/active)', () => {
    const src = readServer('services/matching/matching.service.ts');
    // The within-event exclusion query must gate on PLAYED status, not the old
    // "everything except cancelled/no_show" (which let 'scheduled' future rounds in).
    expect(src).toMatch(/round_number != \$2\s*\n\s*AND status IN \('completed', 'active'\)\s*\n\s*AND is_manual = FALSE/);
    expect(src).not.toMatch(/round_number != \$2\s*\n\s*AND status NOT IN \('cancelled', 'no_show'\)\s*\n\s*AND is_manual = FALSE/);
  });

  it("matching-flow priorRoundPairKeys (the pre-plan guard) uses the same played-only filter", () => {
    const src = readServer('services/orchestration/handlers/matching-flow.ts');
    expect(src).toMatch(/round_number != \$2\s*\n\s*AND status IN \('completed', 'active'\)\s*\n\s*AND is_manual = FALSE/);
  });

  it('the preview met-count remains scoped to prior rounds (unchanged — was already correct)', () => {
    const src = readServer('services/orchestration/handlers/matching-flow.ts');
    expect(src).toMatch(/round_number < \$2/);
  });
});
