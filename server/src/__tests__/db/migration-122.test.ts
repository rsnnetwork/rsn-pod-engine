// ─── Migration 122: the notifications page reads a member's notifications newest first (30 Oct 2026, item 4.5) ─────
//
// The notifications page reads them thirty at a time, newest first, each page starting strictly after where the last one
// ended by (created_at, id). The only index (025: user_id, is_read, created_at) cannot give that order for one member
// without sorting all of their rows. This one can. Not CONCURRENTLY: the runner wraps the file in a transaction, and
// the table is small (about 1,200 rows on production, at most 144 for one member), so the build is instant.
// Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '122_notifications_user_created_index.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 122 (a member\'s notifications, newest first)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is exactly the one index, in the order the page reads', () => {
    expect(flat).toBe('CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC, id DESC);');
  });

  it('is not CONCURRENTLY, which cannot run inside the runner\'s transaction', () => {
    expect(flat).not.toMatch(/CONCURRENTLY/i);
  });
});
