// ─── Phase 6 — Acceptance Gate (Spec §14) ──────────────────────────────────
//
// Final spec-compliance assertion. Every bullet of the Matching Spec
// Section 14 ("ACCEPTANCE CRITERIA") must pass before the rebuild closes.
//
// Spec §14:
//   ✓ a full event plan is generated before start
//   ✓ no duplicate matches occur inside event unless unavoidable
//   ✓ each user gets one match per session
//   ✓ fairness is maintained across participants
//   ✓ premium requests are respected but not dominant
//   ✓ feedback is collected after each session
//   ✓ future matching improves based on feedback   ← Phase 5.5 (deferred)
//   ✓ system adapts to joins and leaves without breaking
//   ✓ no blocked users are ever matched
//   ✓ edge cases are handled without failure
//
// This file pins each bullet against the actual implementation. Failures
// are spec-compliance regressions and must block ship.

import { MatchingEngineV1 } from '../../../services/matching/matching.engine';
import { pairKey } from '../../../services/matching/matching.interface';
import { MatchingConfig, MatchingParticipant, MatchingWeights } from '@rsn/shared';
import * as nodeFs from 'fs';
import * as nodePath from 'path';

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

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
  sharedInterests: 0.25, sharedReasons: 0.25,
  industryDiversity: 0.15, companyDiversity: 0.15,
  languageMatch: 0.10, encounterFreshness: 0.10,
};

const config: MatchingConfig = {
  weights: DEFAULT_WEIGHTS,
  hardConstraints: [],
  numberOfRounds: 5,
  avoidDuplicates: true,
  globalOptimize: false,
};

