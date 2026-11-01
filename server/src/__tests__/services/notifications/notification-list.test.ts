// ─── A member's notifications, a page at a time (30 Oct 2026 review, item 4.5) ───────────────────────────────────────
//
// Stefan: "Add a place to see all notifications in one list (like Facebook)." The bell shows the newest 20 and nothing
// older could be seen anywhere. listNotifications reads them newest first by (created_at, id), each page strictly older
// than the cursor the last page gave (`nextBefore`), so a page never repeats or skips a row however many share a moment.
// The cursor is opaque to the client and carries the full microseconds Postgres keeps (a JavaScript date keeps only
// milliseconds, and a cursor cut to them would skip or repeat rows written in the same millisecond).
//
// The database is a stand-in here; the SQL is run against a real Postgres in notification-list.sql.test.ts.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import {
  NOTIFICATION_BELL_COUNT, NOTIFICATION_PAGE_DEFAULT, NOTIFICATION_PAGE_MAX,
  decodeNotificationCursor, encodeNotificationCursor, listNotifications,
} from '../../../services/notifications/notification-list.service';

const ME = 'a0000000-0000-4000-8000-00000000000a';
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const LIST = /FROM notifications n/;
const listCall = () => mockQuery.mock.calls.find((c) => LIST.test(flat(c[0])))!;

/** n rows, newest first, one second apart, with the cursor columns the query selects. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => {
  const at = new Date(Date.UTC(2026, 9, 31, 12, 0, 0) - i * 1000);
  return {
    id: `0000000${i % 10}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    type: 'platform_match', title: `Row ${i}`, body: null, link: '/', isRead: false, createdAt: at,
    inviteStatus: null, podId: null, sessionId: null, requestStatus: null, requestConversationId: null,
    cursorAt: at.toISOString().replace('Z', '123Z'),
  };
});

function arm(list: Array<Record<string, unknown>>, unread = 7) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (LIST.test(flat(sql))) return { rows: list };
    if (/COUNT\(\*\)/.test(String(sql))) return { rows: [{ count: String(unread) }] };
    return { rows: [] };
  });
}

beforeEach(() => mockQuery.mockReset());

describe('listNotifications', () => {
  it('the sizes: the bell\'s 20, a page of 30, at most 50', () => {
    expect([NOTIFICATION_BELL_COUNT, NOTIFICATION_PAGE_DEFAULT, NOTIFICATION_PAGE_MAX]).toEqual([20, 30, 50]);
  });

  it('reads newest first by (created_at, id), one more row than it returns, to know whether another page follows', async () => {
    arm(rows(31));
    const page = await listNotifications(ME, { before: null, limit: 30 });
    const [sql, params] = listCall();
    expect(flat(sql)).toMatch(/WHERE n\.user_id = \$1 AND \(\$3::timestamptz IS NULL OR \(n\.created_at, n\.id\) < \(\$3::timestamptz, \$4::uuid\)\) ORDER BY n\.created_at DESC, n\.id DESC LIMIT \$5/);
    expect(params).toEqual([ME, expect.any(String), null, null, 31]);
    expect(page.notifications).toHaveLength(30);
    expect(page.notifications.map((n) => n.title)).toEqual(rows(30).map((r) => r.title));
    expect(page.unreadCount).toBe(7);
  });

  it('a full page says where the next starts (its last row), opaque; the last page says null', async () => {
    arm(rows(31));
    const full = await listNotifications(ME, { before: null, limit: 30 });
    expect(full.nextBefore).toBe(encodeNotificationCursor(rows(31)[29].cursorAt, rows(31)[29].id));
    expect(full.nextBefore).not.toContain(rows(31)[29].id);

    arm(rows(12));
    expect((await listNotifications(ME, { before: null, limit: 30 })).nextBefore).toBeNull();
  });

  it('a cursor goes back as the keyset: the time with its microseconds, and the id', async () => {
    arm([]);
    const cursor = encodeNotificationCursor('2026-10-31T12:00:00.123456Z', rows(1)[0].id);
    await listNotifications(ME, { before: decodeNotificationCursor(cursor), limit: 30 });
    expect(listCall()[1]).toEqual([ME, expect.any(String), '2026-10-31T12:00:00.123456Z', rows(1)[0].id, 31]);
  });

  it('selects the cursor time to the microsecond, in UTC, and never sends it to the client', async () => {
    arm(rows(3));
    const page = await listNotifications(ME, { before: null, limit: NOTIFICATION_BELL_COUNT });
    expect(flat(listCall()[0])).toContain(`to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"`);
    for (const n of page.notifications) expect(n).not.toHaveProperty('cursorAt');
    expect(listCall()[1][4]).toBe(21);
  });

  it('a cursor round-trips, and anything else is no cursor', () => {
    const id = rows(1)[0].id;
    expect(decodeNotificationCursor(encodeNotificationCursor('2026-10-31T12:00:00.000001Z', id)))
      .toEqual({ at: '2026-10-31T12:00:00.000001Z', id });
    const forged = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    for (const bad of ['', 'garbage', forged('2026-10-31|x'), forged(`yesterday|${id}`), forged(`2026-10-31T12:00:00Z|${id}'--`), forged(`2026-13-45T99:00:00.000001Z|${id}`)]) {
      expect(decodeNotificationCursor(bad)).toBeNull();
    }
  });
});
