// ─── Quoted replies and the notifications page, on a real Postgres (30 Oct 2026, items 4.3 and 4.5) ──────────────────
//
// The other tests of these two features answer the SQL with stand-ins; this one runs the services unchanged against a
// real database, inside one transaction that is rolled back at the end, so no row of the database is left behind. Its
// own members, conversation, group, messages and notifications are made inside that transaction.
//
//   - A one-to-one reply is kept with its original and read back quoted; a reply to a message of another conversation
//     is refused and nothing is kept; a message from before migration 121 reads replyTo null; an original whose writer's
//     account is closed is quoted under "Former member"; when an original is deleted the reply stays (ON DELETE SET
//     NULL) and is drawn without a quote.
//   - In a group, an original from someone blocked with the reader, or from before the reader joined, is hidden from
//     that reader only; a reply to a message the writer may not see is refused.
//   - 75 notifications, a dozen of them written in the very same microsecond, page thirty at a time in order with no row
//     repeated or skipped, and the bell's read (no cursor) is the newest 20.
//
// Opt-in, because it needs a Postgres with migrations 121 and 122 applied (a local one: it refuses anything else);
// without one it is skipped:
//
//   T6_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/dm/message-replies.sql.test.ts

import { randomUUID } from 'crypto';
import { Client } from 'pg';

const url = process.env.T6_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

let mockClient: Client | null = null;
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (sql: string, params?: unknown[]) => mockClient!.query(sql, params),
  transaction: async (cb: (c: unknown) => Promise<unknown>) => {
    const savepoint = `sp_${Math.random().toString(36).slice(2)}`;
    await mockClient!.query(`SAVEPOINT ${savepoint}`);
    try {
      const out = await cb(mockClient);
      await mockClient!.query(`RELEASE SAVEPOINT ${savepoint}`);
      return out;
    } catch (err) {
      await mockClient!.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw err;
    }
  },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../realtime/emit', () => ({ __esModule: true, emitEntities: jest.fn(), getRealtimeIo: () => null, setRealtimeIo: jest.fn() }));

import { listMessages, sendMessage } from '../../../services/dm/dm.service';
import { listGroupMessages, sendGroupMessage } from '../../../services/dm/group.service';
import { decodeNotificationCursor, listNotifications } from '../../../services/notifications/notification-list.service';
import { REPLY_COPY } from '../../../services/dm/reply-quote';

