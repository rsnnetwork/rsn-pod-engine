// ─── The tick-box endpoints, through the real router ─────────────────────────
//
// The service tests mock the database, so they prove the SQL and leave the
// wiring untested — and the wiring is where this broke. The three write routes
// wrapped their schema as `z.object({ body: … })`, but validate() parses
// req.body directly, so every write answered 400 "body Required" while the
// unit tests stayed green. These go through express, exactly as a browser
// does, so a mistake in the chain cannot hide again.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    env: 'test', isDev: false, isProd: false, isTest: true,
    clientUrl: 'https://app.test',
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs,
  // so the mock has to answer that or every request is a 401.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(async (cb: Function) => cb({ query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }) })),
  __esModule: true,
}));

const mockGetState = jest.fn();
const mockSaveDraft = jest.fn().mockResolvedValue(undefined);
const mockConfirm = jest.fn();
const mockMarkTourSeen = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/onboarding/answers.repo', () => ({
  getState: (...a: unknown[]) => mockGetState(...a),
  saveDraft: (...a: unknown[]) => mockSaveDraft(...a),
  confirm: (...a: unknown[]) => mockConfirm(...a),
  markTourSeen: (...a: unknown[]) => mockMarkTourSeen(...a),
  __esModule: true,
}));

const mockCreateAgents = jest.fn().mockResolvedValue([{ id: 'ag-1', label: 'Investors & VCs' }]);
jest.mock('../../services/matching/first-agent.service', () => ({
  createAgentsFromAnswers: (...a: unknown[]) => mockCreateAgents(...a),
  createFirstAgents: jest.fn().mockResolvedValue([]),
  __esModule: true,
}));
const mockNotify = jest.fn().mockResolvedValue(0);
jest.mock('../../services/matching/platform-match.service', () => ({
  notifyMatchesOfNewUser: (...a: unknown[]) => mockNotify(...a),
  __esModule: true,
}));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutUserEntity: (...a: unknown[]) => mockFanout(...a),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/onboarding/stage-events.repo', () => ({
  record: jest.fn().mockResolvedValue(undefined),
  sanitizeErrorMessage: (e: unknown) => String(e),
  __esModule: true,
}));
jest.mock('../../services/onboarding/avatar.service', () => ({
  tryGravatar: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import onboardingRoutes from '../../routes/onboarding';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/onboarding', onboardingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = jwt.sign({ sub: 'u-1', email: 'u@e.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

const GOOD = {
  intent: 'find_investors',
  lookingToMeet: ['investors'],
  canOffer: ['mentoring_advice'],
  industries: ['software_ai'],
  industryOther: null,
  selfKinds: ['founders'],
  jobTitle: null, company: null, about: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetState.mockResolvedValue({
    status: 'not_started', answers: {}, step: 'welcome',
    displayName: 'Ana', avatarUrl: null,
    tour: { pending: false, seenAt: null, outcome: null },
  });
  mockConfirm.mockResolvedValue({ changed: true, firstCompletion: true, answers: GOOD });
  mockCreateAgents.mockResolvedValue([{ id: 'ag-1', label: 'Investors & VCs' }]);
});

describe('the flow can actually be completed through the router', () => {
  it('saves a partial answer', async () => {
    const res = await auth(request(app).put('/onboarding/answers').send({ intent: 'get_advice', step: 'q2' }));
    expect(res.status).toBe(200);
    expect(mockSaveDraft).toHaveBeenCalledWith('u-1', expect.objectContaining({ intent: 'get_advice' }));
  });

  it('confirms, seeds the searches and hands back where to go next', async () => {
    const res = await auth(request(app).post('/onboarding/answers/confirm').send(GOOD));
    expect(res.status).toBe(200);
    expect(res.body.data.primaryAgentId).toBe('ag-1');
    expect(mockCreateAgents).toHaveBeenCalledWith('u-1', ['investors'], 'find_investors');
    expect(mockNotify).toHaveBeenCalledWith('u-1');
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('remembers how the wizard was left', async () => {
    const res = await auth(request(app).post('/onboarding/tour').send({ outcome: 'skipped', lastCard: 2 }));
    expect(res.status).toBe(200);
    expect(mockMarkTourSeen).toHaveBeenCalledWith('u-1', 'skipped');
  });

  it('returns their own answers, and nothing guessed about them', async () => {
    const res = await auth(request(app).get('/onboarding/state'));
    expect(res.status).toBe(200);
    expect(res.body.data.displayName).toBe('Ana');
    expect(res.body.data).not.toHaveProperty('country');
    expect(res.body.data).not.toHaveProperty('company');
  });
});

describe('what it refuses', () => {
  it('needs you to be signed in', async () => {
    expect((await request(app).get('/onboarding/state')).status).toBe(401);
    expect((await request(app).post('/onboarding/answers/confirm').send(GOOD)).status).toBe(401);
  });

  it('rejects an option that is not on the list', async () => {
    const res = await auth(request(app).post('/onboarding/answers/confirm').send({ ...GOOD, intent: 'made_up' }));
    expect(res.status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('rejects more than three people to meet', async () => {
    const res = await auth(request(app).post('/onboarding/answers/confirm').send({
      ...GOOD, lookingToMeet: ['founders', 'investors', 'advisors_mentors', 'developers_technical'],
    }));
    expect(res.status).toBe(400);
  });

  it('rejects an unfinished set', async () => {
    const res = await auth(request(app).post('/onboarding/answers/confirm').send({ intent: 'get_advice' }));
    expect(res.status).toBe(400);
  });

  it('asks which industry when Other is ticked', async () => {
    const res = await auth(request(app).post('/onboarding/answers/confirm').send({
      ...GOOD, industries: ['other'], industryOther: null,
    }));
    expect(res.status).toBe(400);
  });

  it('rejects a key the draft route does not know either', async () => {
    const res = await auth(request(app).put('/onboarding/answers').send({ lookingToMeet: ['astronauts'] }));
    expect(res.status).toBe(400);
  });
});

describe('finishing twice', () => {
  it('does not seed a second set of searches or tell the network again', async () => {
    mockConfirm.mockResolvedValue({ changed: false, firstCompletion: false, answers: GOOD });
    const res = await auth(request(app).post('/onboarding/answers/confirm').send(GOOD));
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(false);
    expect(mockCreateAgents).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    // Their other tabs still need to hear that they are through the gate.
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });
});
