// ─── Migration 141: published schedule versions and the live matches that follow them (Part 2 Task 9; D4) ──────
//
// event_schedule_versions holds one immutable row per published version; matches gains locked (NOT NULL DEFAULT
// FALSE), schedule_version and assignment_source (NULL, a CHECK on the three sources). Constant defaults, so no
// stored row is rewritten. Applied files are never edited: a later change is a NEW migration and this test follows it.
// The statements were checked against production read-only for the task report (EXPLAIN where Postgres allows it).

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/141_schedule_versions_and_match_locks.sql'), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 141 (schedule versions and match locks)', () => {
  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('creates the versions table with an id, created_at, the event cascade, the publisher set null, one row per version', () => {
    const table = flat(sql).match(/CREATE TABLE IF NOT EXISTS event_schedule_versions \((.*?)\);/)![1];
    expect(table).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(table).toContain('session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect(table).toContain('version INT NOT NULL CHECK (version >= 1)');
    expect(table).toContain('published_by UUID NULL REFERENCES users(id) ON DELETE SET NULL');
    expect(table).toContain('automatic BOOLEAN NOT NULL DEFAULT FALSE');
    expect(table).toContain('snapshot JSONB NOT NULL');
    expect(table).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(table).toContain('UNIQUE (session_id, version)');
    // Every foreign key states what happens on delete.
    expect((table.match(/REFERENCES/g) ?? []).length).toBe((table.match(/ON DELETE (CASCADE|SET NULL)/g) ?? []).length);
  });

  it('refuses any change to a version but the publisher becoming NULL when their account goes', () => {
    const fn = flat(sql);
    expect(fn).toContain('CREATE OR REPLACE FUNCTION event_schedule_versions_immutable() RETURNS trigger');
    expect(fn).toContain('OR NEW.snapshot IS DISTINCT FROM OLD.snapshot');
    expect(fn).toContain('OR (NEW.published_by IS DISTINCT FROM OLD.published_by AND NEW.published_by IS NOT NULL) THEN');
    expect(fn).toContain('DROP TRIGGER IF EXISTS trg_event_schedule_versions_immutable ON event_schedule_versions;');
    expect(fn).toContain('BEFORE UPDATE ON event_schedule_versions FOR EACH ROW EXECUTE FUNCTION event_schedule_versions_immutable();');
  });

  it('adds the three match columns with constant defaults and the source check, all guarded', () => {
    expect(flat(sql)).toContain('ALTER TABLE matches ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;');
    expect(flat(sql)).toContain('ALTER TABLE matches ADD COLUMN IF NOT EXISTS schedule_version INT NULL;');
    expect(flat(sql)).toContain('ALTER TABLE matches ADD COLUMN IF NOT EXISTS assignment_source TEXT NULL;');
    expect(flat(sql)).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_assignment_source_check')");
    expect(flat(sql)).toContain("CHECK (assignment_source IS NULL OR assignment_source IN ('auto', 'manual', 'repair'))");
  });

  it('is safe to run twice and additive: every create is guarded, nothing is deleted, truncated or updated', () => {
    const f = flat(sql);
    expect((f.match(/CREATE TABLE/g) ?? []).length).toBe((f.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length);
    expect((f.match(/CREATE INDEX/g) ?? []).length).toBe((f.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length);
    expect((f.match(/ADD COLUMN/g) ?? []).length).toBe((f.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
    const statements = code(sql).replace(/ON DELETE (CASCADE|SET NULL)/g, '').replace(/BEFORE UPDATE ON/g, '')
      .replace(/DROP TRIGGER IF EXISTS/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
    expect(statements).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
  });
});
