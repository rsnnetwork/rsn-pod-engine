// Proves the per-person change against the real database, through the REAL
// repo rather than a hand-copied query.
//
// The deck's P1 complaint was "no view of who you have asked to meet". Part of
// that was truncation (verify-asked-not-truncated.mjs). The rest was this: a
// person you had already asked showed up as a FRESH match on every other
// search, with an enabled "I want to meet" button — and pressing it answered
// 409, because only one pending request may exist per pair (migration 047).
//
// So the card was lying, and a SQL-text unit test cannot see it: the shape
// looks right either way. This runs the real thing over real rows.
//
//   node verify-asked-is-per-person.mjs

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
config({ path: 'C:/dev/RSN/server/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const made = [];
let agentA, agentB, targetId;

async function seed() {
  const owner = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role,
                        profile_complete, onboarding_completed, onboarding_status, email_verified)
     VALUES ($1, $2, 'PP Owner', 'PP', 'Owner', 'active', 'member', true, true, 'completed', true)`,
    [owner, `e2etest-pp-owner-${Date.now()}@example.com`],
  );
  made.push(owner);

  const mk = async (label, want) => (await pool.query(
    `INSERT INTO matching_agents (user_id, label, want_text, matching_tags, status)
     VALUES ($1, $2, $3, '{}', 'active') RETURNING id`, [owner, label, want],
  )).rows[0].id;
  agentA = await mk('Developers', 'react developers');
  agentB = await mk('Investors', 'angel investors');

  // One person that BOTH searches found.
  targetId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role,
                        profile_complete, onboarding_completed, onboarding_status, email_verified)
     VALUES ($1, $2, 'PP Both', 'PP', 'Both', 'active', 'member', true, true, 'completed', true)`,
    [targetId, `e2etest-pp-both-${Date.now()}@example.com`],
  );
  made.push(targetId);
  for (const a of [agentA, agentB]) {
    await pool.query(
      `INSERT INTO agent_matches (agent_id, candidate_user_id, score, reason)
       VALUES ($1, $2, 0.9, 'seeded')`, [a, targetId]);
  }

  // Asked THROUGH search A only.
  await pool.query(
    `INSERT INTO user_pokes (id, sender_id, recipient_id, status, message, agent_id)
     VALUES (gen_random_uuid(), $1, $2, 'pending', 'Coffee?', $3)`,
    [owner, targetId, agentA],
  );
  return owner;
}

let failed = false;
try {
  const owner = await seed();
  const repo = await import('../server/src/services/matching/agent.repo.ts').catch(() => null);

  // Read through the real repo if ts can be loaded; otherwise exercise the same
  // statements the repo builds, by importing the compiled output.
  const mod = repo ?? await import('../server/dist/services/matching/agent.repo.js');

  const onA = await mod.listMatches(agentA);
  const onB = await mod.listMatches(agentB);
  const rowA = onA.find(m => m.candidateUserId === targetId);
  const rowB = onB.find(m => m.candidateUserId === targetId);

  console.log(`  asked through "Developers" only`);
  console.log(`  on Developers: pokeStatus=${rowA?.pokeStatus ?? 'MISSING'}`);
  console.log(`  on Investors:  pokeStatus=${rowB?.pokeStatus ?? 'MISSING'}`);

  if (!rowA || !rowB) {
    console.log('  ! the person fell off one of the searches entirely');
    failed = true;
  }
  if (rowB && rowB.pokeStatus !== 'pending') {
    console.log('  ! the other search still calls them fresh — pressing the button there would 409');
    failed = true;
  }

  const agents = await mod.listAgents(owner);
  const a = agents.find(x => x.id === agentA);
  const b = agents.find(x => x.id === agentB);
  console.log(`  counts: Developers ${a.matchCount} outstanding / ${a.askedCount} asked`);
  console.log(`          Investors  ${b.matchCount} outstanding / ${b.askedCount} asked`);
  if (b.askedCount !== 1 || b.matchCount !== 0) {
    console.log('  ! the other search still counts them as someone to reach');
    failed = true;
  }
  if (!failed) console.log('  OK — asking someone settles them on every search, because you cannot ask twice');
} catch (err) {
  console.log(`  ! ${err.message}`);
  failed = true;
} finally {
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [made]);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id = ANY($1)`, [[agentA, agentB].filter(Boolean)]);
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [made]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made]);
  await pool.end();
}
process.exit(failed ? 1 : 0);
