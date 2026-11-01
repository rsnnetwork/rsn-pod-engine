// ─── Migration 128: who can join a circle (30 Oct review, item 7.5; L22) ─────────────────────────────────────
//
// A circle is Open (anyone joins at once, as every circle is today) or Closed (people ask and its managers let them
// in). The policy is a column on circles with the default 'open', so every existing circle stays open; the asks
// live in circle_join_requests, a table of their own, so circle_members keeps meaning "member" for every reader.
// Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '128_circle_join_policy.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 128 (who can join a circle)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is additive: nothing dropped, deleted, rewritten, renamed or backfilled, and the bell allowlist is not touched', () => {
    const statements = code.replace(/ON DELETE (CASCADE|SET NULL)/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/notifications_type_check/);
  });

  it('adds join_policy only when it is missing, NOT NULL with the constant default open, so every circle stays open', () => {
    expect(flat).toContain("ALTER TABLE circles ADD COLUMN IF NOT EXISTS join_policy VARCHAR(20) NOT NULL DEFAULT 'open';");
  });

  it('holds join_policy to open or closed, guarded by the constraint name so a second run changes nothing', () => {
    expect(flat).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'circles_join_policy_check')");
    expect(flat).toContain("ALTER TABLE circles ADD CONSTRAINT circles_join_policy_check CHECK (join_policy IN ('open', 'closed'));");
  });

  it('creates circle_join_requests with a uuid id, both people tied to their rows, the four statuses and its times', () => {
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS circle_join_requests (');
    expect(flat).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(flat).toContain('circle_id UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE');
    expect(flat).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(flat).toContain("status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled'))");
    expect(flat).toContain('decided_by UUID NULL REFERENCES users(id) ON DELETE SET NULL');
    expect(flat).toContain('decided_at TIMESTAMPTZ NULL');
    expect(flat).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('allows one pending request per person per circle, and indexes the managers\' list and a person\'s latest answer', () => {
    expect(flat).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_join_requests_pending ON circle_join_requests (circle_id, user_id) WHERE status = 'pending';",
    );
    expect(flat).toContain(
      "CREATE INDEX IF NOT EXISTS idx_circle_join_requests_circle_pending ON circle_join_requests (circle_id, created_at) WHERE status = 'pending';",
    );
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_circle_join_requests_user ON circle_join_requests (user_id, circle_id, created_at DESC);');
  });

  it('is the conflict target the request insert names, so a second ask while one is pending adds nothing', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../services/circle/circle-join.service.ts'), 'utf8');
    expect(service.replace(/\s+/g, ' ')).toContain("ON CONFLICT (circle_id, user_id) WHERE status = 'pending' DO NOTHING");
  });
});
