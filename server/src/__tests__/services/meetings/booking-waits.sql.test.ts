// ─── A booking or a cancel that waits for another reads what that one wrote (real Postgres) ──
//
// 26 Oct 2026, H2a review. The conversation's meeting pointer is read through a guard (current-meeting.ts)
// that compares the conversation row with its meetings row. When the guard sat inside the statement that
// locks the conversation, a statement that had to wait for the lock re-read the conversation at its newest
// version once the lock was free, but read the meetings as they were when it began: behind another booking
// or a move, the meeting that booking had just written or moved read as stale. A second Confirm then wrote a
// second meeting instead of moving the first, and a cancel that waited behind a move cancelled the meeting
// but left the conversation naming it (production's banner and Join with it). The lock is now a statement
// of its own and the guarded read the next one. The SQL-text pins cannot see any of this; this can.
//
// Two real sessions on a real Postgres: one holds the conversation's lock and books (or moves) through the
// real confirmInTx while the other, a real confirmInTx or cancelMeeting, waits for it; then what the waiting
// one did is read back. The services run unchanged; only the thread card, the sockets and the emails are
// stand-ins. Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL)
// and dropped at the end: no row of the database is read or written.
//
// Opt-in, because it needs a Postgres to connect to (a local one: it refuses anything else); without one it
// is skipped:
//
//   MEETINGS_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/meetings/booking-waits.sql.test.ts

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

jest.mock('../../../index', () => ({
  __esModule: true,
  io: { to: () => ({ emit: () => undefined }), in: () => ({ fetchSockets: async () => [] }) },
}));
jest.mock('../../../services/dm/dm.service', () => ({
  __esModule: true,
  insertDirectMessageOn: async (_client: unknown, _from: string, _to: string, content: string) =>
    ({ conversationId: 'thread', message: { id: randomUUID(), content } }),
}));
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({ __esModule: true, broadcastDmMessage: async () => undefined }));
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  sendMeetingConfirmedEmail: async () => undefined,
  sendMeetingCancelledEmail: async () => undefined,
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.MEETINGS_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

