// ─── Migration 156: a second later attempt, and a bound on how many are scheduled (12 Nov 2026) ─────────────────
//
// enrichment_retries gains `attempt` (1 or 2, default 1); enrichment_retry_log records each scheduled attempt per
// request or member, so enrichment-retry.repo can refuse a fourth in 24 hours. Applied files are never edited.
// Running the file twice, the bound, the upsert and the purge were run for real on PGlite
// (workspace/scratch/2026-11-12-enrich/pglite-156.mjs) for the report.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '156_enrichment_retry_attempts.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const flat = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

describe('migration 156 (enrichment retry attempts and log)', () => {
  it('is the only file numbered 156, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '156')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds attempt only when missing, with a default, held to 1 or 2 by a CHECK dropped before it is added', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE enrichment_retries ADD COLUMN IF NOT EXISTS attempt SMALLINT NOT NULL DEFAULT 1;');
    expect(f).toContain('ALTER TABLE enrichment_retries DROP CONSTRAINT IF EXISTS enrichment_retries_attempt_range;');
    expect(f).toContain('ALTER TABLE enrichment_retries ADD CONSTRAINT enrichment_retries_attempt_range CHECK (attempt BETWEEN 1 AND 2);');
  });

  it('makes the log only when missing, one subject per row, deleting with its request or member, and holds no address or name', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS enrichment_retry_log (');
    expect(f).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(f).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(f).toContain('join_request_id UUID NULL REFERENCES join_requests(id) ON DELETE CASCADE');
    expect(f).toContain('user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(f).toContain('CHECK ((join_request_id IS NULL) <> (user_id IS NULL))');
    const table = f.slice(f.indexOf('CREATE TABLE IF NOT EXISTS enrichment_retry_log'), f.indexOf(');', f.indexOf('CREATE TABLE IF NOT EXISTS enrichment_retry_log')));
    expect(table).not.toMatch(/linkedin|full_name|email/);
  });

  it('indexes the 24-hour count per member and per request, and the purge by age, each only when missing', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_enrichment_retry_log_user ON enrichment_retry_log (user_id, created_at) WHERE user_id IS NOT NULL;');
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_enrichment_retry_log_request ON enrichment_retry_log (join_request_id, created_at) WHERE join_request_id IS NOT NULL;');
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_enrichment_retry_log_created ON enrichment_retry_log (created_at);');
  });

  it('gives the every-minute interrupted-lookup sweep a partial index on the searching rows only, made only when missing', () => {
    expect(flat(sql)).toContain(
      "CREATE INDEX IF NOT EXISTS idx_uip_enrichment_searching ON user_intent_profiles (enrichment_started_at) WHERE enrichment_status = 'searching';",
    );
  });
});
