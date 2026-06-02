// ─── Fix #2/#9 — Fresh pairs chosen FIRST (engine) ──────────────────────
//
// Stefan's 25 May list, item #2/#9: never-met pairs must be the highest
// priority in selection, then least-met, with the weighted score only a
// tiebreaker WITHIN a freshness tier.
//
// Pre-fix the engine sorted candidates purely by score
// (matching.engine.ts:206 `candidates.sort((a,b) => b.score - a.score)`),
// so a high-interest already-met pair outranked a never-met pair. Both the
// greedy path AND the backtracking matcher (findCompleteMatching) iterate
// candidates in that order, so both surfaced repeats over fresh pairs.
//
// Post-fix selection is tiered: timesMet ascending first, score descending
// only as the within-tier tiebreaker. When a complete matching using only
// never-met pairs exists, it is chosen; already-met pairs are used only
// when necessary, least-met-first.

import { MatchingEngineV1 } from '../../../services/matching/matching.engine';
import { pairKey } from '../../../services/matching/matching.interface';
import {
  MatchingConfig, MatchingParticipant, MatchingWeights, EncounterHistoryEntry,
} from '@rsn/shared';

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

function makeParticipant(userId: string, overrides?: Partial<MatchingParticipant>): MatchingParticipant {
  return {
    userId,
    interests: [],
    reasonsToConnect: [],
    industry: null,
    company: null,
    languages: ['english'],
    timezone: 'UTC',
    attributes: {},
    ...overrides,
  };
}

const WEIGHTS: MatchingWeights = {
  sharedInterests: 0.25,
  sharedReasons: 0.25,
  industryDiversity: 0.15,
  companyDiversity: 0.15,
  languageMatch: 0.10,
  encounterFreshness: 0.10,
};

const config: MatchingConfig = {
  weights: WEIGHTS,
  hardConstraints: [],
  numberOfRounds: 5,
  avoidDuplicates: true,
  globalOptimize: false,
};

function placedPairs(round: { pairs: { participantAId: string; participantBId: string }[] }): Set<string> {
  return new Set(round.pairs.map(p => pairKey(p.participantAId, p.participantBId)));
}

