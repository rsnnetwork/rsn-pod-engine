// A burst of "rescore this member's searches" requests (Undo on Already met) costs at most two runs, never one each.

const mockListAgents = jest.fn<any, any[]>();
const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/matching/agent.repo', () => ({
  listAgents: (...a: unknown[]) => mockListAgents(...a),
  replaceMatches: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import { rescoreAgentsCoalesced } from '../../../services/matching/agent-matching.service';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  mockListAgents.mockReset();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('rescoreAgentsCoalesced', () => {
  it('runs once for one request', async () => {
    mockListAgents.mockResolvedValue([]);
    await rescoreAgentsCoalesced('u-a');
    expect(mockListAgents).toHaveBeenCalledTimes(1);
  });

  it('a burst while one is running costs one more run, not one each', async () => {
    let release!: () => void;
    mockListAgents.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    mockListAgents.mockResolvedValue([]);
    const first = rescoreAgentsCoalesced('u-a');
    await tick();
    const burst = [rescoreAgentsCoalesced('u-a'), rescoreAgentsCoalesced('u-a'), rescoreAgentsCoalesced('u-a'), rescoreAgentsCoalesced('u-a')];
    expect(mockListAgents).toHaveBeenCalledTimes(1); // nothing new started while the first runs
    release();
    await Promise.all([first, ...burst]);
    expect(mockListAgents).toHaveBeenCalledTimes(2); // the first run and one rerun that covers the whole burst
  });

  it('different members do not wait for each other', async () => {
    let release!: () => void;
    mockListAgents.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    mockListAgents.mockResolvedValue([]);
    const a = rescoreAgentsCoalesced('u-a');
    await tick();
    await rescoreAgentsCoalesced('u-b');
    expect(mockListAgents).toHaveBeenCalledTimes(2);
    release();
    await a;
  });

  it('after a run ends the next request starts a fresh one', async () => {
    mockListAgents.mockResolvedValue([]);
    await rescoreAgentsCoalesced('u-a');
    await rescoreAgentsCoalesced('u-a');
    expect(mockListAgents).toHaveBeenCalledTimes(2);
  });
});
