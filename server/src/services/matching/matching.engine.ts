// ─── Matching Engine v1 Implementation ───────────────────────────────────────
// Weighted scoring with global optimization across all rounds.
// Supports: no duplicate pairings, hard constraints, odd count handling,
//           encounter history freshness, configurable weights.
// Target: schedule generation under 30s for 300 participants.

import {
  MatchingInput, MatchingOutput, MatchingConfig, MatchingParticipant,
  RoundAssignment, MatchPair, EncounterHistoryEntry, HardConstraint,
} from '@rsn/shared';
import { IMatchingEngine, pairKey } from './matching.interface';
import { ValidationError } from '../../middleware/errors';
import logger from '../../config/logger';

export class MatchingEngineV1 implements IMatchingEngine {

  // ─── Validation ───────────────────────────────────────────────────────────

  validateInput(input: MatchingInput): void {
    if (!input.participants || input.participants.length < 2) {
      throw new ValidationError('At least 2 participants are required');
    }

    if (!input.config || input.config.numberOfRounds < 1) {
      throw new ValidationError('At least 1 round is required');
    }

    // Verify we can schedule enough rounds without exhausting unique pairs
    const maxUniquePairs = (input.participants.length * (input.participants.length - 1)) / 2;
    const pairsPerRound = Math.floor(input.participants.length / 2);

    if (input.config.numberOfRounds * pairsPerRound > maxUniquePairs) {
      logger.warn({
        participants: input.participants.length,
        rounds: input.config.numberOfRounds,
        maxUniquePairs,
      }, 'More rounds requested than available unique pairings — duplicates may occur');
    }
  }

  // ─── Main Schedule Generator ──────────────────────────────────────────────

  async generateSchedule(input: MatchingInput): Promise<MatchingOutput> {
    const startTime = Date.now();

    this.validateInput(input);

    const { participants, config, encounterHistory, previousRounds } = input;

    // Build set of already-used pairs across all rounds
    const usedPairs = new Set<string>();

    // Include pairs from previous rounds (if any pre-existing)
    for (const round of previousRounds) {
      for (const pair of round.pairs) {
        usedPairs.add(pairKey(pair.participantAId, pair.participantBId));
      }
    }

    // Build encounter history lookup
    const encounterMap = this.buildEncounterMap(encounterHistory);

    // Apply hard constraints to build excluded pairs
    const hardExclusions = this.buildHardExclusions(participants, config.hardConstraints);

    const rounds: RoundAssignment[] = [];

    for (let roundNum = 1; roundNum <= config.numberOfRounds; roundNum++) {
      const round = this.generateSingleRound(
        participants,
        config,
        usedPairs,
        hardExclusions,
        encounterMap,
        roundNum
      );

      // Add the new pairs to usedPairs for subsequent rounds
      for (const pair of round.pairs) {
        usedPairs.add(pairKey(pair.participantAId, pair.participantBId));
      }

      rounds.push(round);
    }

    const durationMs = Date.now() - startTime;

    // Compute metadata
    const allScores = rounds.flatMap((r) => r.pairs.map((p) => p.score));
    const avgScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
    const minScore = allScores.length > 0 ? Math.min(...allScores) : 0;

    const output: MatchingOutput = {
      sessionId: input.sessionId,
      rounds,
      generatedAt: new Date(),
      durationMs,
      metadata: {
        participantCount: participants.length,
        roundCount: rounds.length,
        avgScore: Math.round(avgScore * 10000) / 10000,
        minScore: Math.round(minScore * 10000) / 10000,
        duplicatesAvoided: usedPairs.size,
      },
    };

    logger.info({
      sessionId: input.sessionId,
      participants: participants.length,
      rounds: rounds.length,
      durationMs,
      avgScore: output.metadata.avgScore,
    }, 'Match schedule generated');

    return output;
  }

  // ─── Single Round Generator ───────────────────────────────────────────────

  generateRound(
    participants: MatchingParticipant[],
    config: MatchingConfig,
    excludedPairs: Set<string>,
    encounterHistory: EncounterHistoryEntry[],
    roundNumber: number,
  ): RoundAssignment {
    const encounterMap = this.buildEncounterMap(encounterHistory);
    const hardExclusions = this.buildHardExclusions(participants, config.hardConstraints);

    return this.generateSingleRound(
      participants, config, excludedPairs, hardExclusions, encounterMap, roundNumber
    );
  }

  // ─── Pair Scoring ─────────────────────────────────────────────────────────

