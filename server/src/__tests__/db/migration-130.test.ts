// ─── Migration 130: entities linked to circles (30 Oct review, 7.3; L23) ─────────────────────────────────────
//
// "An entity should be linkable to one or more Circles." A table of links, one per circle and entity, each going
// with either side when it is deleted (both are archived, never deleted, so in practice the links stay).
// Applied files are never edited: a later change is a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '130_circle_entities.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 130 (circle_entities)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is additive: nothing dropped, deleted, rewritten or backfilled', () => {
    const statements = code.replace(/ON DELETE (CASCADE|SET NULL)/g, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME|ALTER)\b/i);
  });

  it('creates circle_entities with a uuid id, both sides going with their rows, who linked it and when', () => {
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS circle_entities (');
    expect(flat).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(flat).toContain('circle_id UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE');
    expect(flat).toContain('entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE');
    expect(flat).toContain('created_by UUID REFERENCES users(id) ON DELETE SET NULL');
    expect(flat).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(flat).toContain('UNIQUE (circle_id, entity_id)');
  });

  it("indexes an entity's circles (the unique pair already serves a circle's entities)", () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_circle_entities_entity ON circle_entities (entity_id);');
  });

  it('is the conflict target the link insert names, so linking twice adds nothing', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../services/circle/circle-entities.service.ts'), 'utf8');
    expect(service.replace(/\s+/g, ' ')).toContain('ON CONFLICT (circle_id, entity_id) DO NOTHING');
  });
});
