// ─── The sweeper for throwaway test members refuses before it touches anything ─
// (8 Oct 2026)
//
// e2e/sweep-throwaways.mjs deletes members from whatever database DATABASE_URL names. Its real work
// is proved against a scratch database (see the task report): there is none here. What can be pinned
// without one is everything that must happen BEFORE a connection is made, and the shape of the script:
// it names the database from the environment only, it knows exactly two address patterns, it asks for
// the count the dry run showed, and its delete is the clean-up the specs use, not a list of its own.

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../../e2e/sweep-throwaways.mjs');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');

// Nothing listens on port 1, so a script that got as far as connecting would fail with a connection
// error (exit 1), not with the usage error (exit 2) these cases expect.
const NOWHERE = 'postgresql://nobody:hunter2@127.0.0.1:1/none';

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.dirname(SCRIPT),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '', ...env },
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('the sweeper before it connects', () => {
  it('will not start without DATABASE_URL: the address comes from the environment, never from server/.env', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/DATABASE_URL is not set/);
    expect(SOURCE).not.toMatch(/from 'dotenv'|require\('dotenv'\)/);
  });

  it('will not delete without --expect, the count the dry run listed', () => {
    const r = run(['--apply'], { DATABASE_URL: NOWHERE });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--apply needs --expect/);
  });

  it('wants a whole number for --expect, in either spelling', () => {
    expect(run(['--apply', '--expect', 'two'], { DATABASE_URL: NOWHERE }).code).toBe(2);
    expect(run(['--apply', '--expect='], { DATABASE_URL: NOWHERE }).code).toBe(2);
    expect(run(['--apply', '--expect', '-1'], { DATABASE_URL: NOWHERE }).code).toBe(2);
    expect(run(['--apply', '--expect'], { DATABASE_URL: NOWHERE }).code).toBe(2);
  });

  it('treats --expect without --apply as a mistake rather than a dry run that looks like a check', () => {
    const r = run(['--expect', '2'], { DATABASE_URL: NOWHERE });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--expect only means something with --apply/);
  });

  it('stops on an argument it does not know', () => {
    const r = run(['--force'], { DATABASE_URL: NOWHERE });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown argument "--force"/);
  });

  it('fails cleanly, and without printing the password, when the database cannot be reached', () => {
    const r = run([], { DATABASE_URL: NOWHERE });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('hunter2');
  });
});

describe('the sweeper, as written', () => {
  it('knows exactly two address patterns, and nothing broader', () => {
    expect(SOURCE).toMatch(/const EMAIL_PATTERNS = \['%@rsn-e2e\.invalid', 'delivered\+%@resend\.dev'\];/);
    expect(SOURCE).toMatch(/WHERE email LIKE ANY \(\$1::text\[\]\)/);
    expect(SOURCE.match(/\bLIKE\b/g)).toHaveLength(1);
  });

  it('deletes through the clean-up every spec uses, by exact id, and has no delete of its own', () => {
    expect(SOURCE).toMatch(/require\('\.\/helpers\/live-ui\.ts'\)\.cleanup/);
    expect(SOURCE).toMatch(/loadCleanup\(\)\(watched, \{ ids \}\)/);
    expect(SOURCE).not.toMatch(/DELETE\s+FROM/i);
  });

  it('changes nothing unless told to: a dry run is the default, and the transaction is rolled back on any doubt', () => {
    expect(SOURCE).toMatch(/const options = \{ apply: false, expect: null \};/);
    expect(SOURCE).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ/);
    expect(SOURCE).toMatch(/if \(rows\.length !== expect\) throw/);
    expect(SOURCE).toMatch(/if \(before - after !== expect\) throw/);
    expect(SOURCE).toMatch(/await client\.query\('COMMIT'\)/);
    expect(SOURCE).toMatch(/await client\.query\('ROLLBACK'\)/);
  });

  it('refuses a count too large to be a killed run', () => {
    expect(SOURCE).toMatch(/const MAX_SWEEP = 200;/);
    expect(SOURCE).toMatch(/if \(rows\.length > MAX_SWEEP\) throw/);
  });
});
