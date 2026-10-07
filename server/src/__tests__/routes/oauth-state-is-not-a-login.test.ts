// ─── A Google sign-in state is not a login (7 Oct 2026) ──────────────────────
//
// The state is a token signed with the same secret as the access and refresh tokens, and
// GET /api/auth/google hands one to anyone who asks, no sign-in needed. So a valid signature
// proves nothing about who is calling, and every place that reads a token must refuse a state
// as an access token or a refresh token. The places: authenticate and optionalAuth (pinned
// by shape in middleware/auth.test.ts), the socket handshake, and the refresh.
//
// These use a REAL state, taken from the real start the way anyone could, through the real
// router and the real identity service; only the database is a stand-in. Where the database
// answers "no such member" a state is refused by accident (the lookup finds nobody); where it
// fails, isUserActive says yes to everyone ("allowing request"), so only the claims can refuse it.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

const SECRET = 'test-secret-with-enough-length-0123456789';
jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-secret-with-enough-length-0123456789', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
    googleClientId: 'gid', googleClientSecret: 'gsecret',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({ sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined), __esModule: true }));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: jest.fn(),
  __esModule: true,
}));

import authRoutes from '../../routes/auth';
import { __test__ } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { mintPhotoLinkToken } from '../../services/identity/google-photo-link';

const MEMBER = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

/** The state anyone gets by starting a Google sign-in: no account, no token, no sign-in needed. */
async function aRealState(): Promise<string> {
  const res = await request(app).get('/auth/google').query({ origin: 'https://preview.rsn.network', inviteCode: 'ABC123' });
  const state = new URL(res.headers.location).searchParams.get('state');
  expect(state).toBeTruthy();
  expect(jwt.verify(state!, SECRET)).toBeTruthy(); // it really is a token our secret signed
  return state!;
}

// POST /auth/google/photo-state is behind authenticate, and mints a photo link for whoever is signed in.
const callingWith = (token: string) =>
  request(app).post('/auth/google/photo-state').set('Authorization', `Bearer ${token}`).send({ redirect: '/profile' });

beforeEach(() => {
  mockQuery.mockReset();
  __test__.clearAll(); // the 60-second status cache would otherwise carry one test's answer into the next
});

describe('a Google sign-in state is not an access token', () => {
  it('is refused when the user lookup finds nobody', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await callingWith(await aRealState());
    expect(res.status).toBe(401);
  });

  it('is refused when the user lookup fails open (the database is down)', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    const res = await callingWith(await aRealState());
    expect(res.status).toBe(401);
    // It reached nothing: no photo link was minted for a member that does not exist.
    expect(res.body.data).toBeUndefined();
  });

  it('is refused even when the user lookup says every member is active', async () => {
    mockQuery.mockResolvedValue({ rows: [{ status: 'active' }] });
    const res = await callingWith(await aRealState());
    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('is refused as a photo link and a refresh token are: only an access token signs a request in', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    const photoLink = mintPhotoLinkToken(MEMBER);
    const refresh = jwt.sign({ sub: MEMBER, sessionId: 's-1', type: 'refresh' }, SECRET, { expiresIn: '7d' });
    expect((await callingWith(photoLink)).status).toBe(401);
    expect((await callingWith(refresh)).status).toBe(401);
  });

  it('is refused on every route behind authenticate, as on the sign-in check', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/auth/session').set('Authorization', `Bearer ${await aRealState()}`);
    expect(res.status).toBe(401);
  });

  it('still lets a real access token through', async () => {
    mockQuery.mockResolvedValue({ rows: [{ status: 'active' }] });
    const access = jwt.sign({ sub: MEMBER, email: 'a@b.co', role: 'member', sessionId: 's-1' }, SECRET, { expiresIn: '15m' });
    const res = await callingWith(access);
    expect(res.status).toBe(200);
    expect(res.body.data.url).toMatch(/\/api\/auth\/google\?photo=/);
  });
});

describe('a Google sign-in state is not a refresh token', () => {
  it('is refused by POST /auth/refresh before any refresh token is looked up or written', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: await aRealState() });
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('the socket handshake', () => {
  // The handshake lives in index.ts, which starts the server when loaded, so it is read, not run.
  const src = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
  const start = src.indexOf('io.use(async (socket, next)');
  const handshake = src.slice(start, src.indexOf('});', start));

  it('refuses a token that is not an access token, before it asks whether the member is active', () => {
    expect(start).toBeGreaterThan(-1);
    expect(src).toMatch(/import \{ isAccessToken \} from '\.\/middleware\/auth'/);
    const refuses = handshake.indexOf('isAccessToken(payload)');
    const asks = handshake.indexOf('isUserActive(payload.sub)');
    expect(refuses).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(refuses);
  });
});
