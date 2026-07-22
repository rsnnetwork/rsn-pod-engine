// ─── GET /users/:id/avatar — route tests ─────────────────────────────────────
// Deliberately public (no `authenticate`): avatars render in public profile
// contexts (search results, cards) where the viewer may not be signed in.
// Streams the stored blob with its content-type and a 24h Cache-Control;
// 404 when nothing has been captured yet. avatar.service is mocked so this
// file only exercises routing/response-shape, not the capture/storage logic
// (covered by avatar.service.test.ts).

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: 'test-jwt-secret',
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
  },
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../../db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/onboarding/avatar.service', () => ({
  __esModule: true,
  getAvatarBlob: jest.fn(),
  captureAvatar: jest.fn(),
}));

import userRoutes from '../../routes/users';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { getAvatarBlob } from '../../services/onboarding/avatar.service';

const mockGetAvatarBlob = getAvatarBlob as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/users', userRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /users/:id/avatar', () => {
  it('requires no auth — an unauthenticated request is served, not rejected with 401', async () => {
    mockGetAvatarBlob.mockResolvedValue(null);
    const res = await request(app).get('/users/user-1/avatar');
    expect(res.status).not.toBe(401);
  });

  it('200s with the raw bytes, the stored content-type, and a 24h Cache-Control', async () => {
    const blob = Buffer.from('fake-jpeg-bytes');
    mockGetAvatarBlob.mockResolvedValue({ blob, contentType: 'image/jpeg' });

    const res = await request(app).get('/users/user-1/avatar');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(Buffer.compare(Buffer.from(res.body), blob)).toBe(0);
    expect(mockGetAvatarBlob).toHaveBeenCalledWith('user-1');
  });

  it('404s when no avatar has been captured for this user', async () => {
    mockGetAvatarBlob.mockResolvedValue(null);
    const res = await request(app).get('/users/user-1/avatar');
    expect(res.status).toBe(404);
  });

  it('propagates an unexpected service error to the error handler rather than crashing', async () => {
    mockGetAvatarBlob.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/users/user-1/avatar');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
