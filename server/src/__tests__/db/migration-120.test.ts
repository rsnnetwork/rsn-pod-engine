// ─── Migration 120: user_pokes.reason_line (30 Oct 2026) ─────────────────────────────────────────
//
// A meeting request had one text, user_pokes.message, holding the member's note, REASON's own line, or both
// run together, and every screen drew it in the sender's voice (Stefan, 30 Oct: "It looks like the sender
// wrote it"). The column keeps REASON's line apart from the note from now on. No backfill: rows written
// before it keep their one text, which the server splits when it reads them (services/poke/request-text.ts).
// This file is applied in production and is never edited: a later change is a NEW migration.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '120_request_reason_line.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 120 (user_pokes.reason_line)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is one statement: it adds reason_line as nullable text, only when it is missing', () => {
    expect(flat).toBe('ALTER TABLE user_pokes ADD COLUMN IF NOT EXISTS reason_line TEXT;');
  });

  it('only adds: nothing dropped, deleted, rewritten or backfilled, and the old rows keep their message', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/\b(CHECK|CONSTRAINT|NOT NULL|DEFAULT)\b/i);
  });
});
