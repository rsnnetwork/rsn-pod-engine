// ─── Migration 131: a 6-digit sign-in code beside the sign-in link (1 Nov 2026) ────────────────────
//
// Stefan could not sign in on 30 Oct because he expected a password, and a sign-in link only works in the
// browser that opens it. The sign-in email now also carries a 6-digit code to type on the waiting screen.
// The code is stored only as a keyed hash next to the link's own hash (code_hash), and every try is counted
// (code_attempts) so a fifth wrong code kills the link and the code together. Both columns are additive:
// every row made before them is a link with no code (code_hash NULL, no tries), which is exactly what it was.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '131_magic_link_sign_in_code.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 131 (magic_links.code_hash + code_attempts)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds columns: nothing dropped, deleted, rewritten or backfilled', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    const statements = flat.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
  });

  it('adds a nullable code_hash and a code_attempts counter that starts at 0, each only when missing', () => {
    expect(flat).toBe(
      'ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS code_hash TEXT, ADD COLUMN IF NOT EXISTS code_attempts INTEGER NOT NULL DEFAULT 0;',
    );
  });

  it('restates no constraint, index or enum', () => {
    expect(code).not.toMatch(/\b(CHECK|CONSTRAINT|INDEX|ALTER TYPE|ADD VALUE)\b/i);
  });
});
