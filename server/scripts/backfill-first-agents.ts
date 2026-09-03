// ─── One-off: first agents for members who completed onboarding before B2 ────
//
// 13 Aug 2026, Task B2. Members who finished the chat AFTER migration 087
// re-seeded agents (4 Aug) got no agent: 087 only saw members who existed at
// the time, and nothing on the completion path created one until now. This
// gives them exactly what a member finishing today gets, through the SAME
// planner (planFirstAgents) so a dry run shows precisely what the real run
// would make.
//
// Scope: active, onboarding_status = 'completed', zero agents of any status.
// Members gated back into onboarding by 083 ('update_required') are NOT
// touched — they get their agents when they finish the chat.
//
//   cd server && npx ts-node -T scripts/backfill-first-agents.ts          # dry run
//   cd server && npx ts-node -T scripts/backfill-first-agents.ts --apply  # create + search

import '../src/config';
import { query, closePool } from '../src/db';
import { planFirstAgents, createFirstAgents } from '../src/services/matching/first-agent.service';

const apply = process.argv.includes('--apply');

interface Row {
  id: string;
  display_name: string | null;
  email: string;
  who: string | null;
  why: string | null;
}

(async () => {
  const r = await query<Row>(
    `SELECT u.id, u.display_name, u.email,
            u.who_i_want_to_meet AS who, u.why_i_want_to_meet AS why
       FROM users u
      WHERE u.status = 'active'
        AND u.onboarding_completed = true
        AND u.onboarding_status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM matching_agents a WHERE a.user_id = u.id)
      ORDER BY u.created_at`,
  );
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${r.rows.length} completed member(s) with no agent\n`);

  let planned = 0;
  let made = 0;
  for (const u of r.rows) {
    const plans = planFirstAgents({ whoText: u.who, whyText: u.why }, []);
    const who = (u.who || '').slice(0, 90) || '(nothing)';
    console.log(`• ${u.display_name ?? '?'} <${u.email}>`);
    console.log(`    said: "${who}"${u.why ? ` / why: "${(u.why || '').slice(0, 60)}"` : ''}`);
    if (!plans.length) { console.log('    → nothing searchable; skipped'); continue; }
    for (const p of plans) console.log(`    → ${p.label}  ← "${p.wantText.slice(0, 80)}"`);
    planned += plans.length;

    if (apply) {
      const agents = await createFirstAgents(u.id, { whoText: u.who, whyText: u.why });
      made += agents.length;
      for (const a of agents) {
        const m = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM agent_matches WHERE agent_id = $1`, [a.id]);
        console.log(`    ✓ created ${a.id.slice(0, 8)} "${a.label}" — ${m.rows[0].n} match(es) after first search`);
      }
    }
  }

  console.log(`\n${apply ? `Created ${made} agent(s)` : `Would create ${planned} agent(s)`} across ${r.rows.length} member(s).`);
  await closePool();
})().catch(async (err) => {
  console.error('backfill failed:', err);
  await closePool().catch(() => {});
  process.exit(1);
});
