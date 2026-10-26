// ─── Every /api/dm route checks the id in its path (26 Oct 2026, task H2a) ────
//
// PUT /api/dm/conversations/undefined/scheduling/availability answered 500 INTERNAL_ERROR: the id went
// to Postgres, which cannot read "undefined" as a uuid. Found by the R9d reminder smoke, whose script
// sent the word. Every route on the /api/dm mount (routes/dm.ts and routes/meeting.ts) now checks its
// ids first and answers 400 with a sentence a member understands, which production's client shows as
// its toast (or on the call screen) and the preview reads from the details. The service is never
// reached. A well-formed id in capitals is the same row to Postgres, so it is let through, lower-cased,
// so the tags a service sends match the ones each screen listens for.
//
// These go through express with the real routers; only sign-in and the services are stand-ins.

import express from 'express';
import request from 'supertest';

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

const mockServices: Record<string, jest.Mock> = {};
const stand = (name: string, value: unknown) => {
  mockServices[name] = jest.fn().mockResolvedValue(value);
  return (...a: unknown[]) => mockServices[name](...a);
};
jest.mock('../../services/dm/dm.service', () => ({
  __esModule: true,
  listConversations: stand('listConversations', { conversations: [], total: 0 }),
  listMessages: stand('listMessages', { messages: [], total: 0 }),
  markRead: stand('markRead', { markedCount: 0, readAt: null }),
  deleteConversation: stand('deleteConversation', undefined),
  canMessage: stand('canMessage', { allowed: true }),
  getUnreadCount: stand('getUnreadCount', 0),
  sendMessage: stand('sendMessage', { conversationId: 'c', message: {} }),
  addReaction: stand('addReaction', { conversationId: 'c', otherUserId: 'o' }),
  removeReaction: stand('removeReaction', { conversationId: 'c', otherUserId: 'o' }),
}));
jest.mock('../../services/dm/meeting-windows.service', () => ({
  __esModule: true,
  getScheduling: stand('getScheduling', { conversationId: 'c', partnerId: 'p', confirmed: null }),
  setAvailability: stand('setAvailability', { conversationId: 'c', confirmed: null }),
  confirmWindow: stand('confirmWindow', { conversationId: 'c', confirmed: null }),
  markSchedulerSeen: stand('markSchedulerSeen', undefined),
}));
jest.mock('../../services/dm/meeting-call.service', () => ({
  __esModule: true,
  getCallToken: stand('getCallToken', { token: 't' }),
  requestCall: stand('requestCall', { id: 'rq' }),
  getPendingCallRequest: stand('getPendingCallRequest', null),
  acceptCallRequest: stand('acceptCallRequest', { token: 't' }),
  declineCallRequest: stand('declineCallRequest', undefined),
  cancelCallRequest: stand('cancelCallRequest', undefined),
  isPartnerOnline: stand('isPartnerOnline', false),
}));
jest.mock('../../services/presence/presence.service', () => ({ __esModule: true, areActive: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/orchestration/handlers/dm-handlers', () => ({ __esModule: true, broadcastDmMessage: jest.fn() }));
jest.mock('../../realtime/fanout', () => ({ __esModule: true, fanoutDmConversation: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn(), __esModule: true }));

import dmRoutes from '../../routes/dm';
import meetingRoutes from '../../routes/meeting';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', dmRoutes);
app.use('/dm', meetingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const ID = 'cccccccc-0000-4000-8000-0000000000aa';
const SLOT = '2026-11-02T12:00:00Z';
type Method = 'get' | 'post' | 'put' | 'delete';

const CONVERSATION = "We couldn't find that conversation.";
const CALL_REQUEST = "We couldn't find that call request.";
const MESSAGE = "We couldn't find that message.";
const MEMBER = "We couldn't find that member.";

/** Every /api/dm route with an id in its path: how to call it, what it says to a bad id, and its service. */
const routes: Array<{ method: Method; path: (id: string) => string; body?: object; says: string; service: string }> = [
  { method: 'get', path: (id) => `/dm/conversations/${id}/messages`, says: CONVERSATION, service: 'listMessages' },
  { method: 'post', path: (id) => `/dm/conversations/${id}/read`, says: CONVERSATION, service: 'markRead' },
  { method: 'delete', path: (id) => `/dm/conversations/${id}`, says: CONVERSATION, service: 'deleteConversation' },
  { method: 'get', path: (id) => `/dm/conversations/${id}/meeting.ics`, says: CONVERSATION, service: 'getScheduling' },
  { method: 'get', path: (id) => `/dm/conversations/${id}/scheduling`, says: CONVERSATION, service: 'getScheduling' },
  { method: 'put', path: (id) => `/dm/conversations/${id}/scheduling/availability`, body: { windows: [SLOT] }, says: CONVERSATION, service: 'setAvailability' },
  { method: 'post', path: (id) => `/dm/conversations/${id}/scheduling/confirm`, body: { window: SLOT }, says: CONVERSATION, service: 'confirmWindow' },
  { method: 'post', path: (id) => `/dm/conversations/${id}/scheduling/seen`, says: CONVERSATION, service: 'markSchedulerSeen' },
  { method: 'post', path: (id) => `/dm/conversations/${id}/call-token`, body: { kind: 'video' }, says: CONVERSATION, service: 'getCallToken' },
  { method: 'post', path: (id) => `/dm/conversations/${id}/call/request`, body: { kind: 'video', durationMin: 15 }, says: CONVERSATION, service: 'requestCall' },
  { method: 'get', path: (id) => `/dm/conversations/${id}/call/pending`, says: CONVERSATION, service: 'getPendingCallRequest' },
  { method: 'get', path: (id) => `/dm/conversations/${id}/partner-presence`, says: CONVERSATION, service: 'isPartnerOnline' },
  { method: 'post', path: (id) => `/dm/call/requests/${id}/accept`, says: CALL_REQUEST, service: 'acceptCallRequest' },
  { method: 'post', path: (id) => `/dm/call/requests/${id}/decline`, says: CALL_REQUEST, service: 'declineCallRequest' },
  { method: 'post', path: (id) => `/dm/call/requests/${id}/cancel`, says: CALL_REQUEST, service: 'cancelCallRequest' },
  { method: 'post', path: (id) => `/dm/messages/${id}/reactions`, body: { emoji: 'heart' }, says: MESSAGE, service: 'addReaction' },
  { method: 'delete', path: (id) => `/dm/messages/${id}/reactions/heart`, says: MESSAGE, service: 'removeReaction' },
  { method: 'get', path: (id) => `/dm/can-message/${id}`, says: MEMBER, service: 'canMessage' },
];

function send(route: (typeof routes)[number], id: string) {
  const r = request(app)[route.method](route.path(id));
  return route.body ? r.send(route.body) : r;
}

beforeEach(() => {
  for (const service of Object.values(mockServices)) service.mockClear();
});

describe('an id that is not an id is refused with a sentence, never a 500', () => {
  describe.each(routes.map((r) => [`${r.method.toUpperCase()} ${r.path(':id')}`, r] as const))('%s', (_label, route) => {
    it.each(['undefined', 'not-a-uuid', '12345', `${ID}x`])('refuses %s with 400 and the service is never reached', async (bad) => {
      const res = await send(route, bad);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      // Production's client toasts error.message; the preview reads the first detail. Both read as a sentence.
      expect(res.body.error.message).toBe(route.says);
      expect(Object.values(res.body.error.details as Record<string, string[]>)[0]).toEqual([route.says]);
      expect(mockServices[route.service]).not.toHaveBeenCalled();
    });

    it('lets a well-formed id through, lower-cased', async () => {
      const res = await send(route, ID.toUpperCase());

      // Past the check (the .ics route then answers 404 itself, as no meeting is confirmed here).
      expect(res.status).not.toBe(400);
      expect(res.status).toBeLessThan(500);
      expect(mockServices[route.service]).toHaveBeenCalled();
      expect(mockServices[route.service].mock.calls[0]).toContain(ID);
    });
  });
});

describe('the paths with a second part keep it', () => {
  it('a reaction is removed by the emoji in its path', async () => {
    await request(app).delete(`/dm/messages/${ID}/reactions/heart`);
    expect(mockServices.removeReaction).toHaveBeenCalledWith(ID, 'aaaaaaaa-0000-4000-8000-000000000001', 'heart');
  });

  // H2a review: an emoji too long to be a reaction was refused as "We couldn't find that message."
  it('a reaction too long to be one has a sentence of its own; a bad message id is still said first', async () => {
    const long = 'x'.repeat(17);

    const res = await request(app).delete(`/dm/messages/${ID}/reactions/${long}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("That reaction isn't available.");
    expect(res.body.error.details).toEqual({ emoji: ["That reaction isn't available."] });
    expect(mockServices.removeReaction).not.toHaveBeenCalled();

    const both = await request(app).delete(`/dm/messages/undefined/reactions/${long}`);
    expect(both.body.error.message).toBe(MESSAGE);
  });
});

describe('one set of checks for the whole mount', () => {
  // H2a review: the id check and its sentences were written twice, once in each router.
  it('neither router writes its own id check or refusal: both take them from middleware/dm-path-ids.ts', () => {
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');
    for (const file of ['dm.ts', 'meeting.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../routes', file), 'utf8');
      expect(src).toMatch(/from '\.\.\/middleware\/dm-path-ids'/);
      expect(src).not.toMatch(/We couldn't find that/);
      // A path is checked only by the shared checks (a body's own fields are the router's business).
      expect(src).not.toMatch(/'params'/);
    }
  });
});
