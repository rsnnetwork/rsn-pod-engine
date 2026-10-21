// ─── Migration 103: LinkedIn is optional on a join request (21 Oct 2026) ─────
//
// The client asked on 19 Oct: "LinkedIn should not be required. Recommend LinkedIn, but let people add it
// later." join_requests.linkedin_url was NOT NULL (migration 003), so a request without one could not be
// stored. The migration lifts only that one constraint. This file is applied in production and is never
// edited; join_requests rows are real applications and are never deleted or rewritten (the project's
// database rules), so the migration changes nothing that is already there.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '103_join_request_linkedin_optional.sql';

/** The migration's text. Throws when the file is missing, so a test that reads it can never pass on nothing. */
const migration = () => fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 103 (LinkedIn is optional on a join request)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(migration())).toEqual([]);
  });

  it('does one thing: lets join_requests.linkedin_url be empty', () => {
    const statements = code(migration()).split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE join_requests ALTER COLUMN linkedin_url DROP NOT NULL']);
  });

  it('drops no table or column, and deletes and rewrites no row: the requests already there stay exactly as they are', () => {
    expect(code(migration())).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)|DELETE|TRUNCATE|UPDATE|INSERT|SET\s+NOT\s+NULL|ADD)\b/i);
  });
});
