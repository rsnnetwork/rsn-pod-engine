// ─── Error Handler Middleware Tests ──────────────────────────────────────────
import { Request, Response } from 'express';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../middleware/errors';

// Mock logger to suppress output
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

function mockResponse(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/test',
    ...overrides,
  } as Request;
}

describe('errorHandler', () => {
  const next = jest.fn();

  it('should handle AppError with correct status and JSON structure', () => {
    const err = new NotFoundError('User', '123');
    const res = mockResponse();

    errorHandler(err, mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: 'User with id 123 not found',
        details: undefined,
      },
    });
  });

  it('should handle UnauthorizedError (401)', () => {
    const err = new UnauthorizedError('Invalid token');
    const res = mockResponse();

    errorHandler(err, mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'AUTH_UNAUTHORIZED' }),
      })
    );
  });

  it('should handle ValidationError with details', () => {
    const details = { email: ['invalid'] };
    const err = new ValidationError('Validation failed', details);
    const res = mockResponse();

    errorHandler(err, mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { email: ['invalid'] },
      },
    });
  });

  it('should handle generic (non-AppError) errors as 500', () => {
    const err = new Error('Something broke');
    const res = mockResponse();

    errorHandler(err, mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'INTERNAL_ERROR',
        }),
      })
    );
  });

  it('should hide error details in production for unknown errors', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const err = new Error('secret DB info');
    const res = mockResponse();

    errorHandler(err, mockRequest(), res, next);

    const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.error.message).toBe('An unexpected error occurred');
    expect(jsonCall.error.message).not.toContain('secret');

    process.env.NODE_ENV = originalEnv;
  });

  it('should show error message in development for unknown errors', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const err = new Error('debug info here');
    const res = mockResponse();

    errorHandler(err, mockRequest(), res, next);

    const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.error.message).toBe('debug info here');

    process.env.NODE_ENV = originalEnv;
  });
});

describe('notFoundHandler', () => {
  it('should return 404 with route info', () => {
    const req = mockRequest({ method: 'POST', path: '/api/v1/missing' });
    const res = mockResponse();

    notFoundHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route POST /api/v1/missing not found',
      },
    });
  });
});
