// ─── Migration 106: onboarding version 2 ─────────────────────────────────────
//
// Additive and idempotent, and the stage list is restated in full: dropping a
// value from onboarding_stage_events_stage_check would make every insert of it
// fail, and recording is fire-and-forget, so nobody would ever be told.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const dir = path.join(__dirname, '../../db/migrations');
const sql = fs.readFileSync(path.join(dir, '106_onboarding_v2.sql'), 'utf8');
const m100 = fs.readFileSync(path.join(dir, '100_onboarding_tickbox.sql'), 'utf8');
const stageRepo = fs.readFileSync(path.join(__dirname, '../../services/onboarding/stage-events.repo.ts'), 'utf8');

/** The quoted values inside `CHECK (stage IN (...))`. */
function stagesIn(text: string): string[] {
  const m = text.match(/onboarding_stage_events_stage_check\s+CHECK\s*\(\s*stage\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
  if (!m) throw new Error('no stage CHECK found');
  return [...m[1].replace(/--[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('migration 106 (onboarding v2)', () => {
  it('has no top-level transaction control (the runner wraps the file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it.each([
    ['hoping_to_find', /ADD COLUMN IF NOT EXISTS hoping_to_find TEXT\[\] NOT NULL DEFAULT '\{\}'/],
    ['meet_other', /ADD COLUMN IF NOT EXISTS meet_other VARCHAR\(120\)/],
    ['find_other', /ADD COLUMN IF NOT EXISTS find_other VARCHAR\(120\)/],
    ['find_specific', /ADD COLUMN IF NOT EXISTS find_specific VARCHAR\(300\)/],
    ['offer_other', /ADD COLUMN IF NOT EXISTS offer_other VARCHAR\(120\)/],
    ['self_other', /ADD COLUMN IF NOT EXISTS self_other VARCHAR\(120\)/],
    ['onboarding_version', /ADD COLUMN IF NOT EXISTS onboarding_version SMALLINT/],
  ])('adds users.%s, idempotently', (_col, re) => {
    expect(sql).toMatch(re);
  });

  it('holds hoping_to_find to three answers, behind a guard so it can run twice', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'users_hoping_to_find_max'\)/);
    expect(sql).toMatch(/CHECK \(cardinality\(hoping_to_find\) <= 3\)/);
  });

  it('only adds: no column or table is dropped', () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  it('restates every stage 100 allowed, plus the two LinkedIn stages', () => {
    const before = stagesIn(m100);
    const after = stagesIn(sql);
    expect(before.length).toBe(15);
    for (const s of before) expect(after).toContain(s);
    expect(after).toEqual(expect.arrayContaining(['linkedin_connected', 'linkedin_skipped']));
    expect(after.length).toBe(before.length + 2);
  });

  it('allows exactly the stages the code can record', () => {
    const union = stageRepo.match(/export type StageEventStage =([\s\S]*?);/);
    if (!union) throw new Error('StageEventStage not found');
    const typed = [...union[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(x => x[1]);
    expect([...typed].sort()).toEqual([...stagesIn(sql)].sort());
  });
});
