// ─── An event's image, and the zone a new event takes (10 Nov 2026 spec, Part 3 Task 1) ─────────────────────────
//
// PUT    /sessions/:id/image         { image?, crop? }  the event's host or an admin; cut as a banner (3:1), kept with
//                                                      the picture it was cut from; answers { imageUrl } with ?v=
// DELETE /sessions/:id/image         the same people; answers { imageUrl: null }
// GET    /sessions/:id/image/source  what the editor opens on, the same people
// GET    /sessions/:id/image         public (an <img> sends no token), nosniff, a day's cache, 404 when none,
//                                     600 reads a minute per client (a whole venue's Wi-Fi opens a landing at once)
//
// The real routes, service, decoder and cutter run here against a stand-in sessions table, so what is kept is what a
// test reads back. A co-host, a participant and anyone else are refused (the same rule as updateSession); an event
// that does not exist (or was deleted) is a 404. Both changes tell the event's people and their lists.
//
// And the zone a new event takes: the one sent when it is real (400 in a sentence when not), else the host's own
// zone when it is real, else UTC.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../../config', () => {
  const config = {
    jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, apiBaseUrl: 'https://api.example.test',
    clientUrl: 'https://app.example.test', eventComms: 'off',
  };
  return { __esModule: true, default: config, config };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (...a: unknown[]) => mockTransaction(...a),
  __esModule: true,
}));
const mockFanoutSession = jest.fn().mockResolvedValue(undefined);
const mockFanoutSessionList = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/fanout', () => ({
  __esModule: true,
  fanoutSessionEntities: (...a: unknown[]) => mockFanoutSession(...a),
  fanoutSessionListEntities: (...a: unknown[]) => mockFanoutSessionList(...a),
}));
jest.mock('../../../services/pod/pod.service', () => ({
  __esModule: true,
  getPodById: jest.fn().mockResolvedValue({ id: 'pod-1', name: 'Pod', status: 'active', podType: 'speed_networking' }),
  getMemberRole: jest.fn().mockResolvedValue('director'),
}));

import eventImageRoutes from '../../../routes/event-image';
import sessionRoutes from '../../../routes/sessions';
import userRoutes from '../../../routes/users';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';
import { EVENT_IMAGE_READS_PER_CLIENT } from '../../../middleware/rateLimit';
import { createSessionSchema, updateSessionSchema } from '../../../routes/sessions';
import { createSession } from '../../../services/session/session.service';
import { eventImageUrl } from '../../../services/session/event-image-url';
import { BLUE, sizeOf, solid } from '../../fixtures/real-pictures';
import { dataUrl } from '../../fixtures/pictures';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use('/sessions', eventImageRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });

interface Row {
  id: string; pod_id: string; host_user_id: string;
  image_blob: Buffer | null; image_mime: string | null; image_crop: string | null;
  image_source_blob: Buffer | null; image_source_mime: string | null; image_updated_at: Date | null;
}

let sessions: Map<string, Row>;
let writes: Array<{ sql: string; params: unknown[] }>;
let locked: string[];
let HOST: string;
let EVENT: string;
const COHOST = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const PARTICIPANT = '4d5e6f7a-8b9c-4dae-8f01-2b3c4d5e6f70';
const ADMIN = '5e6f7a8b-9cad-4ebf-8012-3c4d5e6f7081';
const UNKNOWN = '6f7a8b9c-adbe-4fc0-8123-4d5e6f708192';

