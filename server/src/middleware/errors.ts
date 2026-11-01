// ─── Application Error Classes ───────────────────────────────────────────────
import { ErrorCode, ErrorCodes } from '@rsn/shared';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  /** Sent to the client as `error.details` (see ApiError in @rsn/shared for the shapes in use). */
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    // The prototype of the class that was constructed, so `err instanceof ConflictError` (or any subclass) holds.
    // It was AppError.prototype, which pointed every subclass's instances back at AppError (26 Oct 2026).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** What a member calls the thing behind each entity name; any other name is read as words ("Call request" is "call request"). */
const NOT_FOUND_LABELS: Record<string, string> = {
  User: 'member',
  PodMember: 'member',
  PendingMember: 'member',
  Session: 'event',
  Poke: 'meeting request',
};

function notFoundLabel(entity: string): string {
  return NOT_FOUND_LABELS[entity] ?? entity.toLowerCase();
}

export class NotFoundError extends AppError {
  /**
   * `message` replaces the generated one where a member reads it. Without it, a call that
   * names an id says "We couldn't find that <thing>." and never prints the id, which would
   * mean nothing to a member. The 404 and the `<ENTITY>_NOT_FOUND` code stay as they are.
   */
  constructor(entity: string, id?: string, message?: string) {
    const generated = id ? `We couldn't find that ${notFoundLabel(entity)}.` : `${entity} not found`;
    super(404, `${entity.toUpperCase()}_NOT_FOUND` as ErrorCode, message ?? generated);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, ErrorCodes.AUTH_UNAUTHORIZED, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(403, ErrorCodes.AUTH_FORBIDDEN, message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, string[]>) {
    super(400, ErrorCodes.VALIDATION_ERROR, message, details);
  }
}

export class ConflictError extends AppError {
  /**
   * `details` says what the request clashed with, so the client can offer it: the entity name
   * clash sends `{ existingId: [id] }`, a meeting request already answered sends `{ status }`,
   * a meeting time that is no longer free for both sends `{ scheduling }`.
   */
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Too many requests. Please try again later.');
  }
}
