// ─── Migration 102: the site a join request was made on (7 Oct 2026) ─────────
//
// An applicant who asks to join on the preview gets approval and reminder emails that
// open the preview. The request remembers the site in one new column. This file is
// applied in production and is never edited; join_requests rows are real applications
// and are never deleted or rewritten (the project's database rules), so the migration only adds.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '102_join_request_sign_in_origin.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = (migration: string) => migration.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 102 (the site a join request was made on)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds one nullable TEXT column to join_requests with no default, and only when it is missing', () => {
    const statements = code(sql).split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS sign_in_origin TEXT']);
  });

  it('deletes, rewrites and constrains nothing: the rows already there stay exactly as they are', () => {
    expect(code(sql)).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|NOT\s+NULL|DEFAULT|CHECK)\b/i);
  });
});
