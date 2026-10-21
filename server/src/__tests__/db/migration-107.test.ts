// ─── Migration 107: entities, and the people linked to them (21 Oct 2026) ────
//
// An Entity is an organisation people relate to with a typed role (Strategic Foundation, "ENTITY"),
// and members create their own (client feedback, 19 Oct: "Users should be able to create an Entity
// (their company) themselves"). This file is applied in production and is never edited: if a shared
// list changes, a NEW migration restates the CHECK and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { ENTITY_KINDS, ENTITY_ROLES } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '107_entities.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ');

/** One CREATE TABLE statement, from its name to the closing `);`. */
function tableBody(table: string): string {
  const match = flat.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.*?)\\);`, 'i'));
  if (!match) throw new Error(`${FILE} has no CREATE TABLE IF NOT EXISTS ${table}`);
  return match[1];
}

/** The values a `CHECK (<column> IN ('a', 'b'))` allows, as the migration writes them. */
function allowedBy(column: string): string[] {
  const check = flat.match(new RegExp(`CHECK \\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i'));
  if (!check) throw new Error(`${FILE} has no CHECK (${column} IN (...))`);
  return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const sorted = (values: readonly string[]) => [...values].sort();

describe('migration 107 (entities)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds: it drops, deletes, rewrites and alters nothing that is already there', () => {
    // A foreign key's ON DELETE says what happens later, when a row goes; it deletes nothing now.
    const statements = code.replace(/\bON DELETE (CASCADE|SET NULL)\b/gi, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/i);
  });

  it('creates entities with the columns the brief names, idempotently', () => {
    const body = tableBody('entities');
    expect(body).toMatch(/\bid UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(body).toMatch(/\bname VARCHAR\(200\) NOT NULL CHECK \(length\(btrim\(name\)\) >= 2\)/i);
    expect(body).toMatch(/\bkind VARCHAR\(40\) NOT NULL CHECK \(kind IN/i);
    expect(body).toMatch(/\babout TEXT\b/i);
    expect(body).toMatch(/\blocation VARCHAR\(200\)/i);
    expect(body).toMatch(/\bsize VARCHAR\(40\)/i);
    expect(body).toMatch(/\bwebsite VARCHAR\(500\)/i);
    expect(body).toMatch(/\bcreated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(body).toMatch(/\bupdated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(body).toMatch(/\barchived_at TIMESTAMPTZ\b/i);
  });

  it('keeps an entity when the member who made it goes, and forgets only who made it', () => {
    expect(tableBody('entities')).toMatch(/\bcreated_by UUID REFERENCES users\(id\) ON DELETE SET NULL/i);
  });

  it('creates entity_members keyed on the entity and the person, each going when either does', () => {
    const body = tableBody('entity_members');
    expect(body).toMatch(/\bentity_id UUID NOT NULL REFERENCES entities\(id\) ON DELETE CASCADE/i);
    expect(body).toMatch(/\buser_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
    expect(body).toMatch(/\brole VARCHAR\(40\) NOT NULL CHECK \(role IN/i);
    expect(body).toMatch(/\btitle VARCHAR\(120\)/i);
    expect(body).toMatch(/\bis_admin BOOLEAN NOT NULL DEFAULT false/i);
    expect(body).toMatch(/\bcreated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(body).toMatch(/PRIMARY KEY \(entity_id, user_id\)/i);
  });

  // The routes and the client read the shared lists; the database CHECKs are the same lists written out.
  it('its CHECK lists are the shared lists', () => {
    expect(sorted(allowedBy('kind'))).toEqual(sorted(ENTITY_KINDS));
    expect(sorted(allowedBy('role'))).toEqual(sorted(ENTITY_ROLES));
  });

  it('allows one active entity per name, whatever its case or outer spaces, and frees the name of an archived one', () => {
    expect(flat).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_active_name ON entities \(lower\(btrim\(name\)\)\) WHERE archived_at IS NULL;/i,
    );
  });

  it('indexes the lookups the service makes: a member\'s entities, who made one, the recent list and the name search', () => {
    expect(flat).toMatch(/CREATE INDEX IF NOT EXISTS idx_entity_members_user ON entity_members \(user_id\);/i);
    expect(flat).toMatch(/CREATE INDEX IF NOT EXISTS idx_entities_created_by ON entities \(created_by\);/i);
    expect(flat).toMatch(/CREATE INDEX IF NOT EXISTS idx_entities_active_recent ON entities \(updated_at DESC\) WHERE archived_at IS NULL;/i);
    expect(flat).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING gin \(name gin_trgm_ops\) WHERE archived_at IS NULL;/i,
    );
  });

  it('creates every table and index only when it is missing', () => {
    const creates = flat.match(/CREATE (UNIQUE )?(TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates.length).toBe(7);
    for (const statement of creates) expect(statement).toMatch(/IF NOT EXISTS/i);
  });
});
