// ─── Matching Engine v1 Tests ────────────────────────────────────────────────
// Tests the pure matching algorithm — no database, no I/O.

import { MatchingEngineV1 } from '../../services/matching/matching.engine';
import { pairKey } from '../../services/matching/matching.interface';
import {
  MatchingInput, MatchingConfig, MatchingParticipant,
  EncounterHistoryEntry, HardConstraint, MatchingWeights,
} from '@rsn/shared';

// Mock logger
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeParticipant(overrides: Partial<MatchingParticipant> & { userId: string }): MatchingParticipant {
  return {
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

function makeConfig(overrides?: Partial<MatchingConfig>): MatchingConfig {
  return {
    weights: DEFAULT_WEIGHTS,
    hardConstraints: [],
    numberOfRounds: 1,
    avoidDuplicates: true,
    globalOptimize: true,
    ...overrides,
  };
}

function makeInput(
  participants: MatchingParticipant[],
  configOverrides?: Partial<MatchingConfig>,
  encounterHistory: EncounterHistoryEntry[] = [],
): MatchingInput {
  return {
    sessionId: 'test-session-1',
    participants,
    config: makeConfig(configOverrides),
    encounterHistory,
    previousRounds: [],
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('MatchingEngineV1', () => {
  let engine: MatchingEngineV1;

  beforeEach(() => {
    engine = new MatchingEngineV1();
  });

  // ─── Validation ─────────────────────────────────────────────────────────

  describe('validateInput', () => {
    it('should throw when fewer than 2 participants', () => {
      const input = makeInput([makeParticipant({ userId: 'a' })]);
      expect(() => engine.validateInput(input)).toThrow('At least 2 participants');
    });

    it('should throw when 0 rounds', () => {
      const input = makeInput(
        [makeParticipant({ userId: 'a' }), makeParticipant({ userId: 'b' })],
        { numberOfRounds: 0 },
      );
      expect(() => engine.validateInput(input)).toThrow('At least 1 round');
    });

    it('should accept 2 participants with 1 round', () => {
      const input = makeInput([
        makeParticipant({ userId: 'a' }),
        makeParticipant({ userId: 'b' }),
      ]);
      expect(() => engine.validateInput(input)).not.toThrow();
    });

    it('should warn but not throw when too many rounds requested', () => {
      // 3 participants → max 3 unique pairs, 1 pair per round → max 3 rounds
      const input = makeInput(
        [
          makeParticipant({ userId: 'a' }),
          makeParticipant({ userId: 'b' }),
          makeParticipant({ userId: 'c' }),
        ],
        { numberOfRounds: 10 },
      );
      expect(() => engine.validateInput(input)).not.toThrow();
    });
  });

  // ─── Basic Pairing ───────────────────────────────────────────────────────

  describe('generateSchedule — basic cases', () => {
    it('should pair 2 participants into 1 match', async () => {
      const input = makeInput([
        makeParticipant({ userId: 'alice' }),
        makeParticipant({ userId: 'bob' }),
      ]);

      const output = await engine.generateSchedule(input);

      expect(output.rounds).toHaveLength(1);
      expect(output.rounds[0].pairs).toHaveLength(1);
      const pair = output.rounds[0].pairs[0];
      expect([pair.participantAId, pair.participantBId].sort()).toEqual(['alice', 'bob']);
      expect(output.rounds[0].byeParticipant).toBeNull();
    });

    it('should pair 4 participants into 2 matches per round', async () => {
      const input = makeInput([
        makeParticipant({ userId: 'a' }),
        makeParticipant({ userId: 'b' }),
        makeParticipant({ userId: 'c' }),
        makeParticipant({ userId: 'd' }),
      ]);

      const output = await engine.generateSchedule(input);

      expect(output.rounds[0].pairs).toHaveLength(2);
      const allParticipants = output.rounds[0].pairs.flatMap((p: any) => [p.participantAId, p.participantBId]);
      expect(allParticipants.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('should handle odd count with trio instead of bye', async () => {
      const input = makeInput([
        makeParticipant({ userId: 'a' }),
        makeParticipant({ userId: 'b' }),
        makeParticipant({ userId: 'c' }),
      ]);

      const output = await engine.generateSchedule(input);

      // With 3 participants, engine forms a trio (no bye)
      expect(output.rounds[0].pairs).toHaveLength(1);
      expect(output.rounds[0].byeParticipant).toBeNull();
      const trioPair = output.rounds[0].pairs[0];
      expect(trioPair.participantCId).toBeDefined();
      expect(trioPair.participantCId).not.toBeNull();
      // All 3 participants should be in the trio
      const allIds = [trioPair.participantAId, trioPair.participantBId, trioPair.participantCId].sort();
      expect(allIds).toEqual(['a', 'b', 'c']);
    });
  });

  // ─── Multi-round Uniqueness ───────────────────────────────────────────────

  describe('generateSchedule — multi-round', () => {
    it('should avoid duplicate pairs across rounds', async () => {
      const participants = ['a', 'b', 'c', 'd'].map(id => makeParticipant({ userId: id }));
      const input = makeInput(participants, { numberOfRounds: 3 });

      const output = await engine.generateSchedule(input);

      expect(output.rounds).toHaveLength(3);

      // Collect all pair keys
      const allPairKeys: string[] = [];
      for (const round of output.rounds) {
        for (const pair of round.pairs) {
          allPairKeys.push(pairKey(pair.participantAId, pair.participantBId));
        }
      }

      // With 4 participants there are C(4,2)=6 unique pairs, 2 pairs per round × 3 rounds = 6
      // So all 6 pairs should be used exactly once
      const uniqueKeys = new Set(allPairKeys);
      expect(uniqueKeys.size).toBe(6);
    });

    it('should give bye rounds when all unique pairs exhausted (no repeat matches)', async () => {
      // 3 participants → max 3 unique pairs, 1 pair per round.
      // Requesting 5 rounds means rounds 4+ have no unique pairs left — participants get bye.
      const participants = ['a', 'b', 'c'].map(id => makeParticipant({ userId: id }));
      const input = makeInput(participants, { numberOfRounds: 5 });

      const output = await engine.generateSchedule(input);

      expect(output.rounds).toHaveLength(5);
      // First 3 rounds should each have 1 pair (3 unique pairs available)
      for (let i = 0; i < 3; i++) {
        expect(output.rounds[i].pairs.length).toBe(1);
      }
      // Rounds 4+ should have no pairs (all unique pairs exhausted) and warnings
      for (let i = 3; i < 5; i++) {
        expect(output.rounds[i].pairs.length).toBe(0);
        expect(output.rounds[i].warnings).toBeDefined();
        expect(output.rounds[i].warnings!.length).toBeGreaterThan(0);
      }
      // No pair should appear twice across all rounds (no-repeat rule)
      const allPairKeys = output.rounds.flatMap(r =>
        r.pairs.map(p => [p.participantAId, p.participantBId].sort().join(':'))
      );
      const uniqueKeys = new Set(allPairKeys);
      expect(uniqueKeys.size).toBe(allPairKeys.length);
    });
  });

  // ─── Scoring ──────────────────────────────────────────────────────────────

  describe('scorePair', () => {
    it('should score higher for shared interests', () => {
      const a = makeParticipant({ userId: 'a', interests: ['tech', 'music', 'design'] });
      const b = makeParticipant({ userId: 'b', interests: ['tech', 'music', 'sports'] });
      const c = makeParticipant({ userId: 'c', interests: ['cooking', 'reading', 'hiking'] });

      const config = makeConfig();
      const scoreAB = engine.scorePair(a, b, config, []);
      const scoreAC = engine.scorePair(a, c, config, []);

      expect(scoreAB.score).toBeGreaterThan(scoreAC.score);
      expect(scoreAB.reasonTags).toContain('shared_interests:2');
    });

    it('should prefer industry diversity (different industries)', () => {
      const a = makeParticipant({ userId: 'a', industry: 'tech' });
      const b = makeParticipant({ userId: 'b', industry: 'finance' });
      const c = makeParticipant({ userId: 'c', industry: 'tech' });

      const config = makeConfig({
        weights: {
          sharedInterests: 0, sharedReasons: 0,
          industryDiversity: 1.0, companyDiversity: 0,
          languageMatch: 0, encounterFreshness: 0,
        },
      });

      const scoreAB = engine.scorePair(a, b, config, []);
      const scoreAC = engine.scorePair(a, c, config, []);

      expect(scoreAB.score).toBeGreaterThan(scoreAC.score);
      expect(scoreAB.reasonTags).toContain('industry_diverse');
    });

    it('should penalize same company', () => {
      const a = makeParticipant({ userId: 'a', company: 'Acme Corp' });
      const b = makeParticipant({ userId: 'b', company: 'Acme Corp' });
      const c = makeParticipant({ userId: 'c', company: 'Other Inc' });

      const config = makeConfig({
        weights: {
          sharedInterests: 0, sharedReasons: 0,
          industryDiversity: 0, companyDiversity: 1.0,
          languageMatch: 0, encounterFreshness: 0,
        },
      });

      const scoreAB = engine.scorePair(a, b, config, []);
      const scoreAC = engine.scorePair(a, c, config, []);

      expect(scoreAC.score).toBeGreaterThan(scoreAB.score);
      expect(scoreAB.reasonTags).toContain('same_company');
    });

    it('should score language match', () => {
      const a = makeParticipant({ userId: 'a', languages: ['english', 'spanish'] });
      const b = makeParticipant({ userId: 'b', languages: ['english', 'french'] });
      const c = makeParticipant({ userId: 'c', languages: ['mandarin', 'japanese'] });

      const config = makeConfig({
        weights: {
          sharedInterests: 0, sharedReasons: 0,
          industryDiversity: 0, companyDiversity: 0,
          languageMatch: 1.0, encounterFreshness: 0,
        },
      });

      const scoreAB = engine.scorePair(a, b, config, []);
      const scoreAC = engine.scorePair(a, c, config, []);

      expect(scoreAB.score).toBeGreaterThan(scoreAC.score);
      expect(scoreAB.reasonTags).toContain('language_match');
    });

    it('should favor first meetings over repeated encounters', () => {
      const a = makeParticipant({ userId: 'a' });
      const b = makeParticipant({ userId: 'b' });
      const c = makeParticipant({ userId: 'c' });

      const config = makeConfig({
        weights: {
          sharedInterests: 0, sharedReasons: 0,
          industryDiversity: 0, companyDiversity: 0,
          languageMatch: 0, encounterFreshness: 1.0,
        },
      });

      const history: EncounterHistoryEntry[] = [{
        userAId: 'a',
        userBId: 'b',
        timesMet: 3,
        lastMetAt: new Date(),
      }];

      const scoreAB = engine.scorePair(a, b, config, history);
      const scoreAC = engine.scorePair(a, c, config, []);

      expect(scoreAC.score).toBeGreaterThan(scoreAB.score);
      expect(scoreAC.reasonTags).toContain('first_meeting');
    });

    it('should return score between 0 and 1', () => {
      const a = makeParticipant({
        userId: 'a', interests: ['tech'], languages: ['english'],
        industry: 'tech', company: 'Acme',
      });
      const b = makeParticipant({
        userId: 'b', interests: ['sports'], languages: ['french'],
        industry: 'finance', company: 'Other',
      });

      const config = makeConfig();
      const result = engine.scorePair(a, b, config, []);

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });
  });

  // ─── Hard Constraints ─────────────────────────────────────────────────────

  describe('hard constraints', () => {
    it('should respect exclude_pair constraint', async () => {
      const participants = [
        makeParticipant({ userId: 'a', interests: ['tech'] }),
        makeParticipant({ userId: 'b', interests: ['tech'] }),
        makeParticipant({ userId: 'c', interests: [] }),
        makeParticipant({ userId: 'd', interests: [] }),
      ];

      const constraints: HardConstraint[] = [{
        type: 'exclude_pair',
        params: { userIds: ['a', 'b'] },
      }];

      const input = makeInput(participants, { hardConstraints: constraints });
      const output = await engine.generateSchedule(input);

      // a-b should never be paired
      for (const round of output.rounds) {
        for (const pair of round.pairs) {
          const ids = [pair.participantAId, pair.participantBId].sort();
          expect(ids).not.toEqual(['a', 'b']);
        }
      }
    });

    it('should respect same_company_block constraint', async () => {
      const participants = [
        makeParticipant({ userId: 'a', company: 'Acme' }),
        makeParticipant({ userId: 'b', company: 'Acme' }),
        makeParticipant({ userId: 'c', company: 'Other' }),
        makeParticipant({ userId: 'd', company: 'Other' }),
      ];

      const constraints: HardConstraint[] = [{
        type: 'same_company_block',
        params: {},
      }];

      const input = makeInput(participants, { hardConstraints: constraints });
      const output = await engine.generateSchedule(input);

      for (const round of output.rounds) {
        for (const pair of round.pairs) {
          const pA = participants.find(p => p.userId === pair.participantAId)!;
          const pB = participants.find(p => p.userId === pair.participantBId)!;
          expect(pA.company?.toLowerCase()).not.toBe(pB.company?.toLowerCase());
        }
      }
    });

    it('should respect language_required constraint', async () => {
      const participants = [
        makeParticipant({ userId: 'a', languages: ['english', 'spanish'] }),
        makeParticipant({ userId: 'b', languages: ['spanish'] }),
        makeParticipant({ userId: 'c', languages: ['english'] }),
        makeParticipant({ userId: 'd', languages: ['english', 'spanish'] }),
      ];

      const constraints: HardConstraint[] = [{
        type: 'language_required',
        params: { language: 'spanish' },
      }];

      const input = makeInput(participants, { hardConstraints: constraints });
      const output = await engine.generateSchedule(input);

      // Only participants who speak Spanish should be paired
      for (const round of output.rounds) {
        for (const pair of round.pairs) {
          const pA = participants.find(p => p.userId === pair.participantAId)!;
          const pB = participants.find(p => p.userId === pair.participantBId)!;
          expect(pA.languages).toContain('spanish');
          expect(pB.languages).toContain('spanish');
        }
      }
    });
  });

  // ─── Metadata ─────────────────────────────────────────────────────────────

  describe('output metadata', () => {
    it('should include correct metadata', async () => {
      const participants = Array.from({ length: 6 }, (_, i) =>
        makeParticipant({ userId: `user-${i}`, interests: ['tech'] })
      );
      const input = makeInput(participants, { numberOfRounds: 2 });

      const output = await engine.generateSchedule(input);

      expect(output.sessionId).toBe('test-session-1');
      expect(output.rounds).toHaveLength(2);
      expect(output.generatedAt).toBeInstanceOf(Date);
      expect(output.durationMs).toBeGreaterThanOrEqual(0);
      expect(output.metadata.participantCount).toBe(6);
      expect(output.metadata.roundCount).toBe(2);
      expect(output.metadata.avgScore).toBeGreaterThanOrEqual(0);
      expect(output.metadata.avgScore).toBeLessThanOrEqual(1);
      expect(output.metadata.minScore).toBeLessThanOrEqual(output.metadata.avgScore);
    });
  });

  // ─── Performance ──────────────────────────────────────────────────────────

  describe('performance', () => {
    it('should handle 50 participants in under 2 seconds', async () => {
      const participants = Array.from({ length: 50 }, (_, i) =>
        makeParticipant({
          userId: `user-${i}`,
          interests: [`interest-${i % 5}`, `interest-${(i + 1) % 5}`],
          industry: `industry-${i % 10}`,
          company: `company-${i % 20}`,
          languages: ['english'],
        })
      );

      const input = makeInput(participants, { numberOfRounds: 5 });

      const start = Date.now();
      const output = await engine.generateSchedule(input);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2000);
      expect(output.rounds).toHaveLength(5);
      expect(output.rounds[0].pairs.length).toBe(25); // 50/2
    });
  });

  // ─── generateRound (single round) ────────────────────────────────────────

  describe('generateRound', () => {
    it('should generate a single round for given participants', () => {
      const participants = [
        makeParticipant({ userId: 'a' }),
        makeParticipant({ userId: 'b' }),
        makeParticipant({ userId: 'c' }),
        makeParticipant({ userId: 'd' }),
      ];

      const round = engine.generateRound(
        participants, makeConfig(), new Set(), [], 1
      );

      expect(round.roundNumber).toBe(1);
      expect(round.pairs).toHaveLength(2);
    });

    it('should respect excluded pairs', () => {
      const participants = [
        makeParticipant({ userId: 'a' }),
        makeParticipant({ userId: 'b' }),
        makeParticipant({ userId: 'c' }),
        makeParticipant({ userId: 'd' }),
      ];

      const excluded = new Set([pairKey('a', 'b'), pairKey('c', 'd')]);
      const round = engine.generateRound(
        participants, makeConfig(), excluded, [], 1,
      );

      for (const pair of round.pairs) {
        const key = pairKey(pair.participantAId, pair.participantBId);
        expect(excluded.has(key)).toBe(false);
      }
    });
  });
});

// ─── pairKey Tests ──────────────────────────────────────────────────────────

describe('pairKey utility', () => {
  it('should produce order-independent keys', () => {
    expect(pairKey('alice', 'bob')).toBe(pairKey('bob', 'alice'));
  });

  it('should produce different keys for different pairs', () => {
    expect(pairKey('alice', 'bob')).not.toBe(pairKey('alice', 'charlie'));
  });

  it('should use colon separator', () => {
    const key = pairKey('a', 'b');
    expect(key).toBe('a:b');
  });
});
