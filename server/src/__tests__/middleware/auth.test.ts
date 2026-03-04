// ─── JWT Auth Middleware Tests ───────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate, optionalAuth } from '../../middleware/auth';

// Mock config
jest.mock('../../config', () => ({
  default: { jwtSecret: 'test-secret-key' },
  __esModule: true,
}));

// Mock logger
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

function createRequest(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as Request;
}

describe('authenticate middleware', () => {
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    next = jest.fn();
  });

  it('should set req.user for a valid token', () => {
    const payload = {
      sub: 'user-123',
      email: 'test@example.com',
      role: 'member',
      sessionId: 'sess-abc',
    };
    const token = jwt.sign(payload, 'test-secret-key', { expiresIn: '15m' });
    const req = createRequest(`Bearer ${token}`);

    authenticate(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('user-123');
    expect(req.user!.email).toBe('test@example.com');
    expect(req.user!.role).toBe('member');
    expect(req.user!.sessionId).toBe('sess-abc');
  });

  it('should call next with UnauthorizedError when no auth header', () => {
    const req = createRequest();

    authenticate(req, {} as Response, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(401);
  });

  it('should call next with UnauthorizedError when auth header is not Bearer', () => {
    const req = createRequest('Basic abc123');

    authenticate(req, {} as Response, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(401);
  });

  it('should call next with UnauthorizedError for expired token', () => {
    const payload = {
      sub: 'user-123',
      email: 'test@example.com',
      role: 'member',
      sessionId: 'sess-abc',
    };
    // Sign with immediate past expiry
    const token = jwt.sign(payload, 'test-secret-key', { expiresIn: '-10s' });
    const req = createRequest(`Bearer ${token}`);

    authenticate(req, {} as Response, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(401);
    expect(err.message).toContain('expired');
  });

  it('should call next with UnauthorizedError for invalid token', () => {
    const req = createRequest('Bearer invalid.token.here');

    authenticate(req, {} as Response, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(401);
  });

  it('should call next with UnauthorizedError for token signed with wrong secret', () => {
    const token = jwt.sign({ sub: 'x' }, 'wrong-secret');
    const req = createRequest(`Bearer ${token}`);

    authenticate(req, {} as Response, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(401);
  });
});

describe('optionalAuth middleware', () => {
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    next = jest.fn();
  });

  it('should set req.user for a valid token', () => {
    const payload = {
      sub: 'user-456',
      email: 'opt@example.com',
      role: 'host',
      sessionId: 'sess-opt',
    };
    const token = jwt.sign(payload, 'test-secret-key', { expiresIn: '15m' });
    const req = createRequest(`Bearer ${token}`);

    optionalAuth(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('user-456');
  });

  it('should proceed without error when no auth header', () => {
    const req = createRequest();

    optionalAuth(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });

  it('should proceed without error for invalid token', () => {
    const req = createRequest('Bearer invalid.token');

    optionalAuth(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });

  it('should proceed without error for expired token', () => {
    const token = jwt.sign({ sub: 'x', email: 'x', role: 'member', sessionId: 'y' }, 'test-secret-key', { expiresIn: '-10s' });
    const req = createRequest(`Bearer ${token}`);

    optionalAuth(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });
});
