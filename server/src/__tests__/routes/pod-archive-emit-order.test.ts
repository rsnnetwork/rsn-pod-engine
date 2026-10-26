// ─── Archiving a pod tells its screens after the archive is saved (26 Oct 2026, H2b item 20) ────────────────
//
// DELETE /pods/:id archives a pod (status → archived; nothing is deleted). The route used to fan out the pod's entity
// tags BEFORE awaiting the service, from the days when the pod and its member rows were really deleted and the member
// list had to be read first. A page that refetched at once could still read the pod as open; C11's pod page guards it
// on screen with a bounded re-read. The rule for every mutation: emit after the write has been saved.
//
// The real router runs under express; sign-in, the services and the fan-out are stand-ins.

import express from 'express';
import request from 'supertest';

const VIEWER = 'aaaaaaaa-0000-4000-8000-000000000001';
const POD = 'cccccccc-0000-4000-8000-0000000000aa';

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
jest.mock('../../middleware/audit', () => ({
  auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  recordAudit: jest.fn(),
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), transaction: jest.fn(), __esModule: true }));
jest.mock('../../realtime/fanout');
jest.mock('../../services/pod/pod.service');
jest.mock('../../services/pods/pod-access');
jest.mock('../../services/session/session.service');
jest.mock('../../services/session/session-access');
jest.mock('../../services/session/session-state-snapshot.service');
jest.mock('../../services/email/email.service');

import * as fanout from '../../realtime/fanout';
import * as podService from '../../services/pod/pod.service';
import podRoutes from '../../routes/pods';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/pods', podRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const archive = podService.deletePod as jest.Mock;
const told = fanout.fanoutPodEntities as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  told.mockResolvedValue(undefined);
});

describe('DELETE /pods/:id (archive)', () => {
  it('tells the pod\'s screens only once the archive is saved, with the tags it always sent', async () => {
    let saved = false;
    archive.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); saved = true; });
    let savedWhenTold: boolean | null = null;
    told.mockImplementation(async () => { savedWhenTold = saved; });

    const res = await request(app).delete(`/pods/${POD}`);

    expect(res.status).toBe(200);
    expect(archive).toHaveBeenCalledWith(POD, VIEWER, 'member');
    expect(told).toHaveBeenCalledWith(POD, [], { includeUserPodsPerMember: true });
    expect(savedWhenTold).toBe(true);
    expect(told.mock.invocationCallOrder[0]).toBeGreaterThan(archive.mock.invocationCallOrder[0]);
  });

  it('tells nobody when the archive is refused', async () => {
    const { ForbiddenError } = jest.requireActual('../../middleware/errors');
    archive.mockRejectedValue(new ForbiddenError('Only the pod director can archive the pod'));

    const res = await request(app).delete(`/pods/${POD}`);

    expect(res.status).toBe(403);
    expect(told).not.toHaveBeenCalled();
  });
});
