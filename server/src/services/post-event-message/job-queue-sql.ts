// ─── Which post-event message jobs need a worker ──────────────────────────────
//
// The three statements the worker uses to find, and take, a job. They sit in a module of their own, with
// no imports, so the rule that decides which jobs need a worker can be run against a real Postgres by a
// test (stale-jobs.sql.test.ts) without loading the database layer.
//
// A job needs a worker when it is 'pending', or when it is 'processing' and has gone silent: a run that
// was draining it stopped (a deploy, a crash) and nothing else will move it on. See the header of
// post-event-message.worker.ts for the whole story.

/** A processing job with no sign of life for this long is taken to have been left by a run that stopped. */
export const STALE_AFTER_MINUTES = 5;

/**
 * SQL: job `j` is 'processing' and silent for the number of minutes in placeholder `$n`. Its last sign of
 * life is the later of its latest start (the claim sets started_at to now) and the latest recipient sent
 * to; failing both, when it was made. One fragment shared by the probe, the pick and the claim, so they
 * cannot drift apart; nothing in it comes from a caller.
 *
 * Not started_at alone: that is stamped when a run begins, so a long job that is still sending would look
 * silent. Not the Redis lock either: it is held for 55 s and never renewed.
 */
const silentFor = (n: number) => `(j.status = 'processing'
       AND COALESCE(GREATEST(j.started_at, (SELECT MAX(r.sent_at) FROM post_event_message_recipients r WHERE r.job_id = j.id)), j.created_at)
           < NOW() - ($${n}::int * INTERVAL '1 minute'))`;

/** One cheap read on an idle tick: is there any job a worker should look at? ($1 = STALE_AFTER_MINUTES) */
export const PROBE_SQL = `SELECT TRUE AS exists FROM post_event_message_jobs j
     WHERE j.status = 'pending' OR ${silentFor(1)}
     LIMIT 1`;

/** The oldest job that needs a worker, a new one or a silent one. ($1 = STALE_AFTER_MINUTES) */
export const PICK_SQL = `SELECT j.id, j.session_id, j.created_by, j.body, j.status AS previous_status, j.created_at
     FROM post_event_message_jobs j
     WHERE j.status = 'pending' OR ${silentFor(1)}
     ORDER BY j.created_at
     LIMIT 1`;

/**
 * Take the job, and only if it still needs a worker: the same question as the pick, asked again in the
 * statement that changes the row, so two instances (or a run that came back to life) cannot both have it.
 * started_at becomes now, which is what makes the next tick leave the job to this run.
 * ($1 = job id, $2 = STALE_AFTER_MINUTES)
 */
export const CLAIM_SQL = `UPDATE post_event_message_jobs j
     SET status = 'processing', started_at = NOW()
     WHERE j.id = $1 AND (j.status = 'pending' OR ${silentFor(2)})
     RETURNING j.id`;
