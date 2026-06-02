// Force-clean any leftover E2E dummy users by ID. Investigates FK refs
// that may have blocked the original cleanup. Uses CASCADE-friendly order.

import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../server/.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

try {
  const users = await pool.query("SELECT id, email FROM users WHERE email LIKE '%rsn-e2e.invalid'");
  console.log('Found orphan E2E users:', users.rows);

  for (const row of users.rows) {
    const id = row.id;
    console.log('---', row.email);

    // Find FKs to users(id)
    const refs = await pool.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'users' AND ccu.column_name = 'id'
    `);

    for (const r of refs.rows) {
      try {
        const cnt = await pool.query(
          `SELECT count(*)::int c FROM ${r.table_name} WHERE ${r.column_name} = $1`,
          [id],
        );
        if (cnt.rows[0].c > 0) {
          console.log(`  FK ${r.table_name}.${r.column_name} = ${cnt.rows[0].c} → DELETE`);
          await pool.query(
            `DELETE FROM ${r.table_name} WHERE ${r.column_name} = $1`,
            [id],
          );
        }
      } catch (e) {
        console.log(`  FK ${r.table_name}.${r.column_name} → err: ${e.message}`);
      }
    }

    // Now delete the user
    try {
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
      console.log(`  ✓ deleted user ${id}`);
    } catch (e) {
      console.log(`  ✗ failed to delete user ${id}: ${e.message}`);
    }
  }

  // Final orphan check
  const remaining = await pool.query("SELECT count(*)::int c FROM users WHERE email LIKE '%rsn-e2e.invalid'");
  console.log('Remaining orphan E2E users:', remaining.rows[0].c);

  // Also check for any leftover magic_links
  const ml = await pool.query("SELECT count(*)::int c FROM magic_links WHERE email LIKE '%rsn-e2e.invalid'");
  if (ml.rows[0].c > 0) {
    console.log(`Cleaning ${ml.rows[0].c} leftover magic_links rows`);
    await pool.query("DELETE FROM magic_links WHERE email LIKE '%rsn-e2e.invalid'");
  }
} finally {
  await pool.end();
}
