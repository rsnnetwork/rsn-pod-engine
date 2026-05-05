// ─── Phase 1 — Greedy completeness + Re-match jitter (5 May 2026 spec) ──
//
// Tests two architectural fixes shipped in Phase 1 of the full matching
// spec compliance rebuild:
//
// 1. Path 2 augmenting search — when the greedy core leaves >=2 people on
//    bye but a complete matching mathematically exists, the engine
//    backtracks to find it. Regression case: live event 3fc21cbb-... on
//    5 May, round 3, 6 participants with 2 prior rounds of history left
//    2 people on bye even though (173↔83), (5b↔ec), (c52↔c43) is a valid
//    full coverage.
//
// 2. Re-match jitter — when generateRound is called with regenerate=true,
//    pair scores get ±2.5% noise so visibly-tied pairs can swap order on
//    successive Re-match presses. Initial Generate (regenerate=false)
//    stays deterministic.

import { MatchingEngineV1 } from '../../../services/matching/matching.engine';
import { pairKey } from '../../../services/matching/matching.interface';
import { MatchingConfig, MatchingParticipant, MatchingWeights } from '@rsn/shared';

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

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

const DEFAULT_WEIGHTS: MatchingWeights = {
  sharedInterests: 0.25,
  sharedReasons: 0.25,
  industryDiversity: 0.15,
  companyDiversity: 0.15,
  languageMatch: 0.10,
  encounterFreshness: 0.10,
};

const config: MatchingConfig = {
  weights: DEFAULT_WEIGHTS,
  hardConstraints: [],
  numberOfRounds: 5,
  avoidDuplicates: true,
  globalOptimize: false,
};

describe('Phase 1 — Greedy completeness fallback (Path 2 augmenting search)', () => {
  describe('regression: session 3fc21cbb round 3 case', () => {
    // Six participants, two prior rounds matching the actual data from the
    // failing live event. Round 3 must produce 3 pairs, zero on bye.
    const participants = [
      makeParticipant('173'),
      makeParticipant('5b'),
      makeParticipant('83'),
      makeParticipant('c43'),
      makeParticipant('c52'),
      makeParticipant('ec'),
    ];

    // Used pairs from r1 + r2 (verified against live DB on 5 May 2026)
    const usedPairs = new Set<string>([
      // r1
      pairKey('173', 'c52'),
      pairKey('5b', 'c43'),
      pairKey('83', 'ec'),
      // r2
      pairKey('83', 'c43'),
      pairKey('173', '5b'),
      pairKey('c52', 'ec'),
    ]);

    it('produces 3 pairs in round 3 (no bye) — a complete matching exists', () => {
      const engine = new MatchingEngineV1();
      const round = engine.generateRound(participants, config, usedPairs, [], 3);

      expect(round.pairs.length).toBe(3);
      expect(round.byeParticipant).toBeNull();
      expect(round.byeParticipants || []).toHaveLength(0);
    });

    it('all six participants are placed in a pair (no one excluded)', () => {
      const engine = new MatchingEngineV1();
      const round = engine.generateRound(participants, config, usedPairs, [], 3);

      const placed = new Set<string>();
      for (const p of round.pairs) {
        placed.add(p.participantAId);
        placed.add(p.participantBId);
        if (p.participantCId) placed.add(p.participantCId);
      }
      expect(placed.size).toBe(6);
      ['173', '5b', '83', 'c43', 'c52', 'ec'].forEach(uid =>
        expect(placed.has(uid)).toBe(true),
      );
    });

    it('no pair from rounds 1 or 2 is repeated', () => {
      const engine = new MatchingEngineV1();
      const round = engine.generateRound(participants, config, usedPairs, [], 3);

      for (const p of round.pairs) {
        const key = pairKey(p.participantAId, p.participantBId);
        expect(usedPairs.has(key)).toBe(false);
      }
    });
  });

  describe('mathematically impossible cases still produce byes', () => {
    it('4 participants who have all met everyone → all 4 on bye', () => {
      const participants = [
        makeParticipant('a'),
        makeParticipant('b'),
        makeParticipant('c'),
        makeParticipant('d'),
      ];
      // Every possible pair already used.
      const usedPairs = new Set<string>([
        pairKey('a', 'b'),
        pairKey('a', 'c'),
        pairKey('a', 'd'),
        pairKey('b', 'c'),
        pairKey('b', 'd'),
        pairKey('c', 'd'),
      ]);

      const engine = new MatchingEngineV1();
      const round = engine.generateRound(participants, config, usedPairs, [], 4);
      expect(round.pairs.length).toBe(0);
      expect((round.byeParticipants || []).length).toBeGreaterThan(0);
    });
  });

  describe('Path 2 does not engage when greedy already complete', () => {
    it('greedy succeeds on first round (no prior history) → no fallback needed', () => {
      const participants = [
        makeParticipant('a'),
        makeParticipant('b'),
        makeParticipant('c'),
        makeParticipant('d'),
      ];
      const engine = new MatchingEngineV1();
      const round = engine.generateRound(participants, config, new Set(), [], 1);
      expect(round.pairs.length).toBe(2);
      expect(round.byeParticipant).toBeNull();
    });
  });
});

