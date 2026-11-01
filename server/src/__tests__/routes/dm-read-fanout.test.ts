// ─── Reading a conversation over REST tells every one of the reader's tabs (1 Nov 2026) ──────────────────────────────
//
// Found by the T6 spec: a member with two tabs read a new message in one, and the other tab went on reading "(1) REASON"
// and showing the Messages badge. Opening a conversation marks it read over the socket (dm:read) when the socket is up,
// and over POST /dm/conversations/:id/read when it is not yet (a page just loaded). The socket path tells both people
// dm-conversation:<id> and each one's user:<id>:dms (the unread counts and the inbox); the REST path told them only the
// conversation's tag, so no other tab's count moved. Both paths now send the same tags.

import express from 'express';
import request from 'supertest';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const THEM = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = 'cccccccc-0000-4000-8000-000000000003';
jest.mock('../../config', () => ({ default: { clientUrl: 'https://app.rsn.network' }, __esModule: true }));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockMarkRead = jest.fn();
jest.mock('../../services/dm/dm.service', () => ({ __esModule: true, markRead: (...a: unknown[]) => mockMarkRead(...a) }));
jest.mock('../../services/orchestration/handlers/dm-handlers', () => ({ __esModule: true, broadcastDmMessage: jest.fn() }));
const mockEmit = jest.fn();
jest.mock('../../realtime/emit', () => ({
  __esModule: true,
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => ({ to: () => ({ emit: () => undefined }) }),
}));
jest.mock('../../db', () => ({
  __esModule: true,
  query: jest.fn().mockResolvedValue({ rows: [{ user_a_id: 'aaaaaaaa-0000-4000-8000-000000000001', user_b_id: 'bbbbbbbb-0000-4000-8000-000000000002' }] }),
  transaction: jest.fn(),
}));

import dmRoutes from '../../routes/dm';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', dmRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  jest.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
});

describe('POST /dm/conversations/:id/read', () => {
  it('a read that marked messages tells both people the conversation and each one\'s Messages counts, as dm:read does', async () => {
    mockMarkRead.mockResolvedValue({ markedCount: 2, readAt: new Date() });
    const res = await request(app).post(`/dm/conversations/${CONV}/read`);
    expect(res.status).toBe(200);
    await settle();
    expect(mockEmit).toHaveBeenCalledWith(expect.anything(), [ME, THEM], [`dm-conversation:${CONV}`, `user:${ME}:dms`, `user:${THEM}:dms`]);
  });

  it('a read with nothing new to mark tells nobody', async () => {
    mockMarkRead.mockResolvedValue({ markedCount: 0, readAt: null });
    await request(app).post(`/dm/conversations/${CONV}/read`);
    await settle();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
