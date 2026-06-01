// ─── Match Domain Types ──────────────────────────────────────────────────────

export enum MatchStatus {
  SCHEDULED = 'scheduled',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  NO_SHOW = 'no_show',
  REASSIGNED = 'reassigned',
  CANCELLED = 'cancelled',
}

export interface Match {
  id: string;
  sessionId: string;
  roundNumber: number;
  participantAId: string;
  participantBId: string;
  participantCId: string | null;  // 3-person room (trio)
  roomId: string | null;
  status: MatchStatus;
  score: number | null;
  reasonTags: string[];
  isManual: boolean;  // TRUE = host-created breakout (independent from algorithm rounds)
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

export interface Rating {
  id: string;
  matchId: string;
  fromUserId: string;
  toUserId: string;
  qualityScore: number;  // 1-5
  meetAgain: boolean;
  feedback: string | null;
  createdAt: Date;
}

export interface CreateRatingInput {
  matchId: string;
  qualityScore: number;
  meetAgain: boolean;
  feedback?: string;
}

export interface EncounterHistory {
  id: string;
  userAId: string;
  userBId: string;
  timesMet: number;
  lastMetAt: Date;
  lastSessionId: string;
  lastQualityScore: number | null;
  lastMeetAgainA: boolean | null;
  lastMeetAgainB: boolean | null;
  mutualMeetAgain: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionResult {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  company: string | null;
  jobTitle: string | null;
  qualityScore: number;
  meetAgain: boolean;
  theirMeetAgain: boolean;
  mutualMeetAgain: boolean;
  roundNumber: number;
}

export interface PeopleMet {
  sessionId: string;
  sessionTitle: string;
  sessionDate: Date;
  totalRounds: number;
  roundsAttended: number;
  connections: ConnectionResult[];
  mutualConnections: ConnectionResult[];
  // Phase 2 (1 May spec) — deterministic stored counts from meeting_records.
  // Headline numbers shown in the recap, never recalculated from connections[]
  // (which is the per-row UI list and may include duplicates across rounds).
  uniquePeopleMet?: number;
  totalMeetings?: number;
  mutualMatches?: number;
}

// ─── Matching Engine Types ───────────────────────────────────────────────────

export interface MatchingInput {
  sessionId: string;
  participants: MatchingParticipant[];
  config: MatchingConfig;
  encounterHistory: EncounterHistoryEntry[];
  previousRounds: RoundAssignment[];
}

export interface MatchingParticipant {
  userId: string;
  interests: string[];
  reasonsToConnect: string[];
  industry: string | null;
  company: string | null;
  languages: string[];
  timezone: string | null;
  attributes: Record<string, string | number | boolean>;
  // Matching Engine 1.0 spec, Section 4 + Section 7 — premium tier flag
  // and the user's outstanding "I want to meet" requests for this event.
  // requestedUserIds is the requester→requested direction; engine looks
  // up reciprocal requests to detect mutual premium pairs.
  isPremium?: boolean;
  requestedUserIds?: string[];
}

export interface MatchingConfig {
  weights: MatchingWeights;
  hardConstraints: HardConstraint[];
  numberOfRounds: number;
  avoidDuplicates: boolean;
  globalOptimize: boolean;
}

export interface MatchingWeights {
  sharedInterests: number;
  sharedReasons: number;
  industryDiversity: number;
  companyDiversity: number;
  languageMatch: number;
  encounterFreshness: number;
  // Matching Engine 1.0 spec, Section 7 — premium boost weights.
  // mutualPremiumRequest fires when both users requested each other (highest
  // priority per spec). singlePremiumRequest fires when only one direction
  // exists. premiumBoost gives any pair containing a premium user a small
  // global lift so premium presence is felt without dominating ("premium
  // cannot dominate all matches" — engine caps the boost so other factors
  // still decide most pairings).
  mutualPremiumRequest?: number;
  singlePremiumRequest?: number;
  premiumBoost?: number;
  // Section 8 — feedback learning. mutualMeetAgainBoost lifts the score
  // of pairs whose past meetings ended with both saying "meet again".
  // Only applied when matchingPolicy allows repeats (otherwise the
  // no-repeat constraint trumps any score).
  mutualMeetAgainBoost?: number;
  [key: string]: number | undefined;
}

export interface HardConstraint {
  type:
    | 'exclude_pair'
    | 'same_company_block'
    | 'language_required'
    | 'inviter_invitee_block'
    /**
     * Phase B (1 May 2026 spec) — user-blocked pairs. Params shape mirrors
     * `inviter_invitee_block`: pairs is a string[] of "blockerId:blockedId"
     * tokens. Direction-agnostic at the engine level (excludes the pair
     * regardless of which direction the block came from).
     */
    | 'user_block'
    | 'custom';
  params: Record<string, string | string[]>;
}

export interface EncounterHistoryEntry {
  userAId: string;
  userBId: string;
  timesMet: number;
  lastMetAt: Date;
  // Matching Engine 1.0 spec, Section 4 (Pair Relationship) + Section 8
  // (Feedback) — learning signals. Engine consults these to deprioritise
  // pairs that already had bad outcomes and to lift pairs that had mutual
  // 'meet again' votes (when repeats are allowed by policy).
  mutualMeetAgain?: boolean;
  averageRating?: number; // 0-5 scale; null/undefined if no ratings yet
}

export interface RoundAssignment {
  roundNumber: number;
  pairs: MatchPair[];
  byeParticipant: string | null;  // odd count handling
  byeParticipants?: string[];     // multiple bye participants when unique pairs exhausted
  warnings?: string[];            // matching warnings (e.g. all unique pairs exhausted)
}

export interface MatchPair {
  participantAId: string;
  participantBId: string;
  participantCId?: string;  // 3-person room (trio)
  score: number;
  reasonTags: string[];
  // Matching Engine 1.0 spec, Section 13 — explicit logging fields.
  // matchReason is a single human-readable label for admin/debug surfaces
  // (e.g. 'mutual_premium_request', 'shared_intent', 'fallback_repeat').
  // The boolean flags drive admin filtering ("show me all fallback matches").
  matchReason?: string;
  fallbackUsed?: boolean;
  repeatInEvent?: boolean;
  premiumInfluenced?: boolean;
}

export interface MatchingOutput {
  sessionId: string;
  rounds: RoundAssignment[];
  generatedAt: Date;
  durationMs: number;
  metadata: {
    participantCount: number;
    roundCount: number;
    avgScore: number;
    minScore: number;
    duplicatesAvoided: number;
  };
}
