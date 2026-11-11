// ─── Migration 118: circle invites ring the bell, and a circle's creator is its owner (1 Nov 2026) ─
//
// notifications_type_check is an allowlist. 'circle_invite' was never on it (migration 090 added circle invites
// without restating it), so every circle-invite bell failed to insert. 118 restates the whole list: 108's 23
// types and 'circle_invite'. It also lets circle_members.role be 'owner' and backfills every circle's creator as
// its owner. Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '118_notification_types_circles.sql';
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

const sorted = (values: readonly string[]) => [...values].sort();

describe('migration 118 (circle invites ring the bell; a creator owns the circle)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
    expect(code(sql)).not.toMatch(/\bBEGIN\s*;/i);
    expect(code(sql)).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it('drops the old allowlist only if it is there, so running it twice is safe', () => {
    expect(flat(sql)).toMatch(/ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;/i);
  });

  it('restates the whole list: the 23 types 108 allowed and circle_invite, nothing else', () => {
    const allowed = allowedTypes(sql, FILE);
    const previous = allowedTypes(
      fs.readFileSync(path.join(MIGRATIONS, '108_notification_types_oct25.sql'), 'utf8'), '108');
    expect(previous).toHaveLength(23);
    expect(new Set(allowed).size).toBe(allowed.length);
    expect(sorted(allowed)).toEqual(sorted([...previous, 'circle_invite']));
    expect(allowed).toHaveLength(24);
  });

  // 135 (Part 2 Task 2) restates it next, as 118's list plus the four event bells (migration-135.test.ts), then 145
  // (Part 3 Task 3) as 135's list plus the waiting-list bell (migration-145.test.ts).
  it('was the latest definition until 135: no other later migration but 145 restates the allowlist', () => {
    const restating = fs.readdirSync(MIGRATIONS)
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) > 108)
      .filter((file) => /notifications_type_check/.test(code(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))));
    expect(restating).toEqual([FILE, '135_event_lifecycle.sql', '145_event_waitlist.sql']);
  });

  it('lets circle_members.role be owner, keeping member and moderator', () => {
    expect(flat(sql)).toMatch(
      /ADD CONSTRAINT circle_members_role_check CHECK \(role IN \('member', 'moderator', 'owner'\)\)/i,
    );
  });

  it('backfills every circle\'s creator as owner, upgrading a creator who is only a member, and nobody else', () => {
    const text = flat(sql);
    expect(text).toMatch(
      /INSERT INTO circle_members \(circle_id, user_id, role\) SELECT c\.id, c\.created_by, 'owner' FROM circles c ON CONFLICT \(circle_id, user_id\) DO UPDATE SET role = 'owner' WHERE circle_members\.role <> 'owner';/i,
    );
    expect(text).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP TABLE\b|\bDROP COLUMN\b/i);
  });

  it('sets member_count to the number of member rows, only where it differs', () => {
    expect(flat(sql)).toMatch(
      /UPDATE circles c SET member_count = counted\.total .*FROM circle_members m WHERE m\.circle_id = c2\.id.* AND c\.member_count <> counted\.total;/i,
    );
  });
});