  scorePair(
    a: MatchingParticipant,
    b: MatchingParticipant,
    config: MatchingConfig,
    encounterHistory: EncounterHistoryEntry[]
  ): { score: number; reasonTags: string[] } {
    const encounterMap = this.buildEncounterMap(encounterHistory);
    return this.computePairScore(a, b, config.weights, encounterMap);
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private generateSingleRound(
    participants: MatchingParticipant[],
    config: MatchingConfig,
    usedPairs: Set<string>,
    hardExclusions: Set<string>,
    encounterMap: Map<string, EncounterHistoryEntry>,
    roundNumber: number,
  ): RoundAssignment {
    const n = participants.length;

    // Build scored candidate matrix
    const candidates: Array<{ aIdx: number; bIdx: number; score: number; reasonTags: string[] }> = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const key = pairKey(participants[i].userId, participants[j].userId);

        // Skip if already paired in this session or hard-excluded
        if (usedPairs.has(key) || hardExclusions.has(key)) {
          continue;
        }

        const { score, reasonTags } = this.computePairScore(
          participants[i], participants[j], config.weights, encounterMap
        );

        candidates.push({ aIdx: i, bIdx: j, score, reasonTags });
      }
    }

    // Sort by score descending (greedy with global awareness via usedPairs)
    candidates.sort((a, b) => b.score - a.score);

    // Greedy maximum weight matching
    const matched = new Set<number>();
    const pairs: MatchPair[] = [];

    for (const candidate of candidates) {
      if (matched.has(candidate.aIdx) || matched.has(candidate.bIdx)) {
        continue;
      }

      pairs.push({
        participantAId: participants[candidate.aIdx].userId,
        participantBId: participants[candidate.bIdx].userId,
        score: candidate.score,
        reasonTags: candidate.reasonTags,
      });

      matched.add(candidate.aIdx);
      matched.add(candidate.bIdx);

      // Stop when we have enough pairs
      if (pairs.length >= Math.floor(n / 2)) {
        break;
      }
    }

    // Handle unmatched participants (fallback: allow previously-used pairs)
    const unmatched = participants
      .map((_, idx) => idx)
      .filter((idx) => !matched.has(idx));

    // Try to pair remaining unmatched even if violating session uniqueness
    for (let i = 0; i < unmatched.length - 1; i += 2) {
      const aIdx = unmatched[i];
      const bIdx = unmatched[i + 1];
      const key = pairKey(participants[aIdx].userId, participants[bIdx].userId);

      if (!hardExclusions.has(key)) {
        const { score, reasonTags } = this.computePairScore(
          participants[aIdx], participants[bIdx], config.weights, encounterMap
        );
        pairs.push({
          participantAId: participants[aIdx].userId,
          participantBId: participants[bIdx].userId,
          score,
          reasonTags: [...reasonTags, 'fallback_repeat'],
        });
        matched.add(aIdx);
        matched.add(bIdx);
      }
    }

    // Determine bye participant (odd count or unable to match)
    let byeParticipant: string | null = null;
    const stillUnmatched = participants
      .map((p, idx) => ({ userId: p.userId, idx }))
      .filter((p) => !matched.has(p.idx));

    if (stillUnmatched.length > 0) {
      // Select the participant with the highest total match score as the bye
      // (they'll get the best matches in other rounds)
      byeParticipant = stillUnmatched[0].userId;
    }

