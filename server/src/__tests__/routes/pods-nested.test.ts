// ─── Pods inside pods: the routes (Stefan, 22 Nov 2026) ─────────────────────────────────────────────────────────
//
//   POST   /pods                         { ...pod, parentPodId }   make a pod inside a main pod (its director, or an admin)
//   GET    /pods/:id                     the pod, with parentPodId, parentPod, parentPodHidden, innerPodCount, joinNeedsMainPod, mayHoldPods
//   GET    /pods/:id/pods                the pods inside it that the viewer may see
//   GET    /pods/:id/pods/candidates     the director's own pods that could go inside it
//   PUT    /pods/:id/parent              { parentPodId }           put this pod inside a main pod
//   DELETE /pods/:id/parent                                        take this pod out of its main pod
//   PUT    /pods/:id/inner-pods-setting  { innerPodsMembersOnly }  the main pod's members-only choice
// Each validates its path and body before the service is reached (400 in a member's words), and every change tells
// both pods' people (fanoutNestingChange) after it is saved, and nobody when nothing changed.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
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
jest.mock('../../services/pod/pod.service');
jest.mock('../../services/pod/nested-pods.service', () => {
  const actual = jest.requireActual('../../services/pod/nested-pods.service');
  return {
    ...actual,
    assertDirectsPod: jest.fn(), readPodNesting: jest.fn(), listInnerPods: jest.fn(), listInnerPodCandidates: jest.fn(),
    putPodInside: jest.fn(), takePodOut: jest.fn(), setInnerPodsMembersOnly: jest.fn(),
    __esModule: true,
  };
});
const mockCanView = jest.fn();
jest.mock('../../services/pods/pod-access', () => ({ canViewPod: (...a: unknown[]) => mockCanView(...a), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({
  fanoutPodEntities: jest.fn().mockResolvedValue(undefined),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutCircleChange: jest.fn().mockResolvedValue(undefined),
  fanoutCirclesOfPod: jest.fn().mockResolvedValue(undefined),
  fanoutPodMembershipForUser: jest.fn().mockResolvedValue(undefined),
  podAudience: jest.fn().mockResolvedValue(['u-1']),
  tellPodAudience: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../realtime/fanout-nesting', () => ({
  fanoutNestingChange: jest.fn().mockResolvedValue(undefined),
  fanoutPodRelatives: jest.fn().mockResolvedValue(undefined),
  readPodRelatives: jest.fn().mockResolvedValue({ parentId: null, innerIds: ['in-1'] }),
  tellPodRelatives: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, __esModule: true }));
jest.mock('../../middleware/audit', () => ({ auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(), __esModule: true }));

import * as podService from '../../services/pod/pod.service';
import * as nested from '../../services/pod/nested-pods.service';
import * as nestingFanout from '../../realtime/fanout-nesting';
import { ForbiddenError } from '../../middleware/errors';
import podRoutes from '../../routes/pods';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const MAIN = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const CHILD = '1a2b3c4d-1c1f-4c3f-9d1e-6a5d0f3b2a22';
const CIRCLE = '9f9e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a33';
const DIR = 'user-director';

const app = express();
app.use(express.json());
app.use('/pods', podRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string, role = 'member') =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT status, account_kind FROM users/.test(String(sql))) return { rows: [{ status: 'active', account_kind: 'member' }] };
    return { rows: [] };
  });
  mockCanView.mockResolvedValue(true);
});

describe('POST /pods with a main pod', () => {
  it('checks the maker directs the main pod BEFORE anything is made, then tells both pods\' people', async () => {
    jest.mocked(podService.createPod).mockResolvedValue({ id: CHILD, name: 'Design', parentPodId: MAIN } as never);
    const res = await request(app).post('/pods').set(as(DIR)).send({ name: 'Design', parentPodId: MAIN.toUpperCase() });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: CHILD, parentPodId: MAIN });
    expect(nested.assertDirectsPod).toHaveBeenCalledWith(MAIN, { userId: DIR, role: 'member' }, nested.NESTING_PERMISSION.make);
    expect(jest.mocked(nested.assertDirectsPod).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(podService.createPod).mock.invocationCallOrder[0]);
    expect(podService.createPod).toHaveBeenCalledWith(DIR, { name: 'Design', parentPodId: MAIN });
    await settle();
    expect(nestingFanout.fanoutNestingChange).toHaveBeenCalledWith([MAIN, CHILD]);
  });

  it('someone who does not direct it is refused, and no pod is made', async () => {
    jest.mocked(nested.assertDirectsPod).mockRejectedValueOnce(new ForbiddenError(nested.NESTING_PERMISSION.make));
    const res = await request(app).post('/pods').set(as('user-other')).send({ name: 'Nope', parentPodId: MAIN });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Only this pod's director can make a pod inside it.");
    expect(podService.createPod).not.toHaveBeenCalled();
  });

  it('a circle and a main pod at once, or a main pod that is not an id, is a 400 before anything is read', async () => {
    const both = await request(app).post('/pods').set(as(DIR)).send({ name: 'x', parentPodId: MAIN, circleId: CIRCLE });
    expect(both.status).toBe(400);
    expect(both.body.error.details.parentPodId).toEqual(['Make the pod in a circle or inside a pod, not both at once.']);
    expect((await request(app).post('/pods').set(as(DIR)).send({ name: 'x', parentPodId: 'nope' })).status).toBe(400);
    expect(nested.assertDirectsPod).not.toHaveBeenCalled();
    expect(podService.createPod).not.toHaveBeenCalled();
  });

  it('a plain new pod is made exactly as before (no main pod is read, nobody else is told)', async () => {
    jest.mocked(podService.createPod).mockResolvedValue({ id: CHILD, name: 'Plain' } as never);
    expect((await request(app).post('/pods').set(as(DIR)).send({ name: 'Plain' })).status).toBe(201);
    expect(podService.createPod).toHaveBeenCalledWith(DIR, { name: 'Plain' });
    expect(nested.assertDirectsPod).not.toHaveBeenCalled();
    await settle();
    expect(nestingFanout.fanoutNestingChange).not.toHaveBeenCalled();
  });
});

