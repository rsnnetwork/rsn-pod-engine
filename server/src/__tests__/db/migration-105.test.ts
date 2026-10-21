// ─── Migration 105: a banner a member can change (21 Oct 2026) ────────────────
//
// "Users should be able to change their banner from their profile" (19 Oct feedback). The picture is kept
// in the users row, like the stored LinkedIn photo, and served by GET /api/users/:id/banner. The file is
// applied in production, where every existing member has no banner, so it only adds: three nullable
// columns, nothing rewritten, constrained or removed.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '105_user_banner.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = (migration: string) => migration.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 105 (the member banner)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the picture, its type and when it changed to users, each only when it is missing', () => {
    const statements = code(sql).split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_blob BYTEA',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_mime VARCHAR(40)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_updated_at TIMESTAMPTZ',
    ]);
  });

  it('deletes, rewrites and constrains nothing: every member keeps exactly the row they have', () => {
    expect(code(sql)).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|NOT\s+NULL|DEFAULT|CHECK)\b/i);
  });

  it('is the only migration numbered 105 (the number this batch gave the banner)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '105')).toHaveLength(1);
  });
});
