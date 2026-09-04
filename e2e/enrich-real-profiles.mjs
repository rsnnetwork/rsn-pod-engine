// One-off (3 Sep 2026): run production enrichment for real accounts whose
// LinkedIn URLs Ali supplied, via the same admin refresh job the platform
// uses, and print what came back. Temp admin is created and deleted by id.
//
//   cd e2e && node enrich-real-profiles.mjs
import dotenv from 'dotenv';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

// Same source of DATABASE_URL as the E2E helpers: the server's .env.
dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)) });

const SERVER = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const JWT_SECRET = fs.readFileSync(new URL('./.jwt_secret', import.meta.url), 'utf8').trim();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Optional: pass an id prefix to run one target only (node enrich-real-profiles.mjs cdabda51).
const ONLY = process.argv[2] || '';
const TARGETS = ([
  { id: 'c52d876d-b314-4b7c-9c24-c2008d35af37', who: 'Raja Ali King (alihamza891840)', linkedin: 'https://www.linkedin.com/in/alihamzaraja/' },
  { id: 'af509ec9-3628-4ef5-ab78-2d8ea8aea955', who: 'Malik Ahmed Javed (…882)', linkedin: 'https://www.linkedin.com/in/malik-ahmed-748738186/' },
  { id: 'cdabda51-1eee-452f-b29e-5c9c62dbe3fe', who: 'Malik Ahmed Javed (…1011)', linkedin: 'https://www.linkedin.com/in/malik-ahmed-748738186/' },
  { id: '7ddf177b-3689-463b-a271-4a7ee170ff67', who: 'Ali Hamzaa (alihammza143, 4 Sep re-signup)', linkedin: 'https://www.linkedin.com/in/ali-hamza-b0650a281' },
]).filter(t => !ONLY || t.id.startsWith(ONLY));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // 1. Set the URLs Ali gave, by exact id.
  for (const t of TARGETS) {
    const r = await pool.query(`UPDATE users SET linkedin_url = $2, updated_at = NOW() WHERE id = $1 RETURNING display_name`, [t.id, t.linkedin]);
    console.log(`set linkedin_url for ${t.who}: ${r.rowCount === 1 ? 'ok' : 'NO ROW'}`);
  }

  // 2. Temp admin (E2E convention: e2etest- prefix, deleted below).
  const adminId = randomUUID();
  const adminEmail = `e2etest-enrichadmin-${Date.now()}@example.com`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed, onboarding_status, email_verified, company, job_title, industry, reasons_to_connect)
     VALUES ($1, $2, 'E2E Enrich Admin', 'E2E', 'Admin', 'active', 'admin', true, true, 'completed', true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[])`,
    [adminId, adminEmail]);
  const token = jwt.sign({ sub: adminId, email: adminEmail, role: 'admin', displayName: 'E2E Enrich Admin', sessionId: randomUUID() }, JWT_SECRET, { expiresIn: '1h' });

  try {
    // 3. Fire the refresh job for each target.
    for (const t of TARGETS) {
      const res = await fetch(`${SERVER}/api/onboarding/admin/refresh-enrichment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: t.id }),
      });
      console.log(`refresh fired for ${t.who}: HTTP ${res.status}`);
    }

    // 4. Poll for results (the job is fire-and-forget on the server).
    const done = new Set();
    for (let i = 0; i < 36 && done.size < TARGETS.length; i++) {
      await sleep(5000);
      for (const t of TARGETS) {
        if (done.has(t.id)) continue;
        const r = await pool.query(
          `SELECT enrichment_status::text AS status, enrichment_source AS source, enrichment_error AS error,
                  enrichment_started_at AS started, enrichment_completed_at AS completed,
                  inferred_profile->'enriched' AS enriched
             FROM user_intent_profiles WHERE user_id = $1`, [t.id]);
        const row = r.rows[0];
        const state = row ? { status: row.status, source: row.source, error: row.error, completed: row.completed } : null;
        const enr = row?.enriched || null;
        const status = state?.status || null;
        if (status && status !== 'searching' && status !== 'none' && status !== 'pending') {
          done.add(t.id);
          console.log(`\n══════ ${t.who} ══════`);
          console.log(`state: ${JSON.stringify(state)}`);
          if (enr) {
            const p = enr.profile || {};
            console.log(`confidence: ${enr.confidence}   source: ${enr.source ?? '-'}   matched url: ${enr.linkedinUrl ?? p.linkedinUrl ?? '-'}`);
            console.log(`  fullName:      ${p.fullName ?? '-'}`);
            console.log(`  headline:      ${p.headline ?? '-'}`);
            console.log(`  currentRole:   ${p.currentRole ?? '-'}`);
            console.log(`  currentCompany:${p.currentCompany ?? '-'}`);
            console.log(`  industry:      ${p.industry ?? '-'}`);
            console.log(`  location:      ${p.location ?? '-'}`);
            console.log(`  summary:       ${(p.summary ?? '-').toString().slice(0, 300)}`);
            console.log(`  skills:        ${(p.skills || []).slice(0, 12).join(', ') || '-'}`);
            console.log(`  pastRoles:     ${(p.pastRoles || []).slice(0, 6).join(' | ') || '-'}`);
            console.log(`  likelyWants:   ${(p.likelyWantsToMeet || []).join(', ') || '-'}`);
            console.log(`  likelyOffers:  ${(p.likelyOffers || []).join(', ') || '-'}`);
            console.log(`  starters:      ${(p.conversationStarters || []).join(' | ') || '-'}`);
            console.log(`  verify:        ${(p.questionsToVerify || []).join(' | ') || '-'}`);
          } else {
            console.log('no enriched candidate stored');
          }
        }
      }
    }
    for (const t of TARGETS) if (!done.has(t.id)) console.log(`\n${t.who}: still not settled after 3 minutes`);
  } finally {
    // 5. Remove the temp admin by id.
    for (const sql of [
      `DELETE FROM audit_log WHERE actor_id = $1`, `DELETE FROM refresh_tokens WHERE user_id = $1`,
      `DELETE FROM notifications WHERE user_id = $1`, `DELETE FROM users WHERE id = $1`,
    ]) await pool.query(sql, [adminId]).catch(() => {});
    const left = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE id = $1`, [adminId]);
    console.log(`\ntemp admin removed: ${left.rows[0].n === 0}`);
    await pool.end();
  }
}
main().catch(async (e) => { console.error('failed:', e); await pool.end(); process.exit(1); });
