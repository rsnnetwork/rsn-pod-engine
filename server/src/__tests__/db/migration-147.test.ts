// ─── Migration 147: who may override group rules, and the Buyers and vendors preset (Part 3 Task 12) ──────────────
//
// event_matching_rules.override_by holds the owner's choice ('owner' or 'owner_and_cohosts'); every row there before
// the column reads 'owner', today's rule (the owner and super admins only). A fifth speed-networking preset, Buyers and
// vendors, with the Founders and investors weights (migration 126), the fixed id the forms start on
// (shared MATCHING_PRESET_IDS.buyersVendors). Applied files are never edited: a later change is a NEW migration.
//
// Running the file twice is held here by its guards (the column only when missing, the CHECK dropped IF EXISTS before
// it is added, the row ON CONFLICT DO NOTHING) and was run twice for real on a scratch Postgres (PGlite,
// t12-pglite.mjs) for the task report.

import * as fs from 'fs';
import * as path from 'path';
import { MATCHING_PRESET_IDS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '147_group_override_and_vendor_preset.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

/** Each inserted matching_templates row: id, name, description, is_default, is_preset, weights. */
function presetRows(text: string): Array<{ id: string; name: string; description: string; isDefault: string; isPreset: string; weights: Record<string, number> }> {
  const re = /\(\s*'([0-9a-f-]{36})',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*(TRUE|FALSE),\s*(TRUE|FALSE),\s*'(\{[^']*\})'::jsonb\)/g;
  return [...code(text).matchAll(re)].map((m) => ({
    id: m[1], name: m[2], description: m[3], isDefault: m[4], isPreset: m[5], weights: JSON.parse(m[6]),
  }));
}

describe('migration 147 (who may override group rules; Buyers and vendors)', () => {
  it('is the only file numbered 147, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '147')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds override_by when missing, NOT NULL with today\'s rule as its default, held to the two choices', () => {
    const f = flat(sql);
    expect(f).toContain("ALTER TABLE event_matching_rules ADD COLUMN IF NOT EXISTS override_by TEXT NOT NULL DEFAULT 'owner';");
    expect(f).toContain('ALTER TABLE event_matching_rules DROP CONSTRAINT IF EXISTS event_matching_rules_override_by_check;');
    expect(f).toContain(
      "ALTER TABLE event_matching_rules ADD CONSTRAINT event_matching_rules_override_by_check CHECK (override_by IN ('owner', 'owner_and_cohosts'));",
    );
  });

  it('only adds: no drop of a table or column, no delete, no update of existing rows', () => {
    const c = code(sql);
    expect(c).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
    expect(c).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    // The one DROP is the CHECK's own, so a second run puts it back the same.
    expect(c.match(/\bDROP\b/gi)).toHaveLength(1);
  });

  it('seeds Buyers and vendors once, with the shared id, as a preset that is not the default template', () => {
    const rows = presetRows(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: MATCHING_PRESET_IDS.buyersVendors, name: 'Buyers and vendors', description: 'Buyers meet vendors first',
      isDefault: 'FALSE', isPreset: 'TRUE',
    });
    expect(flat(sql)).toMatch(/ON CONFLICT \(id\) DO NOTHING;$/);
    expect(MATCHING_PRESET_IDS.buyersVendors).toBe('5e7b1a5e-0000-4000-8000-000000000005');
  });

  it('weighs the pairs as Founders and investors does (migration 126), a full engine weight set', () => {
    const founders = presetRows(fs.readFileSync(path.join(MIGRATIONS, '126_matching_presets.sql'), 'utf8'))
      .find((r) => r.id === MATCHING_PRESET_IDS.foundersInvestors)!;
    expect(presetRows(sql)[0].weights).toEqual(founders.weights);
  });

  it('sets no rule of its own: the event\'s matching rule is the one the engine follows', () => {
    expect(code(sql)).not.toMatch(/matching_policy|cooldown_months/);
  });
});
