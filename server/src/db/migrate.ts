// ─── Database Migration Runner ───────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { pool } from './index';
import logger from '../config/logger';

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<string[]> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM _migrations ORDER BY id'
  );
  return result.rows.map((r) => r.filename);
}

async function runMigrations(): Promise<void> {
  try {
    await ensureMigrationsTable();
    const applied = await getAppliedMigrations();

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => !applied.includes(f));

    if (pending.length === 0) {
      logger.info('No pending migrations');
      return;
    }

    for (const file of pending) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      logger.info({ migration: file }, 'Running migration...');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        logger.info({ migration: file }, 'Migration completed');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err, migration: file }, 'Migration failed');
        throw err;
      } finally {
        client.release();
      }
    }

    logger.info({ count: pending.length }, 'All migrations applied');
  } catch (err) {
    logger.error({ err }, 'Migration runner encountered error');
    throw err;
  }
}

export { runMigrations };

// Run if called directly (node -r ts-node/register src/db/migrate.ts)
if (require.main === module) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Migration runner failed');
      await pool.end();
      process.exit(1);
    });
}
