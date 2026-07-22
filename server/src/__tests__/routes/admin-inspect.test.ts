// ─── Admin per-user inspection routes (Task E2) ─────────────────────────────
//
// TDD for the admin inspector's read API: onboarding transcript + enrichment
// internals, DM conversations/messages (audited reads), pokes + reports +
// blocks. Security-relevant — authz is first-class: member -> 403, admin ->
// 200, on every route. The DM message read must audit-or-abort (an
// unauditable read must not succeed).
//
// Real authenticate + requireRole middleware run; only the DB module is
// mocked. Query calls are dispatched by inspecting the SQL text so the tests
// stay robust to the exact call order inside Promise.all groups.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
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

import { query as dbQuery } from '../../db';
import adminInspectRoutes from '../../routes/admin-inspect';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminInspectRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(role: string, userId = 'admin-1') {
  return jwt.sign(
    { sub: userId, email: 'u@e.com', role, sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' },
  );
}

const app = createApp();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const CONV_ID = '33333333-3333-3333-3333-333333333333';
const ADMIN_ID = '44444444-4444-4444-4444-444444444444';

type Handler = (sql: string, params: any[]) => any;

/** Builds a query mock that dispatches on SQL shape; falls through to a default (empty) result. */
function mockQuery(handlers: Handler[], userExists = true) {
  (dbQuery as jest.Mock).mockImplementation((sql: string, params: any[] = []) => {
    // authenticate()'s isUserActive check + our own user-existence checks.
    if (/SELECT\s+status\s+FROM\s+users/i.test(sql)) {
      return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
    }
    if (/^SELECT\s+id\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1/i.test(sql.trim())) {
      return Promise.resolve(userExists ? { rows: [{ id: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 });
    }
    for (const h of handlers) {
      const r = h(sql, params);
      if (r !== undefined) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Authorization — mandatory on every route ───────────────────────────────

describe('authz', () => {
  it('GET /users/:id/onboarding — 401 unauthenticated, 403 member, 200 admin', async () => {
    mockQuery([
      (sql) => (/LEFT JOIN user_intent_profiles/i.test(sql) ? { rows: [{ id: USER_ID }], rowCount: 1 } : undefined),
    ]);

    const unauth = await request(app).get(`/admin/users/${USER_ID}/onboarding`);
    expect(unauth.status).toBe(401);

    const member = await request(app)
      .get(`/admin/users/${USER_ID}/onboarding`)
      .set('Authorization', `Bearer ${makeToken('member', 'member-1')}`);
    expect(member.status).toBe(403);

    const admin = await request(app)
      .get(`/admin/users/${USER_ID}/onboarding`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(admin.status).toBe(200);
  });

  it('GET /users/:id/conversations — 401 unauthenticated, 403 member, 200 admin', async () => {
    mockQuery([]); // user-existence + empty conversation list is enough for a 200

    const unauth = await request(app).get(`/admin/users/${USER_ID}/conversations`);
    expect(unauth.status).toBe(401);

    const member = await request(app)
      .get(`/admin/users/${USER_ID}/conversations`)
      .set('Authorization', `Bearer ${makeToken('member', 'member-1')}`);
    expect(member.status).toBe(403);

    const admin = await request(app)
      .get(`/admin/users/${USER_ID}/conversations`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(admin.status).toBe(200);
  });

  it('GET /conversations/:id/messages — 401 unauthenticated, 403 member, 200 admin', async () => {
    mockQuery([
      (sql) => (/FROM\s+dm_conversations\s+WHERE\s+id\s*=\s*\$1/i.test(sql) ? { rows: [{ id: CONV_ID }], rowCount: 1 } : undefined),
      (sql) => (/INSERT\s+INTO\s+audit_log/i.test(sql) ? { rows: [], rowCount: 1 } : undefined),
      (sql) => (/FROM\s+direct_messages/i.test(sql) ? { rows: [], rowCount: 0 } : undefined),
    ]);

    const unauth = await request(app).get(`/admin/conversations/${CONV_ID}/messages`);
    expect(unauth.status).toBe(401);

    const member = await request(app)
      .get(`/admin/conversations/${CONV_ID}/messages`)
      .set('Authorization', `Bearer ${makeToken('member', 'member-1')}`);
    expect(member.status).toBe(403);

    const admin = await request(app)
      .get(`/admin/conversations/${CONV_ID}/messages`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(admin.status).toBe(200);
  });

  it('GET /users/:id/interactions — 401 unauthenticated, 403 member, 200 admin', async () => {
    mockQuery([]); // user-existence + empty everything is enough for a 200

    const unauth = await request(app).get(`/admin/users/${USER_ID}/interactions`);
    expect(unauth.status).toBe(401);

    const member = await request(app)
      .get(`/admin/users/${USER_ID}/interactions`)
      .set('Authorization', `Bearer ${makeToken('member', 'member-1')}`);
    expect(member.status).toBe(403);

    const admin = await request(app)
      .get(`/admin/users/${USER_ID}/interactions`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(admin.status).toBe(200);
  });

  it('a super_admin also passes (role hierarchy)', async () => {
    mockQuery([]);
    const res = await request(app)
      .get(`/admin/users/${USER_ID}/interactions`)
      .set('Authorization', `Bearer ${makeToken('super_admin', ADMIN_ID)}`);
    expect(res.status).toBe(200);
  });
});

// ─── GET /users/:id/onboarding ───────────────────────────────────────────────

describe('GET /users/:id/onboarding', () => {
  it('404s for an unknown user id', async () => {
    mockQuery(
      [(sql) => (/LEFT JOIN user_intent_profiles/i.test(sql) ? { rows: [], rowCount: 0 } : undefined)],
    );
    const res = await request(app)
      .get(`/admin/users/${USER_ID}/onboarding`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns the full internal payload including enrichment.source and enrichment.error', async () => {
    mockQuery([
      (sql) =>
        /LEFT JOIN user_intent_profiles/i.test(sql)
          ? {
              rows: [
                {
                  linkedin_url: 'https://www.linkedin.com/in/jane',
                  onboarding_status: 'completed',
                  last_onboarded_at: new Date('2026-07-01T00:00:00.000Z'),
                  enrichment_status: 'failed',
                  enrichment_source: 'linkedin-provider',
                  enrichment_error: 'provider timeout',
                  enrichment_started_at: new Date('2026-07-01T00:00:00.000Z'),
                  enrichment_completed_at: new Date('2026-07-01T00:00:05.000Z'),
                  enrichment_result: { profile: { headline: 'Founder' }, confidence: 0.4 },
                  onboarding_conversation: [{ role: 'user', content: 'hi' }],
                  matching_intent: { desiredOutcome: 'find a cofounder' },
                  matching_tags: ['founders', 'saas'],
                  avoid_preferences: ['recruiters'],
                  profile_strength: 'strong',
                  confidence: { overall: 0.8 },
                },
              ],
              rowCount: 1,
            }
          : undefined,
      (sql) =>
        /FROM\s+onboarding_stage_events/i.test(sql)
          ? { rows: [{ id: 'ev-1', user_id: USER_ID, stage: 'confirmed', detail: {}, duration_ms: 120, created_at: new Date('2026-07-01T00:00:06.000Z') }], rowCount: 1 }
          : undefined,
    ]);

    const res = await request(app)
      .get(`/admin/users/${USER_ID}/onboarding`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.linkedinUrl).toBe('https://www.linkedin.com/in/jane');
    expect(res.body.data.onboardingStatus).toBe('completed');
    // Internal view — unlike member-facing /onboarding/status, source + error ARE exposed.
    expect(res.body.data.enrichment.source).toBe('linkedin-provider');
    expect(res.body.data.enrichment.error).toBe('provider timeout');
    expect(res.body.data.enrichment.result).toEqual({ profile: { headline: 'Founder' }, confidence: 0.4 });
    expect(res.body.data.conversation).toEqual([{ role: 'user', content: 'hi' }]);
    expect(res.body.data.intent).toMatchObject({
      matchingIntent: { desiredOutcome: 'find a cofounder' },
      tags: ['founders', 'saas'],
      avoidPreferences: ['recruiters'],
      profileStrength: 'strong',
      confidence: { overall: 0.8 },
    });
    expect(res.body.data.stageEvents).toHaveLength(1);
    expect(res.body.data.stageEvents[0].stage).toBe('confirmed');
  });

  it('defaults enrichment to `none` and empty collections when the user has no intent-profile row yet', async () => {
    mockQuery([
      (sql) =>
        /LEFT JOIN user_intent_profiles/i.test(sql)
          ? {
              rows: [
                {
                  linkedin_url: null,
                  onboarding_status: 'not_started',
                  last_onboarded_at: null,
                  enrichment_status: null,
                  enrichment_source: null,
                  enrichment_error: null,
                  enrichment_started_at: null,
                  enrichment_completed_at: null,
                  enrichment_result: null,
                  onboarding_conversation: null,
                  matching_intent: null,
                  matching_tags: null,
                  avoid_preferences: null,
                  profile_strength: null,
                  confidence: null,
                },
              ],
              rowCount: 1,
            }
          : undefined,
      (sql) => (/FROM\s+onboarding_stage_events/i.test(sql) ? { rows: [], rowCount: 0 } : undefined),
    ]);

    const res = await request(app)
      .get(`/admin/users/${USER_ID}/onboarding`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.enrichment.status).toBe('none');
    expect(res.body.data.enrichment.result).toBeNull();
    expect(res.body.data.conversation).toEqual([]);
    expect(res.body.data.intent.tags).toEqual([]);
    expect(res.body.data.stageEvents).toEqual([]);
  });

  it('propagates an unexpected DB failure as a 500 with no data payload', async () => {
    (dbQuery as jest.Mock).mockImplementation((sql: string) => {
      if (/SELECT\s+status\s+FROM\s+users/i.test(sql)) return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
      if (/LEFT JOIN user_intent_profiles/i.test(sql)) return Promise.reject(new Error('db down'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const res = await request(app)
      .get(`/admin/users/${USER_ID}/onboarding`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
  });
});

// ─── GET /users/:id/conversations ────────────────────────────────────────────

describe('GET /users/:id/conversations', () => {
  it('404s for an unknown user id', async () => {
    mockQuery([], false);
    const res = await request(app)
      .get(`/admin/users/${USER_ID}/conversations`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(res.status).toBe(404);
  });

  it('lists conversations from both directions, ordered lastMessageAt desc, soft-deleted included and flagged', async () => {
    mockQuery([
      (sql) =>
        /FROM\s+dm_conversations\s+c/i.test(sql)
          ? {
              rows: [
                {
                  conversation_id: CONV_ID,
                  partner_id: OTHER_ID,
                  partner_display_name: 'Jane Partner',
                  partner_avatar_url: 'https://a.example/jane.png',
                  last_message_at: new Date('2026-07-20T00:00:00.000Z'),
                  meeting_confirmed_window: '2026-07-25:morning',
                  deleted_at: new Date('2026-07-21T00:00:00.000Z'),
                  message_count: '7',
                },
              ],
              rowCount: 1,
            }
          : undefined,
    ]);

    const res = await request(app)
      .get(`/admin/users/${USER_ID}/conversations`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      conversationId: CONV_ID,
      partner: { id: OTHER_ID, displayName: 'Jane Partner', avatarUrl: 'https://a.example/jane.png' },
      messageCount: 7,
      meetingConfirmedWindow: '2026-07-25:morning',
    });
    // soft-deleted conversation is still returned, flagged via deletedAt
    expect(res.body.data[0].deletedAt).not.toBeNull();
  });
});

// ─── GET /conversations/:id/messages ─────────────────────────────────────────

describe('GET /conversations/:id/messages', () => {
  it('404s for an unknown conversation id (and never writes an audit row)', async () => {
    mockQuery([
      (sql) => (/FROM\s+dm_conversations\s+WHERE\s+id\s*=\s*\$1/i.test(sql) ? { rows: [], rowCount: 0 } : undefined),
    ]);
    const res = await request(app)
      .get(`/admin/conversations/${CONV_ID}/messages`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(res.status).toBe(404);
    const auditCalls = (dbQuery as jest.Mock).mock.calls.filter((c) => /INSERT INTO audit_log/i.test(c[0]));
    expect(auditCalls).toHaveLength(0);
  });

  it('returns messages ascending and writes the admin_read_dm audit row with the right params', async () => {
    mockQuery([
      (sql) => (/FROM\s+dm_conversations\s+WHERE\s+id\s*=\s*\$1/i.test(sql) ? { rows: [{ id: CONV_ID }], rowCount: 1 } : undefined),
      (sql) => (/INSERT\s+INTO\s+audit_log/i.test(sql) ? { rows: [], rowCount: 1 } : undefined),
      (sql) =>
        /FROM\s+direct_messages/i.test(sql)
          ? {
              rows: [
                { id: 'm1', from_user_id: USER_ID, content: 'hi', attachment_url: null, created_at: new Date('2026-07-01T00:00:00.000Z') },
                { id: 'm2', from_user_id: OTHER_ID, content: null, attachment_url: 'https://res.cloudinary.com/x.png', created_at: new Date('2026-07-01T00:01:00.000Z') },
              ],
              rowCount: 2,
            }
          : undefined,
    ]);

    const res = await request(app)
      .get(`/admin/conversations/${CONV_ID}/messages`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ id: 'm1', fromUserId: USER_ID, content: 'hi' });
    expect(res.body.data[1]).toMatchObject({ id: 'm2', attachmentUrl: 'https://res.cloudinary.com/x.png' });

    const auditCall = (dbQuery as jest.Mock).mock.calls.find((c) => /INSERT INTO audit_log/i.test(c[0]));
    expect(auditCall).toBeDefined();
    const [, params] = auditCall!;
    expect(params[0]).toBe(ADMIN_ID); // actor_id
    expect(params[1]).toBe('admin_read_dm'); // action
    expect(params[2]).toBe('dm_conversation'); // entity_type
    expect(params[3]).toBe(CONV_ID); // entity_id
  });

  it('500s with no message payload when the audit insert fails (unauditable read must not succeed)', async () => {
    mockQuery([
      (sql) => (/FROM\s+dm_conversations\s+WHERE\s+id\s*=\s*\$1/i.test(sql) ? { rows: [{ id: CONV_ID }], rowCount: 1 } : undefined),
    ]);
    // Override: audit insert rejects; messages query (if ever reached) would succeed —
    // proving the failure is what aborts the read, not a coincidental empty result.
    (dbQuery as jest.Mock).mockImplementation((sql: string) => {
      if (/SELECT\s+status\s+FROM\s+users/i.test(sql)) return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
      if (/FROM\s+dm_conversations\s+WHERE\s+id\s*=\s*\$1/i.test(sql)) return Promise.resolve({ rows: [{ id: CONV_ID }], rowCount: 1 });
      if (/INSERT\s+INTO\s+audit_log/i.test(sql)) return Promise.reject(new Error('db down'));
      if (/FROM\s+direct_messages/i.test(sql)) return Promise.resolve({ rows: [{ id: 'm1', from_user_id: USER_ID, content: 'hi', attachment_url: null, created_at: new Date() }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .get(`/admin/conversations/${CONV_ID}/messages`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
    const messagesCalled = (dbQuery as jest.Mock).mock.calls.some((c) => /FROM\s+direct_messages/i.test(c[0]));
    expect(messagesCalled).toBe(false);
  });
});

// ─── GET /users/:id/interactions ─────────────────────────────────────────────

describe('GET /users/:id/interactions', () => {
  it('404s for an unknown user id', async () => {
    mockQuery([], false);
    const res = await request(app)
      .get(`/admin/users/${USER_ID}/interactions`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);
    expect(res.status).toBe(404);
  });

  it('assembles pokes (both directions), reports (violations + user_reports union), and blocks (given + received)', async () => {
    mockQuery([
      (sql) =>
        /p\.recipient_id AS other_id/i.test(sql)
          ? {
              rows: [
                { id: 'poke-1', other_id: OTHER_ID, other_display_name: 'Jane', status: 'pending', message: 'hey', created_at: new Date('2026-07-01T00:00:00.000Z'), responded_at: null },
              ],
              rowCount: 1,
            }
          : undefined,
      (sql) =>
        /p\.sender_id AS other_id/i.test(sql)
          ? {
              rows: [
                { id: 'poke-2', other_id: OTHER_ID, other_display_name: 'Jane', status: 'accepted', message: null, created_at: new Date('2026-07-02T00:00:00.000Z'), responded_at: new Date('2026-07-02T01:00:00.000Z') },
              ],
              rowCount: 1,
            }
          : undefined,
      (sql) =>
        /FROM\s+violations/i.test(sql)
          ? {
              rows: [
                { source: 'violation', id: 'v-1', reporter_id: OTHER_ID, reported_id: USER_ID, reason: 'harassment', status: 'open', resolution_notes: null, resolved_by: null, resolved_at: null, created_at: new Date('2026-07-03T00:00:00.000Z') },
                { source: 'user_report', id: 'r-1', reporter_id: USER_ID, reported_id: OTHER_ID, reason: 'spam', status: 'resolved', resolution_notes: 'actioned', resolved_by: ADMIN_ID, resolved_at: new Date('2026-07-04T00:00:00.000Z'), created_at: new Date('2026-07-04T00:00:00.000Z') },
              ],
              rowCount: 2,
            }
          : undefined,
      // blockService.listBlocked() query ("given") — WHERE ub.blocker_id = $1
      (sql) =>
        /FROM\s+user_blocks\s+ub/i.test(sql) && /ub\.blocker_id\s*=\s*\$1/i.test(sql)
          ? {
              rows: [
                { blocked_id: OTHER_ID, display_name: 'Blocked Barb', avatar_url: null, reason: 'harassment', created_at: new Date('2026-07-06T00:00:00.000Z') },
              ],
              rowCount: 1,
            }
          : undefined,
      // "received" query — WHERE ub.blocked_id = $1
      (sql) =>
        /FROM\s+user_blocks\s+ub/i.test(sql) && /ub\.blocked_id\s*=\s*\$1/i.test(sql)
          ? {
              rows: [
                { blocker_id: OTHER_ID, display_name: 'Blocker Bob', avatar_url: null, reason: 'spam', created_at: new Date('2026-07-05T00:00:00.000Z') },
              ],
              rowCount: 1,
            }
          : undefined,
    ]);

    const res = await request(app)
      .get(`/admin/users/${USER_ID}/interactions`)
      .set('Authorization', `Bearer ${makeToken('admin', ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pokesSent).toHaveLength(1);
    expect(res.body.data.pokesSent[0]).toMatchObject({ id: 'poke-1', otherUser: { id: OTHER_ID, displayName: 'Jane' }, status: 'pending' });
    expect(res.body.data.pokesReceived).toHaveLength(1);
    expect(res.body.data.pokesReceived[0]).toMatchObject({ id: 'poke-2', status: 'accepted' });

    expect(res.body.data.reports).toHaveLength(2);
    const sources = res.body.data.reports.map((r: any) => r.source).sort();
    expect(sources).toEqual(['user_report', 'violation']);
    const resolved = res.body.data.reports.find((r: any) => r.source === 'user_report');
    expect(resolved).toMatchObject({ reporterId: USER_ID, reportedId: OTHER_ID, reason: 'spam', status: 'resolved', resolutionNotes: 'actioned' });

    expect(res.body.data.blocks.given).toHaveLength(1);
    expect(res.body.data.blocks.given[0]).toMatchObject({ blockedId: OTHER_ID, displayName: 'Blocked Barb' });
    expect(res.body.data.blocks.received).toHaveLength(1);
    expect(res.body.data.blocks.received[0]).toMatchObject({ blockerId: OTHER_ID, displayName: 'Blocker Bob' });
  });
});
