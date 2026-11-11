// ─── A new pod from a circle's page (T14, 1 Nov 2026; audit 05 §7.6) ─────────────────────────────────────────
//
// "Create a new Part from the Circle screen ... instead of going to Parts first and then coming back." POST /pods
// takes an optional circleId. Who may add a pod to the circle (the people who run it) is checked BEFORE anything is
// made: 404 for an archived or missing circle, 403 for anyone else, and no pod exists after a refusal. The pod, its
// director and the link are then one transaction (pod.service.ts; run on real Postgres in
// services/circle/circle-join-policy.sql.test.ts). The circle's people are told through circle:<id>.
// Production's form never sends circleId: its body is answered exactly as before.

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
const mockFanoutPod = jest.fn().mockResolvedValue(undefined);
const mockFanoutAdmin = jest.fn().mockResolvedValue(undefined);
const mockFanoutCircle = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutPodEntities: (...args: unknown[]) => mockFanoutPod(...args),
  fanoutAdminEntities: (...args: unknown[]) => mockFanoutAdmin(...args),
  fanoutCircleChange: (...args: unknown[]) => mockFanoutCircle(...args),
  fanoutPodMembershipForUser: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../realtime/emit', () => ({ emitEntities: jest.fn(), getRealtimeIo: () => null, __esModule: true }));
jest.mock('../../middleware/audit', () => ({ auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(), __esModule: true }));

import * as podService from '../../services/pod/pod.service';
import podRoutes from '../../routes/pods';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const CIRCLE = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const OWNER = 'user-owner';
const MEMBER = 'user-member';
const POD = { id: 'pod-1', name: 'Made here', visibility: 'invite_only' };

const app = express();
app.use(express.json());
app.use('/pods', podRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string, role = 'member') =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let circleRow: Record<string, unknown> | null;
beforeEach(() => {
  jest.clearAllMocks();
  circleRow = { id: CIRCLE, name: 'Founders', join_policy: 'open' };
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT status, account_kind FROM users/.test(text)) return { rows: [{ status: 'active', account_kind: 'member' }] };
    if (/SELECT id, name, join_policy FROM circles/.test(text)) return { rows: circleRow ? [circleRow] : [] };
    // Shirley pilot S2: the manager gate asks for an owner or moderator row only.
    if (/SELECT 1 FROM circle_members m WHERE m\.circle_id = \$1 AND m\.user_id = \$2 AND m\.role IN \('owner', 'moderator'\)/.test(text)) {
      return { rows: params[1] === OWNER ? [{}] : [] };
    }
    return { rows: [] };
  });
  jest.mocked(podService.createPod).mockResolvedValue(POD as never);
});

describe('POST /pods with a circle', () => {
  it('the circle\'s owner makes it: the service gets the circle, the answer carries it, and the circle\'s people are told', async () => {
    const res = await request(app).post('/pods').set(as(OWNER)).send({ name: 'Made here', circleId: CIRCLE.toUpperCase() });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { ...POD, circleId: CIRCLE } });
    expect(podService.createPod).toHaveBeenCalledWith(OWNER, { name: 'Made here', circleId: CIRCLE });
    await settle();
    expect(mockFanoutPod).toHaveBeenCalledWith('pod-1', [`user:${OWNER}:pods`]);
    expect(mockFanoutCircle).toHaveBeenCalledWith(CIRCLE, OWNER);
  });

  it('a member who does not run the circle is refused (403) before any pod is made', async () => {
    const res = await request(app).post('/pods').set(as(MEMBER)).send({ name: 'Nope', circleId: CIRCLE });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the people who run this circle can add a pod to it.');
    expect(podService.createPod).not.toHaveBeenCalled();
    await settle();
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutCircle).not.toHaveBeenCalled();
  });

  it('an archived or missing circle is a 404 before any pod is made', async () => {
    circleRow = null;
    const res = await request(app).post('/pods').set(as(OWNER)).send({ name: 'Nope', circleId: CIRCLE });
    expect(res.status).toBe(404);
    expect(podService.createPod).not.toHaveBeenCalled();
  });

  it('a platform admin outside the circle may add one', async () => {
    expect((await request(app).post('/pods').set(as('user-platform', 'admin')).send({ name: 'Admin pod', circleId: CIRCLE })).status).toBe(201);
  });

  it('a circle id that is not an id is a 400', async () => {
    expect((await request(app).post('/pods').set(as(OWNER)).send({ name: 'x', circleId: 'not-a-circle' })).status).toBe(400);
    expect(podService.createPod).not.toHaveBeenCalled();
  });
});

describe('production\'s New pod form (no circleId) is answered exactly as before', () => {
  it('makes the pod with the body as sent, answers the pod alone, and tells no circle', async () => {
    const body = { name: 'Plain', description: 'd', podType: 'speed_networking', visibility: 'private', allowMemberInvites: true };
    const res = await request(app).post('/pods').set(as(MEMBER)).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: POD });
    expect(podService.createPod).toHaveBeenCalledWith(MEMBER, body);
    await settle();
    expect(mockFanoutCircle).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some((c) => /FROM circles/.test(String(c[0])))).toBe(false);
  });
});
