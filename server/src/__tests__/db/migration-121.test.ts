// ─── Migration 121: a message may answer another one (30 Oct 2026 review, item 4.3) ───────────────────────────────
//
// Stefan: "In messages ... you can't reply." A reply quotes one earlier message of the same conversation or group.
// Messages, one-to-one and group alike, live in one table, direct_messages (045; groups through group_id, 052), so a
// reply is one column there: the message it answers. ON DELETE SET NULL: a reply outlives the message it quoted. The
// partial index serves that very rule: deleting a message looks up the replies that point at it, and without an index
// that is a scan of every message for each one deleted (closing an account deletes all of its messages at once).
// Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '121_message_replies.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** SQL without its comments, so a word in a comment is never read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 121 (a message may answer another one)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds one column to direct_messages: the message it answers, cleared if that message is ever deleted', () => {
    expect(flat).toContain(
      'ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES direct_messages(id) ON DELETE SET NULL;',
    );
  });

  it('indexes the column only where it is set, for the lookup that deleting a message makes', () => {
    expect(flat).toContain(
      'CREATE INDEX IF NOT EXISTS idx_direct_messages_reply_to ON direct_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;',
    );
  });

  it('is additive and safe to run twice: nothing is dropped, rewritten or filled in', () => {
    expect(flat.split(';').filter((s) => s.trim()).length).toBe(2);
    expect(flat.replace('ON DELETE SET NULL', '')).not.toMatch(/\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
  });
});
