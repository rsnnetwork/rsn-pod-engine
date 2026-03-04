// ─── RBAC Middleware Tests ───────────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import { requireRole, requireOwnerOrRole } from '../../middleware/rbac';
import { UserRole } from '@rsn/shared';

function createRequest(user?: { userId: string; email: string; role: UserRole; sessionId: string }): Request {
  const req = { user, params: {} } as unknown as Request;
  return req;
}

describe('requireRole', () => {
  let next: jest.MockedFunction<NextFunction>;
  const res = {} as Response;

  beforeEach(() => {
    next = jest.fn();
  });

  it('should pass when user has the required role', () => {
    const req = createRequest({
      userId: '1', email: 'a@b.com', role: UserRole.HOST, sessionId: 's1',
    });

    requireRole(UserRole.HOST)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should pass when user has one of multiple allowed roles', () => {
    const req = createRequest({
      userId: '1', email: 'a@b.com', role: UserRole.ADMIN, sessionId: 's1',
    });

    requireRole(UserRole.HOST, UserRole.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should reject when user role is not in allowed list', () => {
    const req = createRequest({
      userId: '1', email: 'a@b.com', role: UserRole.MEMBER, sessionId: 's1',
    });

    requireRole(UserRole.HOST, UserRole.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain('member');
  });

  it('should reject when no user is set (unauthenticated)', () => {
    const req = createRequest();

    requireRole(UserRole.MEMBER)(req, res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(401);
  });
});

describe('requireOwnerOrRole', () => {
  let next: jest.MockedFunction<NextFunction>;
  const res = {} as Response;

  beforeEach(() => {
    next = jest.fn();
  });

  it('should pass when user is the resource owner', () => {
    const req = createRequest({
      userId: 'owner-123', email: 'a@b.com', role: UserRole.MEMBER, sessionId: 's1',
    });

    const extractor = (_r: Request) => 'owner-123';
    requireOwnerOrRole(extractor)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should pass when user has a fallback role even if not owner', () => {
    const req = createRequest({
      userId: 'not-owner', email: 'a@b.com', role: UserRole.ADMIN, sessionId: 's1',
    });

    const extractor = (_r: Request) => 'owner-123';
    requireOwnerOrRole(extractor, UserRole.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should reject when user is neither owner nor has fallback role', () => {
    const req = createRequest({
      userId: 'not-owner', email: 'a@b.com', role: UserRole.MEMBER, sessionId: 's1',
    });

    const extractor = (_r: Request) => 'owner-123';
    requireOwnerOrRole(extractor, UserRole.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(403);
  });

  it('should reject when user is not authenticated', () => {
    const req = createRequest();

    const extractor = (_r: Request) => 'owner-123';
    requireOwnerOrRole(extractor, UserRole.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0] as any;
    expect(err.statusCode).toBe(401);
  });

  it('should pass when extractor returns undefined and user has fallback role', () => {
    const req = createRequest({
      userId: 'user-1', email: 'a@b.com', role: UserRole.HOST, sessionId: 's1',
    });

    const extractor = (_r: Request) => undefined;
    requireOwnerOrRole(extractor, UserRole.HOST)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});
