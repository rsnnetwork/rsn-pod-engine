// ─── Migration 121: a message may answer another one (30 Oct 2026 review, item 4.3) ───────────────────────────────
//
// Stefan: "In messages ... you can't reply." A reply quotes one earlier message of the same conversation or group.
// Messages, one-to-one and group alike, live in one table, direct_messages (045; groups through group_id, 052), so a
// reply is one column there: the message it answers. A plain column, no foreign key (controller ruling, T6 fix round 1):
// when the original is gone the reply still points at it and reads "Original message deleted"; ON DELETE SET NULL would
// have erased that and left the reply unquoted. An earlier draft created the key on the scratch database, so the file
// drops it if it exists. The partial index holds only the replies. Applied files are never edited once on production:
// a later change is a NEW migration and this test follows it.

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

  it('adds one plain column to direct_messages: the message it answers, kept when that message is deleted', () => {
    expect(flat).toContain('ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_id UUID;');
    expect(flat).not.toMatch(/REFERENCES|ON DELETE/);
  });

  it('drops the foreign key an earlier draft made, if it is there, so every database ends in the same shape', () => {
    expect(flat).toContain('ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_reply_to_id_fkey;');
  });

  it('indexes the column only where it is set', () => {
    expect(flat).toContain(
      'CREATE INDEX IF NOT EXISTS idx_direct_messages_reply_to ON direct_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;',
    );
  });

  it('is additive and safe to run twice: the one DROP is that constraint, never a column or a table, and nothing is rewritten', () => {
    expect(flat.split(';').filter((s) => s.trim()).length).toBe(3);
    const rest = flat.replace('DROP CONSTRAINT IF EXISTS direct_messages_reply_to_id_fkey', '');
    expect(rest).not.toMatch(/\b(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
  });
});
