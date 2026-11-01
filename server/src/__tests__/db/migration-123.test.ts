// ─── Migration 123: feedback after a meeting (30 Oct 2026, item 5c) ──────────────────────────────
//
// "After a meeting ends, show a short prompt asking how it went and if there were any problems. Save the answers
// in the admin panel." The answers go into meeting_outcomes, the table the person brief already reads, so the
// brief keeps reading one table. 123 ties a row to its meeting (one answer per person per meeting, a second press
// edits it), says where it came from, and keeps the problems. The rows the profile's outcome sheet has written,
// and keeps writing, have no meeting and a NULL source. Applied files are never edited: a later change is a NEW
// migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { MEETING_PROBLEMS, MEETING_FEEDBACK_SOURCES } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '123_meeting_feedback.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 123 (feedback after a meeting)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is additive: nothing dropped, deleted, rewritten, renamed or backfilled', () => {
    // The meeting's foreign key says what happens to an answer when its meeting goes: that is no statement.
    const statements = code.replace(/ON DELETE SET NULL/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/notifications_type_check/);
  });

  it('adds the four columns only when they are missing', () => {
    expect(flat).toContain('ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS meeting_id UUID NULL REFERENCES meetings(id) ON DELETE SET NULL;');
    expect(flat).toContain('ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS source TEXT NULL;');
    expect(flat).toContain("ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS problems TEXT[] NOT NULL DEFAULT '{}';");
    expect(flat).toContain('ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS problem_text TEXT NULL;');
  });

  it('leaves source NULL-able, so the profile sheet\'s rows (old and new) keep a NULL source', () => {
    expect(flat).not.toMatch(/source TEXT NOT NULL/);
    expect(flat).not.toMatch(/source TEXT[^;]*DEFAULT/);
  });

  it('holds source to the shared list, NULL allowed', () => {
    const list = MEETING_FEEDBACK_SOURCES.map((s) => `'${s}'`).join(', ');
    expect(flat).toContain(`CHECK (source IS NULL OR source IN (${list}))`);
    expect([...MEETING_FEEDBACK_SOURCES]).toEqual(['meeting', 'event', 'instant']);
  });

  it('holds problems to the shared list and the text to 1000 characters', () => {
    const list = MEETING_PROBLEMS.map((p) => `'${p}'`).join(', ');
    expect(flat).toContain(`CHECK (problems <@ ARRAY[${list}]::TEXT[])`);
    expect([...MEETING_PROBLEMS]).toEqual(['audio', 'video', 'connection', 'behaviour', 'other']);
    expect(flat).toContain('CHECK (problem_text IS NULL OR char_length(problem_text) <= 1000)');
  });

  it('adds each constraint once: every one is guarded by its name, so running the file twice changes nothing', () => {
    for (const name of ['meeting_outcomes_source_check', 'meeting_outcomes_problems_check', 'meeting_outcomes_problem_text_check']) {
      expect(flat).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}')`);
      expect(flat).toContain(`ADD CONSTRAINT ${name} CHECK`);
    }
  });

  it('keeps one answer per person per meeting, and indexes the meeting and the time for the admin list', () => {
    expect(flat).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_outcomes_user_meeting ON meeting_outcomes (user_id, meeting_id) WHERE meeting_id IS NOT NULL;',
    );
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_meeting ON meeting_outcomes (meeting_id);');
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_created ON meeting_outcomes (created_at DESC, id DESC);');
  });

  it('is the conflict target the feedback upsert names, so a second press edits the row', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../services/meetings/meeting-feedback.service.ts'), 'utf8');
    expect(service.replace(/\s+/g, ' ')).toContain('ON CONFLICT (user_id, meeting_id) WHERE meeting_id IS NOT NULL DO UPDATE');
  });
});
