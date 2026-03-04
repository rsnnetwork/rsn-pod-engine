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
  details?: Record<string, string[]>;
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

  // Pod errors
  POD_NOT_FOUND: 'POD_NOT_FOUND',
  POD_FULL: 'POD_FULL',
  POD_NOT_ACTIVE: 'POD_NOT_ACTIVE',
  POD_MEMBER_EXISTS: 'POD_MEMBER_EXISTS',
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

  // Invite errors
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_ALREADY_USED: 'INVITE_ALREADY_USED',
  INVITE_REVOKED: 'INVITE_REVOKED',
  INVITE_LIMIT_REACHED: 'INVITE_LIMIT_REACHED',

  // Match errors
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  MATCH_ALREADY_RATED: 'MATCH_ALREADY_RATED',
  MATCH_RATING_WINDOW_CLOSED: 'MATCH_RATING_WINDOW_CLOSED',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
