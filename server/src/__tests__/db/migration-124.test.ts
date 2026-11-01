// ─── Migration 124: an answered call is a meeting of its own kind (1 Nov 2026) ───────────────────────
//
// A connection can now ring another directly (30 Oct review, item 4). Each answered call is written as a
// meetings row so it lists under Events → Past, carries attendance and is what post-meeting feedback hangs on.
// meetings.source tells the two kinds apart: 'scheduled' (a time two people agreed) and 'instant' (a call).
// Every row made before this file is a scheduled meeting, so the column defaults to that, and the conversation
// pointer, the reminder and the cancel keep reading those rows exactly as before. The second statement indexes
// a caller's own live request, which the app reads to restore its "Calling…" card after a refresh.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '124_instant_calls.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();
const statements = flat.split(';').map((s) => s.trim()).filter(Boolean);

describe('migration 124 (meetings.source; a caller\'s live request indexed)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds: nothing dropped, deleted, rewritten or backfilled', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(statements).toHaveLength(2);
  });

  it('adds meetings.source, scheduled for every row already there, allowing only scheduled and instant, once', () => {
    expect(statements[0]).toBe(
      "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'scheduled' CHECK (source IN ('scheduled', 'instant'))",
    );
  });

  it('indexes a caller\'s requests by status, only when the index is missing', () => {
    expect(statements[1]).toBe(
      'CREATE INDEX IF NOT EXISTS idx_call_requests_from_user ON call_requests (from_user_id, status)',
    );
  });

  it('adds no link from a meeting to its call request (the accept\'s claim on the request keeps it one row per call)', () => {
    expect(code).not.toMatch(/call_request_id/i);
  });
});
