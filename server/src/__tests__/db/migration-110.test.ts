// ─── Migration 110: meetings, one row per confirmed meeting (26 Oct 2026) ────
//
// 25 Oct walkthrough: Stefan and Claus agreed a time and nothing appeared under Events ("Now we've
// found a time to meet. What then?"). A confirmed meeting lived only in five columns on the pair's
// conversation, overwritten by the next one. `meetings` keeps one row per confirmed meeting (history,
// cancel, reminders, a stable calendar identity), written in the same transaction as those columns,
// which production's client still reads. Its shape is the audit's design (02-requests-booking.md
// §CON-04/05.4). The two notification types it rings with were added by migration 108, the only
// migration of this batch that restates notifications_type_check. This file is applied in production
// and never edited: a later change goes in a new migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '110_meetings.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

/** The body of `CREATE TABLE IF NOT EXISTS meetings ( … );`, one column or constraint per entry. */
function meetingsTable(): string[] {
  const match = flat.match(/CREATE TABLE IF NOT EXISTS meetings \((.*?)\);/i);
  if (!match) throw new Error(`${FILE} has no CREATE TABLE IF NOT EXISTS meetings`);
  // Split on the commas between entries, not the ones inside a CHECK (…) or REFERENCES x(y).
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of match[1]) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { entries.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  entries.push(current.trim());
  return entries;
}

/** The statement that starts with `start`, up to its semicolon. */
function statement(start: RegExp): string {
  const at = flat.search(start);
  if (at < 0) throw new Error(`${FILE} has no statement matching ${start}`);
  return flat.slice(at, flat.indexOf(';', at) + 1);
}

describe('migration 110 (meetings)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
    expect(code).not.toMatch(/\bBEGIN\s*;/i);
    expect(code).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it('creates meetings with exactly the audit\'s columns, each with its type, default and foreign key', () => {
    expect(meetingsTable()).toEqual([
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE',
      'user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      'user_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      'request_id UUID NULL REFERENCES user_pokes(id) ON DELETE SET NULL',
      'context TEXT NULL',
      'start_at TIMESTAMPTZ NOT NULL',
      'duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240)',
      "kind TEXT NOT NULL CHECK (kind IN ('audio', 'video'))",
      "status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled'))",
      'confirmed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL',
      'moved_from TIMESTAMPTZ NULL',
      'calendar_sequence INTEGER NOT NULL DEFAULT 0',
      'cancelled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL',
      'cancelled_at TIMESTAMPTZ NULL',
      'joined_a_at TIMESTAMPTZ NULL',
      'joined_b_at TIMESTAMPTZ NULL',
      'reminder_sent_at TIMESTAMPTZ NULL',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'CHECK (user_a_id < user_b_id)',
    ]);
  });

  it('stores only scheduled and cancelled: upcoming, live and ended are worked out from the time when read', () => {
    expect(meetingsTable()).toContain("status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled'))");
    // One upcoming meeting per pair is held by the conversation row lock, not an index: an ended
    // meeting keeps 'scheduled', so a unique index on it would refuse the pair's next meeting.
    expect(flat).not.toMatch(/CREATE UNIQUE INDEX/i);
  });

  it('indexes each person\'s meetings, a conversation\'s meetings, and the reminders that are due', () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_meetings_user_a ON meetings (user_a_id, start_at DESC);');
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_meetings_user_b ON meetings (user_b_id, start_at DESC);');
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_meetings_conversation ON meetings (conversation_id, start_at DESC);');
    expect(flat).toContain(
      "CREATE INDEX IF NOT EXISTS idx_meetings_due_reminder ON meetings (start_at) WHERE status = 'scheduled' AND reminder_sent_at IS NULL;",
    );
  });

  it('points the conversation at the meeting its columns describe, and forgets it if that meeting row goes', () => {
    expect(flat).toContain(
      'ALTER TABLE dm_conversations ADD COLUMN IF NOT EXISTS current_meeting_id UUID NULL REFERENCES meetings(id) ON DELETE SET NULL;',
    );
  });

  it('backfills every conversation meeting that has an exact time, once, with who booked it and who joined', () => {
    const backfill = statement(/INSERT INTO meetings/i);
    expect(backfill).toMatch(
      /^INSERT INTO meetings \(conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, confirmed_by, joined_a_at, joined_b_at, created_at\) SELECT c\.id, c\.user_a_id, c\.user_b_id, c\.meeting_start_at, /i,
    );
    // The length as it was, 30 minutes when none was stored, inside the column's 5 to 240.
    expect(backfill).toContain('LEAST(240, GREATEST(5, COALESCE(c.meeting_duration_min, 30)))');
    expect(backfill).toContain("COALESCE(c.meeting_type, 'video')");
    expect(backfill).toContain('c.meeting_confirmed_by, c.meeting_joined_a_at, c.meeting_joined_b_at, COALESCE(c.meeting_confirmed_at, NOW())');
    expect(backfill).toContain('FROM dm_conversations c');
    // A legacy day-part confirmation has no time to put under Events, so it is skipped.
    expect(backfill).toContain('WHERE c.meeting_start_at IS NOT NULL');
    // Running it again adds nothing.
    expect(backfill).toContain('AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.conversation_id = c.id)');
  });

  it('then points each backfilled conversation at its meeting, leaving one already pointed alone', () => {
    expect(statement(/UPDATE dm_conversations c SET current_meeting_id/i)).toBe(
      'UPDATE dm_conversations c SET current_meeting_id = m.id FROM meetings m WHERE m.conversation_id = c.id AND c.current_meeting_id IS NULL;',
    );
  });

  it('leaves notifications_type_check to migration 108, which already allows meeting_reminder and meeting_cancelled', () => {
    expect(code).not.toMatch(/notifications_type_check/i);
    expect(code).not.toMatch(/\bnotifications\b/i);
    const m108 = fs.readFileSync(path.join(MIGRATIONS, '108_notification_types_oct25.sql'), 'utf8');
    expect(m108).toMatch(/'meeting_reminder'/);
    expect(m108).toMatch(/'meeting_cancelled'/);
  });

  it('only adds: no table, column, constraint or row that is already there is dropped, deleted or changed', () => {
    // A foreign key's ON DELETE says what happens later, when a row goes; it deletes nothing now.
    const statements = code.replace(/\bON DELETE (CASCADE|SET NULL)\b/gi, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    // The one UPDATE fills the new column, and only where it is still empty.
    expect(statements.match(/\bUPDATE\b/gi)).toHaveLength(1);
    expect(statements.match(/\bALTER TABLE\b/gi)).toHaveLength(1);
  });

  it('creates every table, index and column only when it is missing, so running it twice is safe', () => {
    const creates = flat.match(/CREATE (UNIQUE )?(TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates.length).toBe(5);
    for (const create of creates) expect(create).toMatch(/IF NOT EXISTS/i);
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS current_meeting_id/i);
  });
});
