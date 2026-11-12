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
let mockSignedInRole = 'member';
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'ana@example.com', role: mockSignedInRole, sessionId: 's-1' };
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
  mockSignedInRole = 'member';
  told.mockResolvedValue(undefined);
  (fanout.fanoutCirclesOfPod as jest.Mock).mockResolvedValue(undefined);
});

/** A service call that saves after a moment, and a fan-out that records whether the save had landed when it ran. */
function saveThenTell(service: jest.Mock, teller: jest.Mock, result: unknown = undefined) {
  const state = { saved: false, savedWhenTold: null as boolean | null };
  service.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); state.saved = true; return result; });
  teller.mockImplementation(async () => { state.savedWhenTold = state.saved; });
  return state;
}

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

  it('the circles the pod is in are told after the archive too', async () => {
    const circles = fanout.fanoutCirclesOfPod as jest.Mock;
    const state = saveThenTell(archive, circles);

    expect((await request(app).delete(`/pods/${POD}`)).status).toBe(200);
    expect(state.savedWhenTold).toBe(true);
  });

  it('tells nobody when the archive is refused', async () => {
    const { ForbiddenError } = jest.requireActual('../../middleware/errors');
    archive.mockRejectedValue(new ForbiddenError('Only the pod director can archive the pod'));

    const res = await request(app).delete(`/pods/${POD}`);

    expect(res.status).toBe(403);
    expect(told).not.toHaveBeenCalled();
  });
});

// 12 Nov 2026 (pod-wall.spec.ts "a page that read the pod a moment before the archive was saved"): the same rule for
// every other way a pod's status changes, and for the hard delete, which used to tell the members first.
describe('PUT /pods/:id (archive or any edit through the edit form)', () => {
  it('tells the pod\'s screens and its circles only once the change is saved', async () => {
    const update = podService.updatePod as jest.Mock;
    const pod = { id: POD, status: 'archived' };
    const state = saveThenTell(update, told, pod);

    const res = await request(app).put(`/pods/${POD}`).send({ status: 'archived' });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(POD, VIEWER, { status: 'archived' }, 'member');
    expect(told).toHaveBeenCalledWith(POD);
    expect(state.savedWhenTold).toBe(true);
    expect(told.mock.invocationCallOrder[0]).toBeGreaterThan(update.mock.invocationCallOrder[0]);
    expect((fanout.fanoutCirclesOfPod as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(update.mock.invocationCallOrder[0]);
  });

  it('tells nobody when the change is refused', async () => {
    const { ForbiddenError } = jest.requireActual('../../middleware/errors');
    (podService.updatePod as jest.Mock).mockRejectedValue(new ForbiddenError('Only the pod director or host can edit the pod'));

    expect((await request(app).put(`/pods/${POD}`).send({ status: 'archived' })).status).toBe(403);
    expect(told).not.toHaveBeenCalled();
    expect(fanout.fanoutCirclesOfPod).not.toHaveBeenCalled();
  });
});

describe('POST /pods/:id/reactivate', () => {
  it('tells the pod\'s screens, every member\'s My Pods and its circles only once the pod is open again', async () => {
    const reactivate = podService.reactivatePod as jest.Mock;
    const state = saveThenTell(reactivate, told, { id: POD, status: 'active' });

    const res = await request(app).post(`/pods/${POD}/reactivate`);

    expect(res.status).toBe(200);
    expect(told).toHaveBeenCalledWith(POD, [], { includeUserPodsPerMember: true });
    expect(state.savedWhenTold).toBe(true);
    expect((fanout.fanoutCirclesOfPod as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(reactivate.mock.invocationCallOrder[0]);
  });

  it('tells nobody when the pod was not archived', async () => {
    const { ConflictError } = jest.requireActual('../../middleware/errors');
    (podService.reactivatePod as jest.Mock).mockRejectedValue(new ConflictError('POD_NOT_ARCHIVED', 'Only archived pods can be reactivated'));

    expect((await request(app).post(`/pods/${POD}/reactivate`)).status).toBe(409);
    expect(told).not.toHaveBeenCalled();
  });
});

describe('DELETE /pods/:id/permanent (super admin)', () => {
  const audienceOf = fanout.podAudience as jest.Mock;
  const tell = fanout.tellPodAudience as jest.Mock;
  const hardDelete = podService.hardDeletePod as jest.Mock;

  it('reads who to tell before the rows go, and tells them only once the delete is saved', async () => {
    mockSignedInRole = 'super_admin';
    const members = ['m-1', 'm-2'];
    audienceOf.mockResolvedValue(members);
    const state = saveThenTell(hardDelete, tell);

    const res = await request(app).delete(`/pods/${POD}/permanent`);

    expect(res.status).toBe(200);
    expect(audienceOf.mock.invocationCallOrder[0]).toBeLessThan(hardDelete.mock.invocationCallOrder[0]);
    expect(tell).toHaveBeenCalledWith(members, POD, [], { includeUserPodsPerMember: true });
    expect(state.savedWhenTold).toBe(true);
    expect(told).not.toHaveBeenCalled();
  });

  it('tells nobody when the delete fails', async () => {
    mockSignedInRole = 'super_admin';
    audienceOf.mockResolvedValue(['m-1']);
    const { NotFoundError } = jest.requireActual('../../middleware/errors');
    hardDelete.mockRejectedValue(new NotFoundError('Pod'));

    expect((await request(app).delete(`/pods/${POD}/permanent`)).status).toBe(404);
    expect(tell).not.toHaveBeenCalled();
  });
});
