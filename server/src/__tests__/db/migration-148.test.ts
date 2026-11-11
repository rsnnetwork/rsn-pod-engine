// ─── Migration 148: community authority and pod visibility (Shirley pilot S2, 11 Nov 2026; D2, D3) ──────────────────
//
// One owner per circle (a data check, then a unique partial index), "invite only" pods mapped to Private with the
// three settings held by a CHECK and Private the default, and users.show_communities for S3. Applied files are never
// edited: a later change is a NEW migration and this test follows it. The file ran twice for real on PGlite (a scratch
// in-memory Postgres) for the task report, with the real role and handover statements after it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '148_community_authority_and_visibility.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 148 (community authority and pod visibility)', () => {
  it('is the next file in sequence, and 148 is S2\'s alone', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_/.test(f));
    expect(files.filter((f) => f.startsWith('148_'))).toEqual([FILE]);
  });

  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('demotes any extra owner to moderator before the index, keeping the maker (or the first to join), and counts it', () => {
    const f = flat(sql);
    expect(f).toContain("ORDER BY (m.user_id = c.created_by) DESC, m.joined_at ASC, m.user_id ASC");
    expect(f).toContain("UPDATE circle_members m SET role = 'moderator' FROM ranked r WHERE m.circle_id = r.circle_id AND m.user_id = r.user_id AND r.place > 1;");
    expect(f).toContain("RAISE NOTICE '148: % extra circle owner row(s) became moderator', demoted;");
    expect(f.indexOf("SET role = 'moderator'")).toBeLessThan(f.indexOf('CREATE UNIQUE INDEX'));
  });

  it('makes the maker the owner of an ownerless circle only when they are still in it; never inserts anyone', () => {
    const f = flat(sql);
    expect(f).toContain("WHERE c.id = m.circle_id AND m.user_id = c.created_by AND m.role <> 'owner' AND NOT EXISTS (SELECT 1 FROM circle_members o WHERE o.circle_id = c.id AND o.role = 'owner');");
    expect(f).not.toMatch(/INSERT INTO circle_members/);
  });

  it('one owner per circle from now on: a guarded unique partial index', () => {
    expect(flat(sql)).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_members_one_owner ON circle_members (circle_id) WHERE role = 'owner';");
  });

  it('maps invite-only pods to private (the more private setting), merges any request-to-join row, and counts both', () => {
    const f = flat(sql);
    expect(f).toContain("UPDATE pods SET visibility = 'private', updated_at = NOW() WHERE visibility::text = 'invite_only';");
    expect(f).toContain("UPDATE pods SET visibility = 'public_with_approval', updated_at = NOW() WHERE visibility::text = 'request_to_join';");
    expect(f).toMatch(/RAISE NOTICE '148: % invite-only pod\(s\) became private; % request-to-join pod\(s\) became public with approval', retired, merged;/);
  });

  it('holds pods to the three settings with a CHECK added only once, and makes Private the default', () => {
    const f = flat(sql);
    expect(f).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pods_visibility_three_settings') THEN ALTER TABLE pods ADD CONSTRAINT pods_visibility_three_settings CHECK (visibility::text IN ('private', 'public_with_approval', 'public'));");
    expect(f).toContain("ALTER TABLE pods ALTER COLUMN visibility SET DEFAULT 'private';");
    // The data is mapped before the CHECK, so no existing row can fail it.
    expect(f.indexOf("visibility::text = 'invite_only'")).toBeLessThan(f.indexOf('ADD CONSTRAINT pods_visibility_three_settings'));
  });

  it('adds users.show_communities, guarded, on by default', () => {
    expect(flat(sql)).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS show_communities BOOLEAN NOT NULL DEFAULT TRUE;');
  });

  it('drops nothing and deletes nothing', () => {
    expect(flat(sql)).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });
});
