import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, SERVER } from '../helpers/live-ui';

// THE EMPTY-BALANCE ALERT ON PRODUCTION (7 Sep 2026).
//
// One real call into the host through /onboarding/open, as a throwaway member.
// With credits: 200 and a reply, nothing to alert. Without credits: the route
// answers 503 LLM_DISABLED as before, and the server (not this test) emails
// dev@rsn.network once an hour; the ship chain reads the Render log for the
// alert line right after. Either way the route never leaks a stack or hangs.

let member: TestUser;

test.beforeAll(async () => {
  member = await createTestUser('balancealert', 'member', 'not_started');
  await pool.query(`UPDATE users SET onboarding_completed = false, company = 'Fjord Analytics' WHERE id = $1`, [member.id]);
});

test.afterAll(async () => {
  await cleanup(pool, { ids: [member?.id].filter(Boolean) });
  await cleanupByPrefix(pool, 'e2etest-balancealert');
});

test('one host call: a reply when credited, a clean 503 LLM_DISABLED when the balance is empty', async () => {
  test.setTimeout(120_000);
  const started = Date.now();
  const res = await fetch(`${SERVER}/api/onboarding/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${member.accessToken}` },
    body: JSON.stringify({ profile: { name: 'Balance Alert', firstName: 'Balance', company: 'Fjord Analytics', role: 'Engineer' } }),
  });
  const json = await res.json().catch(() => null);
  const ms = Date.now() - started;
  console.log(`  /onboarding/open → ${res.status} in ${ms}ms: ${JSON.stringify(json).slice(0, 160)}`);
  expect([200, 503]).toContain(res.status);
  if (res.status === 200) {
    expect(String(json?.data?.reply || '').length).toBeGreaterThan(0);
    console.log('  ✓ credited: the host answered.');
  } else {
    expect(json?.error?.code ?? json?.code ?? JSON.stringify(json)).toMatch(/LLM_DISABLED/);
    console.log('  ✓ empty balance: clean LLM_DISABLED, the server alerts dev@rsn.network (see the Render log).');
  }
});
