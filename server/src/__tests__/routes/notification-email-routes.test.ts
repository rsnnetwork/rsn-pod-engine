// ─── The weekly email's unsubscribe link, the admin's sample, and the settings save (22 Nov 2026) ────────────
//
// Through Express with the real routers, validation, rate limiters (Redis absent: in memory), the real authenticate and
// role check. The database answers authenticate's account read; the services behind the routes are stood in.
//   GET  /api/email/unsubscribe/weekly    a page with one button; opening it changes nothing
//   POST /api/email/unsubscribe/weekly    the weekly digest switched off, the member's Settings told
//   POST /api/admin/notification-email/sample  admins only, { kind: 'weekly' | 'daily' }
//   PUT  /api/notification-prefs           the three new settings saved, and the member's other screens told

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const SECRET = 'notification-email-routes-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: 'notification-email-routes-secret', clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.rsn.network',
    env: 'test', isTest: true, rateLimitWindowMs: 60_000, rateLimitMaxRequests: 100_000, notificationEmailGate: 'on',
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
jest.mock('../../db', () => ({
  query: async (sql: string) => (/^SELECT status, account_kind FROM users WHERE id = \$1$/.test(String(sql).trim())
    ? { rows: [{ status: 'active', account_kind: 'member' }], rowCount: 1 }
    : { rows: [], rowCount: 0 }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockEmit = jest.fn(async () => undefined);
jest.mock('../../realtime/emit', () => ({ emitEntities: (...a: unknown[]) => mockEmit(...(a as [])), getRealtimeIo: () => 'io', __esModule: true }));
const mockUpdatePrefs = jest.fn();
jest.mock('../../services/notification-prefs/notification-prefs.service', () => ({
  updatePrefs: (...a: unknown[]) => mockUpdatePrefs(...a),
  getPrefs: jest.fn(),
  __esModule: true,
}));
const mockSample = jest.fn();
jest.mock('../../services/notification-email/notification-digest.service', () => {
  const actual = jest.requireActual('../../services/notification-email/notification-digest.service');
  return { ...actual, sendDigestSample: (...a: unknown[]) => mockSample(...a), __esModule: true };
});

import unsubscribeRoutes from '../../routes/email-unsubscribe';
import adminSampleRoutes from '../../routes/notification-email-admin';
import prefsRoutes from '../../routes/notification-prefs';
import { errorHandler } from '../../middleware/errorHandler';
import { mintUnsubscribeToken } from '../../services/notification-email/notification-digest.service';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/email', unsubscribeRoutes);
app.use('/api/admin/notification-email', adminSampleRoutes);
app.use('/api/notification-prefs', prefsRoutes);
app.use(errorHandler);

const tokenFor = (role: string, sub = 'u-1') => jwt.sign({ sub, email: 'ana@getreason.app', role, displayName: 'Ana', sessionId: 's' }, SECRET);

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdatePrefs.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ weekly_digest: true, ...patch }));
});

describe('the weekly email\'s unsubscribe link', () => {
  const url = (token: string) => `/api/email/unsubscribe/weekly?token=${encodeURIComponent(token)}`;

  it('opening the link shows one button and changes nothing, so a mail scanner cannot unsubscribe anyone', async () => {
    const res = await request(app).get(url(mintUnsubscribeToken('ana')));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Stop the weekly email?');
    expect(res.text).toContain('<form method="post" action="https://api.rsn.network/api/email/unsubscribe/weekly?token=');
    expect(res.text).toContain('viewport-fit=cover');
    expect(mockUpdatePrefs).not.toHaveBeenCalled();
  });

  it('the button, or a mail app\'s one-click POST, switches the weekly digest off and tells the member\'s Settings', async () => {
    const res = await request(app).post(url(mintUnsubscribeToken('ana'))).type('form').send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(res.text).toContain('You will no longer get the weekly email.');
    expect(mockUpdatePrefs).toHaveBeenCalledWith('ana', { weekly_digest: false });
    expect(mockEmit).toHaveBeenCalledWith('io', ['ana'], ['user:ana:notification-prefs']);
  });

  it.each([
    ['a sign-in token', () => tokenFor('member', 'ana')],
    ['a forged token', () => jwt.sign({ sub: 'ana', purpose: 'weekly-digest-unsubscribe' }, 'wrong')],
    ['nonsense', () => 'abc'],
  ])('%s gets the calm page and changes nothing', async (_what, make) => {
    const get = await request(app).get(url(make()));
    const post = await request(app).post(url(make()));
    expect(get.status).toBe(400);
    expect(post.status).toBe(400);
    expect(post.text).toContain('This link has expired');
    expect(mockUpdatePrefs).not.toHaveBeenCalled();
  });

  it('no token at all is refused by validation', async () => {
    expect((await request(app).post('/api/email/unsubscribe/weekly')).status).toBe(400);
  });
});

describe('the admin\'s sample', () => {
  it('is for admins only', async () => {
    const res = await request(app).post('/api/admin/notification-email/sample').set('Authorization', `Bearer ${tokenFor('member')}`).send({ kind: 'weekly' });
    expect(res.status).toBe(403);
    expect(mockSample).not.toHaveBeenCalled();
  });

  it('needs a sign-in', async () => {
    expect((await request(app).post('/api/admin/notification-email/sample').send({ kind: 'weekly' })).status).toBe(401);
  });

  it('takes only weekly or daily', async () => {
    const res = await request(app).post('/api/admin/notification-email/sample').set('Authorization', `Bearer ${tokenFor('admin')}`).send({ kind: 'monthly' });
    expect(res.status).toBe(400);
  });

  it('sends one to the admin\'s own address and says where, masked', async () => {
    mockSample.mockResolvedValue({ sent: true, to: 'ana@getreason.app', example: false });
    const res = await request(app).post('/api/admin/notification-email/sample').set('Authorization', `Bearer ${tokenFor('admin')}`).send({ kind: 'weekly' });
    expect(res.status).toBe(200);
    expect(mockSample).toHaveBeenCalledWith('u-1', 'weekly');
    expect(res.body.data.sentTo).not.toBe('ana@getreason.app');
    expect(res.body.data.sentTo).toContain('@getreason.app');
  });

  it('a sample the provider refused is said plainly', async () => {
    mockSample.mockResolvedValue({ sent: false, to: 'ana@getreason.app', example: false });
    const res = await request(app).post('/api/admin/notification-email/sample').set('Authorization', `Bearer ${tokenFor('admin')}`).send({ kind: 'daily' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe('The sample could not be sent just now. Please try again in a moment.');
  });
});

describe('saving the settings', () => {
  it('saves the three new settings and tells the member\'s other screens', async () => {
    const res = await request(app).put('/api/notification-prefs').set('Authorization', `Bearer ${tokenFor('member')}`)
      .send({ email_away_only: false, email_max_per_day: 10, weekly_digest: false });
    expect(res.status).toBe(200);
    expect(mockUpdatePrefs).toHaveBeenCalledWith('u-1', { email_away_only: false, email_max_per_day: 10, weekly_digest: false });
    expect(mockEmit).toHaveBeenCalledWith('io', ['u-1'], ['user:u-1:notification-prefs']);
  });

  it('refuses a daily maximum that is not offered', async () => {
    const res = await request(app).put('/api/notification-prefs').set('Authorization', `Bearer ${tokenFor('member')}`).send({ email_max_per_day: 7 });
    expect(res.status).toBe(400);
    expect(mockUpdatePrefs).not.toHaveBeenCalled();
  });
});
