import { pairKey } from './matching.interface';

/**
 * #6 (June-10 debrief) — minimize AVOIDABLE within-event repeats so the first
 * "Match People" of a bonus round shows fresh pairs whenever fresh pairs exist.
 *
 * When no COMPLETE fresh matching is possible (e.g. one person has already met
 * everyone), the fallback ladder produces a complete matching that reuses
 * already-met pairs — but a fresh-first greedy/backtracker can still leave a
 * fresh pairing on the table and use MORE repeats than mathematically forced
 * (TESTEVENT round 5: 2 repeats where exactly 1 was unavoidable).
 *
 * This is a bounded 2-opt over the round's two-person pairs: for every pair of
 * matches it tries the two alternative re-pairings and keeps a swap ONLY when it
 * STRICTLY reduces the number of already-met pairs and neither new pair is in the
 * round's hard-exclusion set. Safety properties (why this is safe to run on the
 * live matching path):
 *   - it never changes WHO is matched (swaps preserve all four participants),
 *   - it can only reduce the repeat count, never increase it (worst case: no-op),
 *   - it leaves trios untouched, and
 *   - the caller only invokes it when repeats already exist, so the all-fresh
 *     common case (every normal round) is completely unaffected.
 *
 * Mutates `pairs` in place.
 */
export interface SwappablePair {
  participantAId: string;
  participantBId: string;
  participantCId?: string | null;
}

export function reduceRepeatPairs(
  pairs: SwappablePair[],
  excludedPairs: Set<string>,
  hardExcluded: Set<string>,
): void {
  const isRepeat = (a: string, b: string) => excludedPairs.has(pairKey(a, b));
  const blocked = (a: string, b: string) => hardExcluded.has(pairKey(a, b));

  // Only two-person pairs participate; trios are left intact.
  const twoIdx = pairs
    .map((p, i) => ({ p, i }))
    .filter((x) => !x.p.participantCId)
    .map((x) => x.i);

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let x = 0; x < twoIdx.length; x++) {
      for (let y = x + 1; y < twoIdx.length; y++) {
        const M1 = pairs[twoIdx[x]];
        const M2 = pairs[twoIdx[y]];
        const a = M1.participantAId, b = M1.participantBId;
        const c = M2.participantAId, d = M2.participantBId;
        if (!a || !b || !c || !d) continue;

        const cur = (isRepeat(a, b) ? 1 : 0) + (isRepeat(c, d) ? 1 : 0);
        if (cur === 0) continue; // both fresh already — nothing to improve here

        // alt1: (a,c) + (b,d)
        if (!blocked(a, c) && !blocked(b, d)) {
          const alt1 = (isRepeat(a, c) ? 1 : 0) + (isRepeat(b, d) ? 1 : 0);
          if (alt1 < cur) {
            M1.participantBId = c;
            M2.participantAId = b;
            improved = true;
            continue;
          }
        }
        // alt2: (a,d) + (b,c)
        if (!blocked(a, d) && !blocked(b, c)) {
          const alt2 = (isRepeat(a, d) ? 1 : 0) + (isRepeat(b, c) ? 1 : 0);
          if (alt2 < cur) {
            M1.participantBId = d;
            M2.participantAId = b;
            M2.participantBId = c;
            improved = true;
            continue;
          }
        }
      }
    }
  }
}