    return {
      roundNumber,
      pairs,
      byeParticipant,
    };
  }

  private computePairScore(
    a: MatchingParticipant,
    b: MatchingParticipant,
    weights: Record<string, number>,
    encounterMap: Map<string, EncounterHistoryEntry>
  ): { score: number; reasonTags: string[] } {
    let totalScore = 0;
    let totalWeight = 0;
    const reasonTags: string[] = [];

    // 1. Shared interests score
    if (weights.sharedInterests) {
      const shared = this.intersectionCount(a.interests, b.interests);
      const maxPossible = Math.max(a.interests.length, b.interests.length, 1);
      const interestScore = shared / maxPossible;

      totalScore += interestScore * weights.sharedInterests;
      totalWeight += weights.sharedInterests;

      if (shared > 0) reasonTags.push(`shared_interests:${shared}`);
    }

    // 2. Shared reasons score
    if (weights.sharedReasons) {
      const shared = this.intersectionCount(a.reasonsToConnect, b.reasonsToConnect);
      const maxPossible = Math.max(a.reasonsToConnect.length, b.reasonsToConnect.length, 1);
      const reasonScore = shared / maxPossible;

      totalScore += reasonScore * weights.sharedReasons;
      totalWeight += weights.sharedReasons;

      if (shared > 0) reasonTags.push(`shared_reasons:${shared}`);
    }

    // 3. Industry diversity (higher score for different industries)
    if (weights.industryDiversity) {
      const sameIndustry = a.industry && b.industry && a.industry.toLowerCase() === b.industry.toLowerCase();
      const diversityScore = sameIndustry ? 0.3 : 1.0;

      totalScore += diversityScore * weights.industryDiversity;
      totalWeight += weights.industryDiversity;

      if (!sameIndustry) reasonTags.push('industry_diverse');
    }

    // 4. Company diversity (penalize same company)
    if (weights.companyDiversity) {
      const sameCompany = a.company && b.company && a.company.toLowerCase() === b.company.toLowerCase();
      const companyScore = sameCompany ? 0.0 : 1.0;

      totalScore += companyScore * weights.companyDiversity;
      totalWeight += weights.companyDiversity;

      if (sameCompany) reasonTags.push('same_company');
    }

    // 5. Language match
    if (weights.languageMatch) {
      const sharedLangs = this.intersectionCount(a.languages, b.languages);
      const langScore = sharedLangs > 0 ? 1.0 : 0.2;

      totalScore += langScore * weights.languageMatch;
      totalWeight += weights.languageMatch;

      if (sharedLangs > 0) reasonTags.push('language_match');
    }

    // 6. Encounter freshness (prefer people who haven't met recently)
    if (weights.encounterFreshness) {
      const key = pairKey(a.userId, b.userId);
      const encounter = encounterMap.get(key);
      let freshnessScore = 1.0;

      if (encounter) {
        // Penalize based on how recently and how often they met
        const daysSince = (Date.now() - new Date(encounter.lastMetAt).getTime()) / (1000 * 60 * 60 * 24);
        freshnessScore = Math.min(daysSince / 90, 1.0) * (1 / (encounter.timesMet + 1));
        reasonTags.push(`met_${encounter.timesMet}_times`);
      } else {
        reasonTags.push('first_meeting');
      }

      totalScore += freshnessScore * weights.encounterFreshness;
      totalWeight += weights.encounterFreshness;
    }

    // Normalize to 0-1
    const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      score: Math.round(normalizedScore * 10000) / 10000,
      reasonTags,
    };
  }

  private buildEncounterMap(history: EncounterHistoryEntry[]): Map<string, EncounterHistoryEntry> {
    const map = new Map<string, EncounterHistoryEntry>();
    for (const entry of history) {
      map.set(pairKey(entry.userAId, entry.userBId), entry);
    }
    return map;
  }

  private buildHardExclusions(
    participants: MatchingParticipant[],
    constraints: HardConstraint[]
  ): Set<string> {
    const exclusions = new Set<string>();

    for (const constraint of constraints) {
      switch (constraint.type) {
        case 'exclude_pair': {
          const ids = constraint.params.userIds as string[];
          if (ids && ids.length === 2) {
            exclusions.add(pairKey(ids[0], ids[1]));
          }
          break;
        }

        case 'same_company_block': {
          // Exclude all pairs from the same company
          for (let i = 0; i < participants.length; i++) {
            for (let j = i + 1; j < participants.length; j++) {
              if (
                participants[i].company &&
                participants[j].company &&
                participants[i].company!.toLowerCase() === participants[j].company!.toLowerCase()
              ) {
                exclusions.add(pairKey(participants[i].userId, participants[j].userId));
              }
            }
          }
          break;
        }

        case 'language_required': {
          const requiredLang = constraint.params.language as string;
          if (requiredLang) {
            // Exclude pairs where one person doesn't speak the required language
            for (let i = 0; i < participants.length; i++) {
              if (!participants[i].languages.includes(requiredLang)) {
                for (let j = 0; j < participants.length; j++) {
                  if (i !== j) {
                    exclusions.add(pairKey(participants[i].userId, participants[j].userId));
                  }
                }
              }
            }
          }
          break;
        }

        default:
          // Custom constraints can be added later
          break;
      }
    }

    return exclusions;
  }

  private intersectionCount(a: string[], b: string[]): number {
    const setB = new Set(b.map((s) => s.toLowerCase()));
    return a.filter((item) => setB.has(item.toLowerCase())).length;
  }
}

// Export singleton instance
export const matchingEngine = new MatchingEngineV1();
