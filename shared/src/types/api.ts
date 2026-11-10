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
  /** The admin users list only (T2, 1 Nov 2026): how many accounts each status holds for the same search and role. */
  statusCounts?: UserStatusCounts;
}

/** How many accounts hold each status: the admin Users page's tabs (T2, 1 Nov 2026). */
export interface UserStatusCounts { active: number; suspended: number; deactivated: number; banned: number }

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
  // The 6-digit sign-in code in the sign-in email (1 Nov 2026): a wrong code (details.attemptsLeft), a code past
  // its 15 minutes, and a link and code killed together by the fifth wrong code.
  AUTH_SIGN_IN_CODE_WRONG: 'AUTH_SIGN_IN_CODE_WRONG',
  AUTH_SIGN_IN_CODE_EXPIRED: 'AUTH_SIGN_IN_CODE_EXPIRED',
  AUTH_SIGN_IN_LOCKED: 'AUTH_SIGN_IN_LOCKED',

  // User errors
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_PROFILE_INCOMPLETE: 'USER_PROFILE_INCOMPLETE',
  USER_SUSPENDED: 'USER_SUSPENDED',
  ACCOUNT_CLOSED: 'ACCOUNT_CLOSED',  // deleted/removed by an admin; approving a new join request reopens it
  GUEST_MEMBERSHIP_REQUIRED: 'GUEST_MEMBERSHIP_REQUIRED',  // 403; an event guest (users.account_kind = 'event_guest') asked for a member-only part of RSN

  // Pod errors
  POD_NOT_FOUND: 'POD_NOT_FOUND',
  POD_FULL: 'POD_FULL',
  POD_NOT_ACTIVE: 'POD_NOT_ACTIVE',
  POD_NOT_ARCHIVED: 'POD_NOT_ARCHIVED',
  POD_MEMBER_EXISTS: 'POD_MEMBER_EXISTS',
  CIRCLE_MEMBER_EXISTS: 'CIRCLE_MEMBER_EXISTS',
  CIRCLE_CLOSED: 'CIRCLE_CLOSED',  // 403; a closed circle: joining needs an ask its managers approve, and its wall, members and events are for members
  POD_MEMBER_NOT_FOUND: 'POD_MEMBER_NOT_FOUND',
  POD_UNAUTHORIZED: 'POD_UNAUTHORIZED',

  // Group chat errors (26 Oct 2026)
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  GROUP_MEMBER_NOT_FOUND: 'GROUP_MEMBER_NOT_FOUND',
  GROUP_FULL: 'GROUP_FULL',            // 409; a group chat holds GROUP_CHAT_MAX_MEMBERS people, its creator included
  GROUP_TOO_SMALL: 'GROUP_TOO_SMALL',  // 400; a group chat starts with at least GROUP_CHAT_MIN_MEMBERS people

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
  NOT_A_VIDEO_EVENT: 'NOT_A_VIDEO_EVENT',                // 409; Go Live, a video token or the live room asked of an in-person event
  TEMPLATE_IS_PRESET: 'TEMPLATE_IS_PRESET',              // 409; a speed-networking preset cannot be deleted (its weights can be edited)
  EVENT_NEEDS_APPROVAL: 'EVENT_NEEDS_APPROVAL',          // T11: the event asks the host to approve each place
  EVENT_PRIVATE: 'EVENT_PRIVATE',                        // T11: a private event, for its pod's members and invitees
  EVENT_REQUEST_NOT_NEEDED: 'EVENT_REQUEST_NOT_NEEDED',  // T11: the person can register directly
  EVENT_REQUEST_DECLINED: 'EVENT_REQUEST_DECLINED',      // T11: the host declined; the requester cannot reopen it
  EVENT_REQUEST_ANSWERED: 'EVENT_REQUEST_ANSWERED',      // T11: the request was already approved, declined or withdrawn
  REGISTRATION_NOT_OPEN: 'REGISTRATION_NOT_OPEN',        // 409; the event's registration opens later (sessions.registration_opens_at)
  EVENT_NOT_PUBLISHED: 'EVENT_NOT_PUBLISHED',            // 409; a draft cannot go live: publish it first
  EVENT_ALREADY_CANCELLED: 'EVENT_ALREADY_CANCELLED',    // 409; a second cancel sends no second notice
  EVENT_HAS_REGISTRATIONS: 'EVENT_HAS_REGISTRATIONS',    // 409; unpublish refused: people hold places, cancel instead
  EVENT_LIFECYCLE_NOT_ALLOWED: 'EVENT_LIFECYCLE_NOT_ALLOWED',  // 409; that lifecycle step does not apply in the event's state
  // Matching groups (10 Nov 2026 spec, Part 2 Task 5): an event with groups asks each participant which group they are in.
  EVENT_GROUP_REQUIRED: 'EVENT_GROUP_REQUIRED',          // 409; the event has groups and this person has none and chose none
  EVENT_GROUP_UNKNOWN: 'EVENT_GROUP_UNKNOWN',            // 400; a group key the event does not have, or more groups than it allows
  EVENT_GROUP_ALREADY_CHOSEN: 'EVENT_GROUP_ALREADY_CHOSEN', // 409; a participant's own group is set once; an organiser changes it
  // A room the host makes or changes live (Part 2 Task 7): the same checker the engine uses refuses it.
  MATCH_BLOCKED_PAIR: 'MATCH_BLOCKED_PAIR',              // 409; one of the two blocked the other: never overridable
  MATCH_GROUP_RULE: 'MATCH_GROUP_RULE',                  // 409; the round's group rule does not let them meet (overridable)
  GROUP_OVERRIDE_FORBIDDEN: 'GROUP_OVERRIDE_FORBIDDEN',  // 403; only the event owner or a super admin overrides a group rule
  // Part 2 Task 4 (10 Nov 2026): admission per event.
  EVENT_ADMISSION_REQUIRED: 'EVENT_ADMISSION_REQUIRED',  // 403; an invitation-only event: the person is not on its list and holds no redeemed code
  ADMISSION_CODE_USED: 'ADMISSION_CODE_USED',            // 409; someone else already redeemed this admission code
  ADMISSION_CODE_EXPIRED: 'ADMISSION_CODE_EXPIRED',      // 400; the admission code is past its expiry
  ADMISSION_CODE_INVALID: 'ADMISSION_CODE_INVALID',      // 400; unknown, revoked or for another event (one answer for all three)
  ADMISSION_ENTRY_NOT_FOUND: 'ADMISSION_ENTRY_NOT_FOUND',  // 404; no such allowed email on this event's list
  ADMISSION_CODE_NOT_FOUND: 'ADMISSION_CODE_NOT_FOUND',    // 404; no such admission code on this event (the organisers' revoke)
  // The RSN Call link (Part 2 Task 6, 11 Nov 2026).
  EVENT_CANCELLED: 'EVENT_CANCELLED',                    // 409; the event behind a call link was cancelled: it takes nobody
  // The matching board's draft (Part 2 Task 8).
  SCHEDULE_CHANGED: 'SCHEDULE_CHANGED',                  // 409; the board changed since the organiser's read; details.board is the board now
  SCHEDULE_LOCKED: 'SCHEDULE_LOCKED',                    // 409; the meeting or seat is locked: unlock it first
  SCHEDULE_GROUP_RULE: 'SCHEDULE_GROUP_RULE',            // 409; the round's group rule refuses the room (overridable); details.alternatives
  SCHEDULE_RULE: 'SCHEDULE_RULE',                        // 409; a block, a room over three, or a person who can't be seated; details.alternatives
  SCHEDULE_ROUND_STARTED: 'SCHEDULE_ROUND_STARTED',      // 409; the round has already started in the live event

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
  ENTITY_LAST_ADMIN: 'ENTITY_LAST_ADMIN',  // 409; removing them would leave the entity with no active admin

  // Meeting request and meeting errors
  MEETING_REQUEST_ALREADY_ANSWERED: 'MEETING_REQUEST_ALREADY_ANSWERED',  // 409; details.status is the answer it already has
  MEETING_CHANGED_SINCE_SEEN: 'MEETING_CHANGED_SINCE_SEEN',  // 409; the meeting the client saw (expectedWindow) no longer stands; details.scheduling is where things stand now
  MEETING_TIME_NOT_SHARED: 'MEETING_TIME_NOT_SHARED',  // 409; details.scheduling is where the two people's times stand now
  MEETING_ALREADY_ENDED: 'MEETING_ALREADY_ENDED',  // 409; a meeting that is over can no longer be cancelled
  MEETING_ALREADY_STARTED: 'MEETING_ALREADY_STARTED',  // 409; a meeting under way can no longer be cancelled
  MEETING_NOT_STARTED: 'MEETING_NOT_STARTED',  // 409; feedback on a meeting waits for its start
  MEETING_CANCELLED: 'MEETING_CANCELLED',  // 409; a cancelled meeting takes no feedback

  // Call errors (1 Nov 2026)
  CALL_PARTNER_OFFLINE: 'CALL_PARTNER_OFFLINE',  // 409; the person rung is not on REASON right now (no ring, no bell)
  CALL_ALREADY_WAITING: 'CALL_ALREADY_WAITING',  // 409; this pair already has a call ringing, from either side

  // Match errors
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  MATCH_ALREADY_RATED: 'MATCH_ALREADY_RATED',
  MATCH_RATING_WINDOW_CLOSED: 'MATCH_RATING_WINDOW_CLOSED',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',  // 413; a request body over its route's own limit (an admission import)

  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Video / LiveKit errors
  LIVEKIT_TOKEN_ERROR: 'LIVEKIT_TOKEN_ERROR',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
