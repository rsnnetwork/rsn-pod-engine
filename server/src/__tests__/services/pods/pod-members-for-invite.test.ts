// ─── The pod members an event's host is offered to invite (fix round 2, 26 Oct 2026) ─────────────
//
// GET /pods/:id/members/for-invite feeds production's event page: the "Invite Pod Members" list with its per-member
// Invite and its Invite All. It listed every active member who was not going or invited yet, whatever state the account
// was in and whoever had blocked whom, so a host was offered people who could not be invited (the invite itself refuses
// them, and Invite All counts them as skipped) and a person who had blocked the host appeared in the host's list.
// It now leaves out accounts that are not active and anyone blocked either way with the person asking.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm', magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001', rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockDb = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockDb(...args),
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) => cb({ query: (...args: unknown[]) => mockDb(...args) }),
  __esModule: true,
}));
jest.mock('../../../realtime/fanout', () => ({
  fanoutPodEntities: jest.fn().mockResolvedValue(undefined),
  fanoutPodMembershipForUser: jest.fn().mockResolvedValue(undefined),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined),
  getRealtimeIo: () => ({}),
  __esModule: true,
}));

import * as podService from '../../../services/pod/pod.service';
import podRoutes from '../../../routes/pods';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';

const flatSql = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  mockDb.mockReset();
});

describe('getPodMembersForInvite', () => {
  const member = { user_id: 'u-ann', display_name: 'Ann', email: 'ann@example.com', avatar_url: null };

  it('is asked for the pod, the event and the person asking', async () => {
    mockDb.mockResolvedValueOnce({ rows: [member] });
    await podService.getPodMembersForInvite('pod-1', 'event-1', 'u-host');
    expect(mockDb).toHaveBeenCalledTimes(1);
    expect(mockDb.mock.calls[0][1]).toEqual(['pod-1', 'event-1', 'u-host']);
  });

  it('lists only accounts that are active: not a suspended, banned or closed one', async () => {
    mockDb.mockResolvedValueOnce({ rows: [] });
    await podService.getPodMembersForInvite('pod-1', 'event-1', 'u-host');
    expect(flatSql(mockDb.mock.calls[0][0])).toMatch(/AND u\.status = 'active'/);
  });

  it('leaves out anyone blocked either way with the person asking, whoever made the block', async () => {
    mockDb.mockResolvedValueOnce({ rows: [] });
    await podService.getPodMembersForInvite('pod-1', 'event-1', 'u-host');
    expect(flatSql(mockDb.mock.calls[0][0])).toMatch(
      /AND NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$3 AND b\.blocked_id = u\.id\) OR \(b\.blocker_id = u\.id AND b\.blocked_id = \$3\)\)/);
  });

  it('still lists the active members of the pod who are neither going nor invited to the event, by name', async () => {
    mockDb.mockResolvedValueOnce({ rows: [] });
    await podService.getPodMembersForInvite('pod-1', 'event-1', 'u-host');
    const sql = flatSql(mockDb.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE pm\.pod_id = \$1 AND pm\.status = 'active'/);
    expect(sql).toMatch(/pm\.user_id NOT IN \( SELECT sp\.user_id FROM session_participants sp WHERE sp\.session_id = \$2 \)/);
    expect(sql).toMatch(/u\.email NOT IN \( SELECT i\.invitee_email FROM invites i WHERE i\.session_id = \$2 AND i\.status IN \('pending', 'accepted'\)/);
    expect(sql).toMatch(/ORDER BY u\.display_name$/);
  });

  it('does not filter out someone who declined: Invite All skips them, and the single Invite may still ask again', async () => {
    mockDb.mockResolvedValueOnce({ rows: [] });
    await podService.getPodMembersForInvite('pod-1', 'event-1', 'u-host');
    expect(flatSql(mockDb.mock.calls[0][0])).not.toMatch(/declined/);
  });

  it('answers each member as production\'s page reads them: id, name, address and avatar', async () => {
    mockDb.mockResolvedValueOnce({ rows: [member] });
    await expect(podService.getPodMembersForInvite('pod-1', 'event-1', 'u-host')).resolves.toEqual([
      { userId: 'u-ann', displayName: 'Ann', email: 'ann@example.com', avatarUrl: null },
    ]);
  });
});

describe('GET /pods/:id/members/for-invite', () => {
  const app = express();
  app.use(express.json());
  app.use('/pods', podRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  const token = (sub: string, role = 'member') => jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
  const POD = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
  const EVENT = '7a1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8';
  // Mocks are restored before every test, so the spy is made inside each one.
  let list: jest.SpyInstance;

  /** The database: every account is active; the event is hosted by u-host, with u-cohost as a co-host. */
  const world = () => mockDb.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = flatSql(sql);
    if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] };
    if (/SELECT host_user_id FROM sessions/.test(text)) return { rows: [{ host_user_id: 'u-host' }] };
    if (/FROM session_cohosts/.test(text)) return { rows: params[1] === 'u-cohost' ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  });

  beforeEach(() => {
    list = jest.spyOn(podService, 'getPodMembersForInvite').mockResolvedValue([]);
    world();
  });

  it.each([['the host', 'u-host', 'member'], ['a co-host', 'u-cohost', 'member'], ['an admin', 'u-admin', 'admin']])(
    '%s is given the list, made for them: the service is told who is asking, so their blocks and the ones against them are left out',
    async (_who, sub, role) => {
      const res = await request(app).get(`/pods/${POD}/members/for-invite?sessionId=${EVENT}`).set('Authorization', `Bearer ${token(sub, role)}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
      expect(list).toHaveBeenCalledWith(POD, EVENT, sub);
    },
  );

  it('anyone else is refused, and nothing is listed', async () => {
    const res = await request(app).get(`/pods/${POD}/members/for-invite?sessionId=${EVENT}`).set('Authorization', `Bearer ${token('u-stranger')}`);
    expect(res.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('needs the event', async () => {
    const res = await request(app).get(`/pods/${POD}/members/for-invite`).set('Authorization', `Bearer ${token('u-host')}`);
    expect(res.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
