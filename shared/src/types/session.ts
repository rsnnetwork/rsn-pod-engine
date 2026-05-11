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

export type TimerVisibility = 'hidden' | 'always_visible' | 'last_10s' | 'last_30s' | 'last_60s' | 'last_120s';

/**
 * Phase 4 (29 April 2026 spec) — matching policy chosen at event creation.
 *
 * Per Stefan's clarification: there's no single hard-coded rule for the
 * whole platform. Different events have different purposes, so the event
 * creator picks how strict the matching engine should be.
 *
 *   'platform_wide' — strictest. If two people have ever met before
 *                     anywhere on RSN, they will never be matched again.
 *                     Good for large-scale discovery events.
 *   'within_event'  — balanced default. Pairs that already met in THIS
 *                     event won't be re-paired within this event. They
 *                     can meet again in future events.
 *   'none'          — no restriction. Anyone can be paired again, even
 *                     if they met before. Useful for smaller groups,
 *                     curated sessions, or repeat-conversation events.
 *
 * Encounter history is still tracked GLOBALLY across the platform —
 * the policy only governs how the matching engine USES that history.
 */
export type MatchingPolicy = 'platform_wide' | 'within_event' | 'none';

export interface SessionConfig {
  numberOfRounds: number;
  roundDurationSeconds: number;
  lobbyDurationSeconds: number;
  transitionDurationSeconds: number;
  ratingWindowSeconds: number;
  closingLobbyDurationSeconds: number;
  noShowTimeoutSeconds: number;
  maxParticipants: number;
  timerVisibility: TimerVisibility;
  /**
   * Phase 4 — see MatchingPolicy for the three options. Optional for
   * backwards compatibility with existing sessions; if absent the engine
   * treats the session as `'within_event'` (the new default).
   */
  matchingPolicy?: MatchingPolicy;
  /**
   * Phase 3 (1 May spec) — pluggable matching engine. Each event picks
   * which algorithm to use. Speed-networking events use
   * 'speed_networking_v1' (the default Engine V1.0). Future event types
   * (roundtable, mentorship, etc.) self-register their own engine in
   * server matching.registry.ts and pick a different ID here.
   */
  matchingAlgorithmId?: string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  numberOfRounds: 5,
  roundDurationSeconds: 480,         // 8 minutes
  lobbyDurationSeconds: 480,         // 8 minutes
  transitionDurationSeconds: 30,     // 30 seconds
  ratingWindowSeconds: 10,           // 10 seconds (safety net — early-exit fires when all rated)
  closingLobbyDurationSeconds: 480,  // 8 minutes
  noShowTimeoutSeconds: 60,          // 60 seconds
  maxParticipants: 500,
  timerVisibility: 'last_10s' as TimerVisibility,
  matchingPolicy: 'within_event',
  matchingAlgorithmId: 'speed_networking_v1',
};

/**
 * Phase G (10 May 2026 spec item 11) — host/co-host visibility mode.
 * Controls how a host or co-host renders in the lobby/breakout video grid.
 *  • big_speaker — pinned as the big tile
 *  • normal      — regular participant tile (default)
 *  • producer    — not visible in any video tile (off-camera operator)
 *  • hidden      — not rendered anywhere (off-stage organiser)
 *
 * Mirrors the Postgres `host_visibility_mode` enum (migration 059).
 */
export type HostVisibilityMode = 'big_speaker' | 'normal' | 'producer' | 'hidden';
export const HOST_VISIBILITY_MODES: readonly HostVisibilityMode[] = [
  'big_speaker', 'normal', 'producer', 'hidden',
] as const;
export function isHostVisibilityMode(v: unknown): v is HostVisibilityMode {
  return typeof v === 'string' && (HOST_VISIBILITY_MODES as readonly string[]).includes(v);
}

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
  hostVisibilityMode?: HostVisibilityMode;
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
