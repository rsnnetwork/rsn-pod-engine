// ─── JWT Auth Middleware Tests ───────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate, optionalAuth, invalidateUserStatusCache } from '../../middleware/auth';

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

// Mock DB query — return active user by default
jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
}));

function createRequest(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as Request;
}

/** Helper: wait for async middleware to call next */
function waitForNext(fn: (req: Request, res: Response, next: NextFunction) => void, req: Request): Promise<any[]> {
  return new Promise((resolve) => {
    const next = jest.fn((...args: any[]) => resolve(args));
    fn(req, {} as Response, next);
    // Fallback timeout in case next is called synchronously
    setTimeout(() => resolve(next.mock.calls[0] || []), 100);
  });
}

describe('authenticate middleware', () => {
  it('should set req.user for a valid token', async () => {
    const payload = {
      sub: 'user-123',
      email: 'test@example.com',
      role: 'member',
      sessionId: 'sess-abc',
    };
    const token = jwt.sign(payload, 'test-secret-key', { expiresIn: '15m' });
    const req = createRequest(`Bearer ${token}`);

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs.length === 0 || nextArgs[0] === undefined).toBe(true);
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('user-123');
    expect(req.user!.email).toBe('test@example.com');
    expect(req.user!.role).toBe('member');
    expect(req.user!.sessionId).toBe('sess-abc');
  });

  it('should call next with UnauthorizedError when no auth header', async () => {
    const req = createRequest();

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs[0]).toBeDefined();
    expect(nextArgs[0].statusCode).toBe(401);
  });

  it('should call next with UnauthorizedError when auth header is not Bearer', async () => {
    const req = createRequest('Basic abc123');

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs[0]).toBeDefined();
    expect(nextArgs[0].statusCode).toBe(401);
  });

  it('should call next with UnauthorizedError for expired token', async () => {
    const payload = {
      sub: 'user-123',
      email: 'test@example.com',
      role: 'member',
      sessionId: 'sess-abc',
    };
    // Sign with immediate past expiry
    const token = jwt.sign(payload, 'test-secret-key', { expiresIn: '-10s' });
    const req = createRequest(`Bearer ${token}`);

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs[0]).toBeDefined();
    expect(nextArgs[0].statusCode).toBe(401);
    expect(nextArgs[0].message).toContain('expired');
  });

  it('should call next with UnauthorizedError for invalid token', async () => {
    const req = createRequest('Bearer invalid.token.here');

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs[0]).toBeDefined();
    expect(nextArgs[0].statusCode).toBe(401);
  });

  it('should call next with UnauthorizedError for token signed with wrong secret', async () => {
    const token = jwt.sign({ sub: 'x' }, 'wrong-secret');
    const req = createRequest(`Bearer ${token}`);

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs[0]).toBeDefined();
    expect(nextArgs[0].statusCode).toBe(401);
  });

  it('should block deactivated users', async () => {
    const { query: mockQuery } = require('../../db');
    // Clear status cache so DB mock is hit fresh
    invalidateUserStatusCache('user-deactivated');
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'deactivated' }] });

    const payload = {
      sub: 'user-deactivated',
      email: 'deactivated@example.com',
      role: 'member',
      sessionId: 'sess-abc',
    };
    const token = jwt.sign(payload, 'test-secret-key', { expiresIn: '15m' });
    const req = createRequest(`Bearer ${token}`);

    const nextArgs = await waitForNext(authenticate, req);

    expect(nextArgs[0]).toBeDefined();
    expect(nextArgs[0].statusCode).toBe(401);
    expect(nextArgs[0].message).toContain('deactivated');
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
