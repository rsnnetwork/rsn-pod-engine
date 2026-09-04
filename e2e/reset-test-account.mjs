// Reset ONE test account so its email can go through request-to-join again
// (3 Sep 2026, Ali's alihammza143@gmail.com). Exact email only; every
// dependent row is deleted by the resolved user id. Dry run by default.
//
//   cd e2e && node reset-test-account.mjs alihammza143@gmail.com
//   cd e2e && node reset-test-account.mjs alihammza143@gmail.com --apply
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)) });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = (process.argv[2] || '').toLowerCase();
const apply = process.argv.includes('--apply');
if (!email.includes('@')) { console.error('usage: node reset-test-account.mjs <email> [--apply]'); process.exit(1); }

const DEPENDENTS = [
  ['agent_matches', 'candidate_user_id'],
  ['agent_matches', 'agent_id IN (SELECT id FROM matching_agents WHERE user_id = $1)', true],
  ['matching_agents', 'user_id'],
  ['user_pokes', 'sender_id'], ['user_pokes', 'recipient_id'],
  ['encounter_history', 'user_a_id'], ['encounter_history', 'user_b_id'],
  ['direct_messages', 'from_user_id'],
  ['dm_conversations', 'user_a_id'], ['dm_conversations', 'user_b_id'],
  ['user_blocks', 'blocker_id'], ['user_blocks', 'blocked_id'],
  ['circle_members', 'user_id'], ['pod_members', 'user_id'], ['session_participants', 'user_id'],
  ['notifications', 'user_id'], ['refresh_tokens', 'user_id'], ['audit_log', 'actor_id'],
  ['onboarding_stage_events', 'user_id'], ['user_intent_profiles', 'user_id'],
  ['magic_links', 'email = $2', 'email'],
];

async function main() {
  const u = await pool.query(`SELECT id, display_name, onboarding_status::text st FROM users WHERE lower(email) = $1`, [email]);
  const jr = await pool.query(`SELECT id, status::text FROM join_requests WHERE lower(email) = $1`, [email]);
  const inv = await pool.query(`SELECT id, code, status::text FROM invites WHERE lower(invitee_email) = $1`, [email]);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} for ${email}`);
  console.log(`  user rows: ${JSON.stringify(u.rows)}`);
  console.log(`  join requests: ${JSON.stringify(jr.rows)}`);
  console.log(`  invites addressed to it: ${JSON.stringify(inv.rows)}`);
  if (u.rows.length > 1) { console.error('more than one user row — refusing'); process.exit(1); }
  const id = u.rows[0]?.id;

  if (id) {
    for (const [table, where, mode] of DEPENDENTS) {
      const clause = mode === true ? where : mode === 'email' ? where : `${where} = $1`;
      const params = mode === 'email' ? [id, email] : [id];
      const n = await pool.query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${clause}`, params).then(r => r.rows[0].n).catch(() => null);
      if (n === null) { console.log(`  ${table} (${where}): (table/column missing, skipped)`); continue; }
      if (n) console.log(`  ${table} (${where}): ${n} row(s)${apply ? ' → deleting' : ''}`);
      if (apply && n) await pool.query(`DELETE FROM ${table} WHERE ${clause}`, params);
    }
    if (apply) {
      const d = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id]);
      console.log(`  users: deleted ${d.rowCount}`);
    }
  }
  if (apply) {
    if (jr.rows.length) { const d = await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email]); console.log(`  join_requests: deleted ${d.rowCount}`); }
    if (inv.rows.length) { const d = await pool.query(`DELETE FROM invites WHERE lower(invitee_email) = $1`, [email]); console.log(`  invites: deleted ${d.rowCount}`); }
    const left = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE lower(email) = $1`, [email]);
    console.log(`\n${email} now ${left.rows[0].n === 0 ? 'FREE to request to join' : 'STILL EXISTS'}`);
  } else {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply.');
  }
  await pool.end();
}
main().catch(async (e) => { console.error('failed:', e); await pool.end(); process.exit(1); });
