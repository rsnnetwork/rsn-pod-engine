// ─── Routes outside /api/dm check the id in their path too (26 Oct 2026, H2b items 2 and 3) ──────────────
//
// H2a made every /api/dm route refuse an id that is not one. The same probe found nine routes elsewhere that
// still sent the word "undefined" (or any other non-id) to Postgres, which cannot read it as a uuid and came back
// a 500 INTERNAL_ERROR: GET /pokes/with/:userId, GET /pokes/has-pending/:userId, POST /notifications/:id/read,
// GET /users/:id, GET /users/:id/block-status, GET /agents/:id, GET /circles/:id, GET /pods/:id and GET /sessions/:id.
// Each now answers 400 VALIDATION_ERROR with a sentence a member understands (production's client toasts the message,
// the preview reads the first detail) and the service is never reached. A well-formed id in capitals is the same row
// to Postgres, so it is let through, lower-cased.
//
// Item 3: POST and DELETE /users/:id/block handed the raw id to fanoutUserBlocks, so an id in capitals sent tags
// (user:<ID>:blocks) that no screen listens for. They check it the same way, and the tags carry it lower-cased.
//
// These go through express with the real routers; sign-in and the services are stand-ins.

import express from 'express';
import request from 'supertest';

const VIEWER = 'aaaaaaaa-0000-4000-8000-000000000001';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', rateLimitWindowMs: 60_000, rateLimitMaxRequests: 1000, env: 'test', isTest: true },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../realtime/fanout');
jest.mock('../../services/poke/poke.service');
jest.mock('../../services/identity/identity.service');
jest.mock('../../services/block/block.service');
jest.mock('../../services/matching/agent.repo');
jest.mock('../../services/matching/agent-matching.service');
jest.mock('../../services/matching/platform-match.service');
jest.mock('../../services/circle/circle.service');
jest.mock('../../services/circle/circle-wall.service');
jest.mock('../../services/pod/pod.service');
jest.mock('../../services/pods/pod-access');
jest.mock('../../services/session/session.service');
jest.mock('../../services/session/session-access');
jest.mock('../../services/session/session-state-snapshot.service');
jest.mock('../../services/email/email.service');

