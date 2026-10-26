// ─── Shared API Response Types ───────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: PaginationMeta;
}

export interface ApiError {
  code: string;
  message: string;
  /**
   * Validation failures send `{ field: [messages] }`. A conflict says what it clashed with, so the
   * client can show it: `{ existingId: [id] }` (an entity name), `{ status: 'declined' }` (a meeting
   * request already answered), `{ scheduling: {...} }` (a meeting time no longer free for both).
   */
  details?: Record<string, unknown>;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const ErrorCodes = {
  // Auth errors
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_MAGIC_LINK_EXPIRED: 'AUTH_MAGIC_LINK_EXPIRED',
  AUTH_MAGIC_LINK_USED: 'AUTH_MAGIC_LINK_USED',

  // User errors
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_PROFILE_INCOMPLETE: 'USER_PROFILE_INCOMPLETE',
  USER_SUSPENDED: 'USER_SUSPENDED',
  ACCOUNT_CLOSED: 'ACCOUNT_CLOSED',  // deleted/removed by an admin; approving a new join request reopens it

  // Pod errors
  POD_NOT_FOUND: 'POD_NOT_FOUND',
  POD_FULL: 'POD_FULL',
  POD_NOT_ACTIVE: 'POD_NOT_ACTIVE',
  POD_NOT_ARCHIVED: 'POD_NOT_ARCHIVED',
  POD_MEMBER_EXISTS: 'POD_MEMBER_EXISTS',
  CIRCLE_MEMBER_EXISTS: 'CIRCLE_MEMBER_EXISTS',
  POD_MEMBER_NOT_FOUND: 'POD_MEMBER_NOT_FOUND',
  POD_UNAUTHORIZED: 'POD_UNAUTHORIZED',

  // Session errors
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_FULL: 'SESSION_FULL',
  SESSION_NOT_SCHEDULED: 'SESSION_NOT_SCHEDULED',
  SESSION_ALREADY_STARTED: 'SESSION_ALREADY_STARTED',
  SESSION_ALREADY_REGISTERED: 'SESSION_ALREADY_REGISTERED',
  SESSION_NOT_REGISTERED: 'SESSION_NOT_REGISTERED',
  SESSION_IN_PROGRESS: 'SESSION_IN_PROGRESS',
  EVENT_ENDED: 'EVENT_ENDED',
  EVENT_FORMAT_NOT_ALLOWED: 'EVENT_FORMAT_NOT_ALLOWED',  // the format is not offered, or the pod's type does not hold it
  NOT_A_ROUNDS_EVENT: 'NOT_A_ROUNDS_EVENT',              // a round, matching or breakout action on an event that has none (a video meeting)

  // Pod lifecycle
  POD_ARCHIVED: 'POD_ARCHIVED',

  // Invite errors
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_ALREADY_USED: 'INVITE_ALREADY_USED',
  INVITE_REVOKED: 'INVITE_REVOKED',
  INVITE_LIMIT_REACHED: 'INVITE_LIMIT_REACHED',
  INVITE_REQUIRED: 'INVITE_REQUIRED',
  INVALID_INVITE: 'INVALID_INVITE',
  SELF_INVITE: 'SELF_INVITE',
  DUPLICATE_INVITE: 'DUPLICATE_INVITE',
  INVITE_NOT_PERMITTED: 'INVITE_NOT_PERMITTED',
  ALREADY_REGISTERED: 'ALREADY_REGISTERED',
  REGISTRATION_BLOCKED: 'REGISTRATION_BLOCKED',
  JOIN_REQUEST_ALREADY_REVIEWED: 'JOIN_REQUEST_ALREADY_REVIEWED',  // approve/decline of a request someone already reviewed the other way
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',  // T1-1 — invite issued to a different email than the authenticated user

  // Entity errors (an organisation members create: a company, a fund…)
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',    // missing or archived; the two read the same
  ENTITY_NAME_TAKEN: 'ENTITY_NAME_TAKEN',  // 409; details.existingId[0] is the active entity with that name

  // Meeting request and meeting errors
  MEETING_REQUEST_ALREADY_ANSWERED: 'MEETING_REQUEST_ALREADY_ANSWERED',  // 409; details.status is the answer it already has
  MEETING_TIME_NOT_SHARED: 'MEETING_TIME_NOT_SHARED',  // 409; details.scheduling is where the two people's times stand now
  MEETING_ALREADY_ENDED: 'MEETING_ALREADY_ENDED',  // 409; a meeting that is over can no longer be cancelled

  // Match errors
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  MATCH_ALREADY_RATED: 'MATCH_ALREADY_RATED',
  MATCH_RATING_WINDOW_CLOSED: 'MATCH_RATING_WINDOW_CLOSED',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Video / LiveKit errors
  LIVEKIT_TOKEN_ERROR: 'LIVEKIT_TOKEN_ERROR',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
