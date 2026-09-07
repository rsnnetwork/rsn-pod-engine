// One-off (7 Sep 2026): members who finished onboarding before the Gravatar
// fallback existed never had it tried. For every active member with no photo,
// look up their public Gravatar (d=404: no generated image) and, when there is
// one, store it the way the server does (bytes + our own serving URL).
//
//   cd e2e && node gravatar-backfill.mjs            # dry run
//   cd e2e && node gravatar-backfill.mjs --apply
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)) });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const apply = process.argv.includes('--apply');
const API = 'https://api.rsn.network';

const gravatarUrl = (email) => `https://www.gravatar.com/avatar/${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}?s=512&d=404`;

async function main() {
  const r = await pool.query(`SELECT id, email, display_name FROM users WHERE status = 'active' AND avatar_url IS NULL AND avatar_blob IS NULL ORDER BY created_at`);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${r.rows.length} member(s) without a photo`);
  let found = 0;
  for (const u of r.rows) {
    const res = await fetch(gravatarUrl(u.email), { signal: AbortSignal.timeout(15000) }).catch(() => null);
    const type = res?.headers.get('content-type') || '';
    if (!res || !res.ok || !type.startsWith('image/')) { console.log(`  ${u.display_name} <${u.email}>: none`); continue; }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) { console.log(`  ${u.display_name}: gravatar over 2MB, skipped`); continue; }
    found++;
    console.log(`  ${u.display_name} <${u.email}>: FOUND ${type} ${bytes.length} bytes${apply ? ' → storing' : ''}`);
    if (apply) {
      await pool.query(
        `UPDATE users SET avatar_blob = $2, avatar_blob_type = $3, avatar_url = $4, updated_at = NOW() WHERE id = $1`,
        [u.id, bytes, type.split(';')[0], `${API}/api/users/${u.id}/avatar`],
      );
    }
  }
  console.log(`\n${found} of ${r.rows.length} have a public Gravatar${apply ? ', stored' : ''}.`);
  await pool.end();
}
main().catch(async (e) => { console.error('failed:', e); await pool.end(); process.exit(1); });
