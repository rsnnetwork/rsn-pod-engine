// ─── Migration 125: who can join an event (T11, 1 Nov 2026; L17) ─────────────────────────────────
//
// sessions.visibility (NULL keeps the pod's rules) and event_join_requests (a request for a place, never a
// participant row). Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { EVENT_VISIBILITY_KEYS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '125_event_visibility.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 125 (who can join an event)', () => {
  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is additive: nothing dropped, deleted, rewritten, renamed or backfilled, and no bell type touched', () => {
    const statements = code.replace(/ON DELETE (CASCADE|SET NULL)/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/notifications_type_check/);
  });

  it('adds sessions.visibility as a NULL-able column with no default, so every existing event stays NULL', () => {
    expect(flat).toContain('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility TEXT NULL;');
    expect(flat).not.toMatch(/visibility TEXT[^;]*DEFAULT/);
  });

  it('holds visibility to the shared list, NULL allowed, under a guarded constraint', () => {
    const list = [...EVENT_VISIBILITY_KEYS].sort().map((v) => `'${v}'`).join(', ');
    expect(list).toBe("'private', 'public', 'public_with_approval'");
    expect(flat).toContain("CHECK (visibility IS NULL OR visibility IN ('public', 'public_with_approval', 'private'))");
    expect(flat).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_visibility_check')");
  });

  it('indexes the events that carry a visibility', () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_sessions_visibility ON sessions (visibility) WHERE visibility IS NOT NULL;');
  });

  it('creates event_join_requests with one request per person per event and the four statuses', () => {
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS event_join_requests (');
    expect(flat).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(flat).toContain('session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect(flat).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(flat).toContain("status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn'))");
    expect(flat).toContain('message TEXT NULL CHECK (message IS NULL OR char_length(message) <= 500)');
    expect(flat).toContain('decided_by UUID NULL REFERENCES users(id) ON DELETE SET NULL');
    expect(flat).toContain('decided_at TIMESTAMPTZ NULL');
    expect(flat).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(flat).toContain('UNIQUE (session_id, user_id)');
  });

  it('indexes the pending requests of an event and a person\'s own requests', () => {
    expect(flat).toContain("CREATE INDEX IF NOT EXISTS idx_event_join_requests_pending ON event_join_requests (session_id) WHERE status = 'pending';");
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_event_join_requests_user ON event_join_requests (user_id);');
  });
});