function handle(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  if (/SELECT status, account_kind FROM users/.test(sql)) return { rows: [{ status: 'active', account_kind: 'member' }], rowCount: 1 };
  const row = sessions.get(params[0] as string);
  if (/SELECT host_user_id, pod_id FROM sessions WHERE id = \$1/.test(sql)) {
    if (/FOR UPDATE/.test(sql) && row) locked.push(row.id);
    return row ? { rows: [{ host_user_id: row.host_user_id, pod_id: row.pod_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/SELECT image_source_blob AS source/.test(sql)) {
    return row ? { rows: [{ source: row.image_source_blob, source_mime: row.image_source_mime, crop: row.image_crop }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/SELECT image_blob AS blob, image_mime AS mime FROM sessions/.test(sql)) {
    return row ? { rows: [{ blob: row.image_blob, mime: row.image_mime }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^\s*UPDATE sessions SET image_blob = \$2/.test(sql) && row) {
    writes.push({ sql, params });
    row.image_blob = params[1] as Buffer; row.image_mime = params[2] as string; row.image_crop = params[3] as string;
    row.image_updated_at = params[4] as Date;
    if (params.length > 5) { row.image_source_blob = params[5] as Buffer; row.image_source_mime = params[6] as string; }
    return { rows: [], rowCount: 1 };
  }
  if (/^\s*UPDATE sessions SET image_blob = NULL/.test(sql) && row) {
    writes.push({ sql, params });
    Object.assign(row, { image_blob: null, image_mime: null, image_crop: null, image_source_blob: null, image_source_mime: null, image_updated_at: new Date() });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

beforeEach(() => {
  HOST = randomUUID();
  EVENT = randomUUID();
  sessions = new Map([[EVENT, {
    id: EVENT, pod_id: 'pod-1', host_user_id: HOST,
    image_blob: null, image_mime: null, image_crop: null, image_source_blob: null, image_source_mime: null, image_updated_at: null,
  }]]);
  writes = [];
  locked = [];
  mockFanoutSession.mockClear();
  mockFanoutSessionList.mockClear();
  mockQuery.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => handle(sql, params));
  mockTransaction.mockReset().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: async (sql: string, params?: unknown[]) => handle(sql, params) }));
});

const picture = async () => dataUrl('image/png', await solid(1200, 400, BLUE, 'png'));

describe('PUT /sessions/:id/image', () => {
  it('the host keeps a picture: cut 3:1, kept with its source, answered with a ?v= address, its people told', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ image: await picture() });
    expect(res.status).toBe(200);
    const row = sessions.get(EVENT)!;
    expect(res.body).toEqual({ success: true, data: { imageUrl: `https://api.example.test/api/sessions/${EVENT}/image?v=${row.image_updated_at!.getTime()}` } });
    expect(res.body.data.imageUrl).toContain('?v=');
    expect(row.image_mime).toBe('image/jpeg');
    expect(row.image_source_mime).toBe('image/png');
    expect(await sizeOf(row.image_blob!)).toEqual({ width: 1200, height: 400, format: 'jpeg' });
    // Written under the row's lock, which re-checked who may change it.
    expect(locked).toEqual([EVENT]);
    expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT);
    expect(mockFanoutSessionList).toHaveBeenCalledWith('pod-1', EVENT);
  });

  it('an admin may change any event\'s image', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/image`).set(as(ADMIN, 'admin')).send({ image: await picture() });
    expect(res.status).toBe(200);
  });

  it('a crop alone cuts the kept picture again, without sending it', async () => {
    await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ image: await picture() });
    writes = [];
    const res = await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ crop: { x: 0.5, y: 0.5, zoom: 2 } });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).not.toMatch(/image_source_blob/);
    expect(JSON.parse(sessions.get(EVENT)!.image_crop!)).toEqual({ x: 0.5, y: 0.5, zoom: 2 });
  });

  it('a crop with no kept picture asks for one', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ crop: { x: 0.5, y: 0.5, zoom: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a picture first.');
  });

  it.each([['a co-host', COHOST], ['a participant', PARTICIPANT]])('%s is refused in a sentence, and nothing is kept or told', async (_who, id) => {
    const res = await request(app).put(`/sessions/${EVENT}/image`).set(as(id)).send({ image: await picture() });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Only the event's host can change its image.");
    expect(writes).toHaveLength(0);
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });

  it('an event that does not exist, or was deleted, is a 404', async () => {
    const res = await request(app).put(`/sessions/${UNKNOWN}/image`).set(as(HOST)).send({ image: await picture() });
    expect(res.status).toBe(404);
    sessions.delete(EVENT);
    const gone = await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ image: await picture() });
    expect(gone.status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it('refuses a file that is not a picture, in the event image\'s words', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ image: dataUrl('image/gif', Buffer.from('GIF89a........')) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Choose a JPG, PNG or WebP picture for the event image.');
  });

  it('signs in first', async () => {
    const res = await request(app).put(`/sessions/${EVENT}/image`).send({ image: await picture() });
    expect(res.status).toBe(401);
  });
});

describe('GET /sessions/:id/image (public) and DELETE', () => {
  it('serves the bytes without a token, as the picture type only, cached a day; after DELETE it is a 404', async () => {
    await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ image: await picture() });
    const res = await request(app).get(`/sessions/${EVENT}/image`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(Buffer.compare(res.body as Buffer, sessions.get(EVENT)!.image_blob!)).toBe(0);

    mockFanoutSession.mockClear();
    mockFanoutSessionList.mockClear();
    const removed = await request(app).delete(`/sessions/${EVENT}/image`).set(as(HOST));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ success: true, data: { imageUrl: null } });
    expect(sessions.get(EVENT)!.image_source_blob).toBeNull();
    expect(mockFanoutSession).toHaveBeenCalledWith('pod-1', EVENT);
    expect(mockFanoutSessionList).toHaveBeenCalledWith('pod-1', EVENT);
    expect((await request(app).get(`/sessions/${EVENT}/image`)).status).toBe(404);
  });

  it('a co-host cannot take it away', async () => {
    const res = await request(app).delete(`/sessions/${EVENT}/image`).set(as(COHOST));
    expect(res.status).toBe(403);
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });

  it('404 for an event with no image and for one that does not exist', async () => {
    expect((await request(app).get(`/sessions/${EVENT}/image`)).status).toBe(404);
    expect((await request(app).get(`/sessions/${UNKNOWN}/image`)).status).toBe(404);
  });

  it('the editor opens on the kept picture for the host, and refuses a co-host', async () => {
    await request(app).put(`/sessions/${EVENT}/image`).set(as(HOST)).send({ image: await picture() });
    const mine = await request(app).get(`/sessions/${EVENT}/image/source`).set(as(HOST));
    expect(mine.status).toBe(200);
    expect(mine.body.data.image).toMatch(/^data:image\/png;base64,/);
    expect(mine.body.data.crop).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
    expect((await request(app).get(`/sessions/${EVENT}/image/source`).set(as(COHOST))).status).toBe(403);
  });

  it('holds one client to 600 reads a minute: the 601st is a 429, another client is unaffected', async () => {
    expect(EVENT_IMAGE_READS_PER_CLIENT).toBe(600);
    const from = (ip: string) => request(app).get(`/sessions/${EVENT}/image`).set('cf-connecting-ip', ip);
    for (let i = 0; i < 600; i += 1) {
      const res = await from('198.51.100.7');
      expect(res.status).toBe(404);
    }
    expect((await from('198.51.100.7')).status).toBe(429);
    expect((await from('198.51.100.8')).status).toBe(404);
  }, 60_000);
});

describe('eventImageUrl', () => {
  it('is null without an image, absolute with ?v= the change time with one', () => {
    expect(eventImageUrl('e1', false, new Date())).toBeNull();
    expect(eventImageUrl('e1', true, null)).toBeNull();
    expect(eventImageUrl('e1', true, '2026-11-11T10:00:00.000Z')).toBe(`https://api.example.test/api/sessions/e1/image?v=${Date.parse('2026-11-11T10:00:00.000Z')}`);
  });
});

