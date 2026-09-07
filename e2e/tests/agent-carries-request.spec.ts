import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { SERVER } from '../helpers/live-ui';

// ─────────────────────────────────────────────────────────────────────────────
// W3 (7 Sep 2026) — agents carry the WHOLE request, not just the role words.
//
// Stefan's onboarding said "people who run manufacturing and service businesses
// with more than 20 employees, founders, owner". Naming more than one kind of
// person collapsed each agent to a bare designation label ("founders",
// "business owners") and dropped the manufacturing/service criteria entirely, so
// the search could never prefer a manufacturing founder over any other.
//
// This drives the real completion endpoint (POST /onboarding/confirm, real
// Anthropic extraction) with that shape and asserts the seeded agents' search
// text now carries the industry qualifier, and that the structured slice is
// stored on the agent. Deterministic enough: the industry word is stated
// explicitly, so the extractor puts it in desiredIndustries and the seeder
// rides it onto every agent.
// ─────────────────────────────────────────────────────────────────────────────

let member: TestUser;

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.beforeAll(async () => {
  member = await createTestUser('carriesReq', 'member', 'not_started');
  await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [member.id]);
});

test.afterAll(async () => {
  const id = member?.id;
  if (!id) return;
  await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id = $1)`, [id]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = $1`, [id]).catch(() => {});
  await pool.query(`DELETE FROM onboarding_stage_events WHERE user_id = $1`, [id]).catch(() => {});
  await pool.query(`DELETE FROM user_intent_profiles WHERE user_id = $1`, [id]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  await pool.end().catch(() => {});
});

test('a member who names manufacturing founders + owners gets agents that carry the industry, not bare labels', async () => {
  test.setTimeout(300_000);

  const r = await apiAs(member, 'POST', '/onboarding/confirm', {
    messages: [
      { role: 'assistant', content: 'What brings you to Reason?' },
      { role: 'user', content: 'I want to meet founders and owners who run manufacturing and service businesses with more than 20 employees.' },
      { role: 'assistant', content: 'Thank you. I have what I need.' },
      { role: 'user', content: 'Let us wrap up now.' },
    ],
  });
  if (r.status === 503) {
    throw new Error('POST /onboarding/confirm answered 503 LLM_DISABLED — the Anthropic key is off or its prepaid balance is empty. Top up before verifying W3.');
  }
  expect(r.status, `confirm accepted: ${JSON.stringify(r.json)}`).toBe(200);

  const rows = (await pool.query(
    `SELECT label, want_text, matching_tags, status FROM matching_agents WHERE user_id = $1 ORDER BY created_at`,
    [member.id],
  )).rows as Array<{ label: string; want_text: string; matching_tags: string[]; status: string }>;

  console.log(`  agents: ${rows.map(r => `${r.label} [${r.status}] ← "${r.want_text}" tags=${JSON.stringify(r.matching_tags)}`).join('; ')}`);
  expect(rows.length, 'at least one agent seeded').toBeGreaterThan(0);

  // THE FIX: the industry criterion survives into the search text of at least
  // one agent (pre-fix every multi-designation agent was a bare label).
  const wantTexts = rows.map(r => (r.want_text || '').toLowerCase());
  expect(wantTexts.some(w => /manufactur/.test(w)), `an agent carries the industry — got ${JSON.stringify(rows.map(r => r.want_text))}`).toBe(true);

  // The structured want-side slice is stored for later semantic use.
  const anyTags = rows.some(r => Array.isArray(r.matching_tags) && r.matching_tags.length > 0);
  expect(anyTags, `structured tags stored — got ${JSON.stringify(rows.map(r => r.matching_tags))}`).toBe(true);
});
