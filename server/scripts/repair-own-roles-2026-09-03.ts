// One-off repair (3 Sep 2026), exact ids only.
//
// Stefan answered "I need a developer" in onboarding; the extractor put that
// into userRole and the save wrote it into professional_role, so he surfaced
// in every Developers agent as "Stefan Avivson is a developer". Four other
// members who said nothing about their own role had professional_role wiped
// to [] by the same unconditional write. Restore each from what the member
// confirmed on their card, then rescore every active agent so stored reasons
// stop calling Stefan a developer.
//
//   cd server && npx ts-node -T scripts/repair-own-roles-2026-09-03.ts          # dry run
//   cd server && npx ts-node -T scripts/repair-own-roles-2026-09-03.ts --apply

import '../src/config';
import { query, closePool } from '../src/db';
import * as agentRepo from '../src/services/matching/agent.repo';
import { recomputeAgent } from '../src/services/matching/agent-matching.service';

const apply = process.argv.includes('--apply');

const FIXES: Array<{ id: string; who: string; roles: string[] }> = [
  { id: '452186a3-d357-45c7-90c9-db488b6997f6', who: 'Stefan Avivson (stefanavivson@gmail.com)', roles: ['CEO', 'Founder'] },
  { id: '8ee9230f-0000-0000-0000-000000000000', who: 'Andrei Bohon', roles: ['founder'] },
  { id: '085fc051-0000-0000-0000-000000000000', who: 'Beatrice Gutknecht', roles: ['Founding Badass | Lead Strategist'] },
  { id: '12962857-0000-0000-0000-000000000000', who: 'Shirley Palmer', roles: ['CEO & Founder'] },
  { id: 'b0be51e1-0000-0000-0000-000000000000', who: 'jack rajaa', roles: ['frontend engineer'] },
];

(async () => {
  // Resolve the four short ids to full ids from the card role they confirmed,
  // and refuse to touch anything that does not match exactly one row.
  for (const f of FIXES) {
    const prefix = f.id.slice(0, 8);
    const r = await query<{ id: string; display_name: string; professional_role: string[] | null; card: string | null }>(
      `SELECT u.id, u.display_name, u.professional_role, p.confirmed_profile->>'role' AS card
         FROM users u LEFT JOIN user_intent_profiles p ON p.user_id = u.id
        WHERE u.id::text LIKE $1`, [`${prefix}%`]);
    if (r.rows.length !== 1) { console.log(`SKIP ${f.who}: ${r.rows.length} rows for prefix ${prefix}`); continue; }
    const row = r.rows[0];
    f.id = row.id;
    console.log(`${f.who}: professional_role ${JSON.stringify(row.professional_role)} → ${JSON.stringify(f.roles)} (card: ${JSON.stringify(row.card)})`);
    if (apply) {
      await query(`UPDATE users SET professional_role = $2, updated_at = NOW() WHERE id = $1`, [f.id, f.roles]);
      console.log(`  ✓ updated ${row.id}`);
    }
  }

  if (apply) {
    const agents = await agentRepo.listActiveAgentsForMatching();
    let n = 0;
    for (const a of agents) { await recomputeAgent(a); n++; }
    console.log(`rescored ${n} active agent(s)`);
    const check = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agent_matches m WHERE m.candidate_user_id = $1 AND m.reason ILIKE '%is a developer%'`,
      ['452186a3-d357-45c7-90c9-db488b6997f6']);
    console.log(`stored reasons still calling Stefan a developer: ${check.rows[0].n}`);
  } else {
    console.log('\nDRY RUN — re-run with --apply to write and rescore.');
  }
  await closePool();
})().catch(async (e) => { console.error('repair failed:', e); await closePool().catch(() => {}); process.exit(1); });
