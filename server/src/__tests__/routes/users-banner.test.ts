// ─── The member banner routes (21 Oct 2026; cut on the server since the 30 Oct review, T3a) ──────────────────────
// PUT    /users/me/banner  { image?: <data URL>, crop? }  the member's own banner, JPEG/PNG/WebP, at most 3 MB decoded;
//                                                     the old body { image } (the preview's page before T3a) still works
// DELETE /users/me/banner                          back to the default banner
// GET    /users/:id/banner                         the picture, public like the photo, cached for a day
//
// The real banner and picture services, and the real decoder, run here against a stand-in for one member's row, so
// what the routes accept is exactly what the services accept, and what is kept is what a test reads back.

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
import { fakeUserRow } from '../fixtures/fake-user-row';
import { BLUE, RED, colourAt, near, sizeOf, solid } from '../fixtures/real-pictures';
import { dataUrl, png } from '../fixtures/pictures';

const app = express();
app.use(express.json({ limit: '10mb' })); // as index.ts has it
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// A fresh member for every test: the write limit counts per member, and a file of tests is one minute.
let ME = randomUUID();
const OTHER = '9b2d5c1e-3f4a-4b6c-8d7e-0a1b2c3d4e5f';
let db = fakeUserRow({ id: ME });
const token = (sub: string) => jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (sub: string = ME) => ({ Authorization: `Bearer ${token(sub)}` });

// The start of files that are no picture we keep.
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const notAPicture = (head: number[], size = 256) => {
  const bytes = Buffer.alloc(Math.max(size, head.length), 1);
  Buffer.from(head).copy(bytes);
  return bytes;
};
/** A real picture of exactly `size` bytes: a JPEG, then nothing after its end (which a decoder ignores). */
const jpegOfSize = async (size: number) => {
  const j = await solid(1500, 500);
  return Buffer.concat([j, Buffer.alloc(size - j.length, 0)]);
};

// The banner columns of the stand-in row, and another member's banner for the public route.
let other: { banner_blob: Buffer | null; banner_mime: string | null } = { banner_blob: null, banner_mime: null };

beforeEach(() => {
  ME = randomUUID();
  db = fakeUserRow({ id: ME, status: 'active' });
  other = { banner_blob: null, banner_mime: null };
  mockFanoutUser.mockClear();
  mockQuery.mockReset().mockImplementation((sql: string, params: unknown[] = []) => {
    if (/SELECT banner_blob, banner_mime FROM users/.test(sql) && params[0] === OTHER) return Promise.resolve({ rows: [other] });
    if (/UPDATE users SET banner_blob = NULL/.test(sql) && params[0] === OTHER) return Promise.resolve({ rows: [{ id: OTHER }] });
    if (/SELECT status FROM users/.test(sql) && params[0] === OTHER) return Promise.resolve({ rows: [{ status: 'active' }] });
    return Promise.resolve(db.handle(sql, params) ?? { rows: [] });
  });
});

const writes = () => db.writes.filter((w) => /banner/.test(w.sql));

