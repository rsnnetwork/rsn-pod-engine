// ─── The member's photo: placed with the pencil, kept with its crop (30 Oct review, T3a) ──────────────────────────
// PUT /users/me/avatar          { image?: <data URL>, crop?: { x, y, zoom } }  a new photo, or the kept one placed again
// GET /users/me/avatar/source                                                  what the editor opens on (only yours)
// GET /users/me/banner/source                                                  the same for the banner
// PUT /users/me                 { avatarUrl: <data URL> }                       production's own form, as it posts today
//
// The real routes, services and decoder run here against a stand-in for one member's row, so what is stored is what a
// test reads back. A photo change tells the same screens a profile save does: the member's own (user:<id>) and every
// pod they are in.

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
const mockFanoutPod = jest.fn().mockResolvedValue(undefined);
const mockFanoutProfile = jest.fn().mockResolvedValue(undefined);
const mockFanoutAdmins = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutProfileChange: (...a: unknown[]) => mockFanoutProfile(...a),
  fanoutUserEntity: (...a: unknown[]) => mockFanoutUser(...a),
  fanoutPodEntities: (...a: unknown[]) => mockFanoutPod(...a),
  fanoutAdminEntities: (...a: unknown[]) => mockFanoutAdmins(...a),
  fanoutUserBlocks: jest.fn().mockResolvedValue(undefined),
}));

import userRoutes from '../../routes/users';
import { authenticate } from '../../middleware/auth';
import { avatarWriteLimiter, pictureSourceLimiter } from '../../middleware/rateLimit';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { fakeUserRow } from '../fixtures/fake-user-row';
import { BLUE, RED, colourAt, halves, near, sizeOf, solid } from '../fixtures/real-pictures';
import { dataUrl } from '../fixtures/pictures';

