// ─── GET /notifications says where each meeting request stands (25 Oct 2026) ──
//
// On production Claus accepted Stefan's request on the Messages card, opened the bell, and the
// request's entry still offered Accept (walkthrough 2:43:53). The bell held the answer only in
// component memory, and GET /notifications sent no request state for `poke` rows, so every fetch
// brought Accept and Decline back. The request row is the one state now: each `poke` row carries
// `pokeStatus` (the field production's bell already draws: 'accepted' | 'declined' | null) and
// `requestState` ({ status, conversationId }, for the preview), read from user_pokes through the
// request id in the row's link.
//
// There is no database in these tests. The fake one answers the list query by applying the
// pattern the route sends with it ($2) to each row's link, the way `substring(link FROM $2)` does,
// so a wrong pattern or a wrong mapping fails here; the SQL itself is proved against a scratch
// Postgres in the task report.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({ fanoutOwnNotifications: jest.fn().mockResolvedValue(undefined), __esModule: true }));

import notificationRoutes from '../../routes/notifications';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { requestBellLink, REQUEST_BELL_LINK_PATTERN } from '../../services/poke/request-link';

const app = express();
app.use(express.json());
app.use('/notifications', notificationRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const ME = 'u-claus';
const STEFAN = 'u-stefan';
const auth = { Authorization: `Bearer ${jwt.sign({ sub: ME, email: 'c@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` };

const ACCEPTED = 'e8edae35-0000-4000-8000-000000000001';
const DECLINED = 'e8edae35-0000-4000-8000-000000000002';
const PENDING = 'e8edae35-0000-4000-8000-000000000003';
const SOMEONE_ELSES = 'e8edae35-0000-4000-8000-000000000004';

interface Bell {
  id: string; user_id: string; type: string; title: string; body: string | null; link: string | null;
  isRead: boolean; createdAt: string; inviteStatus?: string | null; podId?: string | null; sessionId?: string | null;
}
const bell = (id: string, type: string, link: string | null, extra: Partial<Bell> = {}): Bell => ({
  id, user_id: ME, type, title: `${type} ${id}`, body: null, link, isRead: false, createdAt: '2026-10-25T11:43:07.000Z', ...extra,
});

const requests = [
  { id: ACCEPTED, sender_id: STEFAN, recipient_id: ME, status: 'accepted' },
  { id: DECLINED, sender_id: STEFAN, recipient_id: ME, status: 'declined' },
  { id: PENDING, sender_id: STEFAN, recipient_id: ME, status: 'pending' },
  { id: SOMEONE_ELSES, sender_id: STEFAN, recipient_id: 'u-other', status: 'accepted' },
];
const conversations = [{ id: 'a4e31e41-conv', user_a_id: ME, user_b_id: STEFAN }];

/** Answers the route's queries; the list query is answered the way its LEFT JOINs would be. */
function armDatabase(bells: Bell[]) {
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/SELECT status FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ status: 'active' }] });
    if (/FROM notifications n/.test(sql)) {
      const [userId, pattern] = params as string[];
      const linkPattern = new RegExp(pattern);
      return Promise.resolve({
        rows: bells.filter(b => b.user_id === userId).map(({ user_id: _owner, ...b }) => {
          const id = b.type === 'poke' && b.link ? linkPattern.exec(b.link)?.[1] : undefined;
          const req = requests.find(r => r.id === id?.toLowerCase() && r.recipient_id === userId);
          const conv = req?.status === 'accepted'
            ? conversations.find(c => [c.user_a_id, c.user_b_id].sort().join() === [req.sender_id, req.recipient_id].sort().join())
            : undefined;
          return {
            inviteStatus: null, podId: null, sessionId: null, ...b,
            requestStatus: req?.status ?? null,
            requestConversationId: conv?.id ?? null,
          };
        }),
      });
    }
    if (/COUNT\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ count: String(bells.filter(b => !b.isRead).length) }] });
    return Promise.resolve({ rows: [] });
  });
}

async function fetchBell(bells: Bell[]) {
  armDatabase(bells);
  const res = await request(app).get('/notifications').set(auth);
  expect(res.status).toBe(200);
  return res.body.data.notifications as Array<Record<string, unknown>>;
}

const listQuery = () => mockQuery.mock.calls.find(c => /FROM notifications n/.test(String(c[0])))!;

beforeEach(() => mockQuery.mockReset());