describe('PUT /users/me/banner', () => {
  it.each([
    ['image/jpeg', 'jpeg'], ['image/png', 'png'], ['image/webp', 'webp'],
  ] as const)('keeps a %s as it came, cuts the 2400 by 800 banner from it, answers with its address, and tells their screens', async (mime, format) => {
    const bytes = await solid(3000, 1200, BLUE, format);
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl(mime, bytes) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bannerUrl: `https://api.example.test/api/users/${ME}/banner?v=${(db.row.banner_updated_at as Date).getTime()}` } });
    // The member is the one the token names; nothing in the body can aim it at someone else.
    expect(writes()).toHaveLength(1);
    expect(writes()[0].params[0]).toBe(ME);
    expect(Buffer.compare(db.row.banner_source_blob as Buffer, bytes)).toBe(0);
    expect(db.row.banner_source_mime).toBe(mime);
    expect(db.row.banner_mime).toBe('image/jpeg');
    expect(await sizeOf(db.row.banner_blob as Buffer)).toEqual({ width: 2400, height: 800, format: 'jpeg' });
    expect(mockFanoutUser).toHaveBeenCalledWith(ME);
  });

  it('the old body, a 1500 by 500 strip the page cut itself, is still kept: as the whole strip, never enlarged', async () => {
    const strip = await solid(1500, 500, RED);
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', strip) });
    expect(res.status).toBe(200);
    expect(await sizeOf(db.row.banner_blob as Buffer)).toEqual({ width: 1500, height: 500, format: 'jpeg' });
    expect(JSON.parse(db.row.banner_crop as string)).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
  });

  it('a crop alone places the kept picture again, without sending it', async () => {
    const tall = Buffer.concat([await solid(1500, 1500, RED)]);
    await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', tall) });
    db.writes.length = 0;
    const res = await request(app).put('/users/me/banner').set(auth()).send({ crop: { x: 0.5, y: 0, zoom: 1 } });
    expect(res.status).toBe(200);
    expect(JSON.parse(db.row.banner_crop as string)).toEqual({ x: 0.5, y: 1 / 6, zoom: 1 });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].sql).not.toMatch(/banner_source_blob/);
    expect(near(await colourAt(db.row.banner_blob as Buffer, 10, 10), RED)).toBe(true);
  });

  it('ignores an id in the body: it is always your own banner', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', await solid(1500, 500)), userId: OTHER });
    expect(res.status).toBe(200);
    expect(writes()[0].params[0]).toBe(ME);
  });

  it.each([
    ['image/gif', GIF], ['image/svg+xml', [0x3c, 0x73, 0x76, 0x67]], ['text/html', [0x3c, 0x68]],
  ])('refuses %s with a sentence, keeps nothing and tells no screens', async (mime, head) => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl(mime as string, notAPicture(head as number[])) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a JPG, PNG or WebP picture for your banner.');
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes are not the picture it claims to be', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', notAPicture(GIF)) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That file is not a picture we can use. Choose a JPG, PNG or WebP picture.');
    expect(writes()).toHaveLength(0);
  });

  it('keeps a picture of exactly 3 MB once decoded, and refuses one byte more', async () => {
    const atLimit = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', await jpegOfSize(BANNER_MAX_BYTES)) });
    expect(atLimit.status).toBe(200);
    const over = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', await jpegOfSize(BANNER_MAX_BYTES + 1)) });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toBe('Your banner must be 3 MB or smaller.');
    expect(writes()).toHaveLength(1);
  });

  it('refuses a body far past the limit with the same size sentence, before the service reads it', async () => {
    const res = await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', await jpegOfSize(BANNER_MAX_BYTES + 200_000)) });
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

  it('refuses a body with no picture in it, and a crop with nothing kept to place', async () => {
    for (const body of [{}, { image: 42 }, { image: '' }, { crop: { x: 0.5, y: 0.5, zoom: 7 } }]) {
      const res = await request(app).put('/users/me/banner').set(auth()).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const nothingKept = await request(app).put('/users/me/banner').set(auth()).send({ crop: { x: 0.5, y: 0.5, zoom: 1 } });
    expect(nothingKept.status).toBe(400);
    expect(nothingKept.body.error.message).toBe('Choose a picture first.');
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });

  it('refuses a request with no token, and keeps nothing', async () => {
    const res = await request(app).put('/users/me/banner').send({ image: dataUrl('image/jpeg', await solid(1500, 500)) });
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
  });
});

describe('DELETE /users/me/banner', () => {
  it('takes the banner and the picture it was cut from away, answers that there is none, and tells the member\'s screens', async () => {
    await request(app).put('/users/me/banner').set(auth()).send({ image: dataUrl('image/jpeg', await solid(1500, 500)) });
    db.writes.length = 0;
    const res = await request(app).delete('/users/me/banner').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bannerUrl: null } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].params).toEqual([ME]);
    expect(db.row.banner_blob).toBeNull();
    expect(db.row.banner_source_blob).toBeNull();
    expect(db.row.banner_crop).toBeNull();
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
    other = { banner_blob: await solid(30, 10, RED, 'png'), banner_mime: 'image/png' };
    const res = await request(app).get(`/users/${OTHER}/banner`);
    expect(res.status).toBe(200);
  });

  it('serves the bytes with the stored type and a day-long public cache', async () => {
    const bytes = await solid(30, 10, BLUE, 'webp');
    other = { banner_blob: bytes, banner_mime: 'image/webp' };
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
    const refused = await request(app).put('/users/me/banner').set(heavy).send({ image: dataUrl('image/jpeg', await solid(1500, 500)) });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
    expect((await request(app).delete('/users/me/banner').set(auth(OTHER))).status).toBe(200);
  });
});
