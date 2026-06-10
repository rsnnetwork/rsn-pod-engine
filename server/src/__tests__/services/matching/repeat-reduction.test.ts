// #6 (June-10 debrief) — bonus round must show fresh pairs on the first click.
// Unit-tests the 2-opt repeat-reduction in isolation against the exact TESTEVENT
// round-5 shape (one person has met everyone → exactly 1 repeat is forced).
import { reduceRepeatPairs, SwappablePair } from '../../../services/matching/repeat-reduction';
import { pairKey } from '../../../services/matching/matching.interface';

const met = (...pairs: [string, string][]) => new Set(pairs.map(([a, b]) => pairKey(a, b)));
const countRepeats = (pairs: SwappablePair[], excluded: Set<string>) =>
  pairs.filter((p) => excluded.has(pairKey(p.participantAId, p.participantBId))).length;

describe('#6 reduceRepeatPairs — minimize avoidable within-event repeats', () => {
  it('turns two avoidable repeats into zero when a fully-fresh re-pairing exists', () => {
    // Pairs [A,B] and [C,D] both already met, but A-C and B-D are fresh.
    const excluded = met(['A', 'B'], ['C', 'D']);
    const pairs: SwappablePair[] = [
      { participantAId: 'A', participantBId: 'B' },
      { participantAId: 'C', participantBId: 'D' },
    ];
    expect(countRepeats(pairs, excluded)).toBe(2);
    reduceRepeatPairs(pairs, excluded, new Set());
    expect(countRepeats(pairs, excluded)).toBe(0);
  });

  it('reaches the forced minimum (1) when one person has met everyone (the R5 case)', () => {
    // A has met B, C, D (and C-D met). A MUST repeat with someone → 1 forced.
    // Naive [A,B]+[C,D] = 2 repeats; optimal [A,C]+[B,D] = 1 (B-D fresh).
    const excluded = met(['A', 'B'], ['A', 'C'], ['A', 'D'], ['C', 'D']);
    const pairs: SwappablePair[] = [
      { participantAId: 'A', participantBId: 'B' },
      { participantAId: 'C', participantBId: 'D' },
    ];
    expect(countRepeats(pairs, excluded)).toBe(2);
    reduceRepeatPairs(pairs, excluded, new Set());
    expect(countRepeats(pairs, excluded)).toBe(1); // exactly the forced minimum
  });

  it('never increases repeats and is a no-op when already optimal', () => {
    const excluded = met(['A', 'C']); // [A,B]+[C,D] already has 0 repeats
    const pairs: SwappablePair[] = [
      { participantAId: 'A', participantBId: 'B' },
      { participantAId: 'C', participantBId: 'D' },
    ];
    reduceRepeatPairs(pairs, excluded, new Set());
    expect(countRepeats(pairs, excluded)).toBe(0);
    // membership unchanged
    expect(pairs[0]).toEqual({ participantAId: 'A', participantBId: 'B' });
  });

  it('respects hard exclusions — will not create a blocked pair even to cut a repeat', () => {
    const excluded = met(['A', 'B'], ['C', 'D']);
    const hard = met(['A', 'C'], ['B', 'D'], ['A', 'D'], ['B', 'C']); // every swap blocked
    const pairs: SwappablePair[] = [
      { participantAId: 'A', participantBId: 'B' },
      { participantAId: 'C', participantBId: 'D' },
    ];
    reduceRepeatPairs(pairs, excluded, hard);
    expect(countRepeats(pairs, excluded)).toBe(2); // no legal improving swap → unchanged
  });

  it('leaves trios untouched', () => {
    const excluded = met(['A', 'B']);
    const pairs: SwappablePair[] = [
      { participantAId: 'A', participantBId: 'B', participantCId: 'E' }, // trio — skipped
      { participantAId: 'C', participantBId: 'D' },
    ];
    reduceRepeatPairs(pairs, excluded, new Set());
    expect(pairs[0].participantCId).toBe('E');
    expect(pairs[0].participantAId).toBe('A');
  });

  it('preserves the full participant set (no one dropped or duplicated)', () => {
    const excluded = met(['A', 'B'], ['C', 'D'], ['E', 'F']);
    const pairs: SwappablePair[] = [
      { participantAId: 'A', participantBId: 'B' },
      { participantAId: 'C', participantBId: 'D' },
      { participantAId: 'E', participantBId: 'F' },
    ];
    reduceRepeatPairs(pairs, excluded, new Set());
    const ids = pairs.flatMap((p) => [p.participantAId, p.participantBId]).sort();
    expect(ids).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });
});
