// ─── A closed or suspended account is refused at sign-in, with the reason ────
//
// 23 Sep 2026 (Shradha): her deleted account was handed a full session at
// sign-in, the very next request refused it, and she was bounced to the login
// page with no reason. Every door that issues a session now refuses first, in
// words, and never writes a refresh token for an account that cannot use it.

import jwt from 'jsonwebtoken';
import { UserRole } from '@rsn/shared';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config', () => ({
  default: {
    jwtSecret: 'test-jwt-secret',
    jwtAccessExpiry: '15m',
    jwtRefreshExpiry: '7d',
    magicLinkSecret: 'test-magic-link-secret',
    magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  saveEnrichedCandidate: jest.fn(),
  setEnrichmentState: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/onboarding/avatar.service', () => ({
  hasAvatar: jest.fn().mockResolvedValue(false),
  tryGravatar: jest.fn().mockResolvedValue(false),
  __esModule: true,
}));

import * as identityService from '../../../services/identity/identity.service';
import { sendMagicLinkEmail } from '../../../services/email/email.service';

const account = (status: string) => ({
  id: 'user-closed',
  email: 'shradha@example.com',
  displayName: 'Shradha',
  role: UserRole.MEMBER,
  status,
  emailVerified: true,
  avatarUrl: 'https://example.com/a.png',
});

const CLOSED = /This account was closed\. Ask to join again/;
const SUSPENDED = /This account is suspended/;

const issuedSession = () => mockQuery.mock.calls.some(c => /INSERT INTO refresh_tokens/.test(String(c[0])));
const liveLink = () => ({ id: 'ml-1', email: 'shradha@example.com', expires_at: new Date(Date.now() + 3_600_000), used_at: null });

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  (sendMagicLinkEmail as jest.Mock).mockClear();
});

describe('asking for a sign-in link', () => {
  it('a closed account is told why, and is sent no link', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [account('deactivated')], rowCount: 1 }); // getUserByEmail

    await expect(identityService.sendMagicLink('shradha@example.com'))
      .rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_CLOSED', message: expect.stringMatching(CLOSED) });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO magic_links/.test(String(c[0])))).toBe(false);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'banned'])('a %s account is told it is suspended', async (status) => {
    mockQuery.mockResolvedValueOnce({ rows: [account(status)], rowCount: 1 });

    await expect(identityService.sendMagicLink('shradha@example.com'))
      .rejects.toMatchObject({ statusCode: 403, code: 'USER_SUSPENDED', message: expect.stringMatching(SUSPENDED) });
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });
});

describe('opening a sign-in link', () => {
  it('a closed account gets no session, and the reason (403, so the client does not try to refresh)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [liveLink()], rowCount: 1 }) // SELECT magic_links
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE used_at
      .mockResolvedValueOnce({ rows: [account('deactivated')], rowCount: 1 }); // getUserByEmail

    await expect(identityService.verifyMagicLink('token'))
      .rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_CLOSED', message: expect.stringMatching(CLOSED) });
    expect(issuedSession()).toBe(false);
    expect(mockQuery.mock.calls.some(c => /UPDATE users SET last_active_at/.test(String(c[0])))).toBe(false);
  });

  it('a suspended account gets no session either', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [liveLink()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [account('suspended')], rowCount: 1 });

    await expect(identityService.verifyMagicLink('token'))
      .rejects.toMatchObject({ statusCode: 403, code: 'USER_SUSPENDED' });
    expect(issuedSession()).toBe(false);
  });

  it('an active account still signs in (the refusal is not a blanket one)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [liveLink()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [account('active')], rowCount: 1 });

    const pair = await identityService.verifyMagicLink('token');
    expect(pair.accessToken).toBeTruthy();
    expect(issuedSession()).toBe(true);
  });
});

describe('signing in with Google', () => {
  it('an existing closed account is refused before anything is written', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [account('deactivated')], rowCount: 1 }); // getUserByEmail

    await expect(identityService.findOrCreateGoogleUser({ email: 'Shradha@Example.com', picture: 'https://g/p.png' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_CLOSED' });
    expect(issuedSession()).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('an existing banned account is refused as suspended', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [account('banned')], rowCount: 1 });

    await expect(identityService.findOrCreateGoogleUser({ email: 'shradha@example.com' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'USER_SUSPENDED' });
    expect(issuedSession()).toBe(false);
  });
});

describe('refreshing a session', () => {
  const refreshToken = () => jwt.sign({ sub: 'user-closed', sessionId: 's1', type: 'refresh' }, 'test-jwt-secret', { expiresIn: '7d' });

  it('a closed account is a 401 that carries the reason, so the client ends the session and says why', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'row-1', revoked_at: null }], rowCount: 1 }) // SELECT refresh_tokens
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE revoke
      .mockResolvedValueOnce({ rows: [account('deactivated')], rowCount: 1 }); // getUserById

    await expect(identityService.refreshAccessToken(refreshToken()))
      .rejects.toMatchObject({ statusCode: 401, code: 'ACCOUNT_CLOSED', message: expect.stringMatching(CLOSED) });
    expect(issuedSession()).toBe(false);
  });

  it('an account deleted mid-session (its tokens were revoked with it) still hears why', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'row-1', revoked_at: new Date() }], rowCount: 1 }) // revoked by deleteUser
      .mockResolvedValueOnce({ rows: [account('deactivated')], rowCount: 1 }); // getUserById

    await expect(identityService.refreshAccessToken(refreshToken()))
      .rejects.toMatchObject({ statusCode: 401, code: 'ACCOUNT_CLOSED' });
    expect(issuedSession()).toBe(false);
  });

  it('a revoked token on an ACTIVE account is still the plain "revoked" 401', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'row-1', revoked_at: new Date() }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [account('active')], rowCount: 1 });

    await expect(identityService.refreshAccessToken(refreshToken()))
      .rejects.toMatchObject({ statusCode: 401, code: 'AUTH_UNAUTHORIZED', message: 'Refresh token revoked or not found' });
  });

  it('a suspended account is a 401 with USER_SUSPENDED', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'row-1', revoked_at: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [account('suspended')], rowCount: 1 });

    await expect(identityService.refreshAccessToken(refreshToken()))
      .rejects.toMatchObject({ statusCode: 401, code: 'USER_SUSPENDED' });
  });
});
