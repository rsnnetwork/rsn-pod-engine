// ─── Migration 152: what an entity offers (Shirley pilot S7, 11 Nov 2026; brief RSN 15) ──────────────────────────
//
// entity_services: one row per category per entity, from the shared ENTITY_SERVICE_CATEGORIES written out as a CHECK,
// with an optional 280-character description and an optional https website. Applied files are never edited: if the
// shared list changes, a NEW migration restates the CHECK and this test follows it. The file ran twice for real on
// PGlite (a scratch in-memory Postgres) for the task report, with the real service writes after it.

import * as fs from 'fs';
import * as path from 'path';
import { ENTITY_LIMITS, ENTITY_SERVICE_CATEGORIES, ENTITY_SERVICE_LABELS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '152_entity_services.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = sql.replace(/--[^\n]*/g, '');
const flat = code.replace(/\s+/g, ' ');

function tableBody(): string {
  const match = flat.match(/CREATE TABLE IF NOT EXISTS entity_services \((.*?)\);/i);
  if (!match) throw new Error(`${FILE} has no CREATE TABLE IF NOT EXISTS entity_services`);
  return match[1];
}

describe('migration 152 (entity services)', () => {
  it('is the only file numbered 152 (152 is S7\'s)', () => {
    expect(fs.readdirSync(MIGRATIONS).filter((f) => f.startsWith('152_'))).toEqual([FILE]);
  });

  it('has no top-level BEGIN, COMMIT, ROLLBACK or the like (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds: it drops, deletes, rewrites and alters nothing that is already there', () => {
    const statements = code.replace(/\bON DELETE (CASCADE|SET NULL)\b/gi, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/i);
  });

  it('is guarded, so running it twice changes nothing', () => {
    expect(flat).toMatch(/CREATE TABLE IF NOT EXISTS entity_services/);
    expect([...flat.matchAll(/CREATE INDEX (IF NOT EXISTS )?/g)].every((m) => m[1] === 'IF NOT EXISTS ')).toBe(true);
  });

  it('holds the category list exactly as shared/src/types/entity.ts has it', () => {
    const check = flat.match(/category VARCHAR\(40\) NOT NULL CHECK \(category IN \(([^)]*)\)\)/i);
    expect(check).not.toBeNull();
    const listed = [...check![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...ENTITY_SERVICE_CATEGORIES]);
    // And every category has words a member reads.
    for (const c of ENTITY_SERVICE_CATEGORIES) expect(ENTITY_SERVICE_LABELS[c]).toMatch(/^[A-Z][a-z ]+$/);
  });

  it('the plan\'s fifteen categories, in the plan\'s words', () => {
    expect(ENTITY_SERVICE_CATEGORIES.map((c) => ENTITY_SERVICE_LABELS[c])).toEqual([
      'Advisory', 'Coaching', 'Consulting', 'Design', 'Development', 'Education and training', 'Events', 'Finance', 'Funding',
      'Hiring and recruitment', 'Legal', 'Marketing', 'Mentoring', 'Research', 'Other',
    ]);
    expect(ENTITY_LIMITS.servicesMax).toBe(ENTITY_SERVICE_CATEGORIES.length);
  });

  it('every new table has its id, its created_at, and a deliberate ON DELETE on every foreign key', () => {
    const body = tableBody();
    expect(body).toMatch(/\bid UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(body).toMatch(/\bcreated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    expect(body).toMatch(/entity_id UUID NOT NULL REFERENCES entities\(id\) ON DELETE CASCADE/);
    expect(body).toMatch(/created_by UUID NULL REFERENCES users\(id\) ON DELETE SET NULL/);
    expect((body.match(/REFERENCES/g) ?? []).length).toBe((body.match(/REFERENCES \w+\(id\) ON DELETE (CASCADE|SET NULL)/g) ?? []).length);
  });

  it('a description is at most 280 characters and never only spaces; a website is https only', () => {
    const body = tableBody();
    expect(body).toContain(`description VARCHAR(${ENTITY_LIMITS.serviceDescriptionMax}) NULL CHECK (description IS NULL OR length(btrim(description)) > 0)`);
    expect(body).toContain("website VARCHAR(500) NULL CHECK (website IS NULL OR website ~* '^https://[^[:space:]]+$')");
  });

  it('one row per category per entity (also the index an entity\'s own list is read through), and the category index', () => {
    expect(tableBody()).toMatch(/CONSTRAINT uq_entity_services_category UNIQUE \(entity_id, category\)/);
    expect(flat).toMatch(/CREATE INDEX IF NOT EXISTS idx_entity_services_category ON entity_services \(category\);/);
  });
});
