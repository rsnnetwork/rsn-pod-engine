// ─── Database Connection Pool ────────────────────────────────────────────────
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from '../config';
import logger from '../config/logger';

// Neon pooler doesn't support statement_timeout in startup options — set per-connection instead
const pool = new Pool({
  connectionString: config.databaseUrl,
  min: config.dbPoolMin,  // Keep connections warm — prevents Neon cold-start under load
  max: config.dbPoolMax,
  idleTimeoutMillis: 120_000, // 2 min — balance between keeping warm and not wasting Neon resources
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Neon kills idle-in-transaction connections — pool auto-recovers with fresh ones
  logger.error({ err }, 'Unexpected PostgreSQL pool error — pool will recover');
});

pool.on('connect', () => {
  // No global statement_timeout — Neon pooler handles connection timeouts.
  // 30s timeout was killing legitimate transactions under concurrent load
  // (multiple users registering/accepting invites simultaneously).
  logger.debug('New PostgreSQL client connected');
});

// ─── Query helpers ──────────────────────────────────────────────────────────

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  logger.debug({ query: text.substring(0, 80), duration, rows: result.rowCount }, 'DB query');
  return result;
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Defensive wrapper around `client.query('ROLLBACK')`. If the underlying
 * connection has already been killed by Postgres (e.g. idle-in-transaction
 * timeout), a fresh ROLLBACK throws too — and we don't want that secondary
 * throw to mask the original error or escape as an uncaught exception.
 */
async function safeRollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); }
  catch (rollbackErr) {
    logger.warn({ err: rollbackErr }, 'ROLLBACK failed (connection likely already closed)');
  }
}

/**
 * Defensive wrapper around `client.release()`. release() throws if called
 * on an already-released or already-broken client. We log and move on.
 */
function safeRelease(client: PoolClient, err?: unknown): void {
  try { client.release(err as Error | undefined); }
  catch (releaseErr) {
    logger.warn({ err: releaseErr }, 'client.release failed (already returned to pool)');
  }
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  // Critical safety net: when Postgres terminates an idle-in-transaction
  // connection, pg emits an async 'error' event on the client. Without a
  // listener, Node treats it as `uncaughtException` → process.exit(1) via
  // the handler in index.ts. This swallows the redundant async event so
  // only the synchronous error from the next client.query() reaches the
  // caller, where it can be handled normally. (Both observed crashes on
  // 2026-04-22 — at 10:59:44 and 11:10:22 — were this exact scenario.)
  let connectionDied = false;
  const onClientError = (err: unknown): void => {
    connectionDied = true;
    logger.warn({ err }, 'Async client error during transaction (connection likely terminated by server)');
  };
  client.on('error', onClientError);

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (!connectionDied) await safeRollback(client);
    throw err;
  } finally {
    client.off('error', onClientError);
    safeRelease(client, connectionDied ? new Error('connection terminated') : undefined);
  }
}

/**
 * Acquire a row-level lock on a session and execute a callback.
 * Prevents concurrent host actions from racing on the same session.
 * Uses SELECT ... FOR UPDATE within a transaction.
 *
 * Same defensive error-event listener as `transaction()` — protects against
 * idle-in-transaction Postgres terminations bubbling as uncaughtException.
 */
export async function withSessionLock<T>(
  sessionId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let connectionDied = false;
  const onClientError = (err: unknown): void => {
    connectionDied = true;
    logger.warn({ err, sessionId }, 'Async client error during withSessionLock');
  };
  client.on('error', onClientError);

  try {
    await client.query('BEGIN');
    // Acquire row lock — blocks other withSessionLock calls for same session
    await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (!connectionDied) await safeRollback(client);
    throw err;
  } finally {
    client.off('error', onClientError);
    safeRelease(client, connectionDied ? new Error('connection terminated') : undefined);
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT NOW()');
    logger.info({ time: result.rows[0].now }, 'Database connection verified');
    return true;
  } catch (err) {
    logger.error({ err }, 'Database connection failed');
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}

export { pool };
export default { query, getClient, transaction, testConnection, closePool, pool };
