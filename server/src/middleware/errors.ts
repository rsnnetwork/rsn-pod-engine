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
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class NotFoundError extends AppError {
  /**
   * `message` replaces the generated "<entity> with id <id> not found" where a member
   * reads it and the id or the entity's internal name would mean nothing to them.
   * The 404 and the `<ENTITY>_NOT_FOUND` code stay as they are.
   */
  constructor(entity: string, id?: string, message?: string) {
    const generated = id ? `${entity} with id ${id} not found` : `${entity} not found`;
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
