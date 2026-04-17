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
  [key: string]: number;
}

export interface HardConstraint {
  type: 'exclude_pair' | 'same_company_block' | 'language_required' | 'inviter_invitee_block' | 'custom';
  params: Record<string, string | string[]>;
}

export interface EncounterHistoryEntry {
  userAId: string;
  userBId: string;
  timesMet: number;
  lastMetAt: Date;
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