describe('Phase 1 — Re-match jitter (regenerate flag)', () => {
  // Six participants with light differentiation so multiple pairs can
  // tie on score — without jitter, sort order is deterministic.
  const participants = [
    makeParticipant('a', { interests: ['ai'] }),
    makeParticipant('b', { interests: ['ai'] }),
    makeParticipant('c', { interests: ['ai'] }),
    makeParticipant('d', { interests: ['ai'] }),
    makeParticipant('e', { interests: ['ai'] }),
    makeParticipant('f', { interests: ['ai'] }),
  ];

  it('regenerate=false produces identical output across runs (deterministic)', () => {
    const engine = new MatchingEngineV1();
    const r1 = engine.generateRound(participants, config, new Set(), [], 1, { regenerate: false });
    const r2 = engine.generateRound(participants, config, new Set(), [], 1, { regenerate: false });
    const r3 = engine.generateRound(participants, config, new Set(), [], 1);
    const sig = (round: { pairs: { participantAId: string; participantBId: string }[] }) =>
      round.pairs.map(p => pairKey(p.participantAId, p.participantBId)).sort().join('|');
    expect(sig(r1)).toBe(sig(r2));
    expect(sig(r1)).toBe(sig(r3));
  });

  it('regenerate=true produces at least 2 distinct outputs across many runs', () => {
    const engine = new MatchingEngineV1();
    const sigs = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = engine.generateRound(participants, config, new Set(), [], 1, { regenerate: true });
      const sig = r.pairs.map(p => pairKey(p.participantAId, p.participantBId)).sort().join('|');
      sigs.add(sig);
    }
    // With ±2.5% jitter and 6 tied participants, we expect to see swaps.
    expect(sigs.size).toBeGreaterThan(1);
  });

  it('regenerate=true still produces a complete matching (no participant unfairly byed by jitter)', () => {
    const engine = new MatchingEngineV1();
    for (let i = 0; i < 20; i++) {
      const r = engine.generateRound(participants, config, new Set(), [], 1, { regenerate: true });
      expect(r.pairs.length).toBe(3);
      expect(r.byeParticipant).toBeNull();
    }
  });
});

describe('Phase 1 — Re-match SQL hardening (architectural pin)', () => {
  // Source-grep pin: handleHostRegenerateMatches must DELETE all matches
  // for the pending round (not just scheduled/cancelled), and must call
  // generateSingleRound with regenerate=true.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../../services/orchestration/handlers/matching-flow.ts'),
    'utf8',
  );

  it('handleHostRegenerateMatches DELETE no longer filters by status', () => {
    const fnStart = src.indexOf('export async function handleHostRegenerateMatches(');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    // Pull just the DELETE call (not the comment block that references the
    // pre-fix behaviour for context).
    const deleteCallMatch = fn.match(/await query\(\s*`DELETE FROM matches[\s\S]*?`,[\s\S]*?\);/);
    expect(deleteCallMatch).not.toBeNull();
    const deleteCall = deleteCallMatch![0];
    expect(deleteCall).toMatch(/DELETE FROM matches WHERE session_id = \$1 AND round_number = \$2/);
    expect(deleteCall).not.toMatch(/status IN \(/);
  });

  it('handleHostRegenerateMatches passes regenerate: true to generateSingleRound', () => {
    const fnStart = src.indexOf('export async function handleHostRegenerateMatches(');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toMatch(/generateSingleRound\([\s\S]+?regenerate:\s*true/);
  });
});

describe('Phase 1 — migration 057 unique pair-per-round index', () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../db/migrations/057_matches_unique_pair_per_round.sql'),
    'utf8',
  );

  it('creates a unique expression index on (session, round, LEAST/GREATEST pair)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_unique_pair_per_round/);
    expect(sql).toMatch(/LEAST\(participant_a_id, participant_b_id\)/);
    expect(sql).toMatch(/GREATEST\(participant_a_id, participant_b_id\)/);
  });

  it('scoped to 2-person matches (excludes trios)', () => {
    expect(sql).toMatch(/WHERE participant_b_id IS NOT NULL[\s\S]+?participant_c_id IS NULL/);
  });

  it('aborts with a clear message if duplicates already exist', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'Migration 057 aborted/);
  });
});
