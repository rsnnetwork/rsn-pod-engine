// ─── Error Classes Unit Tests ────────────────────────────────────────────────
import {
  AppError, NotFoundError, UnauthorizedError,
  ForbiddenError, ValidationError, ConflictError, RateLimitError,
} from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

describe('AppError', () => {
  it('should create an error with statusCode, code, and message', () => {
    const err = new AppError(400, 'VALIDATION_ERROR', 'Bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Bad input');
    expect(err.details).toBeUndefined();
  });

  it('should support details', () => {
    const details = { email: ['required'] };
    const err = new AppError(400, 'VALIDATION_ERROR', 'Bad', details);
    expect(err.details).toEqual(details);
  });

  it('should maintain proper prototype chain', () => {
    const err = new AppError(500, 'INTERNAL_ERROR', 'test');
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('NotFoundError', () => {
  it('should create 404 with entity name', () => {
    const err = new NotFoundError('User');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('USER_NOT_FOUND');
    expect(err.message).toBe('User not found');
  });

  it('should include ID in message when provided', () => {
    const err = new NotFoundError('Pod', '123');
    expect(err.message).toBe('Pod with id 123 not found');
    expect(err.code).toBe('POD_NOT_FOUND');
  });
});

describe('UnauthorizedError', () => {
  it('should create 401 with default message', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
    expect(err.message).toBe('Authentication required');
  });

  it('should accept custom message', () => {
    const err = new UnauthorizedError('Token expired');
    expect(err.message).toBe('Token expired');
  });
});

describe('ForbiddenError', () => {
  it('should create 403 with default message', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(ErrorCodes.AUTH_FORBIDDEN);
    expect(err.message).toBe('Insufficient permissions');
  });

  it('should accept custom message', () => {
    const err = new ForbiddenError('No access');
    expect(err.message).toBe('No access');
  });
});

describe('ValidationError', () => {
  it('should create 400 with details', () => {
    const details = { name: ['too short'], email: ['invalid format'] };
    const err = new ValidationError('Validation failed', details);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(err.details).toEqual(details);
  });

  it('should work without details', () => {
    const err = new ValidationError('Bad input');
    expect(err.statusCode).toBe(400);
    expect(err.details).toBeUndefined();
  });
});

describe('ConflictError', () => {
  it('should create 409 with custom code', () => {
    const err = new ConflictError(ErrorCodes.USER_ALREADY_EXISTS, 'Email taken');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('USER_ALREADY_EXISTS');
    expect(err.message).toBe('Email taken');
  });
});

describe('RateLimitError', () => {
  it('should create 429 with fixed message', () => {
    const err = new RateLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED);
    expect(err.message).toContain('Too many requests');
  });
});
