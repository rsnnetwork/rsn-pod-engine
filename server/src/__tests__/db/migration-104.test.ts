// ─── Migration 104: the email list's subjects say REASON (21 Oct 2026) ───────
//
// email_config.subject is the text the admin dashboard lists for each email type. Migrations 020
// and 082 seeded five of them with the word RSN in them. This file is applied in production and is
// never edited; the table holds the admin's switches (enabled, updated_by, updated_at), so the
// migration rewrites the word RSN in the subject and nothing else.
//
// What it does to real rows is shown by running it against the scratch database (see the report);
// this pins the shape of the statement, so it cannot grow into something wider.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '104_email_config_reason.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = (migration: string) => migration.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const statements = () => code(sql).split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

describe('migration 104 (the email list says REASON)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('is one UPDATE: the word RSN in email_config.subject becomes REASON, only on rows that have the word', () => {
    expect(statements()).toEqual([
      "UPDATE email_config SET subject = regexp_replace(subject, '[[:<:]]RSN[[:>:]]', 'REASON', 'g') WHERE subject ~ '[[:<:]]RSN[[:>:]]'",
    ]);
  });

  it('touches no other column and no other table, and deletes, drops and adds nothing', () => {
    const body = code(sql);
    expect(body).not.toMatch(/\b(DELETE|DROP|TRUNCATE|INSERT|ALTER|CREATE|enabled|updated_by|updated_at|email_type|users|join_requests)\b/i);
  });

  it('matches the word in capitals only, so REASON, rsn and a longer word are left alone', () => {
    // 'g' replaces every occurrence in a subject, and the WHERE has no case-insensitive flag.
    expect(code(sql)).toContain("'g'");
    expect(code(sql)).not.toMatch(/~\*|'i'/);
  });

  it('leaves the seed migrations as they were: 020 and 082 are history and still say what they said', () => {
    const seed020 = fs.readFileSync(path.join(MIGRATIONS, '020_violations.sql'), 'utf8');
    const seed082 = fs.readFileSync(path.join(MIGRATIONS, '082_email_config_poke.sql'), 'utf8');
    expect(seed020).toContain("'Your RSN login link'");
    expect(seed082).toContain("'{name} wants to meet you on RSN'");
  });
});
