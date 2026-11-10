// ─── An overdue close sends no recap; every other completion still does (10 Nov 2026, F7 fix round 1) ──────────
//
// Controller ruling: an event the overdue job closes (it sat live for days or weeks) is not a natural end, so its
// people get no recap email weeks late. completeSession takes `{ reason: 'overdue', sendRecap: false }` from that one
// caller; everything else about the completion (the claim, the room and match close, the sweep, the completed
// fan-out, clients told) is the same, and every other caller (End Event, the natural end, the reaper) passes nothing
// and still sends the recap of a rating format. It also says whether it ended the event, so the job counts only what
// it closed.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
const mockUpdateStatus = jest.fn(async () => ({}));
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: (...a: unknown[]) => (mockUpdateStatus as jest.Mock)(...a),
  __esModule: true,
}));
jest.mock('../../../services/video/video.service', () => ({
  closeLobbyRoom: jest.fn(async () => {}),
  closeMatchRoom: jest.fn(async () => {}),
  __esModule: true,
}));
jest.mock('../../../services/rating/rating.service', () => ({
  finalizeSessionEncounters: jest.fn(async () => {}),
  __esModule: true,
}));
const mockBulkEmail = jest.fn(async () => {});
jest.mock('../../../services/email/email.service', () => ({
  asBulkEmail: (...a: unknown[]) => (mockBulkEmail as jest.Mock)(...a),
  __esModule: true,
}));
const mockFanoutCompleted = jest.fn(async () => {});
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionCompleted: (...a: unknown[]) => (mockFanoutCompleted as jest.Mock)(...a),
  __esModule: true,
}));

import type { Server as SocketServer } from 'socket.io';
import { completeSession } from '../../../services/orchestration/handlers/round-lifecycle';

const EVENT = '5c8b3075-5be9-48a2-92fe-e8a290b0b06a';
const emitted: Array<[string, string]> = [];
const io = { to: (room: string) => ({ emit: (event: string) => { emitted.push([room, event]); } }) } as unknown as SocketServer;

let claimable = true;
let format = 'speed_networking';

beforeEach(() => {
  jest.clearAllMocks();
  emitted.length = 0;
  claimable = true;
  format = 'speed_networking';
  mockQuery.mockImplementation(async (sql: string) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (flat.startsWith("UPDATE sessions SET status = 'completed', ended_at = NOW()")) {
      return { rows: claimable ? [{ id: EVENT, event_format: format }] : [] };
    }
    return { rows: [] };
  });
});

/** The recap goes out fire-and-forget; let it start. */
const settle = () => new Promise((r) => setImmediate(r));

describe('completeSession and the recap email', () => {
  it('an ordinary end of a rating event sends the recap, and says it ended the event', async () => {
    await expect(completeSession(io, EVENT)).resolves.toBe(true);
    await settle();
    expect(mockBulkEmail).toHaveBeenCalledTimes(1);
    expect(mockFanoutCompleted).toHaveBeenCalledWith(EVENT);
  });

  it('an overdue close of the same event sends no recap, and everything else still happens', async () => {
    await expect(completeSession(io, EVENT, { reason: 'overdue', sendRecap: false })).resolves.toBe(true);
    await settle();
    expect(mockBulkEmail).not.toHaveBeenCalled();
    // The rest of the completion: status written, matches closed, participants swept, clients told, fan-out run.
    expect(mockUpdateStatus).toHaveBeenCalledWith(EVENT, 'completed');
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());
    expect(sqls.some((q) => q.startsWith("UPDATE matches SET status = 'completed'"))).toBe(true);
    expect(sqls.some((q) => q.startsWith("UPDATE session_participants SET status = 'left'"))).toBe(true);
    expect(emitted.map(([, event]) => event)).toEqual(expect.arrayContaining(['session:completed', 'session:status_changed']));
    expect(mockFanoutCompleted).toHaveBeenCalledWith(EVENT);
  });

  it('an event already over is left alone and reported as not ended by this call', async () => {
    claimable = false;
    await expect(completeSession(io, EVENT, { reason: 'overdue', sendRecap: false })).resolves.toBe(false);
    expect(mockFanoutCompleted).not.toHaveBeenCalled();
    expect(mockBulkEmail).not.toHaveBeenCalled();
  });
});
