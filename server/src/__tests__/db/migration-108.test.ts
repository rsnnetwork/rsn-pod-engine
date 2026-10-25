// ─── Migration 108: the notification types of the 25 Oct batch (26 Oct 2026) ──
//
// notifications_type_check is an allowlist. A type missing from it makes every insert of that type
// fail in production, so the file that restates it must carry every type already allowed forward,
// and add the new ones in the same statement. 108 is the only migration of this batch that touches
// the constraint (meetings, pod walls and group chats all ring the bell with types it adds), so it
// carries the whole final list. Applied files are never edited: a later change restates the CHECK in
// a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '108_notification_types_oct25.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** SQL without its comments, so a word in a comment is never read as a statement. */
const code = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ');

/** The types a file's notifications_type_check allows, as it writes them. */
function allowedTypes(text: string, file: string): string[] {
  const check = flat(text).match(
    /ADD CONSTRAINT notifications_type_check CHECK \(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i,
  );
  if (!check) throw new Error(`${file} has no ADD CONSTRAINT notifications_type_check CHECK (type IN (...))`);
  return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

// The last definition before this one, 099_dm_system_messages.sql (lines 52-57).
const EXISTING = [
  'event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message',
  'poke', 'platform_match', 'meeting_confirmed', 'circle_post', 'poke_accepted',
  'circle_reaction', 'circle_comment', 'circle_reply',
  'incoming_call', 'availability_updated', 'meeting_proposed',
];
const ADDED = ['meeting_reminder', 'meeting_cancelled', 'pod_post', 'pod_comment', 'pod_reply', 'pod_reaction', 'group_message'];

const sorted = (values: readonly string[]) => [...values].sort();

describe('migration 108 (notification types for the 25 Oct batch)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
    expect(code(sql)).not.toMatch(/\bBEGIN\s*;/i);
    expect(code(sql)).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it('drops the old allowlist only if it is there, so running it twice is safe', () => {
    expect(flat(sql)).toMatch(/ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;/i);
  });

  it('restates the whole list in one CHECK: the 16 types 099 allowed and the 7 this batch adds, nothing else', () => {
    const allowed = allowedTypes(sql, FILE);
    expect(new Set(allowed).size).toBe(allowed.length);
    expect(sorted(allowed)).toEqual(sorted([...EXISTING, ...ADDED]));
    expect(allowed).toHaveLength(23);
  });

  it('carries forward every type the previous definition (099) allowed, read from that file itself', () => {
    const previous = allowedTypes(fs.readFileSync(path.join(MIGRATIONS, '099_dm_system_messages.sql'), 'utf8'), '099');
    expect(sorted(previous)).toEqual(sorted(EXISTING));
    expect(allowedTypes(sql, FILE)).toEqual(expect.arrayContaining(previous));
  });

  it('is the latest definition: no other migration file restates the allowlist after 099', () => {
    const restating = fs.readdirSync(MIGRATIONS)
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) > 99)
      .filter((file) => /notifications_type_check/.test(code(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))));
    expect(restating).toEqual([FILE]);
  });

  it('touches nothing but the constraint: no table, column or row is dropped, deleted or rewritten', () => {
    const statements = code(sql).replace(/DROP CONSTRAINT IF EXISTS notifications_type_check/i, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|CREATE)\b/i);
  });
});
