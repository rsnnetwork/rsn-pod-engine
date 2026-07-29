// Pre-warm Stefan via the PROD admin refresh-enrichment endpoint (runs the
// scrape on Render, immune to local network issues). Runbook pre-flight step 4.
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { config as dc } from 'dotenv';
dc({ path: 'C:/Users/ARFA TECH/Desktop/RSN-loop/server/.env' });

const RT = process.env.RENDER_TOKEN, SVC = process.env.RENDER_SVC;
const API = 'https://api.rsn.network';
async function prodSecret() {
  const r = await fetch(`https://api.render.com/v1/services/${SVC}/env-vars?limit=100`, { headers: { Authorization: `Bearer ${RT}` } });
  for (const it of await r.json()) { const ev = it.envVar || it; if (ev.key === 'JWT_SECRET' && ev.value) return ev.value; }
  throw new Error('no prod JWT_SECRET');
}
const SECRET = await prodSecret();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const admin = (await pool.query(`SELECT id, email, role, display_name FROM users WHERE email = 'alihamza891840@gmail.com'`)).rows[0];
const stefan = (await pool.query(`SELECT id FROM users WHERE email = 'stefanavivson@gmail.com'`)).rows[0];
const token = jwt.sign({ sub: admin.id, email: admin.email, role: admin.role, displayName: admin.display_name, sessionId: 'preflight-' + Date.now() }, SECRET, { expiresIn: '30m' });

const res = await fetch(`${API}/api/onboarding/admin/refresh-enrichment`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ userId: stefan.id }),
});
console.log('refresh endpoint:', res.status);

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = (await pool.query(`SELECT enrichment_status::text AS st, enrichment_error, inferred_profile->'enriched'->>'fullName' AS name FROM user_intent_profiles WHERE user_id = $1`, [stefan.id])).rows[0] || {};
  if (s.st && s.st !== 'searching' && s.st !== 'none') {
    console.log(`RESULT: ${s.st}${s.enrichment_error ? ' (' + s.enrichment_error + ')' : ''} | person: ${s.name}`);
    break;
  }
  if (i === 29) console.log('RESULT: still', s.st, 'after 150s');
}
await pool.end();
