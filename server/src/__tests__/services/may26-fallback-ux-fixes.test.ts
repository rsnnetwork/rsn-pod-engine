// 26 May 2026 — fallback UX fixes: Item A (round warning gating + tooltip) and
// #9-UI (host banner + toast on repeat matches).
//
// Source-pattern pins that confirm the server-side changes are in place without
// needing a full HTTP integration harness.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('26 May fallback UX fixes', () => {
  const sessionsSrc = readServer('routes/sessions.ts');
  const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');

  // ── Item A — plan endpoint exposes repeatPairCount ───────────────────────

  describe('Item A — GET /sessions/:id/plan exposes repeatPairCount per round', () => {
    // Locate the plan endpoint block in sessions.ts
    const planIdx = sessionsSrc.indexOf("'/:id/plan'");

    it('plan endpoint exists', () => {
      expect(planIdx).toBeGreaterThan(-1);
    });

    it('queries repeat_in_event from the matches table for each round', () => {
      // The block starting at the plan endpoint must reference repeat_in_event
      // so the server sums how many pairs in each round had repeat_in_event = TRUE.
      const block = sessionsSrc.slice(planIdx, planIdx + 8000);
      expect(block).toMatch(/repeat_in_event/);
    });

    it('includes repeatPairCount in each round object pushed to the response', () => {
      const block = sessionsSrc.slice(planIdx, planIdx + 8000);
      expect(block).toMatch(/repeatPairCount/);
    });

    it('rounds.push includes repeatPairCount alongside hasFallback', () => {
      // Confirm it's in the rounds.push({ ... }) shape, not just a comment.
      const block = sessionsSrc.slice(planIdx, planIdx + 8000);
      const pushIdx = block.indexOf('rounds.push(');
      expect(pushIdx).toBeGreaterThan(-1);
      const pushBlock = block.slice(pushIdx, pushIdx + 400);
      expect(pushBlock).toMatch(/repeatPairCount/);
      expect(pushBlock).toMatch(/hasFallback/);
    });

    it('excludes manual matches from the repeat count (is_manual = FALSE)', () => {
      // repeatPairCount must only count algorithm-generated repeats.
      // The matches query for repeat_in_event must filter out manual rows.
      const block = sessionsSrc.slice(planIdx, planIdx + 8000);
      // The existing query for hasFallback already has is_manual filter;
      // the new column must be in the SAME query or a query with the same guard.
      // Pattern: CASE WHEN repeat_in_event ... AND/filter + is_manual filter nearby.
      expect(block).toMatch(/repeat_in_event[\s\S]{0,200}is_manual/);
    });
  });

  // ── Item #9-UI — sendMatchPreview includes usedRepeats ───────────────────

  describe('Item #9-UI — sendMatchPreview payload includes usedRepeats', () => {
    const fnStart = flowSrc.indexOf('export async function sendMatchPreview');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = flowSrc.indexOf('\nexport ', fnStart + 1);
    const fn = flowSrc.slice(fnStart, fnEnd > -1 ? fnEnd : flowSrc.length);

    it('sendMatchPreview function exists', () => {
      expect(fnStart).toBeGreaterThan(-1);
    });

    it('emits usedRepeats in the host:match_preview payload', () => {
      // The socket.emit('host:match_preview', { ... }) block must contain usedRepeats.
      const emitIdx = fn.indexOf("socket.emit('host:match_preview'");
      expect(emitIdx).toBeGreaterThan(-1);
      const emitBlock = fn.slice(emitIdx, emitIdx + 500);
      expect(emitBlock).toMatch(/usedRepeats/);
    });

    it('derives usedRepeats from whether any match in the round has repeat_in_event or fallback_used', () => {
      // The value must be computed from match data, not hardcoded.
      expect(fn).toMatch(/usedRepeats/);
      // Must reference at least one of the two DB signals for repeats.
      expect(fn).toMatch(/repeat_in_event|fallback_used|metBefore/);
    });
  });
});
