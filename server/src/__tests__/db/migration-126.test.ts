// ─── Migration 126: speed-networking presets (30 Oct 2026, L19) ─────────────────────────────────
//
// Four matching_templates rows any organiser may choose (is_preset = true), with the fixed ids the forms start on
// (shared MATCHING_PRESET_IDS). Their weights are the admin page's own presets (Balanced, Investor Day, Mentorship)
// plus Jobs and hiring, and each is a full engine weight set. Applied files are never edited: a later change is a
// NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { MATCHING_PRESET_IDS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '126_matching_presets.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');
const code = sql.replace(/--[^\n]*/g, '');
const flat = code.replace(/\s+/g, ' ').trim();

/** The engine's own defaults (matching.service.ts DEFAULT_WEIGHTS, the admin page's "Balanced"). */
const DEFAULTS = {
  sharedInterests: 0.25, sharedReasons: 0.25, industryDiversity: 0.15, companyDiversity: 0.15, languageMatch: 0.10,
  encounterFreshness: 0.10, mutualPremiumRequest: 0.20, singlePremiumRequest: 0.10, premiumBoost: 0.03,
  mutualMeetAgainBoost: 0.05, intentAlignment: 0.20, designationDiversity: 0.10, avoidPenalty: 0.15,
  eventIntentionAlignment: 0.15,
};

/** The four ids this file seeds; later presets are later migrations' (Buyers and vendors: 147, migration-147.test.ts). */
type Seeded126 = 'general' | 'foundersInvestors' | 'jobsHiring' | 'mentorship';
const SEEDED_126: Seeded126[] = ['general', 'foundersInvestors', 'jobsHiring', 'mentorship'];

const EXPECTED: Record<Seeded126, { name: string; description: string; weights: Record<string, number> }> = {
  general: { name: 'General', description: 'A broad mix of people, with shared interests first', weights: DEFAULTS },
  foundersInvestors: {
    name: 'Founders and investors', description: 'Founders meet investors first',
    weights: {
      ...DEFAULTS, intentAlignment: 0.30, designationDiversity: 0.25, eventIntentionAlignment: 0.25, sharedReasons: 0.15,
      sharedInterests: 0.10, industryDiversity: 0.05, avoidPenalty: 0.20,
    },
  },
  jobsHiring: {
    name: 'Jobs and hiring', description: 'People hiring meet people looking for a role first',
    weights: { ...DEFAULTS, intentAlignment: 0.35, designationDiversity: 0.20, eventIntentionAlignment: 0.25, industryDiversity: 0.05 },
  },
  mentorship: {
    name: 'Mentorship', description: 'Mentors meet people looking for guidance first',
    weights: {
      ...DEFAULTS, designationDiversity: 0.30, intentAlignment: 0.25, sharedReasons: 0.20, eventIntentionAlignment: 0.20,
      industryDiversity: 0.05,
    },
  },
};

/** Each inserted row: id, name, description, is_default, is_preset, weights. */
function rows(): Array<{ id: string; name: string; description: string; isDefault: string; isPreset: string; weights: Record<string, number> }> {
  const re = /\(\s*'([0-9a-f-]{36})',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*(TRUE|FALSE),\s*(TRUE|FALSE),\s*'(\{[^']*\})'::jsonb\)/g;
  return [...code.matchAll(re)].map((m) => ({
    id: m[1], name: m[2], description: m[3], isDefault: m[4], isPreset: m[5], weights: JSON.parse(m[6]),
  }));
}

describe('migration 126 (speed-networking presets)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds: a column when missing, an index when missing, rows when their id is free', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
    expect(code).not.toMatch(/notifications_type_check/);
    expect(flat).toContain('ALTER TABLE matching_templates ADD COLUMN IF NOT EXISTS is_preset BOOLEAN NOT NULL DEFAULT FALSE;');
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_matching_templates_preset ON matching_templates (is_preset) WHERE is_preset = TRUE;');
    expect(flat).toMatch(/ON CONFLICT \(id\) DO NOTHING;$/);
  });

  it('seeds exactly the four presets, with the shared ids, as presets that are not the default template', () => {
    const seeded = rows();
    expect(seeded.map((r) => r.id)).toEqual(SEEDED_126.map((key) => MATCHING_PRESET_IDS[key]));
    for (const r of seeded) expect([r.isDefault, r.isPreset]).toEqual(['FALSE', 'TRUE']);
  });

  it.each(SEEDED_126)('%s has its name, its one line and its weights', (key) => {
    const row = rows().find((r) => r.id === MATCHING_PRESET_IDS[key])!;
    expect(row).toMatchObject({ name: EXPECTED[key].name, description: EXPECTED[key].description });
    expect(row.weights).toEqual(EXPECTED[key].weights);
    // A full engine weight set, each a soft weight between 0 and 1.
    expect(Object.keys(row.weights).sort()).toEqual(Object.keys(DEFAULTS).sort());
    for (const w of Object.values(row.weights)) expect(w).toBeGreaterThanOrEqual(0);
  });

  it('the cards say "first": soft preferences, not a guarantee', () => {
    for (const key of ['foundersInvestors', 'jobsHiring', 'mentorship'] as const) {
      expect(EXPECTED[key].description).toMatch(/ first$/);
    }
  });

  it('sets no rule of its own: the event\'s matching rule is the one the engine follows', () => {
    expect(code).not.toMatch(/matching_policy|cooldown_months/);
  });

  it('agrees with the engine defaults and the admin page presets it copies', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../services/matching/matching.service.ts'), 'utf8');
    for (const [k, v] of Object.entries(DEFAULTS)) {
      expect(service).toMatch(new RegExp(`\\n\\s+${k}: ${v.toFixed(2).replace(/0$/, '')}0?,`));
    }
  });
});