import * as fanout from '../../realtime/fanout';
import * as pokeService from '../../services/poke/poke.service';
import * as identityService from '../../services/identity/identity.service';
import * as blockService from '../../services/block/block.service';
import * as agentRepo from '../../services/matching/agent.repo';
import * as circleService from '../../services/circle/circle.service';
import * as podService from '../../services/pod/pod.service';
import { canViewPod } from '../../services/pods/pod-access';
import * as sessionService from '../../services/session/session.service';
import { canViewSession } from '../../services/session/session-access';
import pokeRoutes from '../../routes/pokes';
import notificationRoutes from '../../routes/notifications';
import userRoutes from '../../routes/users';
import agentRoutes from '../../routes/agents';
import circleRoutes from '../../routes/circles';
import podRoutes from '../../routes/pods';
import sessionRoutes from '../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/pokes', pokeRoutes);
app.use('/notifications', notificationRoutes);
app.use('/users', userRoutes);
app.use('/agents', agentRoutes);
app.use('/circles', circleRoutes);
app.use('/pods', podRoutes);
app.use('/sessions', sessionRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const ID = 'cccccccc-0000-4000-8000-0000000000aa';
const MEMBER = "We couldn't find that member.";
type Method = 'get' | 'post' | 'delete';

/** The first thing each route asks with the id, which must never see a malformed one. */
const updatesTheBell = () => mockQuery.mock.calls.filter((c) => /UPDATE notifications SET is_read/.test(String(c[0])));
const reached: Record<string, () => unknown[][]> = {
  getPokeWith: () => (pokeService.getPokeWith as jest.Mock).mock.calls,
  hasPendingPoke: () => (pokeService.hasPendingPoke as jest.Mock).mock.calls,
  markOneRead: () => updatesTheBell().map((c) => c[1] as unknown[]),
  getUserById: () => (identityService.getUserById as jest.Mock).mock.calls,
  hasBlocked: () => (blockService.hasBlocked as jest.Mock).mock.calls,
  block: () => (blockService.block as jest.Mock).mock.calls,
  unblock: () => (blockService.unblock as jest.Mock).mock.calls,
  getAgent: () => (agentRepo.getAgent as jest.Mock).mock.calls,
  getCircleDetail: () => (circleService.getCircleDetail as jest.Mock).mock.calls,
  canViewPod: () => (canViewPod as jest.Mock).mock.calls,
  canViewSession: () => (canViewSession as jest.Mock).mock.calls,
};

const routes: Array<{ method: Method; path: (id: string) => string; says: string; service: keyof typeof reached }> = [
  { method: 'get', path: (id) => `/pokes/with/${id}`, says: MEMBER, service: 'getPokeWith' },
  { method: 'get', path: (id) => `/pokes/has-pending/${id}`, says: MEMBER, service: 'hasPendingPoke' },
  { method: 'post', path: (id) => `/notifications/${id}/read`, says: "We couldn't find that notification.", service: 'markOneRead' },
  { method: 'get', path: (id) => `/users/${id}`, says: MEMBER, service: 'getUserById' },
  { method: 'get', path: (id) => `/users/${id}/block-status`, says: MEMBER, service: 'hasBlocked' },
  { method: 'post', path: (id) => `/users/${id}/block`, says: MEMBER, service: 'block' },
  { method: 'delete', path: (id) => `/users/${id}/block`, says: MEMBER, service: 'unblock' },
  { method: 'get', path: (id) => `/agents/${id}`, says: "We couldn't find that agent.", service: 'getAgent' },
  { method: 'get', path: (id) => `/circles/${id}`, says: "We couldn't find that circle.", service: 'getCircleDetail' },
  { method: 'get', path: (id) => `/pods/${id}`, says: "We couldn't find that pod.", service: 'canViewPod' },
  { method: 'get', path: (id) => `/sessions/${id}`, says: "We couldn't find that event.", service: 'canViewSession' },
];

const send = (route: (typeof routes)[number], id: string) => request(app)[route.method](route.path(id)).send({});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  (pokeService.getPokeWith as jest.Mock).mockResolvedValue({ status: 'none' });
  (pokeService.hasPendingPoke as jest.Mock).mockResolvedValue(false);
  (identityService.getUserById as jest.Mock).mockImplementation(async (id: string) => ({ id, displayName: 'Bo', email: 'bo@example.com' }));
  (blockService.hasBlocked as jest.Mock).mockResolvedValue(false);
  (blockService.block as jest.Mock).mockResolvedValue({ id: 'block-1' });
  (blockService.unblock as jest.Mock).mockResolvedValue(undefined);
  (agentRepo.getAgent as jest.Mock).mockResolvedValue(null);
  (circleService.getCircleDetail as jest.Mock).mockResolvedValue({ id: ID });
  (canViewPod as jest.Mock).mockResolvedValue(false);
  (podService.getPodById as jest.Mock).mockResolvedValue({ id: ID });
  (canViewSession as jest.Mock).mockResolvedValue(false);
  (sessionService.getSessionById as jest.Mock).mockResolvedValue({ id: ID });
  (fanout.fanoutUserBlocks as jest.Mock).mockResolvedValue(undefined);
  (fanout.fanoutOwnNotifications as jest.Mock).mockResolvedValue(undefined);
});

describe('an id that is not an id is refused with a sentence, never a 500', () => {
  describe.each(routes.map((r) => [`${r.method.toUpperCase()} ${r.path(':id')}`, r] as const))('%s', (_label, route) => {
    it.each(['undefined', 'not-a-uuid', '12345', `${ID}x`])('refuses %s with 400, and the service is never reached', async (bad) => {
      const res = await send(route, bad);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe(route.says);
      expect(Object.values(res.body.error.details as Record<string, string[]>)[0]).toEqual([route.says]);
      expect(reached[route.service]()).toEqual([]);
    });

    it('lets a well-formed id through, lower-cased', async () => {
      const res = await send(route, ID.toUpperCase());

      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
      const calls = reached[route.service]();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toContain(ID);
      expect(calls[0]).not.toContain(ID.toUpperCase());
    });
  });
});

describe('a block or an unblock tells the screens of both people with the id lower-cased (item 3)', () => {
  it.each(['post', 'delete'] as const)('%s /users/:id/block', async (method) => {
    const res = await request(app)[method](`/users/${ID.toUpperCase()}/block`).send({});

    expect(res.status).toBe(200);
    expect(fanout.fanoutUserBlocks).toHaveBeenCalledWith(VIEWER, ID);
  });

  it('a malformed id tells nobody anything', async () => {
    await request(app).post('/users/undefined/block').send({});
    await request(app).delete('/users/undefined/block').send({});
    expect(fanout.fanoutUserBlocks).not.toHaveBeenCalled();
  });
});

describe('GET /users/blocked reaches the blocked list, not GET /users/:id', () => {
  it('answers the member\'s own blocked list', async () => {
    (blockService.listBlocked as jest.Mock).mockResolvedValue([{ blockedId: ID }]);

    const res = await request(app).get('/users/blocked');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ blockedId: ID }]);
    expect(blockService.listBlocked).toHaveBeenCalledWith(VIEWER);
    expect(identityService.getUserById).not.toHaveBeenCalled();
  });
});
