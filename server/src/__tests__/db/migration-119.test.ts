// ─── Migration 119: the member's own picture, kept with where they placed it (30 Oct review, T3a) ──────────────
//
// "Edit button that allows to fix the size or position." The picture a member chooses is kept beside the one
// everyone sees, with the crop they chose, so they can place it again later without choosing it again; the photo's
// address carries when it changed (?v=), as the banner's does. Applied in production, where no member has any of
// this yet, so it only adds nullable columns: nothing rewritten, constrained or removed.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '119_profile_pictures.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = (migration: string) => migration.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('migration 119 (profile pictures: the kept picture and its crop)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the kept photo and banner, their types, their crops and when the photo changed, each only when missing', () => {
    const statements = code(sql).split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_source_blob BYTEA',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_source_mime VARCHAR(40)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_crop JSONB',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_source_blob BYTEA',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_source_mime VARCHAR(40)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_crop JSONB',
    ]);
  });

  it('deletes, rewrites and constrains nothing: every member keeps exactly the row they have', () => {
    expect(code(sql)).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|NOT\s+NULL|DEFAULT|CHECK)\b/i);
  });

  it('is the only migration numbered 119 (the number this programme gave the pictures)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '119')).toHaveLength(1);
  });
});
