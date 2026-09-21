import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// The five steps (Shradha's deck, 21 Sep 2026, task 1).
//
// "Onboarding is a showstopper. It gets fixed before any user engagement."
// The complaints were: open-ended questions that yield unusable data, a profile
// full of guesses shown as fact, and no idea what to do afterwards.
//
// These walk it as a person does, at a phone size, and check the things that
// went wrong before: nothing guessed on the confirm screen, a refresh in the
// middle losing nothing, and answers that leave the member actually matchable.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };

let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Someone who has just been approved and has answered nothing yet. */
async function freshMember(suffix: string): Promise<TestUser> {
  const u = await createTestUser(suffix, 'member', 'not_started');
  made.push(u.id);
  await pool.query(
    `UPDATE users SET onboarding_completed = false, display_name = $2,
       company = NULL, job_title = NULL, industry = NULL, bio = NULL
     WHERE id = $1`,
    [u.id, `Tick ${suffix}`],
  );
  return u;
}

async function openAs(u: TestUser, path = '/onboarding'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

const tile = (page: Page, label: string | RegExp) =>
  page.getByRole('checkbox', { name: label }).or(page.getByRole('radio', { name: label })).first();

/** Answer one question and move on. */
async function answer(page: Page, labels: (string | RegExp)[], button: RegExp = /Continue|See my profile/) {
  for (const l of labels) await tapReachable(page, tile(page, l), `option ${l}`);
  await tapReachable(page, page.getByRole('button', { name: button }), 'the continue button');
}

test.beforeAll(async () => {
  console.log(`[onboarding-tickbox] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  if (made.length) await cleanup(pool, { ids: made });
  await cleanupByPrefix(pool, 'e2etest-tb');
  await pool.end().catch(() => {});
});

test('a new member answers five questions and lands somewhere with people in it', async () => {
  test.setTimeout(240_000);
  const me = await freshMember('tbfull');
  const page = await openAs(me);

  // Welcome: one button, and nothing pre-filled beyond the name.
  await expect(page.getByText(/welcome to RSN/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button')).toHaveCount(1);
  await tapReachable(page, page.getByRole('button', { name: /Let's go/i }), '"Let\'s go"');

  await answer(page, [/Find investors or funding/i]);
  await answer(page, [/Investors & VCs/i, /Advisors & mentors/i]);
  await answer(page, [/Mentoring & advice/i]);
  await answer(page, [/Software & AI/i]);
  await answer(page, [/Founders & entrepreneurs/i]);

  // Confirm: every row is something they chose. Nothing about their country,
  // their company or a scraped About line — the three the old screen guessed.
  await expect(page.getByText(/Here's your profile/i)).toBeVisible({ timeout: 20_000 });
  const card = page.locator('body');
  await expect(card).toContainText('Investors & VCs');
  await expect(card).toContainText('Founders');
  await expect(card).not.toContainText(/a guess, fix if wrong/i);
  await expect(card).not.toContainText(/Not on your LinkedIn page/i);

  await tapReachable(page, page.getByRole('button', { name: /Looks right/i }), '"Looks right - continue"');

  // Straight into their suggestions, not back to a form.
  await page.waitForURL(/\/agents/, { timeout: 30_000 });
  console.log(`  ✓ landed on ${new URL(page.url()).pathname}`);

  // The answers are stored as keys, so two members can be compared at all.
  const row = (await pool.query<{
    onboarding_intent: string; looking_to_meet: string[]; can_offer: string[];
    self_kinds: string[]; industries: string[]; onboarding_status: string;
    professional_role: string[]; who_i_want_to_meet: string | null;
  }>(
    `SELECT onboarding_intent, looking_to_meet, can_offer, self_kinds, industries,
            onboarding_status, professional_role, who_i_want_to_meet
     FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.onboarding_status).toBe('completed');
  expect(row.onboarding_intent).toBe('find_investors');
  expect(row.looking_to_meet).toEqual(['investors', 'advisors_mentors']);
  expect(row.self_kinds).toEqual(['founders']);
  // And as words the existing matcher reads, so they are visible to members
  // who joined long before this flow existed.
  expect(row.professional_role.join(' ')).toMatch(/founder/i);
  expect(row.who_i_want_to_meet).toMatch(/investor/i);

  // One standing search per kind they asked for, and each is actually running.
  const agents = await pool.query<{ label: string; status: string }>(
    `SELECT label, status FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [me.id],
  );
  expect(agents.rows.length).toBe(2);
  expect(agents.rows.every(a => a.status === 'active')).toBe(true);
  console.log(`  ✓ searches: ${agents.rows.map(a => a.label).join(', ')}`);
});

test('a refresh in the middle loses nothing', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('tbresume');
  const page = await openAs(me);

  await tapReachable(page, page.getByRole('button', { name: /Let's go/i }), '"Let\'s go"');
  await answer(page, [/Get advice from experienced people/i]);
  await answer(page, [/Advisors & mentors/i]);
  await expect(page.getByText(/What can you offer/i)).toBeVisible();

  // Exactly what happens when the browser is closed, or the phone rings.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/What can you offer/i)).toBeVisible({ timeout: 30_000 });

  // And the earlier answers are still ticked, not silently dropped.
  await tapReachable(page, page.getByRole('button', { name: /^Back$/ }), 'Back');
  await expect(tile(page, /Advisors & mentors/i)).toHaveAttribute('aria-checked', 'true');
  console.log('  ✓ came back to the same question with the answers intact');
});

test('you cannot pick more than three people to meet, and it says so', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('tblimit');
  const page = await openAs(me);
  await tapReachable(page, page.getByRole('button', { name: /Let's go/i }), '"Let\'s go"');
  await answer(page, [/Grow my professional network/i]);

  for (const l of [/Founders & entrepreneurs/i, /Investors & VCs/i, /Advisors & mentors/i]) {
    await tapReachable(page, tile(page, l), `option ${l}`);
  }
  await expect(page.getByText(/That is 3/i)).toBeVisible();
  // A fourth is visibly unavailable rather than silently ignored.
  await expect(tile(page, /Developers & technical people/i)).toBeDisabled();
  // …and the ones already chosen still work, so they can swap.
  await tapReachable(page, tile(page, /Investors & VCs/i), 'untick one');
  await expect(tile(page, /Developers & technical people/i)).toBeEnabled();
  console.log('  ✓ the limit is visible and swappable');
});

test('picking Other means saying which, before you can go on', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('tbother');
  const page = await openAs(me);
  await tapReachable(page, page.getByRole('button', { name: /Let's go/i }), '"Let\'s go"');
  await answer(page, [/Grow my professional network/i]);
  await answer(page, [/Founders & entrepreneurs/i]);
  await answer(page, [/Introductions & my network/i]);

  await tapReachable(page, tile(page, /^Other$/i), 'Other');
  await expect(page.getByRole('button', { name: /Continue/ })).toBeDisabled();
  await page.locator('#industry-other').fill('marine logistics');
  await tapReachable(page, page.getByRole('button', { name: /Continue/ }), 'Continue');

  await answer(page, [/Founders & entrepreneurs/i], /See my profile/);
  // Their own words lead the line: for anyone outside the five fixed
  // industries it is the only thing we know about them.
  await expect(page.getByText('marine logistics')).toBeVisible();
  await tapReachable(page, page.getByRole('button', { name: /Looks right/i }), '"Looks right - continue"');
  await page.waitForURL(/\/agents/, { timeout: 30_000 });

  const row = (await pool.query<{ industry: string | null; industry_other: string | null }>(
    `SELECT industry, industry_other FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.industry_other).toBe('marine logistics');
  expect(row.industry).toMatch(/marine logistics/);
});

test('finishing twice does not create a second set of searches', async () => {
  const me = await freshMember('tbtwice');
  const body = {
    intent: 'get_advice', lookingToMeet: ['advisors_mentors'], canOffer: ['introductions_network'],
    industries: ['software_ai'], industryOther: null, selfKinds: ['founders'],
    jobTitle: null, company: null, about: null,
  };
  const a = await apiAs(me, 'POST', '/onboarding/answers/confirm', body);
  const b = await apiAs(me, 'POST', '/onboarding/answers/confirm', body);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(b.json.data.changed).toBe(false);
  const agents = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM matching_agents WHERE user_id = $1`, [me.id],
  );
  expect(agents.rows[0].n).toBe('1');
});

test('an answer that is not on the list is refused', async () => {
  const me = await freshMember('tbbad');
  const bad = await apiAs(me, 'POST', '/onboarding/answers/confirm', {
    intent: 'something_else', lookingToMeet: ['founders'], canOffer: ['investment'],
    industries: ['software_ai'], selfKinds: ['founders'],
  });
  expect(bad.status).toBe(400);

  const tooMany = await apiAs(me, 'POST', '/onboarding/answers/confirm', {
    intent: 'get_advice',
    lookingToMeet: ['founders', 'investors', 'advisors_mentors', 'developers_technical'],
    canOffer: ['investment'], industries: ['software_ai'], selfKinds: ['founders'],
  });
  expect(tooMany.status).toBe(400);

  // Ticking Other without saying which leaves them with no industry at all.
  const otherMissing = await apiAs(me, 'POST', '/onboarding/answers/confirm', {
    intent: 'get_advice', lookingToMeet: ['founders'], canOffer: ['investment'],
    industries: ['other'], selfKinds: ['founders'],
  });
  expect(otherMissing.status).toBe(400);
});

test('two people who answered the tick boxes can find each other', async () => {
  test.setTimeout(180_000);
  // The promise of the whole flow: structured answers that actually match.
  const seeker = await freshMember('tbseek');
  const target = await freshMember('tbtarget');

  await apiAs(target, 'POST', '/onboarding/answers/confirm', {
    intent: 'grow_network', lookingToMeet: ['founders'], canOffer: ['investment'],
    industries: ['finance_investing'], industryOther: null, selfKinds: ['investors'],
    jobTitle: null, company: null, about: null,
  });
  const res = await apiAs(seeker, 'POST', '/onboarding/answers/confirm', {
    intent: 'find_investors', lookingToMeet: ['investors'], canOffer: ['skills_services'],
    industries: ['software_ai'], industryOther: null, selfKinds: ['founders'],
    jobTitle: null, company: null, about: null,
  });
  expect(res.status).toBe(200);

  const agentId = res.json.data.primaryAgentId;
  expect(agentId).toBeTruthy();
  const found = await pool.query<{ n: string; score: string | null }>(
    `SELECT count(*)::text AS n, max(score)::text AS score
     FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`,
    [agentId, target.id],
  );
  console.log(`  ✓ the investor search found the investor: ${found.rows[0].n} match, score ${found.rows[0].score}`);
  expect(Number(found.rows[0].n)).toBeGreaterThan(0);
});
