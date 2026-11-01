// ─── Migration 127: an event for a whole circle (T13, 1 Nov 2026; L20) ─────────────────────────────────
//
// sessions.circle_id names the circle an event is for. The event still lives in its pod; the circle is its
// audience. NULL (every existing event, and every event production's form makes) keeps today's answers. Circles
// are archived, never deleted, so ON DELETE SET NULL only ever leaves an event to its pod.
// Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '127_circle_events.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 127 (an event for a whole circle)', () => {
  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is additive: nothing dropped, deleted, rewritten, renamed or backfilled, and no bell type touched', () => {
    const statements = code.replace(/ON DELETE SET NULL/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/notifications_type_check/);
  });

  it('adds sessions.circle_id as a NULL-able reference to circles that a deleted circle sets back to NULL', () => {
    expect(flat).toContain('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS circle_id UUID NULL REFERENCES circles(id) ON DELETE SET NULL;');
    expect(flat).not.toMatch(/circle_id UUID[^;]*DEFAULT/);
  });

  it('indexes the events that are for a circle, and only those', () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_sessions_circle ON sessions (circle_id) WHERE circle_id IS NOT NULL;');
  });

  it('runs twice without an error (every statement is guarded)', () => {
    const statements = flat.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) expect(statement).toMatch(/IF NOT EXISTS/);
  });
});
