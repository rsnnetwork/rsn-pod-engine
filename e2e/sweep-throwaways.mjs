// Sweeps the throwaway members a killed spec run leaves behind.
//
// A production spec run that is killed (a closed terminal, a timeout, a crash) never reaches its
// clean-up, and its test members stay in the database: active, onboarded, and visible to real members in
// their matches. On 3 Aug 2026 eleven of them did exactly that. This finds them and removes them.
//
// A throwaway member is one whose address matches EXACTLY one of these, and nothing else:
//     %@rsn-e2e.invalid          (the reserved .invalid domain: no real person can have one)
//     delivered+%@resend.dev     (Resend's own test inbox: it never reaches a real inbox)
//
//   DATABASE_URL=<address> node sweep-throwaways.mjs                        dry run: lists them, changes nothing
//   DATABASE_URL=<address> node sweep-throwaways.mjs --apply --expect <n>   deletes them, but only if exactly <n> are found
//
// The address comes from the environment and nowhere else: server/.env is never read, so this cannot
// reach a database you did not name. Read the dry run first, then give --expect the count you saw.
//
// The delete is the clean-up every spec uses (cleanup() in helpers/live-ui.ts), by exact user id, run in
// ONE transaction: it is committed only if the users table loses exactly <n> rows, and rolled back
// otherwise, so a refusal from the database (a throwaway that owns a pod, say) leaves everything as it was.
import { createRequire } from 'node:module';
import pg from 'pg';

const EMAIL_PATTERNS = ['%@rsn-e2e.invalid', 'delivered+%@resend.dev'];
const MAX_SWEEP = 200;
const USAGE = 'usage: DATABASE_URL=<address> node sweep-throwaways.mjs [--apply --expect <n>]';

const FIND_SQL = `
  SELECT id, email, status::text AS status, created_at
    FROM users
   WHERE email LIKE ANY ($1::text[])
   ORDER BY created_at, id
   LIMIT ${MAX_SWEEP + 1}`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** `--apply` and `--expect <n>` (or `--expect=<n>`). Anything else is a mistake worth stopping for. */
function parseArgs(argv) {
  const options = { apply: false, expect: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--expect') options.expect = argv[++i] ?? '';
    else if (arg.startsWith('--expect=')) options.expect = arg.slice('--expect='.length);
    else fail(`unknown argument "${arg}"\n${USAGE}`, 2);
  }
  if (options.expect !== null && !/^\d+$/.test(String(options.expect))) {
    fail(`--expect needs a whole number, not "${options.expect}"\n${USAGE}`, 2);
  }
  if (options.apply && options.expect === null) {
    fail(`--apply needs --expect <n>: the number of throwaway members the dry run listed\n${USAGE}`, 2);
  }
  if (!options.apply && options.expect !== null) {
    fail(`--expect only means something with --apply\n${USAGE}`, 2);
  }
  return { apply: options.apply, expect: options.expect === null ? null : Number(options.expect) };
}

/** Which database this is, without its credentials. */
function describeDatabase(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(address could not be read)';
  }
}

/** cleanup() is TypeScript, so a plain script borrows ts-node to read it. Loaded only when something is to be deleted. */
function loadCleanup() {
  const require = createRequire(import.meta.url);
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compiler: require.resolve('typescript'),
    compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true },
  });
  return require('./helpers/live-ui.ts').cleanup;
}

function shortEmail(email) {
  return email.length > 44 ? `${email.slice(0, 41)}...` : email;
}

function printFound(rows, where) {
  const shown = rows.slice(0, MAX_SWEEP);
  console.log(`Throwaway members in ${where}: ${rows.length > MAX_SWEEP ? `more than ${MAX_SWEEP}` : rows.length}`);
  for (const r of shown) {
    console.log(`  ${r.id}  ${shortEmail(r.email).padEnd(44)}  ${String(r.status).padEnd(10)}  ${new Date(r.created_at).toISOString()}`);
  }
}

async function countUsers(db) {
  return (await db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
}

async function sweep(pool, expect, where) {
  const client = await pool.connect();
  try {
    // One snapshot for the whole sweep: the users table loses exactly what this transaction deletes,
    // whatever other sessions do meanwhile.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const rows = (await client.query(FIND_SQL, [EMAIL_PATTERNS])).rows;
    printFound(rows, where);
    if (rows.length > MAX_SWEEP) throw new Error(`more than ${MAX_SWEEP} found: that is not a killed run. Look at the database by hand.`);
    if (rows.length !== expect) throw new Error(`found ${rows.length}, but --expect said ${expect}: nothing was deleted. Run the dry run again and give --expect what it lists.`);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      console.log('Nothing to sweep.');
      return;
    }

    const ids = rows.map((r) => r.id);
    const before = await countUsers(client);

    // cleanup() keeps going past a refused statement; the first refusal is what to tell the operator.
    let firstRefusal = null;
    const watched = {
      query: async (...args) => {
        try { return await client.query(...args); } catch (err) { firstRefusal ??= err; throw err; }
      },
    };
    await loadCleanup()(watched, { ids });
    if (firstRefusal) throw new Error(`the database refused: ${firstRefusal.message}`);

    const after = await countUsers(client);
    console.log(`users before ${before}, after ${after}: dropped ${before - after}, expected ${expect}`);
    if (before - after !== expect) throw new Error('the users table did not drop by exactly the number expected: rolled back, nothing was deleted.');
    const left = (await client.query('SELECT COUNT(*)::int AS n FROM users WHERE id = ANY($1)', [ids])).rows[0].n;
    if (left !== 0) throw new Error(`${left} of the listed members are still there: rolled back, nothing was deleted.`);

    await client.query('COMMIT');
    console.log(`Swept ${expect} throwaway member${expect === 1 ? '' : 's'}.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    fail(`NOT swept: ${err.message}`);
  } finally {
    client.release();
  }
}

async function main() {
  const { apply, expect } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) fail(`DATABASE_URL is not set. This script reads the database address from the environment only.\n${USAGE}`, 2);

  const where = describeDatabase(url);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    if (!apply) {
      const rows = (await pool.query(FIND_SQL, [EMAIL_PATTERNS])).rows;
      printFound(rows, where);
      console.log(rows.length === 0
        ? 'Dry run: nothing to sweep.'
        : `Dry run: nothing was changed. To delete exactly these ${rows.length}, run:\n  node sweep-throwaways.mjs --apply --expect ${rows.length}`);
      return;
    }
    await sweep(pool, expect, where);
    console.log(`users now: ${await countUsers(pool)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => fail(`sweep-throwaways failed: ${err.message}`));
