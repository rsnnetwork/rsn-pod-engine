// ─── The member banner routes (21 Oct 2026) ──────────────────────────────────
// PUT    /users/me/banner  { image: <data URL> }   the member's own banner, JPEG/PNG/WebP, at most 3 MB decoded
// DELETE /users/me/banner                          back to the default banner
// GET    /users/:id/banner                         the picture, public like the photo, cached for a day
//
// The real banner service runs here against a database stand-in, so what the routes accept is exactly what
// the service accepts.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, apiBaseUrl: 'https://api.example.test',
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../services/onboarding/avatar.service', () => ({ __esModule: true, getAvatarBlob: jest.fn(), captureAvatar: jest.fn() }));
const mockFanoutUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutUserEntity: (...a: unknown[]) => mockFanoutUser(...a),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutPodEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserBlocks: jest.fn().mockResolvedValue(undefined),
}));

import userRoutes from '../../routes/users';
import { authenticate } from '../../middleware/auth';
import { bannerReadLimiter, bannerWriteLimiter } from '../../middleware/rateLimit';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { BANNER_MAX_BYTES } from '../../services/user/banner.service';
import { dataUrl, jpeg, png, webpLossy } from '../fixtures/pictures';

const app = express();
app.use(express.json({ limit: '10mb' })); // as index.ts has it
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// A fresh member for every test: the write limit counts per member, and a file of tests is one minute.
let ME = randomUUID();
const OTHER = '9b2d5c1e-3f4a-4b6c-8d7e-0a1b2c3d4e5f';
const token = (sub: string) => jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (sub: string = ME) => ({ Authorization: `Bearer ${token(sub)}` });

// The three kinds kept, as files with real headers (the server reads the size from them), and the start of other files.
type Kind = 'jpeg' | 'png' | 'webp';
const JPEG: Kind = 'jpeg';
const PNG: Kind = 'png';
const WEBP: Kind = 'webp';
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const file = (head: Kind | number[], size = 256): Buffer => {
  if (head === 'jpeg') return jpeg(1500, 500, size);
  if (head === 'png') return png(1500, 500, size);
  if (head === 'webp') return webpLossy(1500, 500, size);
  const bytes = Buffer.alloc(Math.max(size, head.length), 1);
  Buffer.from(head).copy(bytes);
  return bytes;
};

const STAMP = new Date('2026-10-21T11:00:00.000Z');
let stored: { banner_blob: Buffer | null; banner_mime: string | null } = { banner_blob: null, banner_mime: null };

// What the database answers: the member is active (authenticate asks), and the banner columns behave like a row.
beforeEach(() => {
  ME = randomUUID();
  mockFanoutUser.mockClear();
  stored = { banner_blob: null, banner_mime: null };
  mockQuery.mockReset().mockImplementation((sql: string, params: unknown[] = []) => {
    if (/SELECT status FROM users/.test(sql)) return Promise.resolve({ rows: [{ status: 'active' }] });
    if (/UPDATE users SET banner_blob = \$2/.test(sql)) {
      stored = { banner_blob: params[1] as Buffer, banner_mime: params[2] as string };
      return Promise.resolve({ rows: [{ banner_updated_at: STAMP }] });
    }
    if (/UPDATE users SET banner_blob = NULL/.test(sql)) {
      stored = { banner_blob: null, banner_mime: null };
      return Promise.resolve({ rows: [{ id: params[0] }] });
    }
    if (/SELECT banner_blob, banner_mime FROM users/.test(sql)) return Promise.resolve({ rows: [stored] });
    return Promise.resolve({ rows: [] });
  });
});

const writes = () => mockQuery.mock.calls.filter((c) => /UPDATE users SET banner/.test(String(c[0])));