describe('GET /pods/:id carries where the pod sits', () => {
  it('names a main pod the viewer may see, and never gives the id of one they may not', async () => {
    jest.mocked(podService.getPodById).mockResolvedValue({ id: CHILD, name: 'Design', parentPodId: MAIN, innerPodsMembersOnly: false } as never);
    jest.mocked(podService.getMemberRole).mockResolvedValue(null);
    jest.mocked(nested.readPodNesting).mockResolvedValueOnce({
      parentPod: { id: MAIN, name: 'Founders' }, parentPodHidden: false, innerPodCount: 0, joinNeedsMainPod: true, mayHoldPods: false,
    });
    const seen = await request(app).get(`/pods/${CHILD}`).set(as('user-x'));
    expect(seen.body.data).toMatchObject({
      parentPodId: MAIN, parentPod: { id: MAIN, name: 'Founders' }, joinNeedsMainPod: true, mayHoldPods: false, innerPodCount: 0, innerPodsMembersOnly: false,
    });
    jest.mocked(nested.readPodNesting).mockResolvedValueOnce({
      parentPod: null, parentPodHidden: true, innerPodCount: 0, joinNeedsMainPod: false, mayHoldPods: false,
    });
    const hidden = await request(app).get(`/pods/${CHILD}`).set(as('user-x'));
    expect(hidden.body.data).toMatchObject({ parentPodId: null, parentPod: null, parentPodHidden: true });
  });
});

describe('GET /pods/:id/pods and /pods/:id/pods/candidates', () => {
  it('lists the pods inside to someone who may see the main pod, and 404s anyone else', async () => {
    jest.mocked(nested.listInnerPods).mockResolvedValue([{ id: CHILD, name: 'Design' }] as never);
    const ok = await request(app).get(`/pods/${MAIN}/pods`).set(as('user-x'));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual([{ id: CHILD, name: 'Design' }]);
    expect(nested.listInnerPods).toHaveBeenCalledWith(MAIN, { userId: 'user-x', role: 'member' });
    mockCanView.mockResolvedValueOnce(false);
    expect((await request(app).get(`/pods/${MAIN}/pods`).set(as('user-x'))).status).toBe(404);
    expect((await request(app).get('/pods/not-an-id/pods').set(as('user-x'))).status).toBe(400);
  });

  it('offers candidates only to the main pod\'s director (or an admin)', async () => {
    jest.mocked(nested.listInnerPodCandidates).mockResolvedValue([{ id: CHILD, name: 'Mine', memberCount: 3 }]);
    expect((await request(app).get(`/pods/${MAIN}/pods/candidates`).set(as(DIR))).body.data).toEqual([{ id: CHILD, name: 'Mine', memberCount: 3 }]);
    jest.mocked(nested.assertDirectsPod).mockRejectedValueOnce(new ForbiddenError(nested.NESTING_PERMISSION.put));
    expect((await request(app).get(`/pods/${MAIN}/pods/candidates`).set(as('user-x'))).status).toBe(403);
  });
});