suite('quoted replies and the notifications page (real Postgres, one rolled-back transaction)', () => {
  const tag = Date.now().toString(36);
  const ids = { admin: randomUUID(), ana: randomUUID(), ben: randomUUID(), cleo: randomUUID(), dev: randomUUID(), gone: randomUUID() };
  const db = () => mockClient!;
  const sql = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows;

  beforeAll(async () => {
    if (!/@127\.0\.0\.1:54329\//.test(url!)) throw new Error('Refusing: T6_SQL_TEST_DB must be the local scratch database');
    mockClient = new Client({ connectionString: url });
    await mockClient.connect();
    await sql('BEGIN');
    const column = await sql(`SELECT 1 FROM information_schema.columns WHERE table_name = 'direct_messages' AND column_name = 'reply_to_id'`);
    if (column.length === 0) throw new Error('Migration 121 is not applied on this database');
    for (const [name, id] of Object.entries(ids)) {
      await sql(
        `INSERT INTO users (id, email, display_name, first_name, last_name, role, status)
         VALUES ($1, $2, $3, $3, 'T6', $4, $5)`,
        [id, `t6sql-${name}-${tag}@rsn-e2e.invalid`, name[0].toUpperCase() + name.slice(1), name === 'admin' ? 'admin' : 'member', name === 'gone' ? 'deactivated' : 'active'],
      );
    }
  });

  afterAll(async () => {
    if (!mockClient) return;
    await sql('ROLLBACK');
    await mockClient.end();
  });

  describe('one-to-one', () => {
    it('a reply is kept with its original and read back quoted; a message from before replies reads replyTo null', async () => {
      const first = await sendMessage(ids.admin, ids.ana, 'Shall we meet on Tuesday?');
      expect(first.message.replyTo).toBeNull();
      const reply = await sendMessage(ids.admin, ids.ana, 'Or Wednesday', null, first.message.id);
      expect(reply.message.replyTo).toEqual({ id: first.message.id, senderName: 'Admin', content: 'Shall we meet on Tuesday?', kind: 'user', deleted: false });

      const { messages } = await listMessages(first.conversationId, ids.ana);
      const byId = new Map(messages.map((m) => [m.id, m]));
      expect(byId.get(first.message.id)!.replyTo).toBeNull();
      expect(byId.get(reply.message.id)!.replyTo).toEqual(reply.message.replyTo);
    });

    it('a reply to a message of another conversation is refused, and nothing is kept', async () => {
      const elsewhere = await sendMessage(ids.admin, ids.ben, 'Hello Ben');
      const before = await sql(`SELECT COUNT(*)::int AS n FROM direct_messages WHERE from_user_id = $1`, [ids.admin]);
      await expect(sendMessage(ids.admin, ids.ana, 'Sneaky', null, elsewhere.message.id)).rejects.toMatchObject({
        statusCode: 400, message: REPLY_COPY.notInConversation,
      });
      await expect(sendMessage(ids.admin, ids.ana, 'Nothing', null, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
      const after = await sql(`SELECT COUNT(*)::int AS n FROM direct_messages WHERE from_user_id = $1`, [ids.admin]);
      expect(after[0].n).toBe(before[0].n);
    });

    it('an original whose writer\'s account is closed is quoted under "Former member"', async () => {
      const conv = (await sendMessage(ids.admin, ids.gone, 'Are you still there?')).conversationId;
      const [theirs] = await sql(
        `INSERT INTO direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, 'I am leaving') RETURNING id`,
        [conv, ids.gone],
      );
      const reply = await sendMessage(ids.admin, ids.gone, 'Sorry to hear it', null, theirs.id);
      expect(reply.message.replyTo).toMatchObject({ senderName: 'Former member', content: 'I am leaving' });
      const { messages } = await listMessages(conv, ids.admin);
      expect(messages.find((m) => m.id === reply.message.id)!.replyTo).toMatchObject({ senderName: 'Former member' });
    });

    it('when an original is deleted the reply stays, unquoted (ON DELETE SET NULL)', async () => {
      const first = await sendMessage(ids.admin, ids.cleo, 'Delete me');
      const reply = await sendMessage(ids.admin, ids.cleo, 'Answering it', null, first.message.id);
      await sql(`DELETE FROM direct_messages WHERE id = $1`, [first.message.id]);
      const { messages } = await listMessages(first.conversationId, ids.cleo);
      expect(messages.map((m) => m.id)).toEqual([reply.message.id]);
      expect(messages[0].replyTo).toBeNull();
    });
  });

  describe('groups', () => {
    it('hides an original from a reader blocked with its writer or who joined after it, and refuses a reply the writer may not see', async () => {
      const [g] = await sql(`INSERT INTO dm_groups (name, type, created_by) VALUES ('T6 group', 'custom', $1) RETURNING id`, [ids.ana]);
      const joined = async (user: string, at: string) => sql(
        `INSERT INTO dm_group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`,
        [g.id, user, user === ids.ana ? 'admin' : 'member', at],
      );
      await joined(ids.ana, '2026-10-01T10:00:00Z');
      await joined(ids.ben, '2026-10-01T10:00:00Z');
      await joined(ids.cleo, '2026-10-01T10:00:00Z');
      const [original] = await sql(
        `INSERT INTO direct_messages (group_id, from_user_id, content, created_at) VALUES ($1, $2, 'Ben here', '2026-10-02T10:00:00Z') RETURNING id`,
        [g.id, ids.ben],
      );
      await joined(ids.dev, '2026-10-03T10:00:00Z');
      await sql(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [ids.cleo, ids.ben]);

      const reply = await sendGroupMessage(g.id, ids.ana, 'Hi Ben', original.id);
      expect(reply.message.replyTo).toMatchObject({ id: original.id, senderName: 'Ben', content: 'Ben here', deleted: false });

      const quoteFor = async (reader: string) =>
        (await listGroupMessages(g.id, reader, {})).messages.find((m) => m.id === reply.message.id)!.replyTo;
      expect(await quoteFor(ids.ben)).toMatchObject({ senderName: 'Ben', content: 'Ben here' });
      expect(await quoteFor(ids.cleo)).toEqual({ id: original.id, senderName: '', content: '', kind: 'user', deleted: false, hidden: true });
      expect(await quoteFor(ids.dev)).toEqual({ id: original.id, senderName: '', content: '', kind: 'user', deleted: false, hidden: true });

      await expect(sendGroupMessage(g.id, ids.cleo, 'Replying across a block', original.id)).rejects.toMatchObject({ statusCode: 400, message: REPLY_COPY.notInGroup });
      await expect(sendGroupMessage(g.id, ids.dev, 'Replying to before I joined', original.id)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('notifications', () => {
    it('75 rows, a dozen in the same microsecond, page thirty at a time in order with none repeated or skipped', async () => {
      await sql(
        `INSERT INTO notifications (user_id, type, title, created_at)
         SELECT $1, 'platform_match', 'Row ' || g, CASE WHEN g <= 12 THEN TIMESTAMPTZ '2026-10-31 12:00:00.123456+00'
                                                       ELSE TIMESTAMPTZ '2026-10-31 12:00:00+00' - (g || ' seconds')::interval END
           FROM generate_series(1, 75) g`,
        [ids.dev],
      );
      const expected = (await sql(
        `SELECT id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [ids.dev],
      )).map((r) => r.id);

      const bell = await listNotifications(ids.dev, { before: null, limit: 20 });
      expect(bell.notifications.map((n) => n.id)).toEqual(expected.slice(0, 20));

      const seen: string[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const page = await listNotifications(ids.dev, { before: before ? decodeNotificationCursor(before) : null, limit: 30 });
        seen.push(...page.notifications.map((n) => n.id as string));
        before = page.nextBefore;
        pages += 1;
      } while (before && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
    });
  });
});
