// ─── Matching Agents routes (Wave 2 core, 3 Aug 2026) ────────────────────────

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const mockRepo = {
  listAgents: jest.fn<any, any[]>(),
  getAgent: jest.fn<any, any[]>(),
  createAgent: jest.fn<any, any[]>(),
  updateAgent: jest.fn<any, any[]>(),
  setStatus: jest.fn<any, any[]>(),
  listMatches: jest.fn<any, any[]>(),
  removeMatch: jest.fn<any, any[]>(),
};
const mockRecompute = jest.fn<any, any[]>();
const mockExpressInterest = jest.fn<any, any[]>();

jest.mock('../../services/matching/agent.repo', () => ({ ...mockRepo, __esModule: true }));
jest.mock('../../services/matching/agent-matching.service', () => ({
  recomputeAgent: (...a: unknown[]) => mockRecompute(...a),
  __esModule: true,
}));
jest.mock('../../services/matching/platform-match.service', () => ({
  expressInterest: (...a: unknown[]) => mockExpressInterest(...a),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../config', () => ({
  __esModule: true,
  default: { jwtSecret: 'test-secret', nodeEnv: 'test' },
}));

import agentRoutes from '../../routes/agents';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/agents', agentRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub = 'u-1') =>
  jwt.sign({ sub, email: 'a@b.c', role: 'member', displayName: 'A', sessionId: 's' }, 'test-secret');

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a-1', userId: 'u-1', label: 'Developers', wantText: 'react developers',
  matchingTags: [], status: 'active', lastMatchedAt: null,
  createdAt: new Date(), updatedAt: new Date(), matchCount: 3, ...over,
});

beforeEach(() => {
  Object.values(mockRepo).forEach(m => m.mockReset());
  mockRecompute.mockReset(); mockRecompute.mockResolvedValue(0);
  mockExpressInterest.mockReset();
});

describe('GET /agents', () => {
  it('returns the caller\'s agents with their counts', async () => {
    mockRepo.listAgents.mockResolvedValue([agent(), agent({ id: 'a-2', label: 'Investors', matchCount: 0 })]);
    const res = await request(app).get('/agents').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ label: 'Developers', matchCount: 3 });
    expect(mockRepo.listAgents).toHaveBeenCalledWith('u-1');
  });

  it('requires auth', async () => {
    const res = await request(app).get('/agents');
    expect(res.status).toBe(401);
  });
});

describe('POST /agents', () => {
  it('creates an agent and kicks off scoring without making the caller wait', async () => {
    mockRepo.createAgent.mockResolvedValue(agent({ matchCount: 0 }));
    const res = await request(app).post('/agents')
      .set('Authorization', `Bearer ${token()}`)
      .send({ label: 'Developers', wantText: 'react developers' });
    expect(res.status).toBe(201);
    expect(res.body.data.label).toBe('Developers');
    await new Promise(r => setImmediate(r));
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty label', async () => {
    const res = await request(app).post('/agents')
      .set('Authorization', `Bearer ${token()}`)
      .send({ label: '   ', wantText: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing want', async () => {
    const res = await request(app).post('/agents')
      .set('Authorization', `Bearer ${token()}`)
      .send({ label: 'Developers' });
    expect(res.status).toBe(400);
  });
});

describe('GET /agents/:id', () => {
  it('returns the agent with the people it found', async () => {
    mockRepo.getAgent.mockResolvedValue(agent());
    mockRepo.listMatches.mockResolvedValue([{ candidateUserId: 'u-2', score: 0.8, reason: 'fits' }]);
    const res = await request(app).get('/agents/a-1').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.agent.id).toBe('a-1');
    expect(res.body.data.matches).toHaveLength(1);
  });

  it('404s on someone else\'s agent', async () => {
    mockRepo.getAgent.mockResolvedValue(null);
    const res = await request(app).get('/agents/a-9').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /agents/:id', () => {
  it('rescores when what it looks for changed', async () => {
    mockRepo.updateAgent.mockResolvedValue(agent({ wantText: 'senior react developers' }));
    const res = await request(app).patch('/agents/a-1')
      .set('Authorization', `Bearer ${token()}`)
      .send({ wantText: 'senior react developers' });
    expect(res.status).toBe(200);
    await new Promise(r => setImmediate(r));
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it('does not rescore for a rename alone', async () => {
    mockRepo.updateAgent.mockResolvedValue(agent({ label: 'Engineers' }));
    await request(app).patch('/agents/a-1')
      .set('Authorization', `Bearer ${token()}`)
      .send({ label: 'Engineers' });
    await new Promise(r => setImmediate(r));
    expect(mockRecompute).not.toHaveBeenCalled();
  });
});

describe('POST /agents/:id/status', () => {
  it.each(['paused', 'archived'] as const)('accepts %s without rescoring', async (status) => {
    mockRepo.setStatus.mockResolvedValue(agent({ status }));
    const res = await request(app).post('/agents/a-1/status')
      .set('Authorization', `Bearer ${token()}`).send({ status });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(status);
    await new Promise(r => setImmediate(r));
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it('rescores when resumed, since the world moved on while it was paused', async () => {
    mockRepo.setStatus.mockResolvedValue(agent({ status: 'active' }));
    await request(app).post('/agents/a-1/status')
      .set('Authorization', `Bearer ${token()}`).send({ status: 'active' });
    await new Promise(r => setImmediate(r));
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it('rejects a status outside the lifecycle', async () => {
    const res = await request(app).post('/agents/a-1/status')
      .set('Authorization', `Bearer ${token()}`).send({ status: 'deleted' });
    expect(res.status).toBe(400);
  });
});

describe('POST /agents/:id/interest', () => {
  it('introduces through the agent and drops them from THIS agent only', async () => {
    mockRepo.getAgent.mockResolvedValue(agent());
    mockExpressInterest.mockResolvedValue({ id: 'p-1', status: 'pending' });
    mockRepo.removeMatch.mockResolvedValue(undefined);

    const res = await request(app).post('/agents/a-1/interest')
      .set('Authorization', `Bearer ${token()}`)
      .send({ userId: '11111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(201);
    // The agent id must reach expressInterest — that is what scopes the exclusion.
    expect(mockExpressInterest).toHaveBeenCalledWith('u-1', '11111111-1111-4111-8111-111111111111', 'a-1');
    expect(mockRepo.removeMatch).toHaveBeenCalledWith('a-1', '11111111-1111-4111-8111-111111111111');
  });

  it('refuses to introduce someone to themselves', async () => {
    mockRepo.getAgent.mockResolvedValue(agent({ userId: '11111111-1111-4111-8111-111111111111' }));
    const res = await request(app).post('/agents/a-1/interest')
      .set('Authorization', `Bearer ${token()}`)
      .send({ userId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(400);
  });
});