describe('Fix #2/#9 — fresh-first selection', () => {
  it('chooses a never-met pair over a higher-scoring already-met pair', () => {
    // a & b: strong shared interests (high score) BUT already met 3 times.
    // a & c / b & d: no shared interests (low score) but never met.
    // A complete fresh matching exists: (a,c) + (b,d). Fresh-first must pick
    // it over the tempting (a,b) high-score-but-stale pair.
    const a = makeParticipant('a', { interests: ['ai', 'ml', 'startups'] });
    const b = makeParticipant('b', { interests: ['ai', 'ml', 'startups'] });
    const c = makeParticipant('c', { interests: [] });
    const d = makeParticipant('d', { interests: [] });

    const encounterHistory: EncounterHistoryEntry[] = [
      {
        userAId: 'a', userBId: 'b', timesMet: 3,
        lastMetAt: new Date(Date.now() - 1000 * 60 * 60 * 24), // yesterday
      },
    ];

    const engine = new MatchingEngineV1();
    const round = engine.generateRound([a, b, c, d], config, new Set(), encounterHistory, 1);

    const placed = placedPairs(round);
    // The stale high-score pair must NOT be selected when a fresh complete
    // matching exists.
    expect(placed.has(pairKey('a', 'b'))).toBe(false);
    // All four placed, complete matching.
    expect(round.pairs.length).toBe(2);
    expect(round.byeParticipant).toBeNull();
  });

  it('when repeats are unavoidable, prefers the least-met pair', () => {
    // Force the only complete matchings to involve a repeat. a&b never met;
    // c&d met once; a&c, a&d, b&c, b&d are hard-excluded so the only legal
    // partners leave c & d needing each other. We instead test the tier
    // ordering directly: with two candidate repeats of different timesMet,
    // the lower-timesMet pair wins the tiebreak.
    const a = makeParticipant('a');
    const b = makeParticipant('b');
    const c = makeParticipant('c');
    const d = makeParticipant('d');

    // a-b met 5x, c-d met 1x; a-c / a-d / b-c / b-d all met too so every
    // pair is a repeat. Least-met-first means the round should favour the
    // 1x pairs over the 5x pair where a choice exists.
    const encounterHistory: EncounterHistoryEntry[] = [
      { userAId: 'a', userBId: 'b', timesMet: 5, lastMetAt: new Date() },
      { userAId: 'c', userBId: 'd', timesMet: 1, lastMetAt: new Date() },
      { userAId: 'a', userBId: 'c', timesMet: 2, lastMetAt: new Date() },
      { userAId: 'a', userBId: 'd', timesMet: 2, lastMetAt: new Date() },
      { userAId: 'b', userBId: 'c', timesMet: 2, lastMetAt: new Date() },
      { userAId: 'b', userBId: 'd', timesMet: 2, lastMetAt: new Date() },
    ];

    const engine = new MatchingEngineV1();
    const round = engine.generateRound([a, b, c, d], config, new Set(), encounterHistory, 1);

    // The 5x pair (a,b) is the worst possible repeat. A complete matching
    // that avoids it exists (every other pair is ≤2x). Least-met-first must
    // never select the worst pair when a fresher complete matching exists.
    const placed = placedPairs(round);
    expect(round.pairs.length).toBe(2);
    expect(placed.has(pairKey('a', 'b'))).toBe(false);
    // The total times-met across the chosen matching must be minimal — i.e.
    // no selected pair exceeds the least-met alternative. Here the optimal
    // complete matchings are (a,c)+(b,d) and (a,d)+(b,c) at 2x each, or
    // (c,d 1x)+(a,b 5x) which is worse; least-met-first picks the former.
    const timesMetByKey = new Map(encounterHistory.map(e => [pairKey(e.userAId, e.userBId), e.timesMet]));
    const maxSelectedTimesMet = Math.max(...[...placed].map(k => timesMetByKey.get(k) ?? 0));
    expect(maxSelectedTimesMet).toBeLessThanOrEqual(2);
  });

  it('still produces a complete matching (no participant byed by tiering)', () => {
    const a = makeParticipant('a', { interests: ['x'] });
    const b = makeParticipant('b', { interests: ['x'] });
    const c = makeParticipant('c');
    const d = makeParticipant('d');
    const encounterHistory: EncounterHistoryEntry[] = [
      { userAId: 'a', userBId: 'b', timesMet: 2, lastMetAt: new Date() },
    ];
    const engine = new MatchingEngineV1();
    const round = engine.generateRound([a, b, c, d], config, new Set(), encounterHistory, 1);
    const placed = new Set<string>();
    for (const p of round.pairs) {
      placed.add(p.participantAId);
      placed.add(p.participantBId);
    }
    expect(placed.size).toBe(4);
    expect(round.byeParticipant).toBeNull();
  });

  it('with no encounter history, falls back to pure score ordering (tier is a no-op)', () => {
    // All timesMet=0 → tier equal → score tiebreak decides, identical to
    // pre-fix behaviour. a&b share the most interests → highest score → paired.
    const a = makeParticipant('a', { interests: ['ai', 'ml'] });
    const b = makeParticipant('b', { interests: ['ai', 'ml'] });
    const c = makeParticipant('c', { interests: ['cooking'] });
    const d = makeParticipant('d', { interests: ['cooking'] });
    const engine = new MatchingEngineV1();
    const round = engine.generateRound([a, b, c, d], config, new Set(), [], 1);
    const placed = placedPairs(round);
    // Highest-score pairs win when freshness is tied.
    expect(placed.has(pairKey('a', 'b'))).toBe(true);
    expect(placed.has(pairKey('c', 'd'))).toBe(true);
  });
});
