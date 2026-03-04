// ─── Session Domain Types ────────────────────────────────────────────────────

export enum SessionStatus {
  SCHEDULED = 'scheduled',
  LOBBY_OPEN = 'lobby_open',
  ROUND_ACTIVE = 'round_active',
  ROUND_RATING = 'round_rating',
  ROUND_TRANSITION = 'round_transition',
  CLOSING_LOBBY = 'closing_lobby',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum ParticipantStatus {
  REGISTERED = 'registered',
  CHECKED_IN = 'checked_in',
  IN_LOBBY = 'in_lobby',
  IN_ROUND = 'in_round',
  DISCONNECTED = 'disconnected',
  REMOVED = 'removed',
  LEFT = 'left',
  NO_SHOW = 'no_show',
}

export enum SegmentType {
  LOBBY_MOSAIC = 'lobby_mosaic',
  TIMED_ONE_TO_ONE = 'timed_one_to_one',
  CLOSING_LOBBY = 'closing_lobby',
  TRANSITION = 'transition',
}

export interface SessionConfig {
  numberOfRounds: number;
  roundDurationSeconds: number;
  lobbyDurationSeconds: number;
  transitionDurationSeconds: number;
  ratingWindowSeconds: number;
  closingLobbyDurationSeconds: number;
  noShowTimeoutSeconds: number;
  maxParticipants: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  numberOfRounds: 5,
  roundDurationSeconds: 480,         // 8 minutes
  lobbyDurationSeconds: 480,         // 8 minutes
  transitionDurationSeconds: 30,     // 30 seconds
  ratingWindowSeconds: 30,           // 30 seconds
  closingLobbyDurationSeconds: 480,  // 8 minutes
  noShowTimeoutSeconds: 60,          // 60 seconds
  maxParticipants: 500,
};

export interface Session {
  id: string;
  podId: string;
  title: string;
  description: string | null;
  scheduledAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  status: SessionStatus;
  currentRound: number;
  config: SessionConfig;
  hostUserId: string;
  lobbyRoomId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionParticipant {
  id: string;
  sessionId: string;
  userId: string;
  status: ParticipantStatus;
  joinedAt: Date | null;
  leftAt: Date | null;
  currentRoomId: string | null;
  isNoShow: boolean;
  roundsCompleted: number;
}

export interface CreateSessionInput {
  podId: string;
  title: string;
  description?: string;
  scheduledAt: string;  // ISO date string
  config?: Partial<SessionConfig>;
}

export interface UpdateSessionInput {
  title?: string;
  description?: string;
  scheduledAt?: string;
  config?: Partial<SessionConfig>;
}

export interface SessionSegment {
  segmentType: SegmentType;
  roundNumber: number | null;
  durationSeconds: number;
  startedAt: Date | null;
  endsAt: Date | null;
}

// ─── Host Control Types ─────────────────────────────────────────────────────

export interface HostBroadcast {
  sessionId: string;
  message: string;
  fromUserId: string;
  sentAt: Date;
}

export interface HostReassignment {
  sessionId: string;
  roundNumber: number;
  participantId: string;
  newPartnerId: string | null;
  reason: string;
}
