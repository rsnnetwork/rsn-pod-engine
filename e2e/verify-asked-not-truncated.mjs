// Proves the fix for the deck's P1 first bullet, against the real database.
//
// "No view of who you have asked to meet." The cause was one LIMIT over a list
// that sorted asked people last: a search holding as many un-asked people as
// the page shows would drop every asked one off the end, so the person you had
// just pressed the button for disappeared from the search that found them.
//
// A SQL-string unit test cannot see this — the shape looks right either way.
// So this runs the real query over real rows, both the old way and the new,
// and shows the difference.
//
//   node verify-asked-not-truncated.mjs

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
config({ path: 'C:/dev/RSN/server/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const made = [];
const PAGE = 5; // stand-in for the page size, so six candidates are enough

const ownerId = randomUUID();
let agentId;

async function seed() {
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role,
                        profile_complete, onboarding_completed, onboarding_status, email_verified)
     VALUES ($1, $2, 'Trunc Owner', 'Trunc', 'Owner', 'active', 'member', true, true, 'completed', true)`,
    [ownerId, `e2etest-trunc-owner-${Date.now()}@example.com`],
  );
  made.push(ownerId);

  const a = await pool.query(
    `INSERT INTO matching_agents (user_id, label, want_text, matching_tags, status)
     VALUES ($1, 'Truncation check', 'founders and co-founders', '{}', 'active') RETURNING id`,
    [ownerId],
  );
  agentId = a.rows[0].id;

  // Six candidates. The one we ask is the WEAKEST, so it sorts last on score
  // as well as on asked — the worst case for being cut off.
  for (let i = 0; i < 6; i++) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, display_name, first_name, last_name, status, role,
                          profile_complete, onboarding_completed, onboarding_status, email_verified)
       VALUES ($1, $2, $3, 'Cand', $4, 'active', 'member', true, true, 'completed', true)`,
      [id, `e2etest-trunc-c${i}-${Date.now()}@example.com`, `Trunc Cand ${i}`, String(i)],
    );
    made.push(id);
    await pool.query(
      `INSERT INTO agent_matches (agent_id, candidate_user_id, score, reason)
       VALUES ($1, $2, $3, 'seeded')`,
      [agentId, id, (0.9 - i * 0.05).toFixed(4)],
    );
  }

  const asked = made[made.length - 1]; // the weakest
  await pool.query(
    `INSERT INTO user_pokes (id, sender_id, recipient_id, status, message, agent_id)
     VALUES (gen_random_uuid(), $1, $2, 'pending', 'Coffee?', $3)`,
    [ownerId, asked, agentId],
  );
  return asked;
}

/** What the page showed BEFORE: one limit over the whole list. */
async function oldWay(limit) {
  const r = await pool.query(
    `SELECT m.candidate_user_id AS id
       FROM agent_matches m
       JOIN matching_agents a ON a.id = m.agent_id
       JOIN users u ON u.id = m.candidate_user_id
       LEFT JOIN LATERAL (
         SELECT pk.id, pk.status FROM user_pokes pk
          WHERE pk.agent_id = a.id
            AND ((pk.sender_id = a.user_id AND pk.recipient_id = m.candidate_user_id)
             OR (pk.sender_id = m.candidate_user_id AND pk.recipient_id = a.user_id))
          ORDER BY pk.created_at DESC LIMIT 1
       ) p ON TRUE
      WHERE m.agent_id = $1 AND u.status = 'active'
        AND (p.status IS NULL OR p.status <> 'declined')
      ORDER BY (p.id IS NOT NULL), m.score DESC
      LIMIT $2`,
    [agentId, limit],
  );
  return r.rows.map(x => x.id);
}

/**
 * What it shows now — through the REAL repo, never a copy of its SQL.
 *
 * This used to hand-copy the query. That made it a test of a paste: when the
 * poke lookup went per-person on 22 Sep the copy kept the old agent filter,
 * kept asserting the old behaviour, and would have stayed green through the
 * change. Import the thing being tested.
 */
async function newWay(limit) {
  const repo = await import('../server/dist/services/matching/agent.repo.js');
  const rows = await repo.listMatches(agentId, limit);
  return rows.map(x => x.candidateUserId);
}

let failed = false;
try {
  const asked = await seed();
  const before = await oldWay(PAGE);
  const after = await newWay(PAGE);

  console.log(`  page size ${PAGE}, six people found, one of them asked`);
  console.log(`  before: ${before.length} shown, the asked person ${before.includes(asked) ? 'IS' : 'is NOT'} among them`);
  console.log(`  now:    ${after.length} shown, the asked person ${after.includes(asked) ? 'IS' : 'is NOT'} among them`);

  if (before.includes(asked)) {
    console.log('  ! the old query did not truncate here, so this proves nothing');
    failed = true;
  }
  if (!after.includes(asked)) {
    console.log('  ! the asked person is still missing');
    failed = true;
  }
  // Everyone still to ask is present too, so nothing was traded away.
  if (after.length !== 6) {
    console.log(`  ! expected all six, got ${after.length}`);
    failed = true;
  }
  if (!failed) console.log('  OK — asked people can no longer be squeezed off the page');
} finally {
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [made]);
  if (agentId) await pool.query(`DELETE FROM agent_matches WHERE agent_id = $1`, [agentId]);
  await pool.query(`DELETE FROM matching_agents WHERE user_id = $1`, [ownerId]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made]);
  await pool.end();
}
process.exit(failed ? 1 : 0);
