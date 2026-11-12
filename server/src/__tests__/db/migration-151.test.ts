// ─── Migration 151: a member's public profile link (Shirley pilot S6, D5) ────────────────────────────────────────────
//
// Two nullable columns on users and a partial unique index. Running the file twice is held by its guards (each column
// only when missing, the index IF NOT EXISTS) and was run twice for real on a scratch Postgres (PGlite) for the task
// report.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '151_public_profile_link.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 151 (public profile link)', () => {
  it('is the only file numbered 151, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '151')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the token only when missing, nullable, held to 22 base64url characters', () => {
    expect(flat(sql)).toContain(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile_token VARCHAR(22) NULL CHECK (public_profile_token IS NULL OR public_profile_token ~ '^[A-Za-z0-9_-]{22}$');",
    );
    expect(flat(sql)).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile_token_created_at TIMESTAMPTZ NULL;');
  });

  it('makes a token find at most one member, indexing only the members who have a link', () => {
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_profile_token ON users (public_profile_token) WHERE public_profile_token IS NOT NULL;',
    );
  });

  it('only adds: no drop, delete, update or rename, and no default that would give every member a link', () => {
    const c = code(sql);
    expect(c).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|RENAME|DROP)\b/i);
    expect(c).not.toMatch(/\bDEFAULT\b/i);
  });
});