const app = express();
app.use(express.json({ limit: '10mb' })); // as index.ts has it
app.use('/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const PODS = ['1a2b3c4d-0000-4000-8000-000000000001', '1a2b3c4d-0000-4000-8000-000000000002'];
// A fresh member for every test: the write limit counts per member.
let ME = randomUUID();
let db = fakeUserRow({ id: ME });
const token = (sub: string) => jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (sub: string = ME) => ({ Authorization: `Bearer ${token(sub)}` });

beforeEach(() => {
  ME = randomUUID();
  db = fakeUserRow({ id: ME, status: 'active', email: `${ME}@example.com`, display_name: 'Ada Lovelace', role: 'member' });
  mockFanoutUser.mockClear();
  mockFanoutProfile.mockClear();
  mockFanoutPod.mockClear();
  mockFanoutAdmins.mockClear();
  mockQuery.mockReset().mockImplementation((sql: string, params?: unknown[]) => {
    if (/SELECT pod_id FROM pod_members/.test(sql)) return Promise.resolve({ rows: PODS.map((pod_id) => ({ pod_id })) });
    return Promise.resolve(db.handle(sql, params) ?? { rows: [] });
  });
});

const pictureWrites = () => db.writes.filter((w) => /avatar_blob/.test(w.sql));

describe('PUT /users/me/avatar', () => {
  it('keeps the chosen photo and where it was placed, answers with the new 1024 photo\'s address, and tells the member\'s screens and pods', async () => {
    const chosen = await halves(3000, 2000, RED, BLUE);
    const res = await request(app).put('/users/me/avatar').set(auth())
      .send({ image: dataUrl('image/jpeg', chosen), crop: { x: 0.3, y: 0.5, zoom: 1 } });
    expect(res.status).toBe(200);
    const url = `https://api.example.test/api/users/${ME}/avatar?v=${(db.row.avatar_updated_at as Date).getTime()}`;
    expect(res.body).toEqual({ success: true, data: { avatarUrl: url } });
    expect(db.row.avatar_url).toBe(url);
    expect(Buffer.compare(db.row.avatar_source_blob as Buffer, chosen)).toBe(0);
    expect(JSON.parse(db.row.avatar_crop as string)).toEqual({ x: 0.3333333333333333, y: 0.5, zoom: 1 });
    expect(await sizeOf(db.row.avatar_blob as Buffer)).toEqual({ width: 1024, height: 1024, format: 'jpeg' });
    expect(near(await colourAt(db.row.avatar_blob as Buffer, 512, 512), RED)).toBe(true);
    // The audience of a profile save: the member's own user:<id> and every pod they are in (realtime/fanout.ts).
    expect(mockFanoutProfile).toHaveBeenCalledWith(ME);
  });

  it('placed again with only a crop: the kept photo is cut again, and only the crop and the photo shown change', async () => {
    const chosen = await halves(2000, 1000, RED, BLUE);
    await request(app).put('/users/me/avatar').set(auth()).send({ image: dataUrl('image/jpeg', chosen), crop: { x: 0.25, y: 0.5, zoom: 1 } });
    const firstUrl = db.row.avatar_url;
    db.writes.length = 0;
    await new Promise((r) => setTimeout(r, 5)); // a later moment, so a later address

    const res = await request(app).put('/users/me/avatar').set(auth()).send({ crop: { x: 0.75, y: 0.5, zoom: 1 } });
    expect(res.status).toBe(200);
    expect(near(await colourAt(db.row.avatar_blob as Buffer, 500, 500), BLUE)).toBe(true);
    expect(Buffer.compare(db.row.avatar_source_blob as Buffer, chosen)).toBe(0);
    expect(pictureWrites()).toHaveLength(1);
    expect(pictureWrites()[0].sql).not.toMatch(/avatar_source_blob/);
    expect(res.body.data.avatarUrl).not.toBe(firstUrl);
    expect(mockFanoutProfile).toHaveBeenCalledWith(ME);
  });

  it('ignores an id in the body: it is always your own photo', async () => {
    const res = await request(app).put('/users/me/avatar').set(auth())
      .send({ image: dataUrl('image/jpeg', await solid(400, 400)), userId: randomUUID() });
    expect(res.status).toBe(200);
    expect(pictureWrites()[0].params[0]).toBe(ME);
  });

  it.each([
    ['nothing at all', {}],
    ['a crop off the picture', { crop: { x: 2, y: 0.5, zoom: 1 } }],
    ['a zoom past 4', { crop: { x: 0.5, y: 0.5, zoom: 9 } }],
    ['a zoom under 1', { crop: { x: 0.5, y: 0.5, zoom: 0.5 } }],
    ['a crop that is not numbers', { crop: { x: '0.5', y: 0.5, zoom: 1 } }],
    ['an empty picture', { image: '' }],
  ])('refuses %s, keeps nothing and tells no screens', async (_name, body) => {
    const res = await request(app).put('/users/me/avatar').set(auth()).send(body);
    expect(res.status).toBe(400);
    expect(pictureWrites()).toHaveLength(0);
    expect(mockFanoutUser).not.toHaveBeenCalled();
    expect(mockFanoutProfile).not.toHaveBeenCalled();
  });

  it('refuses a GIF in a sentence about the photo', async () => {
    const res = await request(app).put('/users/me/avatar').set(auth()).send({ image: dataUrl('image/gif', Buffer.from('GIF89a----------', 'latin1')) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a JPG, PNG or WebP picture for your photo.');
  });

  it('a crop with no photo to place asks for a picture first', async () => {
    const res = await request(app).put('/users/me/avatar').set(auth()).send({ crop: { x: 0.5, y: 0.5, zoom: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a picture first.');
  });

  it('refuses a request with no token, and keeps nothing', async () => {
    const res = await request(app).put('/users/me/avatar').send({ image: dataUrl('image/jpeg', await solid(400, 400)) });
    expect(res.status).toBe(401);
    expect(pictureWrites()).toHaveLength(0);
  });
});

describe('GET /users/me/avatar/source and /users/me/banner/source', () => {
  it('give the member their kept picture and where they placed it', async () => {
    const chosen = await solid(1200, 900, BLUE, 'png');
    await request(app).put('/users/me/avatar').set(auth()).send({ image: dataUrl('image/png', chosen), crop: { x: 0.5, y: 0.5, zoom: 2 } });
    db.row.avatar_crop = JSON.parse(db.row.avatar_crop as string); // the database hands jsonb back as an object
    const res = await request(app).get('/users/me/avatar/source').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { image: dataUrl('image/png', chosen), crop: { x: 0.5, y: 0.5, zoom: 2 } } });
  });

  it('with no banner, the banner\'s source is none', async () => {
    const res = await request(app).get('/users/me/banner/source').set(auth());
    expect(res.body).toEqual({ success: true, data: { image: null, crop: null } });
  });

  it.each(['/users/me/avatar/source', '/users/me/banner/source'])('%s needs a token', async (path) => {
    expect((await request(app).get(path)).status).toBe(401);
  });
});

describe('production\'s form: PUT /users/me with the photo as a data URL', () => {
  // origin/main's ProfilePage.tsx: `await api.put('/users/me', { avatarUrl })`, a JPEG data URL of at most 800x800.
  it('is still accepted: the photo is kept as a picture behind its own address, not as text in the profile', async () => {
    const photo = await solid(800, 600, RED);
    const res = await request(app).put('/users/me').set(auth()).send({ avatarUrl: dataUrl('image/jpeg', photo) });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(ME);
    expect(res.body.data.avatarUrl).toBe(`https://api.example.test/api/users/${ME}/avatar?v=${(db.row.avatar_updated_at as Date).getTime()}`);
    expect(String(db.row.avatar_url)).not.toMatch(/^data:/);
    expect(Buffer.compare(db.row.avatar_source_blob as Buffer, photo)).toBe(0);
    expect(await sizeOf(db.row.avatar_blob as Buffer)).toEqual({ width: 600, height: 600, format: 'jpeg' });
    expect(mockFanoutUser).toHaveBeenCalledWith(ME);
    expect(mockFanoutPod.mock.calls.map((c) => c[0])).toEqual(PODS);
  });

  it('saves the rest of the profile in the same request, as before', async () => {
    const res = await request(app).put('/users/me').set(auth())
      .send({ avatarUrl: dataUrl('image/jpeg', await solid(300, 300)), company: 'Analytical Engines' });
    expect(res.status).toBe(200);
    expect(db.row.company).toBe('Analytical Engines');
    expect(res.body.data.company).toBe('Analytical Engines');
  });

  it('a web address or null is kept as it is, as before', async () => {
    await request(app).put('/users/me').set(auth()).send({ avatarUrl: 'https://lh3.googleusercontent.com/a/x=s96-c' });
    expect(db.row.avatar_url).toBe('https://lh3.googleusercontent.com/a/x=s96-c');
    await request(app).put('/users/me').set(auth()).send({ avatarUrl: null });
    expect(db.row.avatar_url).toBeNull();
  });

  // Final sweep F2 (2 Nov 2026): where a member is based and their time zone are on the admin inspector's onboarding
  // card, and a profile save can change both. Production's form (origin/main ProfilePage.tsx) sends the whole form;
  // the save tells the member's own screens, their pods, and every admin's user pages (admin:users).
  it('production\'s whole-form save tells every admin\'s user pages too', async () => {
    const res = await request(app).put('/users/me').set(auth()).send({
      displayName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', bio: '', company: '', jobTitle: '', industry: '',
      location: 'Lisbon, Portugal', linkedinUrl: '', timezone: 'Europe/Lisbon', phone: '', interests: [], reasonsToConnect: [],
      languages: ['english'], expertiseText: null, whatICareAbout: null, whatICanHelpWith: null, whoIWantToMeet: null,
      whyIWantToMeet: null, myIntent: null,
    });
    expect(res.status).toBe(200);
    expect(db.row.location).toBe('Lisbon, Portugal');
    expect(mockFanoutUser).toHaveBeenCalledWith(ME);
    expect(mockFanoutAdmins).toHaveBeenCalledWith('users');
  });

  it('a data URL that is no picture is refused in a sentence, and nothing is saved', async () => {
    const res = await request(app).put('/users/me').set(auth()).send({ avatarUrl: 'data:text/html;base64,PGgxPg==', company: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a JPG, PNG or WebP picture for your photo.');
    expect(db.row.company).toBeUndefined();
    expect(mockFanoutAdmins).not.toHaveBeenCalled();
  });
});

describe('GET /users/:id/avatar', () => {
  it('serves the photo as the type it was kept as, never sniffed as anything else', async () => {
    db.row.avatar_blob = await solid(64, 64);
    db.row.avatar_blob_type = 'image/jpeg';
    const res = await request(app).get(`/users/${ME}/avatar?v=1`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('the photo routes are signed in and rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlersOf = (method: string, path: string) =>
    (userRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([
    ['put', '/me/avatar', avatarWriteLimiter],
    ['get', '/me/avatar/source', pictureSourceLimiter],
    ['get', '/me/banner/source', pictureSourceLimiter],
  ])('%s %s signs in first, then its limit, then the handler', (method, path, limiter) => {
    const handlers = handlersOf(method as string, path as string);
    expect(handlers.indexOf(authenticate)).toBe(0);
    expect(handlers.indexOf(limiter)).toBeGreaterThan(0);
    expect(handlers.indexOf(limiter)).toBeLessThan(handlers.length - 1);
  });

  it('a member who changes their photo over and over is told to slow down, in words', async () => {
    const heavy = auth();
    for (let i = 0; i < 10; i += 1) {
      await request(app).put('/users/me/avatar').set(heavy).send({});
    }
    const refused = await request(app).put('/users/me/avatar').set(heavy).send({});
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
  });

  // Fix round 1: production's form sends a new photo through PUT /users/me, and each one is opened and cut on the server,
  // so a photo sent that way counts against the same 10 a minute as the pencil's. A profile save without one does not.
  it("a burst of photos sent as data URLs through PUT /users/me is told to slow down after 10, sharing the pencil's limit", async () => {
    const heavy = auth();
    const photo = dataUrl('image/jpeg', await solid(64, 64));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await request(app).put('/users/me').set(heavy).send({ avatarUrl: photo })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses.slice(10)).toEqual([429, 429]);
    const pencil = await request(app).put('/users/me/avatar').set(heavy).send({ image: photo });
    expect(pencil.status).toBe(429);
  });

  it('PUT /users/me without a photo, or with a web address, is not held by the photo limit', async () => {
    const heavy = auth();
    for (let i = 0; i < 12; i += 1) {
      expect((await request(app).put('/users/me').set(heavy).send({ company: `Co ${i}` })).status).toBe(200);
    }
    expect((await request(app).put('/users/me').set(heavy).send({ avatarUrl: 'https://lh3.googleusercontent.com/a/x=s96-c' })).status).toBe(200);
  });
});
