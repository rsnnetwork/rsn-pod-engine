// ─── Matching Engine Interface ───────────────────────────────────────────────
// This interface defines the contract for any matching algorithm.
// LiveKit provider-style: implement this interface to swap matching logic.

import {
  MatchingInput, MatchingOutput, MatchingConfig, MatchingParticipant,
  RoundAssignment, EncounterHistoryEntry,
} from '@rsn/shared';

/**
 * IMatchingEngine defines the contract for generating round-based
 * match schedules from a set of participants.
 */
export interface IMatchingEngine {
  /**
   * Validates the input data before running the matching algorithm.
   * Throws if inputs are invalid.
   */
  validateInput(input: MatchingInput): void;

  /**
   * Generates a full match schedule for all rounds.
   * Returns the complete output including timing metadata.
   */
  generateSchedule(input: MatchingInput): Promise<MatchingOutput>;

  /**
   * Generates pairings for a single round.
   * Used for on-demand round generation or reassignment.
   */
  generateRound(
    participants: MatchingParticipant[],
    config: MatchingConfig,
    excludedPairs: Set<string>,
    encounterHistory: EncounterHistoryEntry[],
    roundNumber: number,
  ): RoundAssignment;

  /**
   * Scores a potential pair based on weighted criteria.
   * Returns a normalized score between 0 and 1.
   */
  scorePair(
    a: MatchingParticipant,
    b: MatchingParticipant,
    config: MatchingConfig,
    encounterHistory: EncounterHistoryEntry[]
  ): { score: number; reasonTags: string[] };
}

/**
 * Creates a canonical key for a pair (order-independent).
 */
export function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}
