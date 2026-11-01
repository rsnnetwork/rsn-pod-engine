// ─── POST /dm/messages and POST /groups/:id/messages take an optional reply (30 Oct 2026, item 4.3) ───────────────────
//
// Both routes accept `replyToId`, the earlier message the new one answers, and hand it to the service, which checks it
// belongs to the same conversation or group. It is optional: production's client posts { toUserId, content, attachment }
// (origin/main client/src/features/messages/MessagesPage.tsx) and the preview's group composer posts { content }; both
// are answered exactly as before. An id that is not an id is refused with a sentence before the service is reached.

import express from 'express';
import request from 'supertest';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', jwtSecret: 'x', env: 'test', isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
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
  __esModule: true,
}));
const mockSendMessage = jest.fn();
jest.mock('../../services/dm/dm.service', () => ({
  __esModule: true,
  sendMessage: (...a: unknown[]) => mockSendMessage(...a),
}));
const mockBroadcast = jest.fn();
jest.mock('../../services/orchestration/handlers/dm-handlers', () => ({
  __esModule: true,
  broadcastDmMessage: (...a: unknown[]) => mockBroadcast(...a),
}));
const mockSendGroup = jest.fn();
jest.mock('../../services/dm/group.service', () => ({
  __esModule: true,
  sendGroupMessage: (...a: unknown[]) => mockSendGroup(...a),
  pushGroupBells: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  fanoutDmConversation: jest.fn().mockResolvedValue(undefined),
  fanoutGroupEntities: jest.fn().mockResolvedValue(undefined),
  fanoutGroupReadMark: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn(), __esModule: true }));

import dmRoutes from '../../routes/dm';
import groupRoutes from '../../routes/groups';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { AppError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { REPLY_COPY } from '../../services/dm/reply-quote';

const app = express();
app.use(express.json());
app.set('io', { to: () => ({ emit: () => undefined }) });
app.use('/dm', dmRoutes);
app.use('/groups', groupRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const GROUP = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ORIGINAL = '70000000-0000-4000-8000-0000000000aa';
const sentDm = {
  conversationId: 'cccccccc-0000-4000-8000-000000000003',
  message: { id: 'm-1', conversationId: 'cccccccc-0000-4000-8000-000000000003', fromUserId: ME, content: 'hi', readAt: null, createdAt: '2026-11-01T10:00:00.000Z', replyTo: null },
};
const sentGroup = {
  message: { id: 'g-1', groupId: GROUP, fromUserId: ME, senderName: 'Ana', senderAvatarUrl: null, content: 'hi all', createdAt: '2026-11-01T10:00:00.000Z', replyTo: null },
  bells: { title: 't', body: 'b', link: `/messages/g/${GROUP}`, rows: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMessage.mockResolvedValue(sentDm);
  mockBroadcast.mockResolvedValue(undefined);
  mockSendGroup.mockResolvedValue(sentGroup);
});

describe('POST /dm/messages', () => {
  it('production\'s body { toUserId, content, attachment } is answered as before: 201, the message, and the live fan-out', async () => {
    const res = await request(app).post('/dm/messages').send({ toUserId: BEN, content: 'hi', attachment: null });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: sentDm });
    expect(mockSendMessage).toHaveBeenCalledWith(ME, BEN, 'hi', null, null);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.anything(), ME, BEN, sentDm.conversationId, sentDm.message);
  });

  it('passes the message it answers on, lower-cased', async () => {
    const res = await request(app).post('/dm/messages').send({ toUserId: BEN, content: 'yes', replyToId: ORIGINAL.toUpperCase() });
    expect(res.status).toBe(201);
    expect(mockSendMessage).toHaveBeenCalledWith(ME, BEN, 'yes', null, ORIGINAL);
  });

  it('a reply to something that is not a message id is refused with a sentence, and nothing is sent', async () => {
    const res = await request(app).post('/dm/messages').send({ toUserId: BEN, content: 'yes', replyToId: 'nope' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toContain('That message cannot be replied to.');
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('the service\'s refusal of a reply to another conversation reaches the member word for word, and nothing goes out', async () => {
    mockSendMessage.mockRejectedValueOnce(new AppError(400, ErrorCodes.VALIDATION_ERROR, REPLY_COPY.notInConversation));
    const res = await request(app).post('/dm/messages').send({ toUserId: BEN, content: 'yes', replyToId: ORIGINAL });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('You can only reply to a message in this conversation.');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('POST /groups/:id/messages', () => {
  it('the body { content } is answered as before', async () => {
    const res = await request(app).post(`/groups/${GROUP}/messages`).send({ content: 'hi all' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ messageId: 'g-1', createdAt: '2026-11-01T10:00:00.000Z', message: sentGroup.message });
    expect(mockSendGroup).toHaveBeenCalledWith(GROUP, ME, 'hi all', null);
  });

  it('passes the message it answers on, lower-cased', async () => {
    await request(app).post(`/groups/${GROUP}/messages`).send({ content: 'agreed', replyToId: ORIGINAL.toUpperCase() });
    expect(mockSendGroup).toHaveBeenCalledWith(GROUP, ME, 'agreed', ORIGINAL);
  });

  it('a reply to something that is not a message id is refused with a sentence', async () => {
    const res = await request(app).post(`/groups/${GROUP}/messages`).send({ content: 'agreed', replyToId: '123' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toContain('That message cannot be replied to.');
    expect(mockSendGroup).not.toHaveBeenCalled();
  });
});