describe('GET /notifications — a meeting request row says where the request stands', () => {
  it('a poke notification with link /messages?poke=<uuid> returns pokeStatus and requestState from user_pokes', async () => {
    const rows = await fetchBell([
      bell('n1', 'poke', requestBellLink(ACCEPTED)),
      bell('n2', 'poke', requestBellLink(DECLINED)),
      bell('n3', 'poke', requestBellLink(PENDING)),
    ]);

    expect(rows.map(r => [r.id, r.pokeStatus, r.requestState])).toEqual([
      ['n1', 'accepted', { status: 'accepted', conversationId: 'a4e31e41-conv' }],
      ['n2', 'declined', { status: 'declined', conversationId: null }],
      // Still waiting for an answer: production's bell draws Accept and Decline when pokeStatus is empty.
      ['n3', null, { status: 'pending', conversationId: null }],
    ]);
    // The raw join columns are the route's business, not the client's.
    for (const r of rows) {
      expect(r).not.toHaveProperty('requestStatus');
      expect(r).not.toHaveProperty('requestConversationId');
    }
  });

  it('an upper-case id in the link finds the same request', async () => {
    const rows = await fetchBell([bell('n1', 'poke', requestBellLink(ACCEPTED.toUpperCase()))]);
    expect(rows[0].pokeStatus).toBe('accepted');
  });

  it('a malformed link returns nulls, and never fails the whole bell', async () => {
    const rows = await fetchBell([
      bell('n1', 'poke', '/messages?poke=not-a-request'),
      bell('n2', 'poke', `/messages?poke=${'-'.repeat(36)}`),
      bell('n3', 'poke', `/messages?poke=${ACCEPTED}&x=1`),
      bell('n4', 'poke', '/messages'),
      bell('n5', 'poke', null),
    ]);

    for (const r of rows) {
      expect(r.pokeStatus).toBeNull();
      expect(r.requestState).toBeNull();
    }
  });

  it('a request sent to somebody else is never reported, even if a link names it', async () => {
    const rows = await fetchBell([bell('n1', 'poke', requestBellLink(SOMEONE_ELSES))]);
    expect(rows[0]).toMatchObject({ pokeStatus: null, requestState: null });
    expect(String(listQuery()[0])).toMatch(/p\.recipient_id = n\.user_id/);
  });

  it('non-poke rows are unchanged: exactly the fields they had, and no request fields at all', async () => {
    const invite = bell('n1', 'event_invite', '/invite/ABC123', { inviteStatus: 'pending', sessionId: 's-9', body: 'Join us' });
    // A link in the request shape on a row that is not a request is not read as one.
    const message = bell('n2', 'direct_message', requestBellLink(ACCEPTED));
    const rows = await fetchBell([invite, message]);

    const { user_id: _invitee, ...inviteFields } = invite;
    const { user_id: _reader, ...messageFields } = message;
    expect(rows[0]).toEqual({ ...inviteFields, podId: null });
    expect(rows[1]).toEqual({ ...messageFields, inviteStatus: null, podId: null, sessionId: null });
  });

  it('still answers with the unread count beside the list', async () => {
    armDatabase([bell('n1', 'poke', requestBellLink(PENDING)), bell('n2', 'poke', requestBellLink(ACCEPTED), { isRead: true })]);
    const res = await request(app).get('/notifications').set(auth);
    expect(res.body.data.unreadCount).toBe(1);
  });
});

describe('the request link format is pinned', () => {
  const PRODUCTION_BELL = /^\/messages\?poke=[0-9a-fA-F-]{36}$/; // NotificationBell's extractPokeId on main

  it('pins the link format ^/messages\\?poke=[0-9a-fA-F-]{36}$ that sendPoke writes and both bells parse', () => {
    const link = requestBellLink(ACCEPTED);
    expect(link).toBe(`/messages?poke=${ACCEPTED}`);
    expect(link).toMatch(PRODUCTION_BELL);
    expect(new RegExp(REQUEST_BELL_LINK_PATTERN).exec(link)?.[1]).toBe(ACCEPTED);
  });

  it('the pattern the route reads ids with only captures a whole UUID, so its cast can never fail', () => {
    const pattern = new RegExp(REQUEST_BELL_LINK_PATTERN);
    for (const bad of [
      `/messages?poke=${'-'.repeat(36)}`,
      `/messages?poke=${'a'.repeat(36)}`,
      `/messages?poke=${ACCEPTED}x`,
      `x/messages?poke=${ACCEPTED}`,
      `/messages?poke=${ACCEPTED.replace(/-/g, '')}`,
    ]) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('the list query joins the request through that pattern, for poke rows only, and the conversation only once accepted', () => {
    armDatabase([]);
    return request(app).get('/notifications').set(auth).then(() => {
      const [sql, params] = listQuery();
      const flat = String(sql).replace(/\s+/g, ' ');
      expect(params).toEqual([ME, REQUEST_BELL_LINK_PATTERN]);
      expect(flat).toMatch(/LEFT JOIN user_pokes p ON n\.type = 'poke'/);
      expect(flat).toMatch(/p\.id = substring\(n\.link FROM \$2::text\)::uuid/);
      expect(flat).toMatch(/p\.status = 'accepted'/);
      expect(flat).toMatch(/LIMIT 20/);
    });
  });
});
