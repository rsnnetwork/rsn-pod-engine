// ─── An agent is rescored once at a time (26 Oct 2026, H2b item 14) ──────────────────────────────────────
//
// GET /agents answers at once and scores every active agent that has never been scored in the background, so the
// seeded agents fill in on the next poll. Two reads close together (the dashboard polls, a second tab) used to start
// two rescorings of the same agent, each a search against the whole member base. A rescoring in flight is now the
// only one: a later read skips the agent until it has finished, and the next read after that may start another.
//
// The real router runs under express; sign-in, the repository, the scorer and the fan-out are stand-ins.

import express from 'express';
import request from 'supertest';

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
jest.mock('../../db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), transaction: jest.fn(), __esModule: true }));
jest.mock('../../realtime/fanout');
jest.mock('../../services/matching/agent.repo');
jest.mock('../../services/matching/agent-matching.service');
jest.mock('../../services/matching/platform-match.service');

import * as agentRepo from '../../services/matching/agent.repo';
import * as agentMatching from '../../services/matching/agent-matching.service';
import * as fanout from '../../realtime/fanout';
import agentRoutes from '../../routes/agents';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/agents', agentRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const unscored = (id: string) => ({ id, userId: ME, wantText: 'founders in Berlin', label: 'Founders', status: 'active', lastMatchedAt: null });
const settle = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  (fanout.fanoutUserEntity as jest.Mock).mockResolvedValue(undefined);
});

describe('an edit while a rescoring is running (review I4 of H2b item 14)', () => {
  it('is scored once more, with the new words, when the running one ends', async () => {
    const id = 'a3a3a3a3-0000-4000-8000-0000000000a3';
    const agent = unscored(id);
    const edited = { ...agent, wantText: 'designers in Oslo' };
    (agentRepo.listAgents as jest.Mock).mockResolvedValue([agent]);
    (agentRepo.updateAgent as jest.Mock).mockResolvedValue(edited);
    const finishes: Array<() => void> = [];
    (agentMatching.recomputeAgent as jest.Mock).mockImplementation(() => new Promise<number>((resolve) => { finishes.push(() => resolve(1)); }));

    await request(app).get('/agents').expect(200);
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(1);

    // The edit lands while the first rescoring runs: it is not dropped, and not run beside the first either.
    await request(app).patch(`/agents/${id}`).send({ wantText: 'designers in Oslo' }).expect(200);
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(1);

    finishes[0]();
    await settle();
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(2);
    expect((agentMatching.recomputeAgent as jest.Mock).mock.calls[1][0]).toMatchObject({ id, wantText: 'designers in Oslo' });

    // A read during the second run starts nothing more.
    await request(app).get('/agents').expect(200);
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(2);
  });
});

describe('GET /agents scores an unscored agent in the background, once at a time', () => {
  it('two reads while the first rescoring is still running start it once; a read after it has finished may start it again', async () => {
    const agent = unscored('agent-1');
    (agentRepo.listAgents as jest.Mock).mockResolvedValue([agent]);
    let finish: () => void = () => {};
    (agentMatching.recomputeAgent as jest.Mock).mockImplementation(() => new Promise<number>((resolve) => { finish = () => resolve(3); }));

    await request(app).get('/agents').expect(200);
    await request(app).get('/agents').expect(200);
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(1);

    finish();
    await settle();
    await settle();
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith(ME);

    await request(app).get('/agents').expect(200);
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(2);
  });

  it('a rescoring that fails is logged and lets the next read start another', async () => {
    const agent = unscored('agent-2');
    (agentRepo.listAgents as jest.Mock).mockResolvedValue([agent]);
    (agentMatching.recomputeAgent as jest.Mock).mockRejectedValueOnce(new Error('scorer down')).mockResolvedValueOnce(1);

    await request(app).get('/agents').expect(200);
    await settle();
    await settle();
    await request(app).get('/agents').expect(200);
    await settle();
    expect(agentMatching.recomputeAgent).toHaveBeenCalledTimes(2);
  });

  it('two different unscored agents are each scored', async () => {
    (agentRepo.listAgents as jest.Mock).mockResolvedValue([unscored('agent-3'), unscored('agent-4')]);
    (agentMatching.recomputeAgent as jest.Mock).mockResolvedValue(2);

    await request(app).get('/agents').expect(200);
    await settle();
    expect((agentMatching.recomputeAgent as jest.Mock).mock.calls.map((c) => c[0].id).sort()).toEqual(['agent-3', 'agent-4']);
  });
});
