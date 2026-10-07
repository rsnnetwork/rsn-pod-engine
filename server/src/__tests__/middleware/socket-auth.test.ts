// ─── The socket handshake's token check (Tier-1 A4; 7 Oct 2026) ──────────────
//
// The handshake used to be written out inside index.ts, where all that covered it was a
// source pin, and a source pin passes an inverted condition: with the check turned round
// (refusing every real access token, accepting a Google sign-in state) the tests still
// passed. The check is now a function, so it is tested by what it does: who it lets in,
// who it refuses, and in which words.
//
// It lets in an ACCESS token only. The secret also signs the Google sign-in state (handed
// to anyone who starts a Google sign-in), the photo link and the refresh token; none of
// them opens a socket, even when the user lookup fails open (the database down), so the
// claims alone decide.

jest.mock('../../config', () => ({ default: { jwtSecret: 'test-secret-key' }, __esModule: true }));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }) }));
// A real state is built below, with the real helper, which pulls these two in.
jest.mock('../../services/onboarding/avatar.service', () => ({ captureAvatar: jest.fn(), __esModule: true }));
jest.mock('../../services/onboarding/stage-events.repo', () => ({ record: jest.fn().mockResolvedValue(undefined), __esModule: true }));

import jwt from 'jsonwebtoken';
import { authenticateSocketToken, invalidateUserStatusCache, isUserActive, __test__ } from '../../middleware/auth';
import { buildOauthState, mintPhotoLinkToken } from '../../services/identity/google-photo-link';

const { query: mockQuery } = require('../../db');
const SECRET = 'test-secret-key';
const MEMBER = 'user-123';
const sign = (claims: Record<string, unknown>, secret = SECRET, options: jwt.SignOptions = { expiresIn: '15m' }) =>
  jwt.sign(claims, secret, options);

const ACCESS = { sub: MEMBER, email: 'test@example.com', role: 'member', displayName: 'Test Member', sessionId: 'sess-abc' };

// Tokens the secret signs that are not access tokens, and tokens that are not valid at all.
const REFUSED: Array<[string, string]> = [
  ['a real Google sign-in state, from the real helper', buildOauthState({ inviteCode: 'ABC123', origin: 'https://preview.rsn.network' })],
  ['a real Google sign-in state for a photo link', buildOauthState({ photoLinkUserId: MEMBER, redirect: '/profile' })],
  ['a real photo link token', mintPhotoLinkToken(MEMBER)],
  ['a refresh token', sign({ sub: MEMBER, sessionId: 'sess-abc', type: 'refresh' })],
  ['an access token with a purpose added', sign({ ...ACCESS, purpose: 'anything' })],
  ['an access token with the type refresh added', sign({ ...ACCESS, type: 'refresh' })],
  ['a token with no member', sign({ email: 'test@example.com', role: 'member', sessionId: 'sess-abc' })],
  ['a token with an empty member', sign({ ...ACCESS, sub: '' })],
  ['a token whose member is not text', sign({ ...ACCESS, sub: 42 })],
  ['an access token signed with another secret', sign(ACCESS, 'another-secret-key')],
  ['an expired access token', sign(ACCESS, SECRET, { expiresIn: '-10s' })],
  ['text that is not a token', 'not-a-token'],
];

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [{ status: 'active' }] });
  __test__.clearAll();
});

describe('authenticateSocketToken: who it lets in', () => {
  it('lets a real access token in, as the member it names', async () => {
    await expect(authenticateSocketToken(sign(ACCESS))).resolves.toEqual({
      userId: MEMBER, email: 'test@example.com', role: 'member', displayName: 'Test Member',
    });
  });

  it('names the member by email when the token carries no display name', async () => {
    const { displayName: _name, ...withoutName } = ACCESS;
    await expect(authenticateSocketToken(sign(withoutName))).resolves.toMatchObject({ userId: MEMBER, displayName: 'test@example.com' });
  });

  it('lets in an access token tagged type access, and one that carries only its member (as before)', async () => {
    await expect(authenticateSocketToken(sign({ ...ACCESS, type: 'access' }))).resolves.toMatchObject({ userId: MEMBER });
    await expect(authenticateSocketToken(sign({ sub: 'user-456' }))).resolves.toEqual({
      userId: 'user-456', email: undefined, role: undefined, displayName: undefined,
    });
  });

  it('lets an access token in when the user lookup fails open (the database down), as before', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(authenticateSocketToken(sign(ACCESS))).resolves.toMatchObject({ userId: MEMBER });
  });
});

describe.each([
  ['the user lookup says the member is active', () => mockQuery.mockResolvedValue({ rows: [{ status: 'active' }] })],
  ['the user lookup fails open (the database is down)', () => mockQuery.mockRejectedValue(new Error('db down'))],
])('authenticateSocketToken: who it refuses, when %s', (_when, arm) => {
  beforeEach(() => { arm(); });

  it.each(REFUSED)('refuses %s, in exactly the words the handshake sent before', async (_name, token) => {
    await expect(authenticateSocketToken(token)).rejects.toMatchObject({ message: 'Invalid token' });
  });

  it('asks nothing of the database for a token that is not an access token', async () => {
    mockQuery.mockClear();
    for (const [, token] of REFUSED) await authenticateSocketToken(token).catch(() => undefined);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('authenticateSocketToken: a member who is not active', () => {
  it.each([
    ['deactivated', { rows: [{ status: 'deactivated' }] }],
    ['not found', { rows: [] }],
  ])('refuses a member who is %s, in exactly the words the handshake sent before', async (_why, answer) => {
    mockQuery.mockResolvedValue(answer);
    await expect(authenticateSocketToken(sign(ACCESS))).rejects.toMatchObject({ message: 'Account is deactivated' });
  });
});

// Tier-1 A4: during a lobby surge, 200 members reconnect in seconds. The handshake must not look every one up.
describe('authenticateSocketToken: the user-status cache is shared with the HTTP check', () => {
  it('looks a member up once for repeat handshakes, and the HTTP check reuses that answer', async () => {
    await authenticateSocketToken(sign(ACCESS));
    await authenticateSocketToken(sign(ACCESS));
    await isUserActive(MEMBER); // what authenticate asks
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith('SELECT status FROM users WHERE id = $1', [MEMBER]);
  });

  it('looks the member up again once their cached answer is dropped', async () => {
    await authenticateSocketToken(sign(ACCESS));
    invalidateUserStatusCache(MEMBER);
    await authenticateSocketToken(sign(ACCESS));
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
