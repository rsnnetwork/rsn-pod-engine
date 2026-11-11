// ─── The general API limiter leaves the venue-sized routes to their own buckets (Part 3 Task 1, fix round 1) ──────
//
// index.ts runs `app.use('/api', apiLimiter)` before every router: 100 a minute in production, keyed per signed-in
// member and otherwise per network address, so everyone signed out behind one venue's Wi-Fi is one bucket. The event
// image read (600 a minute per client) and the RSN Call link's landing, email and verify (their own buckets, c64b2717)
// would never reach their own limits behind it. The general limiter now skips exactly those four routes
// (hasOwnBucket), by method and shape: /api/call-links/me/events, /:code/entry and /:code/enter stay under it.
//
// The requests here go through the same middleware order as index.ts (checked against its source below): noStore,
// then apiLimiter, then the routers, with the general limit at production's 100 a minute.

jest.mock('../../config', () => {
  const config = {
    jwtSecret: 'test-jwt-secret', env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60_000, rateLimitMaxRequests: 100, apiBaseUrl: 'https://api.example.test', clientUrl: 'https://app.example.test',
  };
  return { __esModule: true, default: config, config };
});
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../db', () => ({ __esModule: true, query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn() }));
jest.mock('../../services/session/event-image.service', () => ({
  __esModule: true,
  getEventImageBlob: jest.fn().mockResolvedValue({ bytes: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' }),
  saveEventImage: jest.fn(), removeEventImage: jest.fn(), getEventImageSource: jest.fn(),
}));
jest.mock('../../services/session/call-link.service', () => ({
  __esModule: true,
  getCallLanding: jest.fn().mockResolvedValue({ code: 'k7m2x9q4ra', title: 'Founders breakfast' }),
}));
jest.mock('../../services/session/call-entry.service', () => ({ __esModule: true }));

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { apiLimiter, hasOwnBucket, OWN_BUCKET_ROUTES } from '../../middleware/rateLimit';
import { noStore } from '../../middleware/no-store';
import eventImageRoutes from '../../routes/event-image';
import callLinkRoutes from '../../routes/call-links';

const EVENT = '5e550000-0000-4000-8000-0000000000d1';

describe('hasOwnBucket', () => {
  it.each([
    ['GET', `/api/sessions/${EVENT}/image`],
    ['GET', `/api/sessions/${EVENT}/image?v=1794388878811`],
    ['HEAD', `/api/sessions/${EVENT}/image`],
    ['GET', '/api/call-links/k7m2x9q4ra'],
    ['GET', '/api/call-links/K7M2-X9Q4-RA?x=1'],
    ['POST', '/api/call-links/k7m2x9q4ra/email'],
    ['POST', '/api/call-links/k7m2x9q4ra/verify'],
    ['GET', '/api/public/profiles/AbCdEfGhIjKlMnOpQrStUv'],
    ['HEAD', '/api/public/profiles/AbCdEfGhIjKlMnOpQrStUv/'],
  ])('%s %s keeps to its own bucket', (method, url) => {
    expect(hasOwnBucket(method, url)).toBe(true);
  });

  it.each([
    ['PUT', `/api/sessions/${EVENT}/image`],
    ['DELETE', `/api/sessions/${EVENT}/image`],
    ['GET', `/api/sessions/${EVENT}/image/source`],
    ['GET', `/api/sessions/${EVENT}`],
    ['GET', '/api/sessions'],
    ['POST', '/api/call-links/k7m2x9q4ra'],
    ['GET', '/api/call-links/me/events'],
    ['GET', '/api/call-links/k7m2x9q4ra/entry'],
    ['POST', '/api/call-links/k7m2x9q4ra/enter'],
    ['GET', '/api/call-links/k7m2x9q4ra/email'],
    ['POST', '/api/auth/magic-link'],
    ['GET', '/api/users/someone/image'],
    ['POST', '/api/public/profiles/AbCdEfGhIjKlMnOpQrStUv'],
    ['GET', '/api/public/profiles'],
    ['GET', '/api/public/profiles/AbCdEfGhIjKlMnOpQrStUv/more'],
    ['GET', '/api/users/me/public-link'],
    ['POST', '/api/users/me/public-link'],
  ])('%s %s stays under the general limiter', (method, url) => {
    expect(hasOwnBucket(method, url)).toBe(false);
  });

  it('names exactly five routes (the public profile link since Shirley pilot S6)', () => {
    expect(OWN_BUCKET_ROUTES).toHaveLength(5);
  });
});

describe('the mount order is index.ts\'s', () => {
  const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
  const at = (line: string) => {
    const i = index.indexOf(line);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('noStore, then apiLimiter on /api, before the image and call-link routers', () => {
    const limiter = at("app.use('/api', apiLimiter);");
    expect(at("app.use('/api', noStore);")).toBeLessThan(limiter);
    expect(at("app.use('/api/sessions', eventImageRoutes);")).toBeGreaterThan(limiter);
    expect(at("app.use('/api/call-links', callLinkRoutes);")).toBeGreaterThan(limiter);
    expect(at("app.use('/api/public/profiles', publicProfileRoutes);")).toBeGreaterThan(limiter);
  });
});

describe('through that order, one venue address signed out', () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api', noStore);
  app.use('/api', apiLimiter);
  app.use('/api/sessions', eventImageRoutes);
  app.use('/api/call-links', callLinkRoutes);

  const from = (ip: string) => ({ 'cf-connecting-ip': ip });

  it('150 image reads in a minute all succeed, and the general bucket is untouched by them: the 101st other read is 429', async () => {
    const ip = '198.51.100.21';
    for (let i = 0; i < 150; i += 1) {
      const res = await request(app).get(`/api/sessions/${EVENT}/image?v=1`).set(from(ip));
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 100; i += 1) {
      const res = await request(app).get('/api/call-links/me/events').set(from(ip));
      expect(res.status).toBe(401);
    }
    const over = await request(app).get('/api/call-links/me/events').set(from(ip));
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    // The image still reads: its own bucket (600) is far from full.
    expect((await request(app).get(`/api/sessions/${EVENT}/image?v=1`).set(from(ip))).status).toBe(200);
  }, 60_000);

  it('150 call-link landing reads in a minute all succeed, while the 101st other read is 429', async () => {
    const ip = '198.51.100.22';
    for (let i = 0; i < 150; i += 1) {
      const res = await request(app).get('/api/call-links/k7m2x9q4ra').set(from(ip));
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 100; i += 1) {
      expect((await request(app).get('/api/call-links/me/events').set(from(ip))).status).toBe(401);
    }
    expect((await request(app).get('/api/call-links/me/events').set(from(ip))).status).toBe(429);
    expect((await request(app).get('/api/call-links/k7m2x9q4ra').set(from(ip))).status).toBe(200);
  }, 60_000);
});
