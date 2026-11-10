// ─── Migration 135: an event's lifecycle (Part 2 foundation, Task 2; D1) ───────────────────────────
//
// sessions gains publication (NOT NULL DEFAULT 'published', so every existing event reads published), published_at,
// registration_opens_at, archived_at/_by and cancelled_at/_by/cancel_reason, all guarded; the bell allowlist is
// restated as 118's list plus the four event bells; the three event emails get their admin switch, on. Applied files
// are never edited: a later change is a NEW migration and this test follows it.
//
// Running the file twice is proved here by its guards (every ADD COLUMN IF NOT EXISTS, every constraint inside a
// pg_constraint check, every index IF NOT EXISTS, the allowlist dropped IF EXISTS before it is added, the email rows
// ON CONFLICT DO NOTHING), and was run twice for real on a scratch Postgres (PGlite) for the task report.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '135_event_lifecycle.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

function allowedTypes(text: string): string[] {
  const check = flat(text).match(/ADD CONSTRAINT notifications_type_check CHECK \(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (!check) throw new Error('no notifications_type_check');
  return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('migration 135 (an event\'s lifecycle)', () => {
  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds publication NOT NULL with the default published, so every existing event reads published', () => {
    expect(flat(sql)).toContain("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS publication TEXT NOT NULL DEFAULT 'published';");
    expect(flat(sql)).toContain("ALTER TABLE sessions ADD CONSTRAINT sessions_publication_check CHECK (publication IN ('draft', 'published'));");
  });

  it('adds every other lifecycle column NULL-able with no default, so existing rows read NULL (archived_at included)', () => {
    for (const column of [
      'published_at TIMESTAMPTZ NULL', 'registration_opens_at TIMESTAMPTZ NULL', 'archived_at TIMESTAMPTZ NULL',
      'archived_by UUID NULL REFERENCES users(id) ON DELETE SET NULL', 'cancelled_at TIMESTAMPTZ NULL',
      'cancelled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL', 'cancel_reason TEXT NULL',
    ]) {
      expect(flat(sql)).toContain(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ${column};`);
    }
    expect(flat(sql)).toContain('CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500)');
  });

  it('is safe to run twice: every column, constraint and index is guarded', () => {
    const adds = flat(sql).match(/ADD COLUMN/g) ?? [];
    const guarded = flat(sql).match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(adds.length).toBe(8);
    expect(guarded.length).toBe(adds.length);
    expect(flat(sql)).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_publication_check')");
    expect(flat(sql)).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_cancel_reason_check')");
    const indexes = flat(sql).match(/CREATE INDEX/g) ?? [];
    expect(indexes.length).toBe((flat(sql).match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length);
    expect(flat(sql)).toMatch(/ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;/);
    expect(flat(sql)).toMatch(/ON CONFLICT \(email_type\) DO NOTHING;$/);
  });

  it('indexes the drafts by host and the archived events', () => {
    expect(flat(sql)).toContain("CREATE INDEX IF NOT EXISTS idx_sessions_draft_host ON sessions (host_user_id) WHERE publication = 'draft';");
    expect(flat(sql)).toContain('CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON sessions (archived_at) WHERE archived_at IS NOT NULL;');
  });

  it('restates the bell allowlist as 118\'s 24 types plus the four event bells, nothing else', () => {
    const previous = allowedTypes(fs.readFileSync(path.join(MIGRATIONS, '118_notification_types_circles.sql'), 'utf8'));
    const allowed = allowedTypes(sql);
    expect(previous).toHaveLength(24);
    expect(new Set(allowed).size).toBe(allowed.length);
    expect([...allowed].sort()).toEqual(
      [...previous, 'event_cancelled', 'event_reminder', 'event_rescheduled', 'event_schedule_changed'].sort(),
    );
  });

  it('seeds the three event email switches on, never overwriting an admin\'s choice', () => {
    expect(flat(sql)).toContain(
      "INSERT INTO email_config (email_type, enabled, subject) VALUES ('event_cancelled', TRUE, 'Cancelled: {eventTitle}'), "
      + "('event_reminder', TRUE, 'Reminder: {eventTitle}'), ('event_rescheduled', TRUE, 'Rescheduled: {eventTitle}') "
      + 'ON CONFLICT (email_type) DO NOTHING;',
    );
  });

  it('is additive: nothing deleted, truncated, updated or dropped but the allowlist it restates', () => {
    const statements = code(sql).replace(/ON DELETE SET NULL/g, '').replace(/DROP CONSTRAINT IF EXISTS notifications_type_check/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });
});
