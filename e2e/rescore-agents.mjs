// Rescore one or more members' ACTIVE agents on production, the way the app
// does it: PATCH /agents/:id with the agent's own want text, which the route
// answers at once and rescoring in the background. Then wait for the stored
// matches to settle and print them with their reasons.
//
//   cd e2e && JWT_SECRET=... node rescore-agents.mjs alihamza891840@gmail.com alihammza143@gmail.com
//
// 15 Sep 2026: used after the two scorer rules shipped (one synonym word is
// not a match; what a member wants is not what they are), so the agents Ali
// asked about show the new verdicts without waiting for a new member to join.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import pg from 'pg';
dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)) });
const SERVER = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const SECRET = process.env.JWT_SECRET || process.env.E2E_JWT_SECRET;
if (!SECRET) { console.error('JWT_SECRET missing'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const emails = process.argv.slice(2).map((e) => e.toLowerCase());
if (!emails.length) { console.error('usage: node rescore-agents.mjs <email> [email…]'); process.exit(1); }

for (const email of emails) {
  const u = (await pool.query(`SELECT id, email, role::text role, display_name FROM users WHERE lower(email) = $1`, [email])).rows[0];
  if (!u) { console.log(`${email}: no user`); continue; }
  const token = jwt.sign({ sub: u.id, email: u.email, role: u.role, displayName: u.display_name, sessionId: 'rescore' }, SECRET, { expiresIn: '10m' });
  const agents = (await pool.query(`SELECT id, label, want_text FROM matching_agents WHERE user_id = $1 AND status = 'active'`, [u.id])).rows;
  for (const a of agents) {
    const before = (await pool.query(`SELECT count(*)::int n FROM agent_matches WHERE agent_id = $1`, [a.id])).rows[0].n;
    const res = await fetch(`${SERVER}/api/agents/${a.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ wantText: a.want_text }),
    });
    console.log(`\n${u.display_name} — "${a.label}" (${a.want_text}): PATCH ${res.status}, ${before} match(es) before`);
    await new Promise((r) => setTimeout(r, 8000));
    const rows = (await pool.query(
      `SELECT am.score, am.reason, x.display_name, x.job_title, x.company, x.industry
         FROM agent_matches am JOIN users x ON x.id = am.candidate_user_id WHERE am.agent_id = $1 ORDER BY am.score DESC`, [a.id])).rows;
    console.log(`  ${rows.length} match(es) after:`);
    for (const m of rows) console.log(`   - ${m.display_name} (${m.job_title || '-'} @ ${m.company || '-'}, ${m.industry || '-'}) score=${m.score}: ${m.reason}`);
  }
}
await pool.end();
