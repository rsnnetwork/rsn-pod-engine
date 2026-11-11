// ─── Migration 150: what a report names, and the sent-invitation log (Shirley Palmer's item 16 and RSN 09) ──────────
//
// user_reports gains subject_kind / subject_id / subject_excerpt (a message or wall post, and a copy of its words kept
// as evidence), held together and to 2000 characters, with the two indexes the 24-hour repeat check reads.
// meeting_invite_emails is one row per person, meeting, calendar SEQUENCE and method, claimed before an invitation is
// sent, so a retried booking never emails twice. Applied files are never edited: a later change is a NEW migration.
//
// Running the file twice is held here by its guards and was run twice for real on a scratch Postgres (PGlite,
// s5-pglite.mjs) for the task report.

import * as fs from 'fs';
import * as path from 'path';
import { REPORT_SUBJECT_KINDS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '150_report_subjects_and_invite_log.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 150 (report subjects; sent-invitation log)', () => {
  it('is the only file numbered 150, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '150')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the three report columns only when missing, all nullable (a member report names nothing else)', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS subject_kind VARCHAR(20) NULL;');
    expect(f).toContain('ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS subject_id UUID NULL;');
    expect(f).toContain('ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS subject_excerpt TEXT NULL;');
  });

  it('holds the kind to the shared list, the kind and id together, and the copy to 2000 characters; each CHECK dropped before it is added', () => {
    const f = flat(sql);
    const kinds = REPORT_SUBJECT_KINDS.map((k) => `'${k}'`).join(', ');
    expect(f).toContain(`CHECK (subject_kind IS NULL OR subject_kind IN (${kinds}))`);
    expect(f).toContain('CHECK ((subject_kind IS NULL) = (subject_id IS NULL))');
    expect(f).toContain('CHECK (subject_excerpt IS NULL OR length(subject_excerpt) <= 2000)');
    for (const name of ['user_reports_subject_kind_check', 'user_reports_subject_pair_check', 'user_reports_subject_excerpt_len']) {
      expect(f).toContain(`ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS ${name};`);
      expect(f).toContain(`ALTER TABLE user_reports ADD CONSTRAINT ${name}`);
    }
  });

  it('indexes the repeat check by reporter and member, and by reporter and subject, newest first', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_reported ON user_reports (reporter_id, reported_id, created_at DESC);');
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_subject ON user_reports (reporter_id, subject_kind, subject_id, created_at DESC) WHERE subject_id IS NOT NULL;');
  });

  it('the invitation log: one row per person, meeting, SEQUENCE and method, gone with the meeting or the person', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS meeting_invite_emails (');
    expect(f).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(f).toContain('meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE');
    expect(f).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(f).toContain("CHECK (method IN ('REQUEST', 'CANCEL'))");
    expect(f).toContain("CHECK (status IN ('sending', 'sent', 'failed', 'no_provider', 'no_address'))");
    expect(f).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(f).toContain('CONSTRAINT meeting_invite_emails_once UNIQUE (meeting_id, user_id, sequence, method)');
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_meeting_invite_emails_user ON meeting_invite_emails (user_id);');
  });

  it('the service claims against exactly that unique key', () => {
    const svc = fs.readFileSync(path.join(__dirname, '../../services/meetings/meeting-invite-emails.ts'), 'utf8');
    expect(svc).toContain('ON CONFLICT (meeting_id, user_id, sequence, method) DO UPDATE');
  });

  it('only adds: no drop of a table or column, no delete, no update of existing rows', () => {
    const c = code(sql);
    // "ON DELETE CASCADE" is a foreign key's rule, not a delete.
    expect(c.replace(/ON DELETE CASCADE/g, '')).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
    expect(c).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    // The DROPs are the three CHECKs' own, so a second run puts them back the same.
    expect(c.match(/\bDROP\b/gi)).toHaveLength(3);
  });
});
