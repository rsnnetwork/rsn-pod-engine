// ─── Migration 114: invites.declined_at (26 Oct 2026) ────────────────────────────────────────────
//
// A decline was stored as status 'revoked', the same value as an organiser withdrawing an invite, so an
// organiser could never tell "declined" from "withdrawn" (client feedback, 25 Oct). The column keeps the
// moment of the invitee's own "no". The status stays 'revoked' so production's bell and Invites page, which
// map only that value, keep working. This file is applied in production and is never edited.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '114_invites_declined_at.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 114 (invites.declined_at)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds one column: nothing dropped, deleted, rewritten or backfilled', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    const statements = flat.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
  });

  it('adds declined_at as a nullable timestamp with a time zone, only when it is missing', () => {
    expect(flat).toBe('ALTER TABLE invites ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;');
  });

  it('does not restate a constraint or an enum: a decline keeps the status it always had', () => {
    expect(code).not.toMatch(/\b(CHECK|CONSTRAINT|ALTER TYPE|ADD VALUE)\b/i);
  });
});
