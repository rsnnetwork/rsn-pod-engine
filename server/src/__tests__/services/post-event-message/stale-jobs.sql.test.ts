// ─── Which jobs need a worker: the rule, run against a real Postgres ──────────
//
// The worker tests pin what the worker asks and what it does with the answer. This one runs the three
// statements the worker uses to find and take a job (job-queue-sql.ts) against a real database, because
// the rule lives in that SQL: a job needs a worker when it is pending, or when it is 'processing' and has
// shown no sign of life for 5 minutes (a run that was draining it stopped, and nothing else will move it on).
//
// Opt-in, because it needs a Postgres to connect to; without one it is skipped:
//
//   PEM_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/post-event-message/stale-jobs.sql.test.ts
//
// It touches no row of that database. It creates TEMP tables with the names the statements use; a temp
// table hides a real table of the same name for this connection only, and is gone when the connection ends.

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { CLAIM_SQL, PICK_SQL, PROBE_SQL, STALE_AFTER_MINUTES } from '../../../services/post-event-message/job-queue-sql';

const url = process.env.PEM_SQL_TEST_DB;
const suite = url ? describe : describe.skip;

suite('which jobs need a worker, against a real Postgres', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`
      CREATE TEMP TABLE post_event_message_jobs (
        id UUID PRIMARY KEY, session_id UUID NOT NULL, created_by UUID NOT NULL, status TEXT NOT NULL,
        body TEXT, error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ)`);
    // The real table's rule: one pending-or-processing job per event.
    await db.query(`CREATE UNIQUE INDEX uniq_active_job_per_session ON post_event_message_jobs (session_id)
                    WHERE status IN ('pending', 'processing')`);
    await db.query(`
      CREATE TEMP TABLE post_event_message_recipients (
        id UUID PRIMARY KEY, job_id UUID NOT NULL, user_id UUID NOT NULL, status TEXT NOT NULL, sent_at TIMESTAMPTZ)`);
    // Make sure the names resolve to the temp tables, not to anything real.
    const shadow = await db.query(`SELECT to_regclass('pg_temp.post_event_message_jobs') IS NOT NULL AS jobs,
                                          to_regclass('pg_temp.post_event_message_recipients') IS NOT NULL AS recipients`);
    expect(shadow.rows[0]).toEqual({ jobs: true, recipients: true });
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM post_event_message_recipients');
    await db.query('DELETE FROM post_event_message_jobs');
  });

  interface JobSpec {
    status: string;
    /** Minutes since the job was made. Default: an hour. */
    createdMinAgo?: number;
    /** Minutes since a run last took it; null = never. Default: never. */
    startedMinAgo?: number | null;
    /** Minutes since the latest recipient was sent to; omit for a job nobody has been sent to. */
    lastSentMinAgo?: number;
    session?: string;
  }

  async function addJob(spec: JobSpec): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO post_event_message_jobs (id, session_id, created_by, status, created_at, started_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'),
               CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - ($6::int * INTERVAL '1 minute') END)`,
      [id, spec.session ?? randomUUID(), randomUUID(), spec.status, spec.createdMinAgo ?? 60, spec.startedMinAgo ?? null],
    );
    if (spec.lastSentMinAgo !== undefined) {
      await db.query(
        `INSERT INTO post_event_message_recipients (id, job_id, user_id, status, sent_at)
         VALUES ($1, $2, $3, 'sent', NOW() - ($4::int * INTERVAL '1 minute'))`,
        [randomUUID(), id, randomUUID(), spec.lastSentMinAgo],
      );
    }
    return id;
  }

  const needsAWorker = async () => (await db.query(PROBE_SQL, [STALE_AFTER_MINUTES])).rowCount === 1;
  const picked = async () =>
    (await db.query(PICK_SQL, [STALE_AFTER_MINUTES])).rows[0] as { id: string; previous_status: string } | undefined;
  const claim = async (id: string) => (await db.query(CLAIM_SQL, [id, STALE_AFTER_MINUTES])).rowCount === 1;
  const statusOf = async (id: string) =>
    (await db.query('SELECT status FROM post_event_message_jobs WHERE id = $1', [id])).rows[0].status as string;

  describe('who is picked', () => {
    it('a pending job needs a worker', async () => {
      const id = await addJob({ status: 'pending' });
      expect(await needsAWorker()).toBe(true);
      expect(await picked()).toMatchObject({ id, previous_status: 'pending' });
    });

    it('nothing at all: no job needs a worker', async () => {
      expect(await needsAWorker()).toBe(false);
      expect(await picked()).toBeUndefined();
    });

    it('a processing job a worker took a moment ago is left alone', async () => {
      await addJob({ status: 'processing', startedMinAgo: 0 });
      expect(await needsAWorker()).toBe(false);
      expect(await picked()).toBeUndefined();
    });

    it('a processing job taken 4 minutes ago, nobody sent to yet, is not silent yet; at 6 minutes it is', async () => {
      await addJob({ status: 'processing', startedMinAgo: 4 });
      expect(await picked()).toBeUndefined();
      await db.query('DELETE FROM post_event_message_jobs');
      const id = await addJob({ status: 'processing', startedMinAgo: 6 });
      expect(await needsAWorker()).toBe(true);
      expect(await picked()).toMatchObject({ id, previous_status: 'processing' });
    });

    it('a long job that is still sending is alive: its start is an hour old but it sent to someone a minute ago', async () => {
      await addJob({ status: 'processing', startedMinAgo: 60, lastSentMinAgo: 1 });
      expect(await needsAWorker()).toBe(false);
      expect(await picked()).toBeUndefined();
    });

    it('a job a worker has only just taken again is alive, however long ago anyone was sent to', async () => {
      await addJob({ status: 'processing', startedMinAgo: 1, lastSentMinAgo: 30 });
      expect(await needsAWorker()).toBe(false);
    });

    it('a job whose start AND latest send are both over 5 minutes old is silent', async () => {
      const id = await addJob({ status: 'processing', startedMinAgo: 60, lastSentMinAgo: 8 });
      expect(await needsAWorker()).toBe(true);
      expect(await picked()).toMatchObject({ id, previous_status: 'processing' });
    });

    it('a processing job with no start recorded falls back on when it was made', async () => {
      await addJob({ status: 'processing', startedMinAgo: null, createdMinAgo: 1 });
      expect(await needsAWorker()).toBe(false);
      await db.query('DELETE FROM post_event_message_jobs');
      const id = await addJob({ status: 'processing', startedMinAgo: null, createdMinAgo: 10 });
      expect(await picked()).toMatchObject({ id, previous_status: 'processing' });
    });

    it.each(['completed', 'completed_with_errors', 'failed'])('a %s job never needs a worker, however old', async (status) => {
      await addJob({ status, startedMinAgo: 600, createdMinAgo: 1000, lastSentMinAgo: 500 });
      expect(await needsAWorker()).toBe(false);
      expect(await picked()).toBeUndefined();
    });

    it('the oldest job that needs a worker goes first, whether it is new or silent', async () => {
      await addJob({ status: 'pending', createdMinAgo: 3 });
      const oldest = await addJob({ status: 'processing', createdMinAgo: 200, startedMinAgo: 100 });
      await addJob({ status: 'pending', createdMinAgo: 50 });
      expect((await picked())?.id).toBe(oldest);
    });

    it('a job that is alive does not hide a pending one behind it', async () => {
      await addJob({ status: 'processing', createdMinAgo: 200, startedMinAgo: 100, lastSentMinAgo: 0 });
      const waiting = await addJob({ status: 'pending', createdMinAgo: 1 });
      expect((await picked())?.id).toBe(waiting);
    });
  });

  describe('who may take it', () => {
    it('a pending job is taken, and is then a processing job a worker has just started', async () => {
      const id = await addJob({ status: 'pending' });
      expect(await claim(id)).toBe(true);
      expect(await statusOf(id)).toBe('processing');
      expect(await needsAWorker()).toBe(false); // the next tick leaves it to the run that took it
    });

    it('a silent job is taken, which starts its clock again: the next tick does not take it a second time', async () => {
      const id = await addJob({ status: 'processing', startedMinAgo: 60, lastSentMinAgo: 40 });
      expect(await claim(id)).toBe(true);
      expect(await claim(id)).toBe(false); // the second instance, a moment later
      expect(await needsAWorker()).toBe(false);
      const row = await db.query(`SELECT started_at > NOW() - INTERVAL '1 minute' AS fresh FROM post_event_message_jobs WHERE id = $1`, [id]);
      expect(row.rows[0].fresh).toBe(true);
    });

    it('a job that came back to life between the pick and the claim is not taken', async () => {
      const id = await addJob({ status: 'processing', startedMinAgo: 60, lastSentMinAgo: 40 });
      expect((await picked())?.id).toBe(id);
      // The run that looked stopped sends to someone before the claim arrives.
      await db.query(`INSERT INTO post_event_message_recipients (id, job_id, user_id, status, sent_at)
                      VALUES ($1, $2, $3, 'sent', NOW())`, [randomUUID(), id, randomUUID()]);
      expect(await claim(id)).toBe(false);
      expect(await statusOf(id)).toBe('processing');
    });

    it('a job that is alive cannot be taken', async () => {
      const id = await addJob({ status: 'processing', startedMinAgo: 0 });
      expect(await claim(id)).toBe(false);
    });

    it.each(['completed', 'completed_with_errors', 'failed'])('a %s job cannot be taken', async (status) => {
      const id = await addJob({ status, startedMinAgo: 600, lastSentMinAgo: 500 });
      expect(await claim(id)).toBe(false);
      expect(await statusOf(id)).toBe(status);
    });
  });

  describe('the event can send again once the job is done with', () => {
    // One pending-or-processing job per event is the real table's rule (uniq_active_job_per_session).
    const sendAgain = (session: string) =>
      db.query(`INSERT INTO post_event_message_jobs (id, session_id, created_by, status) VALUES ($1, $2, $3, 'pending')`,
        [randomUUID(), session, randomUUID()]);

    it('a silent job refuses the event\'s next send, as the bug was', async () => {
      const session = randomUUID();
      await addJob({ status: 'processing', startedMinAgo: 60, session });
      await expect(sendAgain(session)).rejects.toMatchObject({ code: '23505' });
    });

    it('after a worker carries it on and finishes it, the event can send again', async () => {
      const session = randomUUID();
      const id = await addJob({ status: 'processing', startedMinAgo: 60, session });
      expect(await claim(id)).toBe(true);
      await db.query(`UPDATE post_event_message_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id]);
      await expect(sendAgain(session)).resolves.toBeDefined();
    });

    it('after it is failed, the event can send again', async () => {
      const session = randomUUID();
      const id = await addJob({ status: 'processing', startedMinAgo: 60, session });
      await db.query(`UPDATE post_event_message_jobs SET status = 'failed', error = 'stopped', completed_at = NOW() WHERE id = $1`, [id]);
      await expect(sendAgain(session)).resolves.toBeDefined();
    });
  });
});