describe('PUT and DELETE /pods/:id/parent', () => {
  it('puts the pod inside and tells both pods\' people; a second press tells nobody', async () => {
    jest.mocked(nested.putPodInside).mockResolvedValueOnce({ changed: true, parentPodId: MAIN, previousParentPodId: null });
    const res = await request(app).put(`/pods/${CHILD}/parent`).set(as(DIR)).send({ parentPodId: MAIN.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ podId: CHILD, parentPodId: MAIN, changed: true });
    expect(nested.putPodInside).toHaveBeenCalledWith(MAIN, CHILD, { userId: DIR, role: 'member' });
    await settle();
    expect(nestingFanout.fanoutNestingChange).toHaveBeenCalledWith([MAIN, CHILD]);
    jest.mocked(nestingFanout.fanoutNestingChange).mockClear();
    jest.mocked(nested.putPodInside).mockResolvedValueOnce({ changed: false, parentPodId: MAIN, previousParentPodId: MAIN });
    await request(app).put(`/pods/${CHILD}/parent`).set(as(DIR)).send({ parentPodId: MAIN });
    await settle();
    expect(nestingFanout.fanoutNestingChange).not.toHaveBeenCalled();
  });

  it('a body without a main pod, or with one that is not an id, is a 400 in words', async () => {
    const missing = await request(app).put(`/pods/${CHILD}/parent`).set(as(DIR)).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.parentPodId).toEqual(['Choose the pod to put it inside.']);
    expect((await request(app).put(`/pods/${CHILD}/parent`).set(as(DIR)).send({ parentPodId: 'x' })).status).toBe(400);
    expect(nested.putPodInside).not.toHaveBeenCalled();
  });

  it('takes the pod out and tells the main pod it left and the pod itself', async () => {
    jest.mocked(nested.takePodOut).mockResolvedValueOnce({ changed: true, parentPodId: null, previousParentPodId: MAIN });
    const res = await request(app).delete(`/pods/${CHILD}/parent`).set(as(DIR));
    expect(res.body.data).toEqual({ podId: CHILD, parentPodId: null, previousParentPodId: MAIN, changed: true });
    await settle();
    expect(nestingFanout.fanoutNestingChange).toHaveBeenCalledWith([MAIN, CHILD]);
  });

  it('a refusal from the service is answered in its words', async () => {
    jest.mocked(nested.takePodOut).mockRejectedValueOnce(new ForbiddenError(nested.NESTING_PERMISSION.takeOut));
    const res = await request(app).delete(`/pods/${CHILD}/parent`).set(as('user-x'));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the director of this pod, or of the pod it is in, can take it out.');
  });
});

describe('PUT /pods/:id/inner-pods-setting', () => {
  it('sets the choice and tells the main pod and the pods inside it; the same choice again tells nobody', async () => {
    jest.mocked(nested.setInnerPodsMembersOnly).mockResolvedValueOnce({ innerPodsMembersOnly: true, changed: true });
    const res = await request(app).put(`/pods/${MAIN}/inner-pods-setting`).set(as(DIR)).send({ innerPodsMembersOnly: true });
    expect(res.body.data).toEqual({ podId: MAIN, innerPodsMembersOnly: true, changed: true });
    expect(nested.setInnerPodsMembersOnly).toHaveBeenCalledWith(MAIN, true, { userId: DIR, role: 'member' });
    await settle();
    expect(nestingFanout.fanoutNestingChange).toHaveBeenCalledWith([MAIN]);
    expect(nestingFanout.fanoutPodRelatives).toHaveBeenCalledWith(MAIN);
    jest.clearAllMocks();
    jest.mocked(nested.setInnerPodsMembersOnly).mockResolvedValueOnce({ innerPodsMembersOnly: true, changed: false });
    await request(app).put(`/pods/${MAIN}/inner-pods-setting`).set(as(DIR)).send({ innerPodsMembersOnly: true });
    await settle();
    expect(nestingFanout.fanoutNestingChange).not.toHaveBeenCalled();
  });

  it('anything but true or false is a 400 in words, before the service', async () => {
    for (const body of [{}, { innerPodsMembersOnly: 'yes' }, { innerPodsMembersOnly: 1 }]) {
      const res = await request(app).put(`/pods/${MAIN}/inner-pods-setting`).set(as(DIR)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.innerPodsMembersOnly).toEqual(['Choose whether people must be members of this pod to join its pods.']);
    }
    expect(nested.setInnerPodsMembersOnly).not.toHaveBeenCalled();
  });
});

describe('a pod deleted for good', () => {
  it('reads the pods inside it before the delete and tells them after (they stand alone once it is gone)', async () => {
    jest.mocked(podService.hardDeletePod).mockResolvedValue(undefined);
    const res = await request(app).delete(`/pods/${MAIN}/permanent`).set(as('user-sa', 'super_admin'));
    expect(res.status).toBe(200);
    const readAt = jest.mocked(nestingFanout.readPodRelatives).mock.invocationCallOrder[0];
    const deleteAt = jest.mocked(podService.hardDeletePod).mock.invocationCallOrder[0];
    const tellAt = jest.mocked(nestingFanout.tellPodRelatives).mock.invocationCallOrder[0];
    expect(readAt).toBeLessThan(deleteAt);
    expect(deleteAt).toBeLessThan(tellAt);
    expect(nestingFanout.tellPodRelatives).toHaveBeenCalledWith({ parentId: null, innerIds: ['in-1'] });
  });
});
