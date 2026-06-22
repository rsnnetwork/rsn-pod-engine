// TRF-1 (audit C3) — the REST /state snapshot must carry the canonical doc's
// monotonic `seq` so the client can drop a stale REST response that would
// otherwise regress the roster applied by the newer seq-guarded socket rail.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));

// TRF-1 — the snapshot reads the canonical doc's seq. Mock it (the db /
// session.service mocks above are the pattern; this file uses the REAL
// activeSessions Map, so canonical-state must be jest.mock'd explicitly).
const mockReadCanonical = jest.fn();
jest.mock('../../../services/orchestration/state/canonical-state', () => ({
  readCanonical: (...args: unknown[]) => mockReadCanonical(...args),
  __esModule: true,
}));

import { activeSessions } from '../../../services/orchestration/state/session-state';
import { buildSessionStateSnapshot } from '../../../services/session/session-state-snapshot.service';

const SESSION_ID = '00000000-0000-0000-0000-000000000abc';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID, podId: 'pod-1', title: 'Test Session', status: 'lobby_open',
    currentRound: 0, hostUserId: 'host-1',
    config: { numberOfRounds: 5, timerVisibility: 'last_10s' },
    ...overrides,
  };
}

function primeQueries() {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                 // cohosts
  mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'u-1' }], rowCount: 1 }); // registered
}

describe('TRF-1 — buildSessionStateSnapshot carries canonical seq', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessions.clear();
    mockGetSessionById.mockResolvedValue(makeSession());
  });

  it('includes seq from the canonical doc when present', async () => {
    primeQueries();
    mockReadCanonical.mockResolvedValue({ seq: 42 });
    const snap = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snap).not.toBeNull();
    expect((snap as any).seq).toBe(42);
  });

  it('seq is null when the canonical doc is absent (scheduled/completed sessions)', async () => {
    primeQueries();
    mockReadCanonical.mockResolvedValue(null);
    const snap = await buildSessionStateSnapshot(SESSION_ID, null);
    expect((snap as any).seq).toBeNull();
  });

  it('seq falls back to null (never throws) when the canonical read rejects', async () => {
    primeQueries();
    mockReadCanonical.mockRejectedValue(new Error('redis down'));
    const snap = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snap).not.toBeNull();
    expect((snap as any).seq).toBeNull();
  });
});
