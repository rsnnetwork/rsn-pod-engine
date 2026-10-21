// ─── JWT Auth Middleware Tests ───────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate, optionalAuth, invalidateUserStatusCache, __test__ } from '../../middleware/auth';

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

// ─── Only an access token signs a request in (7 Oct 2026) ────────────────────
//
// The secret also signs tokens that are not access tokens: the refresh token (a `type`), the photo
// link and the Google sign-in state (a `purpose`). The state is handed to ANYONE who starts a Google
// sign-in, so "signed by us" proves nothing about who is calling. An access token names its member
// (`sub`) and carries neither claim. Every case runs with the user lookup active, and again with it
// failing open (the database down: isUserActive then says yes to everyone), so it is the claims alone
// that decide.

const ACCESS = { sub: 'user-123', email: 'test@example.com', role: 'member', sessionId: 'sess-abc' };
const GOOGLE_STATE = { inviteCode: 'ABC', origin: 'https://preview.rsn.network', purpose: 'google-oauth-state' };
const SHAPES: Array<[string, Record<string, unknown>, boolean]> = [
  ['an access token', ACCESS, true],
  ['an access token that carries only its member', { sub: 'user-123' }, true],
  ['a Google sign-in state: no member, a purpose', GOOGLE_STATE, false],
  ['a Google sign-in state that names a member (a photo link state)', { ...GOOGLE_STATE, photoLinkUserId: 'user-123' }, false],
  ['a photo link: a member and a purpose', { sub: 'user-123', purpose: 'google-photo' }, false],
  ['a refresh token: a member and a type', { sub: 'user-123', sessionId: 'sess-abc', type: 'refresh' }, false],
  // An access token may be tagged as one (a type of 'access'); a token that says it is anything else is not.
  ['an access token tagged type access', { ...ACCESS, type: 'access' }, true],
  ['an access token with a purpose added', { ...ACCESS, purpose: 'anything' }, false],
  ['an access token with the type refresh added', { ...ACCESS, type: 'refresh' }, false],
  ['an access token with another type added', { ...ACCESS, type: 'something-else' }, false],
  ['a token with no member', { email: 'test@example.com', role: 'member', sessionId: 'sess-abc' }, false],
  ['a token with an empty member', { ...ACCESS, sub: '' }, false],
  ['a token whose member is not text', { ...ACCESS, sub: 42 }, false],
];

describe('only an access token signs a request in', () => {
  const { query: mockQuery } = require('../../db');
  const sign = (claims: Record<string, unknown>) => jwt.sign(claims, 'test-secret-key', { expiresIn: '15m' });

  afterEach(() => { mockQuery.mockResolvedValue({ rows: [{ status: 'active' }] }); });

  describe.each([
    ['the user lookup says the member is active', () => mockQuery.mockResolvedValue({ rows: [{ status: 'active' }] })],
    ['the user lookup fails open (the database is down)', () => mockQuery.mockRejectedValue(new Error('db down'))],
  ])('when %s', (_when, arm) => {
    beforeEach(() => { arm(); __test__.clearAll(); });

    it.each(SHAPES)('authenticate: %s', async (_name, claims, accepted) => {
      const req = createRequest(`Bearer ${sign(claims)}`);
      const nextArgs = await waitForNext(authenticate, req);
      if (accepted) {
        expect(nextArgs[0]).toBeUndefined();
        expect(req.user?.userId).toBe(claims.sub);
      } else {
        expect(nextArgs[0]).toBeDefined();
        expect(nextArgs[0].statusCode).toBe(401);
        expect(req.user).toBeUndefined();
      }
    });

    it.each(SHAPES)('optionalAuth: %s', (_name, claims, accepted) => {
      const next = jest.fn();
      const req = createRequest(`Bearer ${sign(claims)}`);
      optionalAuth(req, {} as Response, next);
      expect(next).toHaveBeenCalledWith();
      if (accepted) expect(req.user?.userId).toBe(claims.sub);
      else expect(req.user).toBeUndefined();
    });
  });
});
