import * as fs from 'fs';
import * as path from 'path';
import { MEETING_FORMATS, PERSON_RESPONSES, WORTH_CONTINUING } from '@rsn/shared';

const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/101_reason_m1.sql'), 'utf8');

// What is not code: comments, string literals and dollar-quoted bodies. Matched in one
// pass, left to right, so a "--" inside a string or a quote inside a comment cannot
// confuse the next match.
const NOT_CODE = /--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'/g;

/**
 * The statements in a migration that open or end a transaction. The runner
 * (db/migrate.ts) already wraps each file in its own, so a file that does either
 * commits or abandons the runner's transaction part way through. PL/pgSQL blocks
 * have a BEGIN and END of their own, which are not transaction control: they sit
 * inside dollar quotes, which are blanked first.
 */
function transactionControl(migration: string): string[] {
  return migration
    .replace(NOT_CODE, ' ')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\b/i.test(statement));
}

/** The values a `CHECK (<column> IN ('a', 'b'))` allows, as the migration writes them. */
function allowedBy(column: string): string[] {
  const check = sql.match(new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i'));
  if (!check) throw new Error(`101_reason_m1.sql has no CHECK (${column} IN (...))`);
  return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const sorted = (values: readonly string[]) => [...values].sort();

describe('migration 101 (REASON milestone 1)', () => {
  it('has no transaction control (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('the guard catches every way of opening or ending a transaction, and nothing else', () => {
    for (const bad of [
      'BEGIN;', 'begin;', 'BEGIN TRANSACTION;', 'BEGIN WORK;', 'START TRANSACTION;',
      'START TRANSACTION ISOLATION LEVEL SERIALIZABLE;', 'COMMIT;', 'commit;', 'ROLLBACK;',
      'COMMIT', // the last statement of a file needs no semicolon
      'CREATE TABLE a (id int);\n  COMMIT\n',
      'BEGIN\nCREATE TABLE a (id int);\nCOMMIT;',
    ]) {
      expect({ sql: bad, found: transactionControl(bad).length > 0 }).toEqual({ sql: bad, found: true });
    }
    for (const fine of [
      'DO $$ BEGIN PERFORM 1; END $$;', // PL/pgSQL has its own BEGIN and END
      'CREATE FUNCTION f() RETURNS void AS $fn$\nBEGIN\n  RETURN;\nEND;\n$fn$ LANGUAGE plpgsql;',
      '-- No BEGIN/COMMIT here, the runner wraps this file.\nSELECT 1;',
      '/* BEGIN; COMMIT; */ SELECT 1;',
      "INSERT INTO notes (body) VALUES ('BEGIN; COMMIT;');",
      "COMMENT ON TABLE notes IS 'rollback is not run here';",
      'CREATE TABLE commits (id int, begin_at timestamptz);',
    ]) {
      expect({ sql: fine, found: transactionControl(fine) }).toEqual({ sql: fine, found: [] });
    }
  });

  it('adds both tables and the request format column, idempotently, cascading with the user', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS person_responses/);
    expect(sql).toMatch(/UNIQUE \(user_id, target_user_id\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meeting_outcomes/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS preferred_format/);
    expect((sql.match(/ON DELETE CASCADE/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  // The routes and the client read the shared lists; the database CHECKs are the same
  // lists written out by hand. This file is applied in production and is never edited, so
  // if a shared list changes, a NEW migration alters the constraint and this test follows it.
  it('its CHECK lists are the shared lists', () => {
    expect(sorted(allowedBy('response'))).toEqual(sorted(PERSON_RESPONSES));
    expect(sorted(allowedBy('worth_continuing'))).toEqual(sorted(WORTH_CONTINUING));
    expect(sorted(allowedBy('preferred_format'))).toEqual(sorted(MEETING_FORMATS.map((f) => f.key)));
  });
});
