// ─── Migration 109: every onboarding question is "select all that apply" ─────
//
// The 25 Oct review (ONB-01): Claus could choose three people to meet and two words for himself, and that
// was the database speaking, not only the screens. 100 held looking_to_meet to 3 and self_kinds to 2, and 106
// held hoping_to_find to 3, as CHECK constraints, so lifting the limits in Zod or on a screen alone would
// end in a database error. 109 drops the three caps and puts a ceiling of 20 in their place: a guard against
// a runaway request, the same ceiling the server's Zod holds each list to. This file is applied in
// production and never edited.

import * as fs from 'fs';
import * as path from 'path';
import { ONBOARDING_V2_LIMITS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '109_onboarding_select_all.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, on one line, so a word in a comment is never read as a statement. */
const code = sql.replace(/--[^\n]*/g, '');
const flat = code.replace(/\s+/g, ' ');

describe('migration 109 (onboarding: select all that apply)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it.each([
    'users_looking_to_meet_max',
    'users_self_kinds_max',
    'users_hoping_to_find_max',
  ])('drops %s, only if it is there, so it can run twice', (constraint) => {
    expect(flat).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}\\b`));
  });

  it.each([
    ['looking_to_meet', 'users_looking_to_meet_ceiling'],
    ['self_kinds', 'users_self_kinds_ceiling'],
    ['hoping_to_find', 'users_hoping_to_find_ceiling'],
  ])('holds %s to the ceiling the server holds it to, behind a guard so it can run twice', (column, constraint) => {
    const guarded = new RegExp(
      `IF NOT EXISTS \\(SELECT 1 FROM pg_constraint WHERE conname = '${constraint}'\\) THEN `
      + `ALTER TABLE users ADD CONSTRAINT ${constraint} CHECK \\(cardinality\\(${column}\\) <= ${ONBOARDING_V2_LIMITS.ceiling}\\); END IF;`,
    );
    expect(flat).toMatch(guarded);
  });

  it('the ceiling is 20, and no list is held to anything lower', () => {
    const bounds = [...flat.matchAll(/cardinality\(\w+\) <= (\d+)/g)].map((m) => Number(m[1]));
    expect(bounds).toEqual([20, 20, 20]);
  });

  it('drops no column and no table, and touches no row', () => {
    expect(code).not.toMatch(/DROP\s+(COLUMN|TABLE)\b/i);
    expect(code).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
  });

  it('touches no other constraint: in particular not notifications_type_check, which only 108 restates', () => {
    const named = [...flat.matchAll(/CONSTRAINT (?:IF EXISTS )?(\w+)/g)].map((m) => m[1]);
    expect([...new Set(named)].sort()).toEqual([
      'users_hoping_to_find_ceiling', 'users_hoping_to_find_max',
      'users_looking_to_meet_ceiling', 'users_looking_to_meet_max',
      'users_self_kinds_ceiling', 'users_self_kinds_max',
    ]);
  });
});
