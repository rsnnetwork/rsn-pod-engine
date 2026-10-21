// ─── No new migration commits or abandons the runner's transaction ───────────
//
// The runner (db/migrate.ts) wraps each file in its own transaction and records the
// file only after it commits. A file with a top-level BEGIN, COMMIT, END, ROLLBACK or
// ABORT ends that transaction early (the project's database rules). Migrations up to 087 open
// with BEGIN; and close with COMMIT; and are history, applied and never edited.
// From 101 on, the rule is held for every file by name, so the next migration is
// checked the day it is added and no one has to remember to write its test.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FROM = 101;

const files = fs.readdirSync(MIGRATIONS)
  .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) >= FROM)
  .sort();

describe(`every migration from ${FROM} on`, () => {
  it('is found: the check below is not passing for want of files', () => {
    expect(files).toEqual(expect.arrayContaining(['101_reason_m1.sql', '102_join_request_sign_in_origin.sql']));
  });

  it.each(files)('%s has no top-level transaction control', (file) => {
    expect(transactionControl(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))).toEqual([]);
  });
});