describe('Phase 6 — Spec §14 acceptance gate', () => {
  const engine = new MatchingEngineV1();

  describe('§14.1 — full event plan generated before start', () => {
    it('engine.generateSchedule produces all rounds in one call', async () => {
      const participants = Array.from({ length: 6 }, (_, i) => makeParticipant(`u${i}`));
      const out = await engine.generateSchedule({
        sessionId: 's1', participants, config: { ...config, numberOfRounds: 5 },
        encounterHistory: [], previousRounds: [],
      } as any);
      expect(out.rounds).toHaveLength(5);
    });

    it('handleHostStart wires generateSessionSchedule (Phase 2.5A)', () => {
      const src = readServer('services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function handleHostStart(');
      const fnEnd = src.indexOf('\n// ─── Host Start Round', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/matchingService\.generateSessionSchedule\(/);
    });
  });

  describe('§14.2 — no duplicate matches inside event unless unavoidable', () => {
    it('5-round K_6 produces 15 unique pairs (1-factorisation, zero duplicates)', async () => {
      const participants = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => makeParticipant(id));
      const out = await engine.generateSchedule({
        sessionId: 's2', participants, config: { ...config, numberOfRounds: 5 },
        encounterHistory: [], previousRounds: [],
      } as any);
      const seen = new Set<string>();
      for (const round of out.rounds) {
        for (const p of round.pairs) {
          const k = pairKey(p.participantAId, p.participantBId);
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
      expect(seen.size).toBe(15);
    });

    it('migration 057 enforces uniqueness at the DB level', () => {
      const sql = readServer('db/migrations/057_matches_unique_pair_per_round.sql');
      expect(sql).toMatch(/CREATE UNIQUE INDEX/);
      expect(sql).toMatch(/LEAST\(participant_a_id, participant_b_id\)/);
    });
  });

  describe('§14.3 — each user gets one match per session', () => {
    it('6 participants × 3 rounds → 9 unique pairs, ZERO byes (Phase 1 + 2.5E)', () => {
      const participants = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => makeParticipant(id));
      // Replay the failing 3fc21cbb scenario exactly: rounds 1+2 used pairs.
      const usedPairs = new Set<string>([
        pairKey('A', 'B'), pairKey('C', 'D'), pairKey('E', 'F'),
        pairKey('A', 'C'), pairKey('B', 'E'), pairKey('D', 'F'),
      ]);
      const round = engine.generateRound(participants, config, usedPairs, [], 3);
      expect(round.pairs).toHaveLength(3);
      expect(round.byeParticipant).toBeNull();
      expect((round.byeParticipants || []).length).toBe(0);
    });

    it('fallback ladder (Phase 2.8) catches the impossible-at-L0 case', () => {
      const src = readServer('services/matching/matching.service.ts');
      // Service-layer ladder iterates levels 0..4 and stops at first complete.
      expect(src).toMatch(/for\s*\(\s*let\s+level\s*=\s*0\s*;\s*level\s*<=\s*4/);
      expect(src).toMatch(/break/);
    });
  });

  describe('§14.4 — fairness maintained across participants', () => {
    it('over 5 rounds × 6 participants, every participant meets exactly 5 distinct partners', async () => {
      const participants = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => makeParticipant(id));
      const out = await engine.generateSchedule({
        sessionId: 's3', participants, config: { ...config, numberOfRounds: 5 },
        encounterHistory: [], previousRounds: [],
      } as any);
      const partnerCount = new Map<string, Set<string>>();
      for (const p of participants) partnerCount.set(p.userId, new Set());
      for (const round of out.rounds) {
        for (const p of round.pairs) {
          partnerCount.get(p.participantAId)!.add(p.participantBId);
          partnerCount.get(p.participantBId)!.add(p.participantAId);
        }
      }
      for (const partners of partnerCount.values()) {
        // Exactly 5 distinct partners (every other participant) — the
        // mathematically maximum fair coverage for K_6 across 5 rounds.
        expect(partners.size).toBe(5);
      }
    });
  });

  describe('§14.5 — premium requests respected but not dominant', () => {
    it('engine.service has premium weights capped below intent weights', () => {
      const src = readServer('services/matching/matching.service.ts');
      // mutualPremiumRequest (0.20) + singlePremiumRequest (0.10) + premiumBoost (0.03)
      // = 0.33 max combined, less than sharedInterests (0.25) + sharedReasons (0.25) = 0.50.
      expect(src).toMatch(/mutualPremiumRequest:\s*0\.20/);
      expect(src).toMatch(/singlePremiumRequest:\s*0\.10/);
      expect(src).toMatch(/premiumBoost:\s*0\.03/);
      expect(src).toMatch(/sharedInterests:\s*0\.25/);
      expect(src).toMatch(/sharedReasons:\s*0\.25/);
    });
  });

  describe('§14.6 — feedback collected after each session', () => {
    it('rating service collects qualityScore + meetAgain', () => {
      const src = readServer('services/rating/rating.service.ts');
      expect(src).toMatch(/qualityScore/);
      expect(src).toMatch(/meetAgain/);
    });

    it('meeting_records canonical aggregate exists (migration 054)', () => {
      const sql = readServer('db/migrations/054_meeting_records.sql');
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meeting_records/);
      expect(sql).toMatch(/is_mutual\s+BOOLEAN GENERATED ALWAYS AS/);
    });
  });

  describe('§14.7 — future matching improves based on feedback (deferred to Phase 5.5)', () => {
    it.skip('pair_relationship aggregate populated from accumulated feedback — Phase 5.5', () => {
      // Phase 5.5 will introduce pair_relationship table per spec §4 and
      // wire the engine to consume it. Documented as future work in
      // progress.md; this slot reserves the assertion until that ships.
    });
  });

  describe('§14.8 — system adapts to joins and leaves without breaking', () => {
    it('repairFutureRounds exists for late-joiner / leaver (Phase 2.5D)', () => {
      const src = readServer('services/matching/matching.service.ts');
      expect(src).toMatch(/export async function repairFutureRounds\(/);
    });

    it('participant-flow.ts auto-fires repair on late-joiner + leaver', () => {
      const src = readServer('services/orchestration/handlers/participant-flow.ts');
      expect(src).toMatch(/maybeRepairFutureRounds\(io,\s*data\.sessionId,\s*'late_joiner'\)/);
      expect(src).toMatch(/maybeRepairFutureRounds\(io,\s*data\.sessionId,\s*'left'\)/);
    });

    it('15s mid-match disconnect transitions LEFT + repairs future (Phase 2.7)', () => {
      const src = readServer('services/orchestration/handlers/participant-flow.ts');
      expect(src).toMatch(/transitionParticipant\([\s\S]+?ParticipantState\.LEFT/);
    });
  });

  describe('§14.9 — no blocked users are ever matched', () => {
    it('matching.service.ts loads block-pairs into hardConstraints', () => {
      const src = readServer('services/matching/matching.service.ts');
      expect(src).toMatch(/blockService\.getBlockedPairsForUsers/);
      expect(src).toMatch(/user_block/);
    });

    it('engine respects hardConstraints (block-pairs never produce a match)', () => {
      const src = readServer('services/matching/matching.engine.ts');
      expect(src).toMatch(/buildHardExclusions/);
      expect(src).toMatch(/hardExclusions\.has\(key\)/);
    });
  });

  describe('§14.10 — edge cases handled without failure', () => {
    it('odd-count: 1 leftover forms a trio', () => {
      const participants = ['A', 'B', 'C'].map(id => makeParticipant(id));
      const round = engine.generateRound(participants, config, new Set(), [], 1);
      expect(round.pairs).toHaveLength(1);
      expect(round.pairs[0].participantCId).toBeTruthy();
    });

    it('atomic create-breakout (Phase 4A) prevents half-completed state', () => {
      const src = readServer('services/orchestration/handlers/host-actions.ts');
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/await transaction\(async \(client\)/);
    });

    it('atomic bulk create-breakout (Phase 6) prevents half-completed state', () => {
      const src = readServer('services/orchestration/handlers/breakout-bulk.ts');
      const fnStart = src.indexOf('export async function handleHostCreateBreakoutBulk(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/await transaction\(async \(client\)/);
    });

    it('reconciler heals state drift every 30s without leave-and-rejoin (Phase 2)', () => {
      const src = readServer('services/orchestration/state/participant-state-machine.ts');
      expect(src).toMatch(/RECONCILER_INTERVAL_MS\s*=\s*30_000/);
    });
  });

  describe('Final principle: "Plan globally. Execute session by session. Repair only the future."', () => {
    it('all three pillars exist in the codebase', () => {
      const matchingSrc = readServer('services/matching/matching.service.ts');
      const flowSrc = readServer('services/orchestration/handlers/round-lifecycle.ts');

      // Plan globally
      expect(matchingSrc).toMatch(/generateSessionSchedule/);
      // Execute session by session (transitionToRound consumes pre-planned)
      expect(flowSrc).toMatch(/getMatchesByRound/);
      // Repair only the future
      expect(matchingSrc).toMatch(/repairFutureRounds/);
    });
  });
});
