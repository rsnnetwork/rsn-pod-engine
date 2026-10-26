// ─── Migration 117: an admin switch for meeting reminder emails (26 Oct 2026) ─
//
// The reminder 10 minutes before a meeting emails each person whose notify_email is on, and only while the
// admin email switch for 'meeting_reminder' is on. That switch is an email_config row, which the admin
// dashboard lists and toggles; a type with no row fails open, so the emails went out with nothing for an
// admin to switch off. 117 seeds the row, on, the way 082 seeded the request emails. Applied files are never
// edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '117_meeting_reminder_email_config.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** SQL without its comments, so a word in a comment is never read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 117 (an admin switch for meeting reminder emails)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is one statement: it seeds the meeting_reminder row, on, with the subject the admin list shows', () => {
    expect(flat).toBe(
      "INSERT INTO email_config (email_type, enabled, subject) VALUES ('meeting_reminder', TRUE, 'Your meeting with {name} starts in 10 minutes') ON CONFLICT (email_type) DO NOTHING;",
    );
  });

  it('never overwrites a switch an admin has already set, so running it twice changes nothing', () => {
    expect(flat).toMatch(/ON CONFLICT \(email_type\) DO NOTHING;$/);
    expect(flat).not.toMatch(/\b(UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it('seeds the very type the reminder worker asks email_config about', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../../services/meetings/meeting-reminder.worker.ts'), 'utf8');
    expect(worker).toMatch(/const MEETING_REMINDER_EMAIL_TYPE = 'meeting_reminder';/);
    expect(worker).toMatch(/isEmailTypeEnabled\(MEETING_REMINDER_EMAIL_TYPE\)/);
  });
});
