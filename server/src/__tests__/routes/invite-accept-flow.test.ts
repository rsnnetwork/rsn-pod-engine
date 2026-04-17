// ─── Invite Accept Flow Tests ───────────────────────────────────────────────
// Regression guards for Stefan's report: "user gets auto-registered without
// accepting invite" (April 17 items #6, #12). The audit found no server-side
// bug — the bug was a client-side auto-accept in InviteAcceptPage.tsx that
// was removed in the same commit. These tests lock in the SERVER contract:
//
//   (1) GET /invites/:code is read-only — it NEVER inserts into
//       session_participants (even for authenticated users).
//   (2) POST /invites/:code/accept requires explicit invocation — only
//       then does inviteService.acceptInvite run and session_participants
//       get populated.
//   (3) After acceptance, a user can POST /sessions/:id/leave (unregister),
//       and subsequently re-accept the invite if it's still valid.
//
// Mocked stack — service behavior is verified in service-level tests; this
// suite verifies the ROUTE contract (no accidental writes on GET).

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { InviteType, InviteStatus } from '@rsn/shared';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    jwtAccessExpiry: '15m',
    jwtRefreshExpiry: '7d',
    magicLinkSecret: 'test-magic-link-secret',
    magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
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

jest.mock('../../services/invite/invite.service');
jest.mock('../../services/session/session.service');
jest.mock('../../services/identity/identity.service');

import * as inviteService from '../../services/invite/invite.service';
import * as sessionService from '../../services/session/session.service';
import { query as dbQuery } from '../../db';
import inviteRoutes from '../../routes/invites';
import sessionRoutes from '../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { invalidateUserStatusCache } from '../../middleware/auth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/invites', inviteRoutes);
  app.use('/sessions', sessionRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(userId = 'user-abc') {
  return jwt.sign(
    { sub: userId, email: 'u@e.com', role: 'member', sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const INVITE_CODE = 'ABC123XYZ';

const mockInvite = {
  id: 'invite-1',
  code: INVITE_CODE,
  type: InviteType.SESSION,
  status: InviteStatus.PENDING,
  inviterId: 'user-inviter',
  inviteeEmail: null,
  podId: null,
  sessionId: SESSION_ID,
  maxUses: 1,
  useCount: 0,
  acceptedByUserId: null,
  acceptedAt: null,
  expiresAt: null,
  createdAt: new Date(),
  revokedAt: null,
};

describe('Invite accept flow — no auto-registration on view', () => {
  const app = createApp();

  let uid = 0;
  function freshUser() {
    uid += 1;
    return `user-invite-${uid}`;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Default auth middleware DB check — user exists and is active
    (dbQuery as jest.Mock).mockResolvedValue({ rows: [{ status: 'active' }], rowCount: 1 });
  });

  afterAll(() => {
    for (let i = 1; i <= uid; i++) invalidateUserStatusCache(`user-invite-${i}`);
  });

  it('GET /invites/:code does NOT call acceptInvite or register participant', async () => {
    (inviteService.getInviteByCode as jest.Mock).mockResolvedValue(mockInvite);
    // After the first call for auth middleware status check, the route itself
    // issues more `dbQuery` calls for inviter/session context. None should be
    // an INSERT into session_participants.
    (dbQuery as jest.Mock).mockImplementation((sql: string) => {
      if (/INSERT INTO session_participants/i.test(sql)) {
        throw new Error('TEST FAIL: GET /invites/:code must not INSERT into session_participants');
      }
      if (/SELECT status FROM users WHERE id/i.test(sql)) {
        return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
      }
      if (/SELECT display_name/i.test(sql)) {
        return Promise.resolve({ rows: [{ displayName: 'Inviter' }], rowCount: 1 });
      }
      if (/FROM sessions WHERE id/i.test(sql)) {
        return Promise.resolve({
          rows: [{ title: 'Demo', scheduledAt: null, description: null, status: 'scheduled' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const token = makeToken(freshUser());
    const res = await request(app)
      .get(`/invites/${INVITE_CODE}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Critical: service-level acceptInvite must NOT have been invoked
    expect(inviteService.acceptInvite).not.toHaveBeenCalled();
    // No session registration calls either
    expect(sessionService.registerParticipant).not.toHaveBeenCalled();
  });

  it('GET /invites/:code works without auth (public invite page preview) — still no registration', async () => {
    (inviteService.getInviteByCode as jest.Mock).mockResolvedValue(mockInvite);
    (dbQuery as jest.Mock).mockImplementation((sql: string) => {
      if (/INSERT INTO session_participants/i.test(sql)) {
        throw new Error('TEST FAIL: GET /invites/:code must not INSERT into session_participants');
      }
      if (/SELECT display_name/i.test(sql)) {
        return Promise.resolve({ rows: [{ displayName: 'Inviter' }], rowCount: 1 });
      }
      if (/FROM sessions WHERE id/i.test(sql)) {
        return Promise.resolve({
          rows: [{ title: 'Demo', scheduledAt: null, description: null, status: 'scheduled' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).get(`/invites/${INVITE_CODE}`); // no auth header

    expect(res.status).toBe(200);
    expect(inviteService.acceptInvite).not.toHaveBeenCalled();
    expect(sessionService.registerParticipant).not.toHaveBeenCalled();
  });

  it('POST /invites/:code/accept calls acceptInvite — explicit user action required', async () => {
    (inviteService.acceptInvite as jest.Mock).mockResolvedValue({
      ...mockInvite,
      status: InviteStatus.ACCEPTED,
      acceptedByUserId: 'user-abc',
    });

    const token = makeToken(freshUser());
    const res = await request(app)
      .post(`/invites/${INVITE_CODE}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(inviteService.acceptInvite).toHaveBeenCalledTimes(1);
    expect(inviteService.acceptInvite).toHaveBeenCalledWith(INVITE_CODE, expect.any(String));
  });

  it('DELETE /sessions/:id/register works after acceptance — user can unregister', async () => {
    (sessionService.unregisterParticipant as jest.Mock).mockResolvedValue(undefined);

    const token = makeToken(freshUser());
    const res = await request(app)
      .delete(`/sessions/${SESSION_ID}/register`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(sessionService.unregisterParticipant).toHaveBeenCalledWith(SESSION_ID, expect.any(String));
  });

  it('user can re-accept after unregistering (if invite still has uses left)', async () => {
    // First accept succeeds
    (inviteService.acceptInvite as jest.Mock).mockResolvedValueOnce({
      ...mockInvite, status: InviteStatus.ACCEPTED, useCount: 1, acceptedByUserId: 'user-rejoin',
    });
    // Unregister
    (sessionService.unregisterParticipant as jest.Mock).mockResolvedValue(undefined);
    // Re-accept: invite.service handles the "already-consumed-by-this-user" re-apply path
    (inviteService.acceptInvite as jest.Mock).mockResolvedValueOnce({
      ...mockInvite, status: InviteStatus.ACCEPTED, useCount: 1, acceptedByUserId: 'user-rejoin',
    });

    const uidStr = freshUser();
    const token = makeToken(uidStr);

    const r1 = await request(app)
      .post(`/invites/${INVITE_CODE}/accept`)
      .set('Authorization', `Bearer ${token}`);
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .delete(`/sessions/${SESSION_ID}/register`)
      .set('Authorization', `Bearer ${token}`);
    expect(r2.status).toBe(200);

    const r3 = await request(app)
      .post(`/invites/${INVITE_CODE}/accept`)
      .set('Authorization', `Bearer ${token}`);
    expect(r3.status).toBe(200);
    expect(inviteService.acceptInvite).toHaveBeenCalledTimes(2);
  });
});
