// ─── Nothing reaches an event's chat after it ends (real Postgres, H1b, 26 Oct 2026) ──────────────────
//
// persistEventChatMessage stores a message only while the event is open: its INSERT … SELECT reads the event's row
// and writes nothing when the status is completed or cancelled. Without a lock that read is a snapshot: a send that
// read the row while the completion (completeSession's `UPDATE sessions SET status = 'completed', ended_at = NOW()`)
// had written it but not yet committed saw the event still open and stored its message after the end. The read now
// takes FOR SHARE OF s, which waits for the completion's row lock and then reads the row as the completion left it,
// so a message is stored before the end or not at all. A reaction's toggle reads the same row in its transaction and
// takes the same lock. The SQL-text pins cannot see any of this; this can.
//
// Two real sessions on a real Postgres: one holds the completion open while the other, the real service, sends or
// reacts; then what was stored is read back. Everything happens in a schema of its own, made from the real tables
// (LIKE … INCLUDING ALL) and dropped at the end: no row of the database is read or written.
//
// Opt-in, because it needs a Postgres to connect to (a local one: it refuses anything else); without one it is
// skipped:
//
//   EVENT_CHAT_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/event-chat/event-chat-end-order.sql.test.ts

import { randomUUID } from 'crypto';
import { Client } from 'pg';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.EVENT_CHAT_SQL_TEST_DB;
const suite = url ? describe : describe.skip;
/** What a call that should have waited gave back instead, in words. */
const described = (outcome: unknown) => (outcome instanceof Error ? outcome.message : JSON.stringify(outcome));

suite('nothing is stored in an event\'s chat after it ends (real Postgres, two sessions)', () => {
  const schema = `zz_event_chat_end_${Date.now()}`;
  const app = `${schema}_sender`;
  const scoped = (name: string) =>
    `${url}${url!.includes('?') ? '&' : '?'}application_name=${name}&options=${encodeURIComponent(`-c search_path=${schema}`)}`;

  let admin: Client;
  let holder: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let chat: typeof import('../../../services/event-chat/event-chat.service');

  const messagesOf = async (sessionId: string) => (await admin.query(
    `SELECT content, created_at FROM ${schema}.event_chat_messages WHERE session_id = $1 ORDER BY created_at`, [sessionId],
  )).rows as { content: string; created_at: Date }[];
  const endedAt = async (sessionId: string) => (await admin.query(
    `SELECT ended_at FROM ${schema}.sessions WHERE id = $1`, [sessionId],
  )).rows[0].ended_at as Date;

  async function anOpenEvent(): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO ${schema}.sessions (id, pod_id, title, status, host_user_id) VALUES ($1, $2, 'Chat end order', 'lobby_open', $3)`,
      [id, randomUUID(), randomUUID()],
    );
    return id;
  }

  /**
   * Until the sending session is blocked on a lock (it is the only connection that uses this application name and
   * waits). A send that finishes first did not wait: what it did is in the error.
   */
  async function untilWaiting(finished: () => { outcome: unknown } | null): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const done = finished();
      if (done) throw new Error(`the send finished without waiting for the completion: ${described(done.outcome)}`);
      const waiting = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [app]);
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the send never waited for the completion');
  }

  /** Hold the completion of the event open on the holder, start `send`, wait until it waits, commit, give back what it did. */
  async function duringCompletion<T>(sessionId: string, send: () => Promise<T>): Promise<{ outcome: T | Error }> {
    await holder.query('BEGIN');
    try {
      // completeSession's claim, as it runs on production.
      await holder.query(
        `UPDATE sessions SET status = 'completed', ended_at = NOW() WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [sessionId],
      );
      let finished: { outcome: T | Error } | null = null;
      const sending = send().then((v) => v, (e: Error) => e).then((outcome) => { finished = { outcome }; return outcome; });
      await untilWaiting(() => finished);
      await holder.query('COMMIT');
      return { outcome: await sending };
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  const lobbyMessage = (sessionId: string, content: string) => ({
    sessionId, senderId: randomUUID(), senderName: 'Guest', senderIsHost: false, scope: 'lobby' as const, content,
  });

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('EVENT_CHAT_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    // user_blocks: the reaction's check leaves out a blocked author, so it is read too (it stays empty).
    for (const table of ['sessions', 'matches', 'event_chat_messages', 'event_chat_reactions', 'user_blocks']) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // The service's own pool, and the holder, see only this schema's tables.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scoped(app);
    db = await import('../../../db');
    chat = await import('../../../services/event-chat/event-chat.service');
    holder = new Client({ connectionString: scoped(`${schema}_holder`) });
    await holder.connect();
  });

  afterAll(async () => {
    await holder?.end();
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  it('a message sent while the end is being written waits for it, then stores nothing and says the chat is closed', async () => {
    const sessionId = await anOpenEvent();
    const { outcome } = await duringCompletion(sessionId, () => chat.persistEventChatMessage(lobbyMessage(sessionId, 'Just in time?')));
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ code: 'EVENT_ENDED', message: 'This event has ended, so its chat is closed.' });
    expect(await messagesOf(sessionId)).toEqual([]);
  }, 30_000);

  it('a message sent before the end is stored, and stored before it', async () => {
    const sessionId = await anOpenEvent();
    await chat.persistEventChatMessage(lobbyMessage(sessionId, 'Before the end'));
    await admin.query(`UPDATE ${schema}.sessions SET status = 'completed', ended_at = NOW() WHERE id = $1`, [sessionId]);
    const stored = await messagesOf(sessionId);
    expect(stored.map((m) => m.content)).toEqual(['Before the end']);
    expect(stored[0].created_at.getTime()).toBeLessThanOrEqual((await endedAt(sessionId)).getTime());
  }, 30_000);

  it('a reaction given while the end is being written waits for it, then changes nothing', async () => {
    const sessionId = await anOpenEvent();
    const sent = await chat.persistEventChatMessage(lobbyMessage(sessionId, 'React to me'));
    const reactor = randomUUID();
    const { outcome } = await duringCompletion(sessionId, () =>
      chat.toggleEventChatReaction({ sessionId, messageId: sent.message.id, userId: reactor, emoji: 'heart' }));
    expect(outcome).toBeNull();
    const reactions = await admin.query(`SELECT 1 FROM ${schema}.event_chat_reactions WHERE message_id = $1`, [sent.message.id]);
    expect(reactions.rowCount).toBe(0);
  }, 30_000);
});
