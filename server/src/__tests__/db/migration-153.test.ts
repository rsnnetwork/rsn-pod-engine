// ─── Migration 153: LinkedIn lookups to try once more, later (12 Nov 2026) ──────────────────────────────────────────
//
// enrichment_retries holds one waiting row per lookup ScrapingDog asked us to repeat ("not stored yet, try again after
// 2-3 minutes"): for a join request (the approval-time lookup) or a member (their own lookup), never both, at most one
// waiting per request and per member. The worker deletes a row when it claims it. Applied files are never edited.
//
// Running the file twice, the schedule's ON CONFLICT and the claim were run for real on a scratch Postgres (PGlite,
// workspace/scratch/2026-11-12-enrich/pglite-153.mjs) for the report.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';
import { SCHEDULE_RETRY_SQL, CLAIM_DUE_RETRIES_SQL } from '../../services/onboarding/enrichment-retry.repo';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '153_enrichment_retries.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const flat = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

describe('migration 153 (enrichment retries)', () => {
  it('is the only file numbered 153, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '153')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('makes the table only when missing, with the id and created_at every table has, and deletes with its request or member', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS enrichment_retries (');
    expect(f).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(f).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(f).toContain('join_request_id UUID NULL REFERENCES join_requests(id) ON DELETE CASCADE');
    expect(f).toContain('user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(f).toContain('run_at TIMESTAMPTZ NOT NULL');
  });

  it('names exactly one subject, and keeps one waiting row per request and per member', () => {
    const f = flat(sql);
    expect(f).toContain('CHECK ((join_request_id IS NULL) <> (user_id IS NULL))');
    expect(f).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_enrichment_retries_join_request ON enrichment_retries (join_request_id) WHERE join_request_id IS NOT NULL;');
    expect(f).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_enrichment_retries_user ON enrichment_retries (user_id) WHERE user_id IS NOT NULL;');
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_enrichment_retries_run_at ON enrichment_retries (run_at);');
  });

  it('the schedule and the claim use only what the migration makes', () => {
    expect(SCHEDULE_RETRY_SQL).toMatch(/INSERT INTO enrichment_retries \(join_request_id, user_id, linkedin_url, full_name, run_at\)/);
    expect(SCHEDULE_RETRY_SQL).toMatch(/ON CONFLICT DO NOTHING/);
    expect(CLAIM_DUE_RETRIES_SQL).toMatch(/RETURNING id, join_request_id, user_id, linkedin_url, full_name/);
  });
});
