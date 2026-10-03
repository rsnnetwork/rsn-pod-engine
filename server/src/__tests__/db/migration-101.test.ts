import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/101_reason_m1.sql'), 'utf8');

describe('migration 101 (REASON milestone 1)', () => {
  it('has no BEGIN/COMMIT (the runner wraps each file in its own transaction)', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
  it('adds both tables and the request format column, idempotently, cascading with the user', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS person_responses/);
    expect(sql).toMatch(/UNIQUE \(user_id, target_user_id\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meeting_outcomes/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS preferred_format/);
    expect((sql.match(/ON DELETE CASCADE/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
