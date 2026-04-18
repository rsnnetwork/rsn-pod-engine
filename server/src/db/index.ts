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

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Acquire a row-level lock on a session and execute a callback.
 * Prevents concurrent host actions from racing on the same session.
 * Uses SELECT ... FOR UPDATE within a transaction.
 */
export async function withSessionLock<T>(
  sessionId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Acquire row lock — blocks other withSessionLock calls for same session
    await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await pool.query('SELECT NOW()');
      logger.info({ time: result.rows[0].now, attempt }, 'Database connection verified');
      return true;
    } catch (err) {
      logger.warn({ err, attempt, maxRetries: MAX_RETRIES }, 'Database connection attempt failed');
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * attempt; // 2s, 4s, 6s, 8s
        logger.info({ delay, nextAttempt: attempt + 1 }, 'Retrying database connection...');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.error('Database connection failed after all retries');
  return false;
}

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}

export { pool };
export default { query, getClient, transaction, testConnection, closePool, pool };
