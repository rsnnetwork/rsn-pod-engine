// Warm every member's profile card (3 Sep 2026): re-run production enrichment
// for each active account with a LinkedIn URL, two at a time (ScrapingDog Lite
// allows 2 concurrent LinkedIn scrapes), through the same admin refresh job
// onboarding uses, so the card is cached WITH a role before they log in.
//
//   cd e2e && node warm-cards.mjs            # dry run: who would be refreshed
//   cd e2e && node warm-cards.mjs --apply    # refresh, 2 at a time, print before/after
import dotenv from 'dotenv';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)) });
const SERVER = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const JWT_SECRET = fs.readFileSync(new URL('./.jwt_secret', import.meta.url), 'utf8').trim();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const apply = process.argv.includes('--apply');
// --missing-role-only: skip accounts whose cached card already carries a role.
const missingRoleOnly = process.argv.includes('--missing-role-only');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function snapshot(ids) {
  const r = await pool.query(
    `SELECT u.id, u.display_name, u.onboarding_status::text st, p.enrichment_status::text es,
            (p.inferred_profile->'enriched'->>'confidence')::float conf,
            COALESCE(p.inferred_profile->'enriched'->'profile'->>'currentRole','') role,
            COALESCE(p.inferred_profile->'enriched'->'profile'->>'headline','') headline
       FROM users u LEFT JOIN user_intent_profiles p ON p.user_id = u.id WHERE u.id = ANY($1)`, [ids]);
  return new Map(r.rows.map(x => [x.id, x]));
}

async function main() {
  const t = await pool.query(
    `SELECT id, display_name, email, onboarding_status::text st FROM users
      WHERE status = 'active' AND linkedin_url IS NOT NULL AND email NOT LIKE 'e2etest-%'
      ORDER BY (onboarding_status::text <> 'completed') DESC, display_name`);
  const all = t.rows;
  const before = await snapshot(all.map(x => x.id));
  const targets = missingRoleOnly ? all.filter(u => !(before.get(u.id)?.role)) : all;
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${targets.length} account(s) with a LinkedIn URL`);
  for (const u of targets) {
    const b = before.get(u.id);
    console.log(`  ${(u.display_name || '?').padEnd(26)} ${u.st.padEnd(15)} now: ${b?.es || 'none'} role="${b?.role || ''}"`);
  }
  if (!apply) { await pool.end(); return; }

  const adminId = randomUUID();
  const adminEmail = `e2etest-warmadmin-${Date.now()}@example.com`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed, onboarding_status, email_verified, company, job_title, industry, reasons_to_connect)
     VALUES ($1, $2, 'E2E Warm Admin', 'E2E', 'Admin', 'active', 'admin', true, true, 'completed', true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[])`,
    [adminId, adminEmail]);
  const token = jwt.sign({ sub: adminId, email: adminEmail, role: 'admin', displayName: 'E2E Warm Admin', sessionId: randomUUID() }, JWT_SECRET, { expiresIn: '2h' });

  const settled = async (id) => {
    const r = await pool.query(`SELECT enrichment_status::text es FROM user_intent_profiles WHERE user_id = $1`, [id]);
    const es = r.rows[0]?.es;
    return es && es !== 'searching' && es !== 'none';
  };

  try {
    const PAIR = 2;
    for (let i = 0; i < targets.length; i += PAIR) {
      const batch = targets.slice(i, i + PAIR);
      for (const u of batch) {
        const res = await fetch(`${SERVER}/api/onboarding/admin/refresh-enrichment`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ userId: u.id }),
        });
        console.log(`fired ${u.display_name}: HTTP ${res.status}`);
      }
      // Wait for both to settle (up to 4 minutes; the fill adds ~15s each).
      for (let k = 0; k < 48; k++) {
        await sleep(5000);
        const done = await Promise.all(batch.map(u => settled(u.id)));
        if (done.every(Boolean)) break;
      }
    }
  } finally {
    for (const sql of [`DELETE FROM audit_log WHERE actor_id = $1`, `DELETE FROM refresh_tokens WHERE user_id = $1`, `DELETE FROM notifications WHERE user_id = $1`, `DELETE FROM users WHERE id = $1`]) {
      await pool.query(sql, [adminId]).catch(() => {});
    }
  }

  const after = await snapshot(targets.map(x => x.id));
  let withRoleBefore = 0, withRoleAfter = 0, found = 0, partial = 0, failed = 0;
  console.log('\nBEFORE → AFTER');
  for (const u of targets) {
    const b = before.get(u.id), a = after.get(u.id);
    if (b?.role) withRoleBefore++;
    if (a?.role) withRoleAfter++;
    if (a?.es === 'found') found++; else if (a?.es === 'partial') partial++; else failed++;
    console.log(`  ${(u.display_name || '?').padEnd(26)} ${b?.es || 'none'}/"${b?.role || ''}"  →  ${a?.es || 'none'}/"${a?.role || ''}"`);
  }
  console.log(`\ncards with a role: ${withRoleBefore} → ${withRoleAfter} of ${targets.length}; found ${found}, partial ${partial}, other ${failed}`);
  await pool.end();
}
main().catch(async (e) => { console.error('warm failed:', e); await pool.end(); process.exit(1); });
