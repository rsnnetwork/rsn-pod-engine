import { test, expect } from '@playwright/test';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, apiRequest } from '../helpers/api';

// #3 (25 May, Ali) — the HEADLINE fix, proven against the DEPLOYED server.
// The host picks "Platform-wide no rematch" (config.matchingPolicy='platform_wide'),
// but the create/update session zod config schema omitted the field, so zod stripped
// it at validation and the session persisted the within_event default — prior-event
// pairs were re-matched under a "no rematch" promise. This round-trips the policy
// through the live API: create with platform_wide, read it back, expect it kept.

let host: TestUser;

test.afterAll(async () => {
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('deployed server persists config.matchingPolicy = platform_wide (zod no longer strips it)', async () => {
  host = await createTestUser('mphost', 'super_admin');
  const pod = await createPod(host, 'E2E MatchingPolicy Pod');
  const sched = new Date(Date.now() + 3_600_000);
  const created = await apiRequest(host, 'POST', '/sessions', {
    podId: pod.id,
    title: 'E2E MatchingPolicy Test',
    description: 'E2E matching-policy persistence',
    scheduledAt: sched.toISOString(),
    config: {
      eventType: 'speed_networking',
      numberOfRounds: 3,
      matchingPolicy: 'platform_wide',
    },
  });
  const sessionId = created.data.id;

  // Read it back from the deployed server — the full persistence path
  // (zod -> service -> DB -> serialize), not just the in-process schema.
  const fetched = await apiRequest(host, 'GET', `/sessions/${sessionId}`);
  const policy = fetched.data?.config?.matchingPolicy;
  console.log('  persisted matchingPolicy:', policy, '| full config:', JSON.stringify(fetched.data?.config));
  expect(policy).toBe('platform_wide');
});

// 30 Oct 2026 (T12) — the cooldown rule keeps its months, and a pod's director (no admin) may choose a preset, which
// the server keeps; a template that is no preset is refused for them, at the field.
test('deployed server keeps the cooldown rule, its months and a preset chosen by a director', async () => {
  const director = await createTestUser('mpdirector', 'member');
  const pod = await createPod(director, 'E2E Presets Pod');
  const sched = new Date(Date.now() + 3_600_000);
  const founders = '5e7b1a5e-0000-4000-8000-000000000002';
  const created = await apiRequest(director, 'POST', '/sessions', {
    podId: pod.id, title: 'E2E Presets Test', scheduledAt: sched.toISOString(), format: 'speed_networking',
    config: { eventType: 'speed_networking', numberOfRounds: 3, matchingPolicy: 'cooldown', cooldownMonths: 6, matchingTemplateId: founders },
  });
  const fetched = await apiRequest(director, 'GET', `/sessions/${created.data.id}`);
  expect(fetched.data?.config).toMatchObject({ matchingPolicy: 'cooldown', cooldownMonths: 6, matchingTemplateId: founders });
  const presets = await apiRequest(director, 'GET', '/sessions/matching-presets');
  expect((presets.data as Array<{ name: string }>).map((p) => p.name))
    .toEqual(['General', 'Founders and investors', 'Jobs and hiring', 'Mentorship']);
});
