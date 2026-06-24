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
  // WS2 (27 May remaining work) — members who departed early (leave /
  // pull-back / grace expiry / kick). RATING-ONLY: lets round-end emission
  // have the survivors rate the departed; matching/presence never read it.
  // Optional for rows fetched by queries that don't select the column.
  departedUserIds?: string[];
  roomId: string | null;
  status: MatchStatus;
  score: number | null;
  reasonTags: string[];
  isManual: boolean;  // TRUE = host-created breakout (independent from algorithm rounds)
  // Phase 2 — richer storage (optional; rows from older queries may omit them).
  matchingTemplateId?: string | null;
  confidence?: number | null;
  isOverride?: boolean;
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
  // WS3/H5 (27 May remaining work) — "this conversation didn't work"
  // (no-show partner, tech failure). Recorded so dedup/replay treat the
  // match as handled, but EXCLUDED from every quality average.
  excludedFromQualityStats?: boolean;
  createdAt: Date;
}

export interface CreateRatingInput {
  matchId: string;
  qualityScore: number;
  meetAgain: boolean;
  feedback?: string;
  // WS3/H5 — marks the rating excluded from quality stats.
  didntWork?: boolean;
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
  // #5 (24 May, Ali) — manual breakout rooms are stamped with the current
  // round_number; this flag lets the recap render them in a separate
  // "Manual rooms" section instead of folding them into a numbered round.
  isManual: boolean;
}

export interface PeopleMet {
  sessionId: string;
  sessionTitle: string;
  sessionDate: Date;
  totalRounds: number;
  roundsAttended: number;
  // Bug 28 (19 May Ali + Stefan) — how many of `totalRounds` were added
  // mid-event via "Another Round". Recap uses this to render an honest
  // "3 rounds + 1 bonus" split. Defaults to 0 for events that ran their
  // original plan.
  bonusRoundsAdded?: number;
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
  // Matching enhancement (onboarding intent) — all optional + backward
  // compatible. A participant without these scores exactly as before.
  /** Normalised designation bucket (founder/investor/ceo/...) from job title. */
  designation?: string | null;
  /** Free terms for who this member wants to meet (desired roles/people/industries). */
  wantsToMeet?: string[];
  /** Free terms for who this member does NOT want to meet (avoid_preferences). */
  avoid?: string[];
  // Phase 2 — per-event intention captured at check-in (overlay on the profile)
  // + openness-to-unexpected, and a 0..1 profile-completeness for tiered scoring.
  eventIntention?: string | null;
  openness?: string | null;
  completeness?: number;
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
  // Matching enhancement (onboarding intent) — additive relevance signals.
  // intentAlignment: directional "who you want to meet" vs the other's identity.
  // designationDiversity: complementary designations (e.g. founder + investor).
  // avoidPenalty: drops the pair's score on this dimension when either side's
  //   "do not want to meet" matches the other (soft, never a hard exclusion).
  intentAlignment?: number;
  designationDiversity?: number;
  avoidPenalty?: number;
  // Phase 2 — per-event check-in intention overlay.
  eventIntentionAlignment?: number;
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
  // Fix #9 (25 May Stefan) — fallback feedback. The matching SERVICE
  // (generateSingleRound) sets these after running the L0→L4 fallback ladder
  // so callers can tell the host "no fresh pairings left — showing closest
  // available" instead of the Re-match button silently re-rolling. The engine
  // itself does not set these (it has no concept of the ladder); they're a
  // service-level annotation on the returned round.
  fallbackLevel?: number;         // 0 = strict/all-fresh; 1-4 = ladder relaxed
  usedRepeats?: boolean;          // true when the round had to reuse an excluded (already-met) pair
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
  // Phase 2 — 0..1 confidence for this pairing (score tempered by fallback level).
  confidence?: number;
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
