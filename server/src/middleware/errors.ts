// ─── Application Error Classes ───────────────────────────────────────────────
import { ErrorCode, ErrorCodes } from '@rsn/shared';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, string[]>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, string[]>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    const message = id ? `${entity} with id ${id} not found` : `${entity} not found`;
    super(404, `${entity.toUpperCase()}_NOT_FOUND` as ErrorCode, message);
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
  constructor(code: ErrorCode, message: string) {
    super(409, code, message);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Too many requests. Please try again later.');
  }
}
