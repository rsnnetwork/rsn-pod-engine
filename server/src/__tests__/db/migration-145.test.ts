// ─── Migration 145: an event's waiting list (10 Nov 2026 spec, Part 3 Task 3; plan K3) ──────────────────────
//
// event_waitlist is its own table (never a participant status), with the line's two partial indexes; the bell allowlist
// is restated as 135's list plus 'event_waitlist_promoted'; the promotion email's admin switch is seeded on. Applied
// files are never edited: a later change is a NEW migration and this test follows it.
//
// Running the file twice is held here by its guards (CREATE TABLE / INDEX IF NOT EXISTS, the allowlist dropped IF
// EXISTS before it is added, the email row ON CONFLICT DO NOTHING) and was run twice for real on a scratch Postgres
// (PGlite, t3-pglite.mjs) for the task report.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '145_event_waitlist.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

function allowedTypes(text: string): string[] {
  const check = flat(text).match(/ADD CONSTRAINT notifications_type_check CHECK \(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (!check) throw new Error('no notifications_type_check');
  return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('migration 145 (an event\'s waiting list)', () => {
  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('makes event_waitlist with an id, its timestamps, both foreign keys cascading and one row per person and event', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS event_waitlist (');
    expect(f).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(f).toContain('session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect(f).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(f).toContain('decided_by UUID NULL REFERENCES users(id) ON DELETE SET NULL');
    expect(f).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(f).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(f).toContain('queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(f).toContain('UNIQUE (session_id, user_id)');
    // Every foreign key states what a delete does (the fourth is the invite's, below).
    const references = f.match(/REFERENCES [a-z_]+\([a-z_]+\) ON DELETE [A-Z ]+?(?=[,;)])/g) ?? [];
    expect(references).toHaveLength(4);
    for (const ref of references) expect(ref).toMatch(/ON DELETE (CASCADE|SET NULL)$/);
  });

  it('remembers the invite that queued the person (fix round 3): guarded, set to NULL when the invite is deleted, indexed', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE event_waitlist ADD COLUMN IF NOT EXISTS invite_id UUID NULL REFERENCES invites(id) ON DELETE SET NULL;');
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_event_waitlist_invite ON event_waitlist (invite_id) WHERE invite_id IS NOT NULL;');
    expect((f.match(/ADD COLUMN/g) ?? []).length).toBe((f.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
  });

  it('holds the statuses, the ways in and a short lapse reason to their lists', () => {
    const f = flat(sql);
    expect(f).toContain("status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'promoted', 'left', 'removed', 'lapsed'))");
    expect(f).toContain("joined_via TEXT NOT NULL CHECK (joined_via IN ('register', 'call_link', 'approval', 'invite'))");
    expect(f).toContain("group_keys TEXT[] NOT NULL DEFAULT '{}'");
    expect(f).toContain('lapsed_reason TEXT NULL CHECK (lapsed_reason IS NULL OR char_length(lapsed_reason) <= 64)');
  });

  it('indexes the line in its order and a person\'s waiting places, both only for rows still waiting', () => {
    const f = flat(sql);
    expect(f).toContain("CREATE INDEX IF NOT EXISTS idx_event_waitlist_line ON event_waitlist (session_id, queued_at, id) WHERE status = 'waiting';");
    expect(f).toContain("CREATE INDEX IF NOT EXISTS idx_event_waitlist_user ON event_waitlist (user_id) WHERE status = 'waiting';");
  });

  it('restates the bell allowlist as 135\'s full list plus the waiting-list bell, nothing else', () => {
    const previous = allowedTypes(fs.readFileSync(path.join(MIGRATIONS, '135_event_lifecycle.sql'), 'utf8'));
    const allowed = allowedTypes(sql);
    expect(previous).toHaveLength(28);
    expect(new Set(allowed).size).toBe(allowed.length);
    expect([...allowed].sort()).toEqual([...previous, 'event_waitlist_promoted'].sort());
    expect(flat(sql)).toContain('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;');
  });

  it('seeds the promotion email switch on, never overwriting an admin\'s choice', () => {
    expect(flat(sql)).toContain(
      "INSERT INTO email_config (email_type, enabled, subject) VALUES ('event_waitlist_promoted', TRUE, 'You''re in: {eventTitle}') "
      + 'ON CONFLICT (email_type) DO NOTHING;',
    );
  });

  it('is additive: nothing deleted, truncated, updated, renamed or dropped but the allowlist it restates', () => {
    const statements = code(sql).replace(/ON DELETE (CASCADE|SET NULL)/g, '').replace(/DROP CONSTRAINT IF EXISTS notifications_type_check/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });
});