describe('PUT /users/me/banner', () => {
  it.each([
    ['image/jpeg', JPEG], ['image/png', PNG], ['image/webp', WEBP],
  ])('keeps a %s for the member who sent it, answers with its address, and tells their screens', async (mime, head) => {
    const bytes = file(head as Kind);
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl(mime as string, bytes) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bannerUrl: `https://api.example.test/api/users/${ME}/banner?v=${STAMP.getTime()}` } });
    // The member is the one the token names; nothing in the body can aim it at someone else.
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1][0]).toBe(ME);
    expect(Buffer.compare(stored.banner_blob!, bytes)).toBe(0);
    expect(stored.banner_mime).toBe(mime);
    expect(mockFanoutUser).toHaveBeenCalledWith(ME);
  });

  it('ignores an id in the body: it is always your own banner', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', file(JPEG)), userId: OTHER });
    expect(res.status).toBe(200);
    expect(writes()[0][1][0]).toBe(ME);
  });

  it.each([
    ['image/gif', GIF], ['image/svg+xml', [0x3c, 0x73, 0x76, 0x67]], ['text/html', [0x3c, 0x68]],
  ])('refuses %s with a sentence, keeps nothing and tells no screens', async (mime, head) => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl(mime as string, file(head as number[])) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a JPG, PNG or WebP picture for your banner.');
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes are not the picture it claims to be', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', file(GIF)) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That file is not a picture we can use. Choose a JPG, PNG or WebP picture.');
    expect(writes()).toHaveLength(0);
  });

  it('keeps a picture of exactly 3 MB once decoded, and refuses one byte more', async () => {
    const atLimit = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', file(JPEG, BANNER_MAX_BYTES)) });
    expect(atLimit.status).toBe(200);
    const over = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', file(JPEG, BANNER_MAX_BYTES + 1)) });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toBe('Your banner must be 3 MB or smaller.');
    expect(writes()).toHaveLength(1);
  });

  it('refuses a body far past the limit with the same size sentence, before the service reads it', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', file(JPEG, BANNER_MAX_BYTES + 200_000)) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.image).toEqual(['Your banner must be 3 MB or smaller.']);
    expect(writes()).toHaveLength(0);
  });

  it('refuses a picture over 4096 pixels on a side, in a sentence, though it is small in bytes', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/png', png(5000, 1000)) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Your banner can be at most 4096 by 4096 pixels.');
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });

  it('refuses a body with no picture in it', async () => {
    for (const body of [{}, { image: 42 }, { image: '' }]) {
      const res = await request(app).put('/users/me/banner').set(auth()).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });

  it('refuses a request with no token, and keeps nothing', async () => {
    const res = await request(app).put('/users/me/banner').send({ image: dataUrl('image/jpeg', file(JPEG)) });
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });
});

describe('DELETE /users/me/banner', () => {
  it('takes the banner away, answers that there is none, and tells the member\'s screens', async () => {
    stored = { banner_blob: file(JPEG), banner_mime: 'image/jpeg' };
    const res = await request(app).delete('/users/me/banner').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bannerUrl: null } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1]).toEqual([ME]);
    expect(stored.banner_blob).toBeNull();
    expect(mockFanoutUser).toHaveBeenCalledWith(ME);
  });

  it('refuses a request with no token', async () => {
    const res = await request(app).delete('/users/me/banner');
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });
});

describe('GET /users/:id/banner', () => {
  it('needs no token: a banner shows wherever the profile does', async () => {
    stored = { banner_blob: file(PNG, 900), banner_mime: 'image/png' };
    const res = await request(app).get(`/users/${OTHER}/banner`);
    expect(res.status).toBe(200);
  });

  it('serves the bytes with the stored type and a day-long public cache', async () => {
    const bytes = file(WEBP, 1200);
    stored = { banner_blob: bytes, banner_mime: 'image/webp' };
    const res = await request(app).get(`/users/${OTHER}/banner?v=1761040000000`).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/webp/);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    // Set by the route itself, not left to helmet: a browser never reads the bytes as anything but the stored type.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
    const read = mockQuery.mock.calls.find((c) => /SELECT banner_blob, banner_mime/.test(String(c[0])))!;
    expect(read[1]).toEqual([OTHER]);
  });

  it('is a 404 with nothing in it when the member has no banner', async () => {
    const res = await request(app).get(`/users/${OTHER}/banner`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  it('refuses an id that is no member id without asking the database', async () => {
    const res = await request(app).get('/users/not-a-member/banner');
    expect(res.status).toBe(400);
    expect(mockQuery.mock.calls.some((c) => /banner/.test(String(c[0])))).toBe(false);
  });

  it('a database failure is an error answer, not a crash', async () => {
    mockQuery.mockImplementation((sql: string) => (/SELECT banner_blob/.test(sql) ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [] })));
    const res = await request(app).get(`/users/${OTHER}/banner`);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('the banner routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlersOf = (method: string, path: string) =>
    (userRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([['put', '/me/banner'], ['delete', '/me/banner']])('%s %s signs in first, then the write limit, then the handler', (method, path) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(2);
    const signedIn = handlers.indexOf(authenticate);
    const limited = handlers.indexOf(bannerWriteLimiter);
    expect(signedIn).toBe(0);
    expect(limited).toBeGreaterThan(signedIn);
    expect(limited).toBeLessThan(handlers.length - 1);
  });

  it('get /:id/banner carries the read limit ahead of its handler, and no sign-in', () => {
    const handlers = handlersOf('get', '/:id/banner');
    expect(handlers.length).toBeGreaterThan(1);
    expect(handlers.indexOf(bannerReadLimiter)).toBe(0);
    expect(handlers).not.toContain(authenticate);
  });

  it('a member who changes their banner over and over is told to slow down, in words, and someone else is not', async () => {
    const heavy = auth();
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).delete('/users/me/banner').set(heavy)).status).toBe(200);
    }
    const refused = await request(app).put('/users/me/banner').set(heavy).send({ image: dataUrl('image/jpeg', file(JPEG)) });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
    expect((await request(app).delete('/users/me/banner').set(auth(OTHER))).status).toBe(200);
  });
});
