// Reset ONE test account so its email can go through request-to-join again
// (3 Sep 2026, Ali's alihammza143@gmail.com). Exact email only; every
// dependent row is deleted by the resolved user id. Dry run by default.
//
//   cd e2e && node reset-test-account.mjs alihammza143@gmail.com
//   cd e2e && node reset-test-account.mjs alihammza143@gmail.com --apply
//
// 14 Sep 2026: runs in ONE transaction, and refuses up front when the account
// still OWNS something other people may depend on (a pod it created, an event
// it hosts) — the first version deleted the dependents one by one, then hit a
// foreign-key refusal on the user row and left two accounts half reset.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)) });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const email = (process.argv[2] || '').toLowerCase();
const apply = process.argv.includes('--apply');
if (!email.includes('@')) { console.error('usage: node reset-test-account.mjs <email> [--apply]'); process.exit(1); }

// Rows that belong to the account alone. Order matters only where noted.
const DEPENDENTS = [
  ['agent_matches', 'candidate_user_id'],
  ['agent_matches', 'agent_id IN (SELECT id FROM matching_agents WHERE user_id = $1)', true],
  ['matching_agents', 'user_id'],
  ['user_pokes', 'sender_id'], ['user_pokes', 'recipient_id'],
  ['encounter_history', 'user_a_id'], ['encounter_history', 'user_b_id'],
  ['direct_messages', 'from_user_id'],
  ['dm_conversations', 'user_a_id'], ['dm_conversations', 'user_b_id'],
  ['user_blocks', 'blocker_id'], ['user_blocks', 'blocked_id'],
  ['ratings', 'from_user_id'], ['ratings', 'to_user_id'],
  ['meeting_records', 'user_id'], ['meeting_records', 'partner_id'],
  ['matches', 'participant_a_id'], ['matches', 'participant_b_id'], ['matches', 'participant_c_id'],
  ['circle_members', 'user_id'], ['pod_members', 'user_id'], ['session_participants', 'user_id'],
  ['user_entitlements', 'user_id'], ['user_subscriptions', 'user_id'],
  ['notifications', 'user_id'], ['refresh_tokens', 'user_id'], ['audit_log', 'actor_id'],
  ['onboarding_stage_events', 'user_id'], ['user_intent_profiles', 'user_id'],
  ['magic_links', 'email = $2', 'email'],
];

// Things the account OWNS that other people may be inside. Never deleted here:
// the operator decides (reassign, or delete the object first by hand).
const OWNERSHIP = [
  ['pods', 'created_by', 'name', 'pods it created'],
  ['sessions', 'host_user_id', 'title', 'events it hosts'],
  ['circles', 'created_by', 'name', 'circles it created'],
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
    // Ownership check BEFORE anything is touched.
    let blocked = false;
    for (const [table, col, labelCol, label] of OWNERSHIP) {
      // No catch here on purpose: a failing ownership query must abort the
      // run, never read as "owns nothing".
      const r = await pool.query(`SELECT id, ${labelCol} AS name FROM ${table} WHERE ${col} = $1`, [id]);
      if (r.rows.length) {
        blocked = true;
        console.log(`  REFUSING: ${label}: ${r.rows.map(x => `${x.name} (${x.id})`).join(', ')}`);
      }
    }
    if (blocked) {
      console.log('\nThis account owns objects other members may be inside. Reassign or remove them first; nothing was changed.');
      await pool.end();
      process.exit(2);
    }
    // Invites the account accepted stay (they belong to someone else's pod or
    // event); only the pointer to this account is cleared.
    const accepted = await pool.query(`SELECT COUNT(*)::int n FROM invites WHERE accepted_by_user_id = $1`, [id]);
    if (accepted.rows[0].n) console.log(`  invites it accepted: ${accepted.rows[0].n} (acceptor pointer will be cleared)`);
  }

  if (!apply) {
    if (id) {
      for (const [table, where, mode] of DEPENDENTS) {
        const clause = mode === true ? where : mode === 'email' ? where : `${where} = $1`;
        const params = mode === 'email' ? [id, email] : [id];
        const n = await pool.query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${clause}`, params).then(r => r.rows[0].n).catch(() => null);
        if (n === null) { console.log(`  ${table} (${where}): (table/column missing, skipped)`); continue; }
        if (n) console.log(`  ${table} (${where}): ${n} row(s)`);
      }
    }
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (id) {
      for (const [table, where, mode] of DEPENDENTS) {
        const clause = mode === true ? where : mode === 'email' ? where : `${where} = $1`;
        const params = mode === 'email' ? [id, email] : [id];
        const n = await client.query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${clause}`, params).then(r => r.rows[0].n).catch(() => null);
        if (n === null) { console.log(`  ${table} (${where}): (table/column missing, skipped)`); continue; }
        if (n) {
          console.log(`  ${table} (${where}): ${n} row(s) → deleting`);
          await client.query(`DELETE FROM ${table} WHERE ${clause}`, params);
        }
      }
      await client.query(`UPDATE invites SET accepted_by_user_id = NULL WHERE accepted_by_user_id = $1`, [id]);
      const d = await client.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id]);
      console.log(`  users: deleted ${d.rowCount}`);
    }
    if (jr.rows.length) { const d = await client.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email]); console.log(`  join_requests: deleted ${d.rowCount}`); }
    if (inv.rows.length) { const d = await client.query(`DELETE FROM invites WHERE lower(invitee_email) = $1`, [email]); console.log(`  invites: deleted ${d.rowCount}`); }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nROLLED BACK, nothing changed:', e.message);
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();
  const left = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE lower(email) = $1`, [email]);
  console.log(`\n${email} now ${left.rows[0].n === 0 ? 'FREE to request to join' : 'STILL EXISTS'}`);
  await pool.end();
}
main().catch(async (e) => { console.error('failed:', e); await pool.end(); process.exit(1); });
