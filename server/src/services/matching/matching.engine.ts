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
      }, 'More rounds requested than available unique pairings — some participants will have bye rounds');
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
    options?: { regenerate?: boolean },
  ): RoundAssignment {
    const encounterMap = this.buildEncounterMap(encounterHistory);
    const hardExclusions = this.buildHardExclusions(participants, config.hardConstraints);

    return this.generateSingleRound(
      participants, config, excludedPairs, hardExclusions, encounterMap, roundNumber, options,
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
    const r = this.computePairScore(a, b, config.weights, encounterMap);
    // Public scorePair contract is { score, reasonTags } per IMatchingEngine
    // — premiumInfluenced is consumed internally by generateSingleRound.
    return { score: r.score, reasonTags: r.reasonTags };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private generateSingleRound(
    participants: MatchingParticipant[],
    config: MatchingConfig,
    usedPairs: Set<string>,
    hardExclusions: Set<string>,
    encounterMap: Map<string, EncounterHistoryEntry>,
    roundNumber: number,
    options?: { regenerate?: boolean },
  ): RoundAssignment {
    const n = participants.length;
    const regenerate = options?.regenerate === true;

    // Build scored candidate matrix
    const candidates: Array<{
      aIdx: number; bIdx: number;
      score: number; reasonTags: string[];
      premiumInfluenced: boolean;
      isRepeatInEvent: boolean;
    }> = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const key = pairKey(participants[i].userId, participants[j].userId);

        // Skip if already paired in this session or hard-excluded
        if (usedPairs.has(key) || hardExclusions.has(key)) {
          continue;
        }

        const r = this.computePairScore(
          participants[i], participants[j], config.weights, encounterMap
        );

        // Phase 1 (5 May spec) — Re-match jitter. ±2.5% noise is small
        // enough that clearly-best pairs still win on the first sort, but
        // big enough that near-tied pairs can swap order, so the host
        // sees the UI visibly do something on Re-match. Initial Generate
        // (regenerate=false) stays deterministic.
        const score = regenerate
          ? r.score * (1 + (Math.random() - 0.5) * 0.05)
          : r.score;

        candidates.push({
          aIdx: i, bIdx: j,
          score,
          reasonTags: r.reasonTags,
          premiumInfluenced: r.premiumInfluenced,
          isRepeatInEvent: false, // first pass — no repeats; flipped only if fallback engages
        });
      }
    }

    // Sort by score descending (greedy with global awareness via usedPairs)
    candidates.sort((a, b) => b.score - a.score);

    // Phase 2.5E (5 May spec §10 + §14) — for typical event sizes (≤30
    // participants), use the exact backtracking matcher as the PRIMARY
    // path instead of greedy. Backtracking always finds a complete
    // matching when one exists, scoring-descending, so quality is
    // preserved while the "greedy paints itself into a corner" failure
    // mode disappears entirely. Above 30 participants, fall through to
    // greedy (which is fast at scale) + the Phase-1 Path 2 fallback.
    const matched = new Set<number>();
    let pairs: MatchPair[] = [];

    if (n <= 30 && n >= 2 && n % 2 === 0) {
      const backtrackedComplete = this.findCompleteMatching(
        participants, candidates, usedPairs, hardExclusions,
      );
      if (backtrackedComplete) {
        for (const p of backtrackedComplete) {
          pairs.push(p);
          const aIdx = participants.findIndex(x => x.userId === p.participantAId);
          const bIdx = participants.findIndex(x => x.userId === p.participantBId);
          if (aIdx >= 0) matched.add(aIdx);
          if (bIdx >= 0) matched.add(bIdx);
        }
        // Cap to floor(n/2) — backtracking can't exceed this anyway.
      }
    }

    // Greedy fallback path: triggers for n > 30, odd n (1 leftover handled
    // by the trio path below), or backtracking-failed (no complete matching
    // exists in the candidate graph). Existing behaviour preserved.
    if (pairs.length === 0) {
      for (const candidate of candidates) {
        if (matched.has(candidate.aIdx) || matched.has(candidate.bIdx)) {
          continue;
        }

        // Matching Engine 1.0 spec, Section 13 — derive a single-tag reason
        // for admin/debug surfaces from the multi-tag list.
        const matchReason = candidate.reasonTags[0] || 'best_available';

        pairs.push({
          participantAId: participants[candidate.aIdx].userId,
          participantBId: participants[candidate.bIdx].userId,
          score: candidate.score,
          reasonTags: candidate.reasonTags,
          matchReason,
          fallbackUsed: false,
          repeatInEvent: candidate.isRepeatInEvent,
          premiumInfluenced: candidate.premiumInfluenced,
        });

        matched.add(candidate.aIdx);
        matched.add(candidate.bIdx);

        // Stop when we have enough pairs
        if (pairs.length >= Math.floor(n / 2)) {
          break;
        }
      }
    }

    // Phase 1 (5 May spec) — Path 2 augmenting search.
    // Greedy is locally optimal but not globally optimal: it can paint
    // itself into a corner where a complete matching exists but greedy
    // can't reach it. With 6 people in 3 rounds (e.g. session 3fc21cbb
    // r3), greedy left 2 people on bye despite a complete matching
    // existing. We brute-force search for a complete matching when:
    //   - greedy left >=2 people unmatched (1 leftover is handled by
    //     the trio path below; 0 leftover is already complete)
    //   - participant count is even (a complete matching is even possible)
    //   - participant count is small enough that backtracking is fast
    //     (≤30 covers every realistic event; the search space stays
    //     well under 100ms even at the cap)
    // If a complete matching is found, it REPLACES the greedy result.
    // If not, we fall through to trio/bye handling unchanged.
    const greedyUnmatched = participants
      .map((_, idx) => idx)
      .filter(idx => !matched.has(idx));

    if (greedyUnmatched.length >= 2 && n % 2 === 0 && n <= 30) {
      const completeMatching = this.findCompleteMatching(
        participants, candidates, usedPairs, hardExclusions,
      );
      if (completeMatching) {
        logger.info(
          { roundNumber, n, greedyByes: greedyUnmatched.length },
          'Path 2 augmenting search found complete matching where greedy failed',
        );
        // Replace greedy result with the complete matching
        pairs.length = 0;
        matched.clear();
        for (const p of completeMatching) {
          pairs.push(p);
          // Re-derive participant indices for the matched set so trio/bye
          // logic below operates on the new matching consistently.
          const aIdx = participants.findIndex(x => x.userId === p.participantAId);
          const bIdx = participants.findIndex(x => x.userId === p.participantBId);
          if (aIdx >= 0) matched.add(aIdx);
          if (bIdx >= 0) matched.add(bIdx);
        }
      }
    }

    // No fallback repeat logic — Dr Prompt hard rule: no repeat matches within same event.
    // Unmatched participants go directly to bye handling.

    // Handle unmatched — form trio instead of bye when exactly 1 leftover
    const stillUnmatched = participants
      .map((p, idx) => ({ userId: p.userId, idx }))
      .filter((p) => !matched.has(p.idx));

    let byeParticipant: string | null = null;
    const byeParticipants: string[] = [];
    const warnings: string[] = [];

    if (stillUnmatched.length === 1 && pairs.length > 0) {
      // Exactly one leftover — add to the best-fit existing pair to form a trio
      const leftover = stillUnmatched[0];
      let bestPairIdx = pairs.length - 1;
      let bestTrioScore = -1;

      for (let pi = 0; pi < pairs.length; pi++) {
        const aIdx = participants.findIndex(p => p.userId === pairs[pi].participantAId);
        const bIdx = participants.findIndex(p => p.userId === pairs[pi].participantBId);
        if (aIdx < 0 || bIdx < 0) continue;

        const scoreA = this.computePairScore(participants[leftover.idx], participants[aIdx], config.weights, encounterMap).score;
        const scoreB = this.computePairScore(participants[leftover.idx], participants[bIdx], config.weights, encounterMap).score;
        const avgScore = (scoreA + scoreB) / 2;

        if (avgScore > bestTrioScore) {
          bestTrioScore = avgScore;
          bestPairIdx = pi;
        }
      }

      pairs[bestPairIdx] = {
        ...pairs[bestPairIdx],
        participantCId: leftover.userId,
        reasonTags: [...pairs[bestPairIdx].reasonTags, 'trio'],
        // Trio creation is the spec's odd-count handling, not a fallback.
        matchReason: pairs[bestPairIdx].matchReason || 'trio',
      };
    } else if (stillUnmatched.length > 1) {
      // Multiple unmatched — all unique pairs exhausted, everyone gets bye
      for (const u of stillUnmatched) {
        byeParticipants.push(u.userId);
      }
      byeParticipant = stillUnmatched[0].userId; // backwards compat
      warnings.push(`All unique pairs exhausted — ${stillUnmatched.length} participants have bye rounds`);
      logger.warn({ roundNumber, byeCount: stillUnmatched.length, byeParticipants },
        'Multiple bye participants: unique pairs exhausted');
    }

    // ─── Duplicate user guard (belt-and-suspenders) ─────────────────────
    // HARD ENFORCEMENT: remove any pair containing a duplicate user.
    // At 200+ participants, even rare edge cases become likely.
    const seenUsers = new Set<string>();
    const cleanPairs: MatchPair[] = [];
    for (const pair of pairs) {
      const pairUsers = [pair.participantAId, pair.participantBId, pair.participantCId].filter(Boolean) as string[];
      const hasDuplicate = pairUsers.some(uid => seenUsers.has(uid));
      if (hasDuplicate) {
        // Remove this pair — send participants to bye instead of double-booking
        const duplicateUids = pairUsers.filter(uid => seenUsers.has(uid));
        logger.error({ duplicateUids, roundNumber, pairCount: pairs.length },
          'DUPLICATE USER IN MATCHES — removed pair, participants go to bye');
        for (const uid of pairUsers) {
          if (!seenUsers.has(uid)) byeParticipants.push(uid);
        }
        warnings.push(`Pair removed: duplicate user(s) ${duplicateUids.join(', ')} detected`);
      } else {
        for (const uid of pairUsers) seenUsers.add(uid);
        cleanPairs.push(pair);
      }
    }
    // Replace pairs with clean set
    pairs.length = 0;
    pairs.push(...cleanPairs);

    return {
      roundNumber,
      pairs,
      byeParticipant,
      ...(byeParticipants.length > 0 && { byeParticipants }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  private computePairScore(
    a: MatchingParticipant,
    b: MatchingParticipant,
    weights: Record<string, number | undefined>,
    encounterMap: Map<string, EncounterHistoryEntry>
  ): { score: number; reasonTags: string[]; premiumInfluenced: boolean } {
    let totalScore = 0;
    let totalWeight = 0;
    const reasonTags: string[] = [];
    let premiumInfluenced = false;

    // ── Matching Engine 1.0 spec, Section 7 — Premium boost layer ────
    // Applied BEFORE the diversity/freshness signals so premium presence
    // shows up in the reasonTags ranked first. Engine still caps total
    // boost so "premium cannot dominate all matches": the boosts feed
    // into the same weighted average; very high weights on these signals
    // would skew everything but the default config caps them at the
    // same magnitude as a single intent factor.
    const aRequestedB = (a.requestedUserIds || []).includes(b.userId);
    const bRequestedA = (b.requestedUserIds || []).includes(a.userId);
    const eitherPremium = !!a.isPremium || !!b.isPremium;

    if (aRequestedB && bRequestedA && weights.mutualPremiumRequest) {
      // Highest-priority premium signal per spec.
      totalScore += 1.0 * weights.mutualPremiumRequest;
      totalWeight += weights.mutualPremiumRequest;
      reasonTags.push('mutual_premium_request');
      premiumInfluenced = true;
    } else if ((aRequestedB || bRequestedA) && weights.singlePremiumRequest) {
      // Strong but lower than mutual.
      totalScore += 1.0 * weights.singlePremiumRequest;
      totalWeight += weights.singlePremiumRequest;
      reasonTags.push('premium_request');
      premiumInfluenced = true;
    } else if (eitherPremium && weights.premiumBoost) {
      // Modest lift for any pair containing a premium user.
      totalScore += 1.0 * weights.premiumBoost;
      totalWeight += weights.premiumBoost;
      reasonTags.push('premium_present');
      premiumInfluenced = true;
    }

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

    // 6. Seniority/experience diversity (prefer mixing junior + senior)
    if (weights.seniorityDiversity) {
      const aLevel = (a as any).seniorityLevel || 0;
      const bLevel = (b as any).seniorityLevel || 0;
      const diff = Math.abs(aLevel - bLevel);
      const seniorityScore = Math.min(diff / 3, 1.0); // Max 1.0 for 3+ levels apart

      totalScore += seniorityScore * weights.seniorityDiversity;
      totalWeight += weights.seniorityDiversity;

      if (diff >= 2) reasonTags.push('seniority_diverse');
    }

    // 7. Encounter freshness (prefer people who haven't met recently)
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

    // ── Matching Engine 1.0 spec, Section 8 — Feedback learning ─────
    // Pairs whose past meetings ended with both saying "meet again" get
    // a small lift; this only matters when matchingPolicy allows repeats
    // (otherwise the no-repeat hard constraint trumps any score). Pairs
    // with low average rating are deprioritised symmetrically.
    if (weights.mutualMeetAgainBoost) {
      const key = pairKey(a.userId, b.userId);
      const encounter = encounterMap.get(key);
      if (encounter?.mutualMeetAgain) {
        totalScore += 1.0 * weights.mutualMeetAgainBoost;
        totalWeight += weights.mutualMeetAgainBoost;
        reasonTags.push('mutual_meet_again');
      } else if (encounter?.averageRating !== undefined && encounter.averageRating > 0) {
        // Normalise 0-5 → 0-1.
        const ratingScore = encounter.averageRating / 5;
        totalScore += ratingScore * weights.mutualMeetAgainBoost;
        totalWeight += weights.mutualMeetAgainBoost;
        if (encounter.averageRating >= 4) reasonTags.push('positive_history');
      }
    }

    // Normalize to 0-1
    const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      score: Math.round(normalizedScore * 10000) / 10000,
      reasonTags,
      premiumInfluenced,
    };
  }

  private buildEncounterMap(history: EncounterHistoryEntry[]): Map<string, EncounterHistoryEntry> {
    const map = new Map<string, EncounterHistoryEntry>();
    for (const entry of history) {
      map.set(pairKey(entry.userAId, entry.userBId), entry);
    }
    return map;
  }

  /**
   * Phase 1 (5 May spec) — exact backtracking search for a complete
   * matching when greedy fails. Used as a fallback only when greedy
   * leaves >=2 participants unmatched. Bounded to ≤30 participants
   * (caller guards) so the recursion stays under 100ms in practice.
   *
   * Algorithm: classic depth-first backtracking on perfect matchings.
   * Picks the lowest-index unmatched participant, tries each valid
   * partner in score-descending order, recurses on the remainder.
   * Returns null if no complete matching exists in the candidate graph.
   */
  private findCompleteMatching(
    participants: MatchingParticipant[],
    candidates: Array<{
      aIdx: number; bIdx: number;
      score: number; reasonTags: string[];
      premiumInfluenced: boolean;
      isRepeatInEvent: boolean;
    }>,
    _usedPairs: Set<string>,
    _hardExclusions: Set<string>,
  ): MatchPair[] | null {
    const n = participants.length;

    // Build adjacency from candidates list. Candidates already exclude
    // usedPairs and hardExclusions, so anything in here is a legal pair.
    const adj = new Map<number, Array<{ partnerIdx: number; cand: typeof candidates[number] }>>();
    for (let i = 0; i < n; i++) adj.set(i, []);
    for (const cand of candidates) {
      adj.get(cand.aIdx)!.push({ partnerIdx: cand.bIdx, cand });
      adj.get(cand.bIdx)!.push({ partnerIdx: cand.aIdx, cand });
    }
    // Score-descending so we prefer high-quality matchings when one exists.
    for (const list of adj.values()) {
      list.sort((a, b) => b.cand.score - a.cand.score);
    }

    const matched = new Array<boolean>(n).fill(false);
    const result: MatchPair[] = [];

    const recurse = (): boolean => {
      // Find the next unmatched participant (lowest index).
      let nextIdx = -1;
      for (let i = 0; i < n; i++) {
        if (!matched[i]) { nextIdx = i; break; }
      }
      if (nextIdx === -1) return true; // all matched — success

      for (const neighbour of adj.get(nextIdx)!) {
        if (matched[neighbour.partnerIdx]) continue;

        matched[nextIdx] = true;
        matched[neighbour.partnerIdx] = true;
        result.push({
          participantAId: participants[nextIdx].userId,
          participantBId: participants[neighbour.partnerIdx].userId,
          score: neighbour.cand.score,
          reasonTags: neighbour.cand.reasonTags,
          matchReason: neighbour.cand.reasonTags[0] || 'best_available',
          fallbackUsed: false,
          repeatInEvent: neighbour.cand.isRepeatInEvent,
          premiumInfluenced: neighbour.cand.premiumInfluenced,
        });

        if (recurse()) return true;

        // Backtrack
        matched[nextIdx] = false;
        matched[neighbour.partnerIdx] = false;
        result.pop();
      }
      return false;
    };

    return recurse() ? result : null;
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

        case 'user_block': {
          // Phase B (1 May 2026) — bidirectional user blocks. Pairs format
          // is "blockerId:blockedId" but the exclusion is direction-agnostic
          // (pairKey normalises by sorting). One block excludes the pair
          // for the whole event regardless of who blocked whom.
          const userBlockPairs = constraint.params.pairs as string[];
          if (userBlockPairs) {
            for (const pair of userBlockPairs) {
              const [blockerId, blockedId] = pair.split(':');
              if (blockerId && blockedId) {
                exclusions.add(pairKey(blockerId, blockedId));
              }
            }
          }
          break;
        }

        case 'inviter_invitee_block': {
          // Avoid matching the inviter with the person they invited
          const inviterInviteePairs = constraint.params.pairs as string[];
          if (inviterInviteePairs) {
            // Pairs format: ["inviterId:inviteeId", ...]
            for (const pair of inviterInviteePairs) {
              const [inviterId, inviteeId] = pair.split(':');
              if (inviterId && inviteeId) {
                exclusions.add(pairKey(inviterId, inviteeId));
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
