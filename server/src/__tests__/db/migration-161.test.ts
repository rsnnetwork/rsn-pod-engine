// ─── Migration 161: pods inside pods (Stefan, 22 Nov 2026) ──────────────────────────────────────────────────────
//
// "A pod can be a main pod, like a circle", and whether people must be in the main pod first is the pod owner's choice.
// pods gains parent_pod_id (the main pod it is inside; SET NULL when that pod is deleted for good, never itself) and
// inner_pods_members_only (off for every pod). Nothing existing moves: no pod is put inside another and nobody is
// taken out of a pod. Applied files are never edited.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '161_nested_pods.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const flat = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

describe('migration 161 (nested pods)', () => {
  it('is the only file numbered 161, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '161')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the main pod link only when missing, nullable, to pods, and SET NULL when the main pod is deleted', () => {
    expect(flat(sql)).toContain(
      'ALTER TABLE pods ADD COLUMN IF NOT EXISTS parent_pod_id UUID NULL REFERENCES pods(id) ON DELETE SET NULL;',
    );
  });

  it('adds the members-only choice only when missing, NOT NULL and off for every pod', () => {
    expect(flat(sql)).toContain('ALTER TABLE pods ADD COLUMN IF NOT EXISTS inner_pods_members_only BOOLEAN NOT NULL DEFAULT false;');
  });

  it('keeps a pod out of itself with a CHECK dropped before it is added (safe to run twice)', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE pods DROP CONSTRAINT IF EXISTS pods_parent_pod_not_self_check;');
    expect(f).toContain('ALTER TABLE pods ADD CONSTRAINT pods_parent_pod_not_self_check CHECK (parent_pod_id IS NULL OR parent_pod_id <> id);');
    expect(f.indexOf('DROP CONSTRAINT IF EXISTS pods_parent_pod_not_self_check'))
      .toBeLessThan(f.indexOf('ADD CONSTRAINT pods_parent_pod_not_self_check'));
  });

  it('indexes the link for the "pods inside" read', () => {
    expect(flat(sql)).toContain('CREATE INDEX IF NOT EXISTS idx_pods_parent_pod_id ON pods (parent_pod_id) WHERE parent_pod_id IS NOT NULL;');
  });

  it('moves nothing: no pod is put inside another and no membership is touched', () => {
    const f = flat(sql);
    // No statement writes rows (the only DELETE is the foreign key's ON DELETE SET NULL).
    expect(f.split(';').map((st) => st.trim()).filter((st) => /^(UPDATE|INSERT|DELETE|TRUNCATE)\b/i.test(st))).toEqual([]);
    expect(f.replace(/ON DELETE SET NULL/g, '')).not.toMatch(/\bDELETE\b/i);
    expect(f).not.toMatch(/pod_members/);
  });
});
