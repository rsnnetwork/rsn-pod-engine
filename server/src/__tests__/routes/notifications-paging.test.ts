// ─── GET /notifications pages, and production's bell reads it exactly as before (30 Oct 2026, item 4.5) ──────────────
//
// Production's bell (origin/main client/src/components/ui/NotificationBell.tsx) calls GET /notifications with no query
// string, reads `notifications` and `unreadCount`, and marks rows read with POST /notifications/:id/read and
// POST /notifications/read-all. All of that is unchanged: the newest 20, the same fields on every row, the same read
// marks. The notifications page adds ?before=<cursor>&limit=<1..50> (30 when it asks for none) and reads `nextBefore`.
// A cursor this server did not write, or a limit out of range, is refused with a sentence before the database is read.

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
jest.mock('../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({ fanoutOwnNotifications: (...a: unknown[]) => mockFanout(...a), __esModule: true }));

import notificationRoutes from '../../routes/notifications';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { encodeNotificationCursor } from '../../services/notifications/notification-list.service';

const app = express();
app.use(express.json());
app.use('/notifications', notificationRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const ME = 'a0000000-0000-4000-8000-00000000000a';
const auth = (sub = ME) => ({ Authorization: `Bearer ${jwt.sign({ sub, email: 'm@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });

/** n stored notifications, newest first, the columns the list query selects (before the route's mapping). */
const stored = (n: number) => Array.from({ length: n }, (_, i) => {
  const at = new Date(Date.UTC(2026, 9, 31, 12, 0, 0) - i * 60_000);
  return {
    id: `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, type: 'direct_message', title: `Ana sent you a message ${i}`,
    body: 'Hi', link: '/messages/c-1', isRead: i > 3, createdAt: at.toISOString(),
    inviteStatus: null, podId: null, sessionId: null, requestStatus: null, requestConversationId: null,
    cursorAt: at.toISOString().replace('Z', '000Z'),
  };
});

/** Answers the list query with the stored rows its params ask for (keyset + LIMIT), and the counts. */
function arm(all: ReturnType<typeof stored>) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/SELECT status FROM users WHERE id/.test(sql)) return { rows: [{ status: 'active' }] };
    if (/FROM notifications n/.test(sql)) {
      const [, , beforeAt, beforeId, limit] = params as [string, string, string | null, string | null, number];
      const older = all.filter((r) => !beforeAt || r.cursorAt < beforeAt || (r.cursorAt === beforeAt && r.id < (beforeId as string)));
      return { rows: older.slice(0, limit) };
    }
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: String(all.filter((r) => !r.isRead).length) }] };
    return { rows: [], rowCount: 1 };
  });
}

const listParams = () => mockQuery.mock.calls.find((c) => /FROM notifications n/.test(String(c[0])))![1];

beforeEach(() => { mockQuery.mockReset(); mockFanout.mockClear(); });

describe('production\'s bell: GET /notifications with no query string', () => {
  it('answers the newest 20 with the fields it always had, and the unread count', async () => {
    arm(stored(45));
    const res = await request(app).get('/notifications').set(auth());
    expect(res.status).toBe(200);
    const { notifications, unreadCount } = res.body.data;
    expect(notifications).toHaveLength(20);
    expect(notifications.map((n: { id: string }) => n.id)).toEqual(stored(20).map((r) => r.id));
    expect(Object.keys(notifications[0]).sort()).toEqual(['body', 'createdAt', 'id', 'inviteStatus', 'isRead', 'link', 'podId', 'sessionId', 'title', 'type']);
    expect(unreadCount).toBe(4);
    expect(listParams()[4]).toBe(21);
  });

  it('a query string the bell may carry for other reasons (a cache-buster) changes nothing', async () => {
    arm(stored(45));
    const res = await request(app).get('/notifications?_=1730000000').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.notifications).toHaveLength(20);
  });

  it('mark one read and mark all read are unchanged, and tell the member\'s other tabs', async () => {
    arm([]);
    const one = await request(app).post(`/notifications/${stored(1)[0].id}/read`).set(auth());
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ success: true });
    expect(mockQuery.mock.calls.some((c) => /UPDATE notifications SET is_read = TRUE WHERE id = \$1 AND user_id = \$2/.test(String(c[0])))).toBe(true);
    const all = await request(app).post('/notifications/read-all').set(auth());
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ success: true });
    expect(mockQuery.mock.calls.some((c) => /UPDATE notifications SET is_read = TRUE WHERE user_id = \$1 AND is_read = FALSE/.test(String(c[0])))).toBe(true);
    expect(mockFanout).toHaveBeenCalledTimes(2);
  });
});

describe('the notifications page: ?before= and ?limit=', () => {
  it('pages through 75 rows thirty at a time, in order, never repeating or skipping one', async () => {
    const all = stored(75);
    arm(all);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await request(app).get('/notifications').query(before ? { before, limit: 30 } : { limit: 30 }).set(auth());
      expect(res.status).toBe(200);
      seen.push(...res.body.data.notifications.map((n: { id: string }) => n.id));
      before = res.body.data.nextBefore;
      pages += 1;
    } while (before && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it('a page asks for 30 unless it says otherwise, and never more than 50', async () => {
    arm(stored(5));
    await request(app).get(`/notifications?before=${encodeNotificationCursor('2026-10-31T12:00:00.000000Z', stored(1)[0].id)}`).set(auth());
    expect(listParams()[4]).toBe(31);
    mockQuery.mockClear();
    await request(app).get('/notifications?limit=50').set(auth());
    expect(listParams()[4]).toBe(51);
  });

  it.each([
    ['a limit over 50', '?limit=51'],
    ['a limit of 0', '?limit=0'],
    ['a limit that is not a number', '?limit=lots'],
    ['a cursor this server did not write', '?before=not-a-cursor'],
    ['a cursor carrying SQL', `?before=${Buffer.from("2026-10-31T12:00:00.000000Z|x' OR 1=1--").toString('base64url')}`],
  ])('refuses %s with a sentence, before reading anything', async (_what, qs) => {
    arm(stored(5));
    const res = await request(app).get(`/notifications${qs}`).set(auth());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('We could not read that page of notifications.');
    expect(mockQuery.mock.calls.some((c) => /FROM notifications n/.test(String(c[0])))).toBe(false);
  });
});
