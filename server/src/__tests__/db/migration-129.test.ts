// ─── Migration 129: an entity's logo and banner, and member claims that wait for approval (30 Oct review, 7.1 and 7.2) ─
//
// "Please add options to upload a company logo and banner." The pictures follow the member photo's pattern
// (migration 119): the picture everyone sees, its type and its crop beside the picture the admin chose, kept so it can
// be placed again later (L1). "Entity members need approval": every link gets a status, and the constant default
// 'active' makes every link that exists today approved (L23), so nobody already listed disappears. A change of role or
// title an active member asks for waits beside their current link in requested_role / requested_title.
// Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { ENTITY_ROLES } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '129_entity_pictures_member_status.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

const sorted = (values: readonly string[]) => [...values].sort();

describe('migration 129 (entity pictures and member status)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is additive: nothing dropped, deleted, rewritten, renamed or backfilled, and the bell allowlist is not touched', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    expect(code).not.toMatch(/notifications_type_check/);
  });

  it.each([
    ['logo_blob', 'BYTEA'], ['logo_mime', 'VARCHAR(40)'], ['logo_crop', 'JSONB'],
    ['logo_source_blob', 'BYTEA'], ['logo_source_mime', 'VARCHAR(40)'],
    ['banner_blob', 'BYTEA'], ['banner_mime', 'VARCHAR(40)'], ['banner_crop', 'JSONB'],
    ['banner_source_blob', 'BYTEA'], ['banner_source_mime', 'VARCHAR(40)'],
    ['pictures_updated_at', 'TIMESTAMPTZ'],
  ])('adds entities.%s %s, nullable, only when it is missing', (column, type) => {
    expect(flat).toContain(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS ${column} ${type};`);
  });

  it("adds entity_members.status NOT NULL with the constant default 'active', so every existing link is approved", () => {
    expect(flat).toContain("ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';");
  });

  it('holds status to pending, active, declined or removed, guarded by the constraint name so a second run changes nothing', () => {
    expect(flat).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_members_status_check')");
    expect(flat).toContain(
      "ALTER TABLE entity_members ADD CONSTRAINT entity_members_status_check CHECK (status IN ('pending', 'active', 'declined', 'removed'));",
    );
  });

  it('adds the change an active member asks for, and when they asked, nullable', () => {
    expect(flat).toContain('ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS requested_role VARCHAR(40);');
    expect(flat).toContain('ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS requested_title VARCHAR(120);');
    expect(flat).toContain('ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;');
  });

  it('holds requested_role to the shared role list (or none), guarded by its constraint name', () => {
    expect(flat).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_members_requested_role_check')");
    const check = flat.match(/CHECK \(requested_role IS NULL OR requested_role IN \(([^)]*)\)\)/);
    expect(check).not.toBeNull();
    expect(sorted([...check![1].matchAll(/'([^']*)'/g)].map((m) => m[1]))).toEqual(sorted(ENTITY_ROLES));
  });

  it("indexes an entity's waiting requests, oldest first", () => {
    expect(flat).toContain(
      "CREATE INDEX IF NOT EXISTS idx_entity_members_requests ON entity_members (entity_id, requested_at) WHERE status = 'pending' OR requested_role IS NOT NULL;",
    );
  });
});
