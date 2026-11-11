// ─── Migration 149: wall edits and the moderation trail (Shirley pilot S4, 11 Nov 2026) ─────────────────────────────
//
// Additive only: edited_at and deleted_by on both comment tables, deleted_by on circle_posts, and the circle wall's pinned
// index. Every statement is guarded so the file can run twice; it writes no row. The file ran twice for real on PGlite
// (a scratch in-memory Postgres) for the task report, with the services' new statements after it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '149_wall_edit_and_moderation.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 149 (wall edits and the moderation trail)', () => {
  it('is 149, and 149 is S4\'s alone', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_/.test(f));
    expect(files.filter((f) => f.startsWith('149_'))).toEqual([FILE]);
  });

  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the edit stamp to both comment tables (the post tables have had theirs since 077 and 115)', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE pod_post_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ NULL;');
    expect(f).toContain('ALTER TABLE circle_post_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ NULL;');
  });

  it('records who removed a comment or a circle post, and keeps the record if that account row is ever deleted', () => {
    const f = flat(sql);
    for (const table of ['pod_post_comments', 'circle_post_comments', 'circle_posts']) {
      expect(f).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;`);
    }
  });

  it('indexes a circle\'s pinned strip, as the pod wall\'s is (newest pin first, live posts only)', () => {
    expect(flat(sql)).toContain(
      'CREATE INDEX IF NOT EXISTS idx_circle_posts_pinned ON circle_posts (circle_id, pinned_at DESC) WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;',
    );
  });

  it('every statement is guarded, and nothing is dropped, deleted, written or made NOT NULL', () => {
    const statements = code(sql).split(';').map((st) => st.replace(/\s+/g, ' ').trim()).filter(Boolean);
    expect(statements).toHaveLength(6);
    for (const st of statements) expect(st).toMatch(/IF NOT EXISTS/);
    expect(flat(sql)).not.toMatch(/\bDROP\b|DELETE FROM|\bUPDATE \w+ SET|INSERT INTO|TRUNCATE|SET NOT NULL|NOT NULL DEFAULT/i);
  });
});
