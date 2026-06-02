// Standalone migration verification — confirms that Phase M (060) and
// Phase O (061) actually applied on the live database. Independent of
// Playwright; can be run via `npx ts-node verify-migrations.ts` from e2e/.
//
// Reads DATABASE_URL from server/.env. Read-only — no inserts or DDL.

import { Pool } from 'pg';
import { config as dotenvConfig } from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Resolve __dirname under both CommonJS and ESM loaders.
const __filename_local = typeof __filename !== 'undefined'
  ? __filename
  : fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);

dotenvConfig({ path: path.resolve(__dirname_local, '../server/.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

async function getColumns(table: string): Promise<ColumnInfo[]> {
  const result = await pool.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return result.rows;
}

async function main() {
  console.log('=== Phase M/O/P migration verification ===\n');

  // Phase M — migration 060: session_participants.acting_as_host
  const spCols = await getColumns('session_participants');
  const actingAsHost = spCols.find(c => c.column_name === 'acting_as_host');
  console.log('Phase M (migration 060) — session_participants.acting_as_host:');
  if (actingAsHost) {
    console.log(`  ✓ EXISTS — type=${actingAsHost.data_type}, nullable=${actingAsHost.is_nullable}, default=${actingAsHost.column_default || 'NULL'}`);
  } else {
    console.log('  ✗ MISSING — migration 060 has not applied');
  }

  // Phase O — migration 061: session_participants.host_muted + host_muted_at
  const hostMuted = spCols.find(c => c.column_name === 'host_muted');
  const hostMutedAt = spCols.find(c => c.column_name === 'host_muted_at');
  console.log('\nPhase O (migration 061) — session_participants.host_muted:');
  if (hostMuted) {
    console.log(`  ✓ EXISTS — type=${hostMuted.data_type}, nullable=${hostMuted.is_nullable}, default=${hostMuted.column_default || 'NULL'}`);
  } else {
    console.log('  ✗ MISSING — migration 061 has not applied');
  }
  console.log('Phase O (migration 061) — session_participants.host_muted_at:');
  if (hostMutedAt) {
    console.log(`  ✓ EXISTS — type=${hostMutedAt.data_type}, nullable=${hostMutedAt.is_nullable}`);
  } else {
    console.log('  ✗ MISSING — migration 061 has not applied');
  }

  // Phase G prerequisite — migration 059: session_cohosts.visibility_mode (already pre-existed)
  const cohostCols = await getColumns('session_cohosts');
  const visMode = cohostCols.find(c => c.column_name === 'visibility_mode');
  console.log('\nPhase G (migration 059, prerequisite) — session_cohosts.visibility_mode:');
  if (visMode) {
    console.log(`  ✓ EXISTS — type=${visMode.data_type}, default=${visMode.column_default || 'NULL'}`);
  } else {
    console.log('  ✗ MISSING');
  }

  // Sanity — count of session_participants rows so we know we're talking
  // to the right database (not an empty test DB).
  const count = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM session_participants`,
  );
  console.log(`\nSanity: session_participants table has ${count.rows[0].c} rows (non-zero = live DB).`);

  await pool.end();
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