describe('the zone a new event takes', () => {
  let inserted: unknown[] | null;
  let hostZone: string | null;

  beforeEach(() => {
    inserted = null;
    hostZone = 'Europe/Madrid';
    mockQuery.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/SELECT status, account_kind FROM users/.test(sql)) return { rows: [{ status: 'active', account_kind: 'member' }], rowCount: 1 };
      if (/SELECT timezone FROM users WHERE id = \$1/.test(sql)) return { rows: [{ timezone: hostZone }], rowCount: 1 };
      if (/INSERT INTO sessions/.test(sql)) {
        inserted = params;
        return { rows: [{ id: params[0], podId: 'pod-1', title: params[2], timezone: params[params.length - 1], hasImage: false, imageUpdatedAt: null }], rowCount: 1 };
      }
      if (/SELECT call_code FROM sessions/.test(sql)) return { rows: [{ call_code: 'abcdefghjk' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  const input = (extra: Record<string, unknown> = {}) => ({
    podId: '11111111-1111-4111-8111-111111111111', title: 'Founders evening', scheduledAt: '2026-12-01T13:00:00.000Z', ...extra,
  });

  it("without a zone, takes the host's own zone", async () => {
    const created = await createSession(HOST, input() as never);
    expect(inserted).toContain('Europe/Madrid');
    expect(created.timezone).toBe('Europe/Madrid');
    expect(created.imageUrl).toBeNull();
  });

  it("with a zone, takes it, whatever the host's own", async () => {
    await createSession(HOST, input({ timezone: 'Europe/Copenhagen' }) as never);
    expect(inserted).toContain('Europe/Copenhagen');
    expect(inserted).not.toContain('Europe/Madrid');
  });

  it.each([null, 'garbage', '+05:45'])("a host whose own zone is %p gives UTC", async (zone) => {
    hostZone = zone;
    await createSession(HOST, input() as never);
    expect(inserted).toContain('UTC');
  });

  it('the forms\' zone is checked and spelled as the runtime spells it; an invented one is refused in a sentence', () => {
    const ok = createSessionSchema.safeParse(input({ timezone: 'europe/copenhagen' }));
    expect(ok.success && ok.data.timezone).toBe('Europe/Copenhagen');
    for (const schema of [createSessionSchema, updateSessionSchema]) {
      const bad = schema.safeParse(input({ timezone: 'Mars/Base' }));
      expect(bad.success).toBe(false);
      if (!bad.success) expect(bad.error.issues[0]).toMatchObject({ path: ['timezone'], message: "Choose the event's time zone from the list." });
    }
  });

  it('POST and PUT /sessions answer an invented zone with a 400 in that sentence, before anything is written', async () => {
    const sessionsApp = express();
    sessionsApp.use(express.json());
    sessionsApp.use('/sessions', sessionRoutes);
    sessionsApp.use(errorHandler);
    const created = await request(sessionsApp).post('/sessions').set(as(HOST)).send(input({ timezone: 'Mars/Base' }));
    expect(created.status).toBe(400);
    expect(created.body.error.message).toBe("Choose the event's time zone from the list.");
    expect(created.body.error.details).toEqual({ timezone: ["Choose the event's time zone from the list."] });
    const moved = await request(sessionsApp).put(`/sessions/${EVENT}`).set(as(HOST)).send({ timezone: 'Mars/Base' });
    expect(moved.status).toBe(400);
    expect(moved.body.error.message).toBe("Choose the event's time zone from the list.");
    expect(inserted).toBeNull();
  });

  it('PUT /users/me refuses a zone that is not one ("+05:45", invented) in a sentence, before anything is written', async () => {
    const usersApp = express();
    usersApp.use(express.json());
    usersApp.use('/users', userRoutes);
    usersApp.use(errorHandler);
    for (const timezone of ['Mars/Base', '+05:45', 'garbage']) {
      const res = await request(usersApp).put('/users/me').set(as(HOST)).send({ timezone });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Choose a time zone from the list.');
      expect(res.body.error.details).toEqual({ timezone: ['Choose a time zone from the list.'] });
    }
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE users/.test(String(sql)))).toBe(false);
  });
});
