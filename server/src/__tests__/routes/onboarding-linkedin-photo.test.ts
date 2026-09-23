// ─── "Is this you?" through the real router (23 Sep 2026) ────────────────────
//
// The tick-box writes broke on 21 Sep in the WIRING — validate() and the
// schema disagreed — while every service test stayed green. So these go through
// express exactly as a browser does. The rule they guard: a member can only
// ever say yes to THEIR OWN scraped photo. Nothing they send can choose which
// image goes on a profile.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, clientUrl: 'https://app.test' },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(async (cb: Function) => cb({ query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }) })),
  __esModule: true,
}));
const mockFind = jest.fn();
const mockUse = jest.fn();
jest.mock('../../services/onboarding/linkedin-photo', () => ({
  findLinkedinPhoto: (...a: unknown[]) => mockFind(...a),
  useLinkedinPhoto: (...a: unknown[]) => mockUse(...a),
  __esModule: true,
}));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutUserEntity: (...a: unknown[]) => mockFanout(...a),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/onboarding/stage-events.repo', () => ({
  record: jest.fn().mockResolvedValue(undefined),
  sanitizeErrorMessage: (e: unknown) => String(e),
  __esModule: true,
}));
jest.mock('../../services/onboarding/avatar.service', () => ({
  tryGravatar: jest.fn().mockResolvedValue(undefined),
  captureAvatar: jest.fn(),
  __esModule: true,
}));

import onboardingRoutes from '../../routes/onboarding';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/onboarding', onboardingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = jwt.sign({ sub: 'u-1', email: 'u@e.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

beforeEach(() => jest.clearAllMocks());

describe('GET /onboarding/linkedin-photo', () => {
  it('returns the photo found for the signed-in member', async () => {
    mockFind.mockResolvedValue('https://media.licdn.com/dms/image/own.jpg');
    const res = await auth(request(app).get('/onboarding/linkedin-photo'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ photoUrl: 'https://media.licdn.com/dms/image/own.jpg' });
    expect(mockFind).toHaveBeenCalledWith('u-1');
  });

  it('null when there is none — the card simply does not appear', async () => {
    mockFind.mockResolvedValue(null);
    const res = await auth(request(app).get('/onboarding/linkedin-photo'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ photoUrl: null });
  });

  it('needs a signed-in member', async () => {
    const res = await request(app).get('/onboarding/linkedin-photo');
    expect(res.status).toBe(401);
    expect(mockFind).not.toHaveBeenCalled();
  });
});

describe('POST /onboarding/linkedin-photo', () => {
  it('"that\'s me" makes it their photo, and their face updates everywhere', async () => {
    mockUse.mockResolvedValue('done');
    const res = await auth(request(app).post('/onboarding/linkedin-photo'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ used: true });
    expect(mockUse).toHaveBeenCalledWith('u-1');
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('a URL in the body is ignored — the member cannot choose the image', async () => {
    mockUse.mockResolvedValue('done');
    await auth(request(app).post('/onboarding/linkedin-photo')
      .send({ photoUrl: 'https://evil.example/someone-else.jpg', url: 'https://evil.example/x.jpg' }));
    // Called with the member id and nothing else: the body never reaches it.
    expect(mockUse).toHaveBeenCalledWith('u-1');
    expect(mockUse.mock.calls[0]).toHaveLength(1);
  });

  it('404 when there is no LinkedIn photo to use, and nothing changes', async () => {
    mockUse.mockResolvedValue('none');
    const res = await auth(request(app).post('/onboarding/linkedin-photo'));
    expect(res.status).toBe(404);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('a failed download says so plainly, in words a member can read', async () => {
    mockUse.mockResolvedValue('failed');
    const res = await auth(request(app).post('/onboarding/linkedin-photo'));
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/could not fetch that photo/i);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('needs a signed-in member', async () => {
    const res = await request(app).post('/onboarding/linkedin-photo');
    expect(res.status).toBe(401);
    expect(mockUse).not.toHaveBeenCalled();
  });
});
