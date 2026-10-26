// ─── A kick between the registration's read and its write stands (real Postgres, H1b, 26 Oct 2026) ─────
//
// registerParticipant reads the person's row, then writes it back to 'registered' (someone who left and is coming
// back). The invite accept and the REST register run outside the event's guard, so a host's kick can commit between
// the two. That write used to be unguarded and made the row 'registered' again, undoing the kick. It is now guarded as
// every other status write is: a removed row is written only for a host's fresh personal invite (the one way back),
// so a kick that lands there stands and the person is told they were removed. The fake databases in the unit tests
// copy how Postgres re-checks an UPDATE that waited for a row; this proves it on Postgres: the kick holds the row,
// the registration's write waits for it, and once the kick commits Postgres re-reads the row and the guard decides.
//
// Two real sessions on a real Postgres: one holds the kick's write open while the other, the real service,
// re-registers; then what was stored is read back. Everything happens in a schema of its own, made from the real
// tables (LIKE … INCLUDING ALL) and dropped at the end: no row of the database is read or written.
//
// Opt-in, because it needs a Postgres to connect to (a local one: it refuses anything else); without one it is
// skipped:
//
//   REGISTER_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/session/register-removal-race.sql.test.ts

import { randomUUID } from 'crypto';
import { Client } from 'pg';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.REGISTER_SQL_TEST_DB;
const suite = url ? describe : describe.skip;
/** What a call that should have waited gave back instead, in words. */
const described = (outcome: unknown) => (outcome instanceof Error ? outcome.message : JSON.stringify(outcome));

suite('a kick between the registration\'s read and its write stands (real Postgres, two sessions)', () => {
  const schema = `zz_register_race_${Date.now()}`;
  const app = `${schema}_register`;
  const scoped = (name: string) =>
    `${url}${url!.includes('?') ? '&' : '?'}application_name=${name}&options=${encodeURIComponent(`-c search_path=${schema}`)}`;

  let admin: Client;
  let holder: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let sessions: typeof import('../../../services/session/session.service');

  const statusOf = async (event: string, member: string) => (await admin.query(
    `SELECT status FROM ${schema}.session_participants WHERE session_id = $1 AND user_id = $2`, [event, member],
  )).rows[0]?.status ?? null;

  /** A running event in a private pod, and a member of the pod who took part in it and left. */
  async function aMemberWhoLeft(): Promise<{ event: string; member: string }> {
    const [host, member, pod, event] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[host, 'Host'], [member, 'Member']]) {
      await admin.query(
        `INSERT INTO ${schema}.users (id, email, display_name, first_name, last_name) VALUES ($1, $2, $3, $3, 'Test')`,
        [id, `${id}@rsn-e2e.invalid`, name],
      );
    }
    await admin.query(`INSERT INTO ${schema}.pods (id, name, created_by, visibility) VALUES ($1, 'Race pod', $2, 'private')`, [pod, host]);
    await admin.query(
      `INSERT INTO ${schema}.pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active'), ($1, $3, 'member', 'active')`,
      [pod, host, member],
    );
    await admin.query(
      `INSERT INTO ${schema}.sessions (id, pod_id, title, status, host_user_id) VALUES ($1, $2, 'Race event', 'lobby_open', $3)`,
      [event, pod, host],
    );
    await admin.query(
      `INSERT INTO ${schema}.session_participants (session_id, user_id, status, left_at) VALUES ($1, $2, 'left', NOW())`,
      [event, member],
    );
    return { event, member };
  }

  /**
   * Until the registering session is blocked on a lock (it is the only connection that uses this application name
   * and waits). A registration that finishes first did not wait: what it did is in the error.
   */
  async function untilWaiting(finished: () => { outcome: unknown } | null): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const done = finished();
      if (done) throw new Error(`the registration finished without waiting for the kick: ${described(done.outcome)}`);
      const waiting = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [app]);
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the registration never waited for the kick');
  }

  /**
   * The host's kick writes the row and holds it (not yet committed) while `register` reads it and then waits to write
   * it; the kick commits, and what the registration did is given back.
   */
  async function kickLandingMidway<T>(event: string, member: string, register: () => Promise<T>): Promise<T | Error> {
    await holder.query('BEGIN');
    try {
      // The kick's own write, as transitionParticipant makes it.
      await holder.query(
        `UPDATE session_participants SET status = 'removed', left_at = NOW()
          WHERE session_id = $1 AND user_id = $2 AND status <> 'removed'`,
        [event, member],
      );
      let finished: { outcome: T | Error } | null = null;
      const registering = register().then((v) => v, (e: Error) => e).then((outcome) => { finished = { outcome }; return outcome; });
      await untilWaiting(() => finished);
      await holder.query('COMMIT');
      return await registering;
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('REGISTER_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    // users and invites: the registration also marks the person's pending invite to the event accepted.
    for (const table of ['users', 'pods', 'pod_members', 'sessions', 'session_participants', 'invites']) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // The service's own pool, and the holder, see only this schema's tables.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scoped(app);
    db = await import('../../../db');
    sessions = await import('../../../services/session/session.service');
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

  it('a re-registration from the page (the REST register) waits for the kick, then leaves them removed and says so', async () => {
    const { event, member } = await aMemberWhoLeft();
    const outcome = await kickLandingMidway(event, member, () => sessions.registerParticipant(event, member));
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ statusCode: 403, code: 'REMOVED_FROM_EVENT', message: 'You have been removed from this event by the host' });
    expect(await statusOf(event, member)).toBe('removed');
  }, 30_000);

  it('a host\'s fresh personal invite waits for the kick too, then takes them back: the one way back', async () => {
    const { event, member } = await aMemberWhoLeft();
    const outcome = await kickLandingMidway(event, member,
      () => sessions.registerParticipant(event, member, undefined, { allowRemovedReadmit: true }));
    expect(outcome).toMatchObject({ status: 'registered', isNewRegistration: false });
    expect(await statusOf(event, member)).toBe('registered');
  }, 30_000);

  it('with no kick, someone who left is registered again as before', async () => {
    const { event, member } = await aMemberWhoLeft();
    await expect(sessions.registerParticipant(event, member)).resolves.toMatchObject({ status: 'registered', isNewRegistration: false });
    expect(await statusOf(event, member)).toBe('registered');
  }, 30_000);
});
