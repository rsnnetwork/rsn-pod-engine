import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, SERVER } from '../helpers/live-ui';

// THE HOST'S VOICE (13 Aug 2026, Task D2) — a real conversation with the real
// model on production, printed for a human to read, with the two hard style
// rules asserted: no dashes, and short messages. Whether it *sounds* human is
// Stefan's call; the transcript below is what he judges.
//
// Then the same member confirms, so the transcript ends the way a real
// onboarding does: with first agents created from what they said (B2).

let member: TestUser;

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

test.beforeAll(async () => {
  member = await createTestUser('hostvoice', 'member', 'not_started');
  await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [member.id]);
});

test.afterAll(async () => {
  const ids = [member?.id].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-hostvoice');
});

test('the host reacts before it asks, keeps it short, never uses a dash, and the chat ends on first agents', async () => {
  test.setTimeout(600_000);

  const memberSays = [
    'I run a small fintech startup in Copenhagen, about eight of us, we do invoicing for freelancers.',
    'Honestly I need senior React developers who have shipped consumer products, and maybe an angel or two who know Nordic fintech.',
    'I can help with pricing and with getting a first hundred paying customers, I have done that twice.',
  ];

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const transcript: string[] = [];
  let ready = false;

  for (const line of memberSays) {
    messages.push({ role: 'user', content: line });
    const r = await apiAs(member, 'POST', '/onboarding/chat', { messages });
    if (r.status === 503) throw new Error('LLM still disabled on production (503). Is the Anthropic balance really topped up?');
    expect(r.status, `chat turn: ${JSON.stringify(r.json)}`).toBe(200);
    const reply: string = r.json.data.reply;
    ready = !!r.json.data.ready;
    messages.push({ role: 'assistant', content: reply });
    transcript.push(`MEMBER: ${line}`, `HOST:   ${reply}`, '');

    // Hard style rules from the prompt.
    expect(reply, 'no em or en dash').not.toMatch(/[—–]/);
    expect(words(reply), `under the word budget: "${reply}"`).toBeLessThanOrEqual(55);
    if (ready) break;
  }

  if (!ready) {
    messages.push({ role: 'user', content: 'Let us wrap up now.' });
    const r = await apiAs(member, 'POST', '/onboarding/chat', { messages, hardFinish: true });
    expect(r.status).toBe(200);
    messages.push({ role: 'assistant', content: r.json.data.reply });
    transcript.push('MEMBER: Let us wrap up now.', `HOST:   ${r.json.data.reply}`, '');
  }

  console.log('\n──────── REAL TRANSCRIPT (production, ' + new Date().toISOString() + ') ────────');
  for (const l of transcript) console.log(l);
  console.log('────────────────────────────────────────────────────────────────\n');

  // The member confirms, the way the client does (opening dropped).
  const confirm = await apiAs(member, 'POST', '/onboarding/confirm', {
    messages: messages.map(m => ({ ...m, content: m.content.replace(/<<READY>>/g, '').trim() || '.' })),
  });
  expect(confirm.status, `confirm: ${JSON.stringify(confirm.json)}`).toBe(200);
  const agents = confirm.json.data.firstAgents as Array<{ id: string; label: string }>;
  console.log(`FIRST AGENTS: ${agents.map(a => a.label).join(' | ') || '(none)'}`);
  expect(agents.length, 'the chat ended on at least one agent').toBeGreaterThan(0);
  expect(agents.map(a => a.label).join(' ')).toMatch(/Developers|Investors/);

  const rows = await pool.query(`SELECT label, want_text, last_matched_at FROM matching_agents WHERE user_id = $1`, [member.id]);
  for (const a of rows.rows) {
    expect(a.last_matched_at, `${a.label} searched`).not.toBeNull();
    console.log(`  ${a.label} ← "${String(a.want_text).slice(0, 90)}"`);
  }
});
