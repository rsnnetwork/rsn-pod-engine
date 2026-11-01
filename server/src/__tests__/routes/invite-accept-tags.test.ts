// ─── Accepting an invite tells the invite lists (26 Oct 2026, H2b item 28) ───────────────────────────────────
//
// ENTITIES.md says session:<id>:invites and pod:<id>:invites move when an invite is accepted, and the Invitations
// card the people who run a pod or an event see follows those tags. The accept route sent neither: an accepted
// invite stayed "Invited" on the host's card until a reload. The route now sends both, beside the tags it already
// sent (the accepter's own lists, the participants).
//
// The real router runs under express; sign-in, the database, the services and the fan-out are stand-ins.

import express from 'express';
import request from 'supertest';

const ME = 'aaaaaaaa-0000-4000-8000-00000000000a';
const EVENT = 'dddddddd-0000-4000-8000-0000000000aa';
const POD = 'eeeeeeee-0000-4000-8000-0000000000aa';

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
    req.user = { userId: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'me@getjacksapp.com', role: 'member', sessionId: 's-1' };
    next();
  },
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  __esModule: true,
}));
jest.mock('../../middleware/audit', () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  recordAudit: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), transaction: jest.fn(), __esModule: true }));
jest.mock('../../realtime/fanout');
jest.mock('../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, __esModule: true }));
jest.mock('../../services/invite/invite.service');
jest.mock('../../services/invite/invite-reminders.service');
jest.mock('../../services/invite/invite-candidates.service');
jest.mock('../../services/email/email.service');
jest.mock('../../services/session/session.service');
jest.mock('../../services/pod/pod.service');

import * as inviteService from '../../services/invite/invite.service';
import * as fanout from '../../realtime/fanout';
import { E } from '../../realtime/entities';
import inviteRoutes from '../../routes/invites';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/invites', inviteRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  (fanout.fanoutSessionEntities as jest.Mock).mockResolvedValue(undefined);
  (fanout.fanoutPodEntities as jest.Mock).mockResolvedValue(undefined);
});

describe('POST /invites/:code/accept', () => {
  it('for an event invite: the event\'s invite list is told, beside the participants and the accepter\'s lists', async () => {
    (inviteService.acceptInvite as jest.Mock).mockResolvedValue({
      invite: { id: 'inv-1', type: 'session', status: 'accepted' }, redirectTo: `/sessions/${EVENT}`,
      registeredFor: { sessionId: EVENT, podId: POD },
    });
    const res = await request(app).post('/invites/CODE123/accept').send({});
    await settle();

    expect(res.status).toBe(200);
    expect(fanout.fanoutSessionEntities).toHaveBeenCalledTimes(1);
    const [podId, sessionId, tags] = (fanout.fanoutSessionEntities as jest.Mock).mock.calls[0];
    expect([podId, sessionId]).toEqual([POD, EVENT]);
    expect(tags).toEqual(expect.arrayContaining([E.sessionInvites(EVENT), E.sessionParticipants(EVENT), E.userSessions(ME)]));
  });

  it('for a pod invite: the pod\'s invite list is told, beside the accepter\'s pods', async () => {
    (inviteService.acceptInvite as jest.Mock).mockResolvedValue({
      invite: { id: 'inv-2', type: 'pod', status: 'accepted' }, redirectTo: `/pods/${POD}`,
      registeredFor: { podId: POD },
    });
    const res = await request(app).post('/invites/CODE456/accept').send({});
    await settle();

    expect(res.status).toBe(200);
    expect(fanout.fanoutPodEntities).toHaveBeenCalledWith(POD, expect.arrayContaining([E.podInvites(POD), E.userPods(ME)]));
    expect(fanout.fanoutSessionEntities).not.toHaveBeenCalled();
  });
});
