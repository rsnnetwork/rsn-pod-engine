// ─── The presets route, an in-person body, and production's own bodies (30 Oct 2026, T12) ────────
//
//   - GET /sessions/matching-presets: any signed-in member reads the four presets, { id, name, description }, and
//     nothing else (no admin template, no weights); it is declared before /sessions/:id.
//   - POST /sessions keeps an in-person event's place (config.location) through validation.
//   - Production's client still works: its old body (config.eventType, no format), its 26 Oct format body and its
//     admin template select (GET /admin/templates, every field it reads, unchanged; isPreset is added).
//   - A preset cannot be deleted from the admin page (409 in a sentence); any other template is deleted as before.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm',
    magicLinkExpiryMinutes: 15, clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/session/session.service');

jest.mock('../../realtime/emit', () => ({
  emitEntities: jest.fn(async () => {}),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import { MATCHING_PRESET_IDS } from '@rsn/shared';
import * as sessionService from '../../services/session/session.service';
import sessionRoutes from '../../routes/sessions';
import adminRoutes from '../../routes/admin';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const POD_ID = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const SESSION_ID = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const OTHER_TEMPLATE = '33333333-3333-4333-8333-333333333333';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/sessions', sessionRoutes);
  a.use('/admin', adminRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

const token = (role = 'member', sub = 'user-me') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });

const PRESET_ROWS = [
  { id: MATCHING_PRESET_IDS.general, name: 'General', description: 'A broad mix of people, with shared interests first' },
  { id: MATCHING_PRESET_IDS.foundersInvestors, name: 'Founders and investors', description: 'Founders meet investors first' },
];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/SELECT status, account_kind FROM users WHERE id = \$1/.test(sql)) return { rows: [{ status: 'active', account_kind: 'member' }] };
    if (/FROM matching_templates WHERE is_preset = TRUE/.test(sql)) return { rows: PRESET_ROWS };
    if (/FROM matching_templates WHERE id::text = \$1 AND is_preset = TRUE/.test(sql)) {
      return { rows: Object.values(MATCHING_PRESET_IDS).includes(params[0] as never) ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [], rowCount: 0 };
  });
  (sessionService.createSession as jest.Mock).mockResolvedValue({ id: SESSION_ID, podId: POD_ID, format: 'physical_event' });
  (sessionService.registerParticipant as jest.Mock).mockResolvedValue({ isNewRegistration: false });
});

describe('GET /sessions/matching-presets', () => {
  it('gives any signed-in member the presets as { id, name, description }, nothing more', async () => {
    const res = await request(app()).get('/sessions/matching-presets').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(PRESET_ROWS);
    const sql = mockQuery.mock.calls.map(([q]) => q as string).find((q) => /matching_templates/.test(q))!;
    expect(sql.replace(/\s+/g, ' ')).toBe('SELECT id, name, description FROM matching_templates WHERE is_preset = TRUE ORDER BY id LIMIT 20');
    // It never reached the event route, which would read "matching-presets" as an id.
    expect(sessionService.getSessionById).not.toHaveBeenCalled();
  });

  it('asks for a sign-in', async () => {
    expect((await request(app()).get('/sessions/matching-presets')).status).toBe(401);
  });
});

describe('POST /sessions', () => {
  it('passes an in-person event, with its place, to the service', async () => {
    const res = await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`).send({
      podId: POD_ID, title: 'Dinner', scheduledAt: '2026-11-20T19:00:00.000Z', format: 'physical_event',
      config: { eventType: 'physical_event', location: 'The Ivy, London', durationMinutes: 180, maxParticipants: 20 },
    });
    expect(res.status).toBe(201);
    expect((sessionService.createSession as jest.Mock).mock.calls[0][1]).toMatchObject({
      format: 'physical_event', config: { location: 'The Ivy, London', durationMinutes: 180 },
    });
  });

  it("accepts production's old body (config.eventType, no format) and its 26 Oct format body, unchanged", async () => {
    const old = {
      podId: POD_ID, title: 'Old form', description: '', scheduledAt: null,
      config: { eventType: 'video_meeting', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500, timerVisibility: 'last_10s', matchingPolicy: 'within_event' },
    };
    // origin/main client/src/features/sessions/event-form.ts sessionBody, for a video meeting.
    const oct26 = {
      podId: POD_ID, title: 'Video meeting · Pod', scheduledAt: '2026-11-20T19:00:00.000Z', format: 'video_meeting',
      config: { eventType: 'video_meeting', durationMinutes: 60, maxParticipants: 25 },
    };
    for (const body of [old, oct26]) {
      const res = await request(app()).post('/sessions').set('Authorization', `Bearer ${token()}`).send(body);
      expect(res.status).toBe(201);
    }
    const calls = (sessionService.createSession as jest.Mock).mock.calls;
    expect(calls[0][1]).toEqual(old);
    expect(calls[1][1]).toEqual(oct26);
  });
});

describe('the admin template list and delete', () => {
  it("GET /admin/templates still sends every field production's select reads, and adds isPreset", async () => {
    const res = await request(app()).get('/admin/templates').set('Authorization', `Bearer ${token('admin', 'user-admin')}`);
    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls.map(([q]) => q as string).find((q) => /FROM matching_templates ORDER BY/.test(q))!;
    for (const alias of [
      'id', 'name', 'description', 'is_default AS "isDefault"', 'weights', 'matching_policy AS "matchingPolicy"',
      'cooldown_months AS "cooldownMonths"', 'is_preset AS "isPreset"', 'created_at AS "createdAt"',
    ]) expect(sql).toContain(alias);
    expect(sql).toMatch(/ORDER BY is_default DESC, created_at DESC/);
  });

  it('refuses to delete a preset, with a sentence, and deletes another template as before', async () => {
    const admin = `Bearer ${token('admin', 'user-admin')}`;
    const refused = await request(app()).delete(`/admin/templates/${MATCHING_PRESET_IDS.foundersInvestors}`).set('Authorization', admin);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'TEMPLATE_IS_PRESET',
      message: "This is one of REASON's speed-networking presets, so it can't be deleted. You can change its weights.",
    });
    expect(mockQuery.mock.calls.some(([q]) => /DELETE FROM matching_templates/.test(q as string))).toBe(false);

    const deleted = await request(app()).delete(`/admin/templates/${OTHER_TEMPLATE}`).set('Authorization', admin);
    expect(deleted.status).toBe(200);
    expect(mockQuery.mock.calls.some(([q, p]) => /DELETE FROM matching_templates WHERE id = \$1 AND is_default = FALSE/.test(q as string)
      && (p as unknown[])[0] === OTHER_TEMPLATE)).toBe(true);
  });
});

describe('a removed account cannot register for an in-person event (Review Focus 3)', () => {
  it('is turned away before the registration is tried', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT status, account_kind FROM users WHERE id = \$1/.test(sql)) return { rows: [{ status: 'deactivated' }] };
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app()).post(`/sessions/${SESSION_ID}/register`).set('Authorization', `Bearer ${token('member', 'user-removed')}`);
    expect([401, 403]).toContain(res.status);
    expect(sessionService.registerParticipant).not.toHaveBeenCalled();
  });
});
