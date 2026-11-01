// ─── Circle invites: who is told when one is made, accepted, declined or withdrawn (1 Nov 2026) ───────────────
// A circle invite changes the circle's pending invites for the people who run it and, once accepted, the circle's
// page, members and count for everyone in it, and the new member's own circles list. Production's client
// (its Invites page, the bell's Accept and Decline) makes the same calls as before and reads the same answers.
//
// The invite service is a stand-in (its rules are in invite.service.test.ts); the real routes, the real circle
// fanout and a fake database answering by who the SQL asks for are used, with the emit boundary recorded.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm', magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001', rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockDb = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockDb(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/invite/invite.service', () => {
  const actual = jest.requireActual('../../services/invite/invite.service');
  return {
    ...(jest.createMockFromModule('../../services/invite/invite.service') as Record<string, unknown>),
    isAdminRole: actual.isAdminRole,
    maskEmail: actual.maskEmail,
    hideOthersAddresses: actual.hideOthersAddresses,
    CANNOT_BE_INVITED: actual.CANNOT_BE_INVITED,
  };
});
jest.mock('../../services/invite/invite-candidates.service', () => ({
  listInviteCandidates: jest.fn(), createInvitesBatch: jest.fn(), declinedAddresses: jest.fn(), BATCH_MAX: 50, __esModule: true,
}));
jest.mock('../../services/invite/invite-reminders.service', () => ({
  reminderAllowance: jest.fn(), claimReminders: jest.fn(), releaseReminders: jest.fn(), countRemindersSent: jest.fn(), __esModule: true,
}));

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn();
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as inviteService from '../../services/invite/invite.service';
import inviteRoutes from '../../routes/invites';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { E } from '../../realtime/entities';
import { InviteType, InviteStatus } from '@rsn/shared';

const CIRCLE = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const ADMIN = 'user-admin';      // made the circle
const MEMBER = 'user-member';    // in it
const INVITEE = 'user-invitee';  // is invited
let members: string[];

const app = express();
app.use(express.json());
app.use('/invites', inviteRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string, role = 'member') =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));

type Emit = [unknown, string[], string[]];
const emits = () => mockEmitEntities.mock.calls as Emit[];
function heard(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [, recipients, tags] of emits()) for (const r of recipients) out[r] = [...(out[r] ?? []), ...tags];
  return out;
}
const tagsOf = (user: string) => new Set(heard()[user] ?? []);

const circleInvite = {
  id: 'invite-1', code: 'CODE1234', type: InviteType.CIRCLE, inviterId: MEMBER, inviteeEmail: 'guest@example.com', podId: null,
  sessionId: null, circleId: CIRCLE, status: InviteStatus.PENDING, maxUses: 5, useCount: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  members = [ADMIN, MEMBER];
  mockEmitEntities.mockResolvedValue(undefined);
  mockDb.mockImplementation(async (sql: string) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] }; // authenticate
    if (/SELECT email FROM users WHERE id = \$1/.test(text)) return { rows: [{ email: 'guest@example.com' }] };
    if (/FROM circle_members WHERE circle_id = \$1 UNION SELECT created_by FROM circles/.test(text)) {
      return { rows: [...new Set([...members, ADMIN])].map(user_id => ({ user_id })) };
    }
    return { rows: [] };
  });
});

describe('who hears a circle invite change', () => {
  it('an invite made (production\'s own body): the circle\'s people hear the circle\'s invites, the inviter included', async () => {
    jest.mocked(inviteService.createInvite).mockResolvedValue(circleInvite as never);
    const res = await request(app).post('/invites').set(as(MEMBER)).send({ type: 'circle', circleId: CIRCLE, maxUses: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: circleInvite });
    expect(inviteService.createInvite).toHaveBeenCalledWith(MEMBER, { type: 'circle', circleId: CIRCLE, maxUses: 5 }, 'member');
    await settle();
    for (const person of [ADMIN, MEMBER]) {
      expect(tagsOf(person).has(E.circleInvites(CIRCLE))).toBe(true);
      expect(tagsOf(person).has(E.userCircles(person))).toBe(true);
    }
    expect(Object.keys(heard()).sort()).toEqual([ADMIN, MEMBER]);
  });

  it('an invite accepted: everyone in the circle hears its page, members and invites; the new member hears their own list', async () => {
    members = [ADMIN, MEMBER, INVITEE];
    jest.mocked(inviteService.acceptInvite).mockResolvedValue({
      invite: circleInvite, redirectTo: `/circles/${CIRCLE}`, registeredFor: { circleId: CIRCLE },
    } as never);
    const res = await request(app).post('/invites/CODE1234/accept').set(as(INVITEE));
    expect(res.status).toBe(200);
    expect(res.body.data.registeredFor).toEqual({ circleId: CIRCLE });
    expect(res.body.data.redirectTo).toBe(`/circles/${CIRCLE}`);
    await settle();
    for (const person of [ADMIN, MEMBER, INVITEE]) {
      for (const tag of [E.circle(CIRCLE), E.circleMembers(CIRCLE), E.circleInvites(CIRCLE), E.userCircles(person), E.userCircles(INVITEE)]) {
        expect(tagsOf(person).has(tag)).toBe(true);
      }
    }
    expect(tagsOf(INVITEE).has(E.userInvites(INVITEE))).toBe(true);
  });

  it('an invite declined: the circle\'s people hear its invites, and the invitee\'s own invites list changes', async () => {
    jest.mocked(inviteService.declineInvite).mockResolvedValue({ podId: null, sessionId: null, circleId: CIRCLE });
    const res = await request(app).post('/invites/CODE1234/decline').set(as(INVITEE));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { message: 'Invite declined' } });
    await settle();
    expect(tagsOf(ADMIN).has(E.circleInvites(CIRCLE))).toBe(true);
    expect(tagsOf(MEMBER).has(E.circleInvites(CIRCLE))).toBe(true);
    expect(tagsOf(INVITEE).has(E.userInvites(INVITEE))).toBe(true);
  });

  it('an invite withdrawn by an admin who is not in the circle: its people, the admin, the sender and the invitee are told', async () => {
    jest.mocked(inviteService.revokeInvite).mockResolvedValue({
      podId: null, sessionId: null, circleId: CIRCLE, inviterId: MEMBER, inviteeUserId: INVITEE,
    });
    const res = await request(app).delete('/invites/invite-1').set(as('user-platform', 'admin'));
    expect(res.status).toBe(200);
    await settle();
    expect(tagsOf(ADMIN).has(E.circleInvites(CIRCLE))).toBe(true);
    expect(tagsOf('user-platform').has(E.circleInvites(CIRCLE))).toBe(true);
    expect(tagsOf(MEMBER).has(E.userInvites(MEMBER))).toBe(true);
    expect(tagsOf(INVITEE).has(E.userInvites(INVITEE))).toBe(true);
  });

  it('a pod or event invite tells no circle', async () => {
    jest.mocked(inviteService.declineInvite).mockResolvedValue({ podId: null, sessionId: null, circleId: null });
    await request(app).post('/invites/CODE1234/decline').set(as(INVITEE));
    await settle();
    expect(Object.values(heard()).flat().some(tag => tag.startsWith('circle:'))).toBe(false);
  });
});
