// Phase J — pinned invariants for Stefan's 12 May test feedback.
//
// The 12 May review listed 10 items (numbered with gaps 1, 2, 3, 4, 6, 7, 9,
// 10, 12, 14). This file pins the four items that are already correctly
// implemented in production code, so they cannot silently regress while the
// remaining six items (1, 2, 3, 4, 6, 7) ship in their own phases.
//
//   Item 9  — Matching pairing dedup on rematch (handleHostRegenerateMatches
//             must wipe the round before regen — no status filter).
//   Item 10 — Stats count unique people, not rounds (already pinned by
//             phase-f-stats-and-no-repeat; cross-referenced below).
//   Item 12 — Per-interaction rating dedup (emitRatingWindowOnce helper +
//             every rating:window_open emit goes through dedup).
//   Item 14 — Meet-everyone-again safety / no-repeat pairs (already pinned
//             by phase-f-stats-and-no-repeat; cross-referenced below).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Phase J — 12 May invariants (items 9, 12; cross-ref 10, 14)', () => {
  // ─── Item 9 — Rematch wipes round before regen, no status filter ────────
  describe('Item 9 — handleHostRegenerateMatches wipes the round before regen', () => {
    const src = readSource('services/orchestration/handlers/matching-flow.ts');
    const fnStart = src.indexOf('export async function handleHostRegenerateMatches');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

    it('handler is declared', () => {
      expect(fnStart).toBeGreaterThan(-1);
    });

    it('DELETEs all matches for the round without a status filter', () => {
      // The Phase 1 (5 May spec) broad DELETE — fixes the 3fc21cbb duplicate-
      // pair bug where the prior narrow filter (status IN scheduled,cancelled)
      // let confirmed/forced/duplicate rows survive and stack on every
      // Re-match press. Stefan's 12 May item 9: "Before every rematch: clear
      // old pairing map, regenerate fresh allocation state, rebuild
      // participant pool."
      expect(fn).toMatch(
        /DELETE\s+FROM\s+matches\s+WHERE\s+session_id\s*=\s*\$1\s+AND\s+round_number\s*=\s*\$2/i,
      );
      // Forbid any status filter on the DELETE — that's the exact form that
      // caused the duplicate-pair bug. Pin its absence in this handler.
      expect(fn).not.toMatch(
        /DELETE\s+FROM\s+matches[\s\S]{0,200}WHERE[\s\S]{0,200}status\s+IN\s*\(/i,
      );
    });

    it('verifies host BEFORE performing the destructive delete', () => {
      const verifyIdx = fn.search(/verifyHost\(/);
      const deleteIdx = fn.search(/DELETE\s+FROM\s+matches/i);
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeGreaterThan(verifyIdx);
    });

    it('calls matchingService.generateSingleRound with regenerate option', () => {
      // The regenerate flag tells the engine to ignore any stale pre-plan and
      // build a fresh allocation from current live eligibility — the
      // "rebuild participant pool" part of Stefan's spec.
      expect(fn).toMatch(/matchingService\.generateSingleRound\(/);
      expect(fn).toMatch(/regenerate:\s*true/);
    });
  });

  // ─── Item 12 — Rating prompt dedup helper architecture ──────────────────
  describe('Item 12 — every rating:window_open emit dedups against the ratings table', () => {
    it('emitRatingWindowOnce helper exists and queries ratings before emitting', () => {
      const stateSrc = readSource('services/orchestration/state/session-state.ts');
      const fnStart = stateSrc.indexOf('export async function emitRatingWindowOnce');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = stateSrc.indexOf('\nexport ', fnStart + 1);
      const fn = stateSrc.slice(fnStart, fnEnd > -1 ? fnEnd : stateSrc.length);
      // The dedup query keyed on (match_id, from_user_id) — the same shape
      // submitRating uses to enforce MATCH_ALREADY_RATED. Both must use the
      // same key or the helper would let through prompts the submission
      // would reject (the confusing "you already rated this" UI bug).
      expect(fn).toMatch(
        /SELECT[\s\S]{0,80}FROM\s+ratings\s+WHERE\s+match_id\s*=\s*\$1\s+AND\s+from_user_id\s*=\s*\$2/i,
      );
      // Must skip the emit when a rating row exists.
      expect(fn).toMatch(/existing\.rows\.length\s*>\s*0/);
    });

    it('submitRating rejects duplicate rating attempts with MATCH_ALREADY_RATED', () => {
      // The dedup is enforced at TWO layers — helper at emit time AND service
      // at submit time. Both must hold; the helper alone is not enough
      // because clients can submit ratings without seeing the prompt (eg.
      // via a stale UI).
      const ratingSrc = readSource('services/rating/rating.service.ts');
      const fnStart = ratingSrc.indexOf('export async function submitRating');
      const fnEnd = ratingSrc.indexOf('\nexport ', fnStart + 1);
      const fn = ratingSrc.slice(fnStart, fnEnd > -1 ? fnEnd : ratingSrc.length);
      expect(fn).toMatch(
        /SELECT\s+id\s+FROM\s+ratings\s+WHERE\s+match_id\s*=\s*\$1\s+AND\s+from_user_id\s*=\s*\$2\s+AND\s+to_user_id\s*=\s*\$3/i,
      );
      expect(fn).toMatch(/ConflictError\([\s\S]{0,80}MATCH_ALREADY_RATED/);
    });

    it('every file emitting rating:window_open dedups (helper import OR inline ratings-table SELECT)', () => {
      // Phase 7B converted host-actions, breakout-bulk, and participant-flow to
      // import the centralised helper. round-lifecycle uses an equivalent inline
      // dedup at the round-end loop — 23 May (#6) it became round-scoped and
      // partner-keyed (FROM ratings r JOIN matches m, matching the rater→partner
      // edge across the round) so it survives a match-id change from a pull-back.
      // All forms are architecturally equivalent — pin the rule (dedup exists),
      // not the specific implementation.
      const files = [
        'services/orchestration/handlers/host-actions.ts',
        'services/orchestration/handlers/breakout-bulk.ts',
        'services/orchestration/handlers/round-lifecycle.ts',
        'services/orchestration/handlers/participant-flow.ts',
      ];
      for (const rel of files) {
        const src = readSource(rel);
        const usesHelper = /emitRatingWindowOnce/.test(src);
        const usesInlineDedup =
          /SELECT[\s\S]{0,80}from_user_id[\s\S]{0,80}FROM\s+ratings\s+WHERE\s+match_id/i.test(
            src,
          ) ||
          /SELECT\s+id\s+FROM\s+ratings\s+WHERE\s+match_id\s*=\s*\$1\s+AND\s+from_user_id\s*=\s*\$2/i.test(
            src,
          ) ||
          // 23 May (#6) — round-lifecycle now uses a round-scoped, partner-keyed
          // dedup (FROM ratings r JOIN matches m … r.from_user_id / r.to_user_id)
          // that survives a match-id change from a pull-back / reassign.
          /FROM\s+ratings\s+r\s+JOIN\s+matches\s+m[\s\S]{0,200}from_user_id/i.test(
            src,
          );
        // Helpful failure label: the file path, so a regression reads cleanly.
        expect({ file: rel, usesHelper, usesInlineDedup }).toEqual(
          expect.objectContaining({ file: rel }),
        );
        expect(usesHelper || usesInlineDedup).toBe(true);
      }
    });

    it('participant-flow.ts: every bare rating:window_open emit is paired with an inline ratings-table dedup check', () => {
      // participant-flow has three direct socket.emit('rating:window_open', ...)
      // sites:
      //   ~L545 — rejoin-replay (inline check exists at lines ~522-527)
      //   ~L979 — trio-leave (one-shot per match — user just left, hasn't rated)
      //   ~L1045 — voluntary-leave (one-shot per match — same)
      //
      // The rejoin-replay site MUST gate on an inline ratings-table SELECT
      // because the user may have already rated and disconnected. The other
      // two are leave-actions and don't need dedup (the match is being ended
      // in the same handler). We pin only the rejoin site.
      //
      // The pin is structural: if anyone removes the rejoin dedup, the test
      // fails. If a future PR replaces the inline check with the helper, that
      // also satisfies the pin (the helper string appears between the rating
      // window status check and the emit).
      const src = readSource('services/orchestration/handlers/participant-flow.ts');
      const ratingReplayIdx = src.indexOf('ratingReplayStatuses');
      expect(ratingReplayIdx).toBeGreaterThan(-1);

      const nextEmitIdx = src.indexOf("emit('rating:window_open'", ratingReplayIdx);
      const nextHelperIdx = src.indexOf('emitRatingWindowOnce(', ratingReplayIdx);
      const sectionEnd = Math.min(
        nextEmitIdx > -1 ? nextEmitIdx : Number.MAX_SAFE_INTEGER,
        nextHelperIdx > -1 ? nextHelperIdx : Number.MAX_SAFE_INTEGER,
      );
      expect(sectionEnd).toBeGreaterThan(ratingReplayIdx);
      expect(sectionEnd).toBeLessThan(Number.MAX_SAFE_INTEGER);

      // Between the ratingReplayStatuses guard and the emit/helper, there
      // must be either:
      //   (a) an inline SELECT id FROM ratings WHERE match_id = ... check, OR
      //   (b) the emitRatingWindowOnce helper call (which itself does the check).
      const between = src.slice(ratingReplayIdx, sectionEnd);
      const inlineDedup =
        /SELECT\s+id\s+FROM\s+ratings\s+WHERE\s+match_id/i.test(between);
      const helperDedup = nextHelperIdx > -1 && nextHelperIdx <= sectionEnd;
      expect(inlineDedup || helperDedup).toBe(true);
    });
  });

  // ─── Items 10 & 14 — cross-reference to phase-f pin file ────────────────
  describe('Items 10 and 14 — pinned in phase-f-stats-and-no-repeat', () => {
    // Items 10 (Stefan's 12 May "Trial Room / Breakout Statistics" — count
    // unique people not rounds) and 14 (12 May "Meet Everyone Again" — no-
    // repeat pairs) are the same architectural invariants as 10-May audit
    // items 15 and 16 respectively. Phase F pinned both. Phase J doesn't
    // re-pin to avoid duplication, but DOES verify the Phase F file still
    // covers the needed assertions so a future PR can't quietly delete them.
    it('phase-f-stats-and-no-repeat.test.ts still covers stats dedup (item 10) and no-repeat (item 14)', () => {
      const fPath = nodePath.join(__dirname, 'phase-f-stats-and-no-repeat.test.ts');
      expect(nodeFs.existsSync(fPath)).toBe(true);
      const f = nodeFs.readFileSync(fPath, 'utf8');
      // Item 10 / Phase F item 15 — partner_id UUID dedup.
      expect(f).toMatch(/COUNT\(DISTINCT\s+partner_id\)/);
      expect(f).toMatch(/getUniquePeopleMet/);
      expect(f).toMatch(/getMeetingCounts/);
      // Item 14 / Phase F item 16 — usedPairs in matching engine.
      expect(f).toMatch(/usedPairs/);
      expect(f).toMatch(/previousRounds/);
      expect(f).toMatch(/generateSchedule/);
    });
  });
});