suite('a booking or a cancel that waits for another reads what that one wrote (real Postgres, two sessions)', () => {
  const schema = `zz_booking_waits_${Date.now()}`;
  const app = `${schema}_waiter`;
  const slot = (daysAhead: number, hh: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysAhead);
    d.setUTCHours(hh, 0, 0, 0);
    return d.toISOString().replace('.000Z', 'Z');
  };
  const S1 = slot(3, 10);
  const S2 = slot(4, 11);
  const S3 = slot(5, 12);

  let admin: Client;
  let holder: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let windows: typeof import('../../../services/dm/meeting-windows.service');
  let meetings: typeof import('../../../services/meetings/meeting.service');

  const book = (client: Pick<PoolClient, 'query'>, conv: string, by: string, window: string) =>
    windows.confirmInTx(client as PoolClient, conv, by, { window, startAt: window, durationMin: 30, type: 'video' });
  const rowsOf = async (conv: string) => (await admin.query(
    `SELECT id, start_at, moved_from, calendar_sequence, status FROM ${schema}.meetings WHERE conversation_id = $1 ORDER BY created_at`,
    [conv],
  )).rows;
  const conversationOf = async (conv: string) => (await admin.query(
    `SELECT meeting_confirmed_window, meeting_start_at, current_meeting_id FROM ${schema}.dm_conversations WHERE id = $1`,
    [conv],
  )).rows[0];

  /** Two new people and their conversation (one per pair, as the real table holds), both of whom saved S1, S2 and S3. */
  async function conversation(): Promise<{ conv: string; a: string; b: string }> {
    const [a, b] = [randomUUID(), randomUUID()].sort(); // the pair's tables keep the lower id first
    for (const [id, name] of [[a, 'Ana'], [b, 'Bo']]) {
      await admin.query(
        `INSERT INTO ${schema}.users (id, email, display_name, first_name, last_name, status) VALUES ($1, $2, $3, $3, 'Test', 'active')`,
        [id, `${id}@booking-waits.invalid`, name],
      );
    }
    const conv = randomUUID();
    await admin.query(`INSERT INTO ${schema}.dm_conversations (id, user_a_id, user_b_id) VALUES ($1, $2, $3)`, [conv, a, b]);
    for (const user of [a, b]) {
      for (const key of [S1, S2, S3]) {
        await admin.query(`INSERT INTO ${schema}.meeting_availability (conversation_id, user_id, window_key) VALUES ($1, $2, $3)`, [conv, user, key]);
      }
    }
    return { conv, a, b };
  }

  /** Until the waiting session is blocked on a lock (it is the only connection that uses this application name and waits). */
  async function untilWaiting(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const waiting = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [app]);
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the second session never waited for the lock');
  }

  /** Hold the conversation's lock on the holder, start `waiter`, let the holder do `first`, commit, and give back what the waiter did. */
  async function behind<T>(conv: string, waiter: () => Promise<T>, first: () => Promise<unknown>): Promise<T> {
    await holder.query('BEGIN');
    try {
      await holder.query('SELECT 1 FROM dm_conversations WHERE id = $1 FOR UPDATE', [conv]);
      const waiting = waiter();
      waiting.catch(() => undefined); // read below; never an unhandled rejection while the holder works
      await untilWaiting();
      await first();
      await holder.query('COMMIT');
      return await waiting;
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('MEETINGS_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['users', 'user_blocks', 'user_pokes', 'dm_conversations', 'meetings', 'meeting_availability', 'notifications']) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // The services' own pool, and the holder, see only this schema's tables.
    const scoped = `${url}${url!.includes('?') ? '&' : '?'}application_name=${app}&options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scoped;
    db = await import('../../../db');
    windows = await import('../../../services/dm/meeting-windows.service');
    meetings = await import('../../../services/meetings/meeting.service');
    holder = new Client({ connectionString: `${url}${url!.includes('?') ? '&' : '?'}application_name=${schema}_holder&options=${encodeURIComponent(`-c search_path=${schema}`)}` });
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

  it('two Confirms on two shared times at once: the one that waited moves the meeting the other booked, so there is one meeting', async () => {
    const { conv, a, b } = await conversation();

    const waited = await behind(conv, () => db.transaction((client) => book(client, conv, b, S2)), () => book(holder, conv, a, S1));

    const rows = await rowsOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0].start_at.toISOString()).toBe(new Date(S2).toISOString());
    expect(rows[0].moved_from.toISOString()).toBe(new Date(S1).toISOString());
    expect(rows[0].calendar_sequence).toBe(1);
    expect(waited).toMatchObject({ already: false, movedFrom: new Date(S1).toISOString(), meeting: { id: rows[0].id, calendarSequence: 1 } });
    expect(await conversationOf(conv)).toMatchObject({ meeting_confirmed_window: S2, current_meeting_id: rows[0].id });
  }, 30_000);

  it('a Confirm that waited behind a move moves that same meeting again', async () => {
    const { conv, a, b } = await conversation();
    await db.transaction((client) => book(client, conv, a, S1));

    await behind(conv, () => db.transaction((client) => book(client, conv, b, S3)), () => book(holder, conv, a, S2));

    const rows = await rowsOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0].start_at.toISOString()).toBe(new Date(S3).toISOString());
    expect(rows[0].moved_from.toISOString()).toBe(new Date(S2).toISOString());
    expect(rows[0].calendar_sequence).toBe(2);
    expect(await conversationOf(conv)).toMatchObject({ meeting_confirmed_window: S3, current_meeting_id: rows[0].id });
  }, 30_000);

  it('a cancel that waited behind a move cancels the moved meeting and takes it off the conversation', async () => {
    const { conv, a, b } = await conversation();
    const booked = await db.transaction((client) => book(client, conv, a, S1));
    if (booked.already || !booked.meeting) throw new Error('the first booking did not write a meeting');
    const meetingId = booked.meeting.id;

    const cancelled = await behind(conv, () => meetings.cancelMeeting(b, meetingId), () => book(holder, conv, a, S2));

    expect(cancelled).toMatchObject({ id: meetingId, status: 'cancelled' });
    const rows = await rowsOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: meetingId, status: 'cancelled' });
    expect(rows[0].start_at.toISOString()).toBe(new Date(S2).toISOString());
    // Production's banner and Join read these: the cancelled meeting is no longer the conversation's.
    expect(await conversationOf(conv)).toEqual({ meeting_confirmed_window: null, meeting_start_at: null, current_meeting_id: null });
  }, 30_000);
});
