import * as path from 'path';
import { test, expect, Browser, BrowserContext, Locator, Page, WebSocketRoute } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding, version 2 (Shradha's brief, 19 Oct 2026): Welcome, "Let's get you
// started", four questions, "Here's how others will see you", then For You with
// the short tour over it. Built on Task 8's /api/onboarding/v2 endpoints.
//
// Walked as a person does, at a phone size, pressing by coordinates (a button
// that is clipped or covered fails), and checked in the database afterwards.
// The LinkedIn lookup runs for real: on the local stack there is no ScrapingDog
// key, so it ends with nothing found, and the member types their details. The
// "found" case is the real cached-result path, seeded the way a lookup writes it.
//
// 25 Oct review (Stefan and Claus): every question is "Select all that apply."
// (no limit, nothing greyed out), an employee finds themselves without
// "Something else", and LinkedIn can suggest several descriptions, each marked
// "From LinkedIn", for a tab or a device that did not make the choice too.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };
const ZONE = 'Europe/Berlin';
const ALL_THAT_APPLY = 'Select all that apply.';
const PICKED_LINE = "We picked these from your LinkedIn. Change them if they're wrong.";
const FROM_LINKEDIN = 'From LinkedIn';
// On the local stack there is no ScrapingDog key, so a LinkedIn lookup costs nothing and ends with nothing found.
// Anywhere else (a preview, production) a lookup is a paid request: a test that presses "Continue with LinkedIn" seeds
// the outcome for its address first, and the server reuses it instead of starting one (final review, 21 Oct 2026).
const LOCAL_API = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(SERVER);
// Where the screens worth looking at are saved: E2E_SHOTS_DIR when it is set, as reason-m1.spec.ts does.
const SHOTS = process.env.E2E_SHOTS_DIR ? path.resolve(process.env.E2E_SHOTS_DIR) : path.resolve(__dirname, '..', 'test-results');

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

/** Someone just approved: signed in, nothing answered, no role, company, photo or time zone yet. */
async function freshMember(suffix: string, linkedinUrl: string | null = null): Promise<TestUser> {
  const u = await createTestUser(suffix, 'member', 'not_started');
  made.push(u.id);
  await pool.query(
    `UPDATE users SET onboarding_completed = false, display_name = $2, first_name = 'Ana', last_name = $3,
       company = NULL, job_title = NULL, industry = NULL, bio = NULL, avatar_url = NULL, timezone = NULL,
       linkedin_url = $4
     WHERE id = $1`,
    [u.id, `Ana ${suffix}`, suffix, linkedinUrl],
  );
  return u;
}

/** A finished version 2 member who has already seen the tour. */
async function finishedMember(suffix: string): Promise<TestUser> {
  const u = await freshMember(suffix);
  const done = await apiAs(u, 'POST', '/onboarding/v2/confirm', {
    lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'],
    canOffer: ['offer_advice_mentoring'], selfKinds: ['self_founder_owner'],
    profile: { company: 'Crumb', timezone: ZONE },
  });
  expect(done.status).toBe(200);
  expect((await apiAs(u, 'POST', '/onboarding/tour', { outcome: 'skipped' })).status).toBe(200);
  return u;
}

/**
 * A finished LinkedIn lookup for `url`, exactly as one leaves it: the result, the state, and the address it ran for.
 * `profile` replaces words of the page (a role, a headline, where the role was read from).
 */
async function seedFoundLookup(u: TestUser, url: string, photoUrl = `${APP}/sheep/wave.png`, profile: Record<string, unknown> = {}) {
  await pool.query(
    `INSERT INTO user_intent_profiles (user_id, inferred_profile, enrichment_status, enrichment_started_at, enrichment_completed_at)
     VALUES ($1, jsonb_build_object('enriched', $2::jsonb, 'lastLookup', jsonb_build_object('linkedinUrl', $3::text, 'at', NOW())),
             'found', NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET inferred_profile = EXCLUDED.inferred_profile, enrichment_status = 'found',
       enrichment_started_at = NOW(), enrichment_completed_at = NOW()`,
    [u.id, JSON.stringify({
      confidence: 0.9, sources: ['e2e'], foundLinkedinUrl: url, requestedLinkedinUrl: url, enrichedAt: new Date().toISOString(),
      profile: {
        fullName: 'Ana Found', headline: 'Founder at Crumb Bakery', currentRole: 'Founder & CEO', currentCompany: 'Crumb Bakery',
        industry: 'Food and drink', location: 'Vienna, Austria', summary: null, pastRoles: [], education: [], skills: [],
        likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [], questionsToVerify: [], linkedinUrl: url, photoUrl,
        ...profile,
      },
    }), url],
  );
}

/** A lookup's state for `url` as the server records it: running, or ended with nothing found. */
function seedLookupState(u: TestUser, url: string, status: 'searching' | 'not_found') {
  return pool.query(
    `INSERT INTO user_intent_profiles (user_id, inferred_profile, enrichment_status, enrichment_started_at, enrichment_completed_at)
     VALUES ($1, jsonb_build_object('lastLookup', jsonb_build_object('linkedinUrl', $2::text, 'at', NOW())), $3::enrichment_status, NOW(),
             CASE WHEN $3::text = 'searching' THEN NULL ELSE NOW() END)
     ON CONFLICT (user_id) DO UPDATE SET inferred_profile = EXCLUDED.inferred_profile, enrichment_status = EXCLUDED.enrichment_status,
       enrichment_started_at = EXCLUDED.enrichment_started_at, enrichment_completed_at = EXCLUDED.enrichment_completed_at`,
    [u.id, url, status],
  );
}

/** The choice screen 2 remembered for this visit, as the app keeps it (useSignupChoice). */
const storedChoice = (page: Page, u: TestUser) => page.evaluate((key) => sessionStorage.getItem(key), `rsn_onb_v2_via_${u.id}`);

/** The four answers, saved as a draft that has reached screen 7. */
async function answeredUpToProfile(u: TestUser) {
  expect((await apiAs(u, 'PUT', '/onboarding/v2/answers', {
    lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'], canOffer: ['offer_investment'], selfKinds: ['self_investor'], step: 'profile',
  })).status).toBe(200);
}

async function openAs(
  u: TestUser, path = '/onboarding', viewport = PHONE, prepare?: (page: Page) => Promise<void>,
): Promise<Page> {
  const ctx = await browser.newContext({ viewport, timezoneId: ZONE });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  if (prepare) await prepare(page);
  await gotoRetry(page, `${APP}${path}`);
  // The web font swaps in when it arrives and every line of text reflows: a tap measured before that can land
  // on the option next to the one meant.
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return page;
}

const tile = (page: Page, label: string) => page.getByRole('checkbox', { name: label, exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const pathOf = (page: Page) => new URL(page.url()).pathname;

/** Scrolled into view as a person would, then pressed where a finger lands: anything clipped or covered fails. */
async function tapInView(page: Page, target: Locator, label: string) {
  await target.scrollIntoViewIfNeeded();
  await tapReachable(page, target, label);
}

async function tick(page: Page, ...labels: string[]) {
  for (const l of labels) await tapInView(page, tile(page, l), `option "${l}"`);
}

async function press(page: Page, name: string) {
  await tapInView(page, button(page, name), `"${name}"`);
}

/** Nothing on the question is greyed out and nothing says a limit was reached. */
async function nothingInTheWay(page: Page, where: string) {
  await expect(page.locator('[role="checkbox"][disabled]'), `${where}: a tile is greyed out`).toHaveCount(0);
  await expect(page.getByText(/You've chosen|Untick one|Select up to/), `${where}: a line about a limit`).toHaveCount(0);
}

/** LinkedIn picked nothing on this question: no line above the options, and no tile says "From LinkedIn". */
async function nothingFromLinkedin(page: Page, where: string) {
  await expect(page.getByText(PICKED_LINE), `${where}: the line about LinkedIn's picks`).toHaveCount(0);
  await expect(page.getByText(FROM_LINKEDIN, { exact: true }), `${where}: a tile marked From LinkedIn`).toHaveCount(0);
}

async function noSidewaysScroll(page: Page, where: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${where}: the page runs off the side by ${over}px`).toBeLessThanOrEqual(0);
}

/** Welcome, then screen 2. */
async function throughWelcome(page: Page) {
  await expect(heading(page, "Welcome to REASON. We're glad you're here.")).toBeVisible({ timeout: 30_000 });
  await press(page, "Let's go");
  await expect(heading(page, "Let's get you started")).toBeVisible();
}

/** Q1 to Q4 with one plain answer each, ending on screen 7. */
async function throughQuestions(page: Page, q4 = 'I am a founder or business owner.') {
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await tick(page, 'I would like to meet investors.');
  await press(page, 'Continue');
  await expect(heading(page, 'What are you hoping to find?')).toBeVisible();
  await tick(page, 'I am looking to raise funding.');
  await press(page, 'Continue');
  await expect(heading(page, 'What can you offer others?')).toBeVisible();
  await tick(page, 'I can give advice and mentoring.');
  await press(page, 'Continue');
  await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
  if (q4) await tick(page, q4);
  await press(page, 'Continue');
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
}

test.beforeAll(async () => {
  console.log(`[onboarding-v2] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  if (made.length) await cleanup(pool, { ids: made });
  await cleanupByPrefix(pool, 'e2etest-ob2');
  await pool.end().catch(() => {});
});

test('continue with email: the brief\'s words, own words for Q1, a specific wish for Q2, and For You with the tour at the end', async () => {
  test.setTimeout(240_000);
  const me = await freshMember('ob2email');
  const page = await openAs(me);
  const confirms: unknown[] = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/onboarding/v2/confirm')) confirms.push(r.postDataJSON()); });

  // Screen 1, word for word, with one button.
  await expect(heading(page, "Welcome to REASON. We're glad you're here.")).toBeVisible({ timeout: 30_000 });
  for (const line of [
    'Every good connection starts with a reason.',
    'On REASON, you connect with people you want to meet, who also want to meet you, for a specific reason.',
    'Answer quick questions and we will suggest the potential mutuals for you.',
  ]) await expect(page.getByText(line, { exact: true })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText(/\bRSN\b/);
  await press(page, "Let's go");

  // Screen 2.
  await expect(heading(page, "Let's get you started")).toBeVisible();
  await expect(page.getByText("We'll use your LinkedIn profile to fill in your details for you.", { exact: true })).toBeVisible();
  await expect(button(page, 'Continue with LinkedIn')).toBeVisible();
  await press(page, 'Continue with email');

  // Q1: "Something else" opens a box whose words are required.
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('1 of 4', { exact: true })).toBeVisible();
  await expect(page.getByText(ALL_THAT_APPLY, { exact: true })).toBeVisible();
  // The options are described by that line, so a screen reader says it with them.
  const describedBy = (await page.getByRole('group', { name: 'Who would you like to meet?' }).getAttribute('aria-describedby')) ?? '';
  await expect(page.locator(`[id="${describedBy.split(' ')[0]}"]`)).toHaveText(ALL_THAT_APPLY);
  // Nothing ticked: Continue reads as unavailable, and pressing it says why rather than doing nothing.
  await expect(button(page, 'Continue')).toHaveAttribute('aria-disabled', 'true');
  await press(page, 'Continue');
  await expect(page.getByText('Select at least one answer.', { exact: true })).toBeVisible();
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible();
  await tick(page, 'I would like to meet investors.', "Something else. I'd like to say it in my own words.");
  await expect(page.getByText('Select at least one answer.', { exact: true })).toHaveCount(0);
  const own = page.getByLabel('In your own words');
  await expect(own).toBeVisible();
  await expect(own).toHaveAttribute('maxlength', '120');
  await press(page, 'Continue');
  await expect(page.getByText('Tell us who you would like to meet.', { exact: true })).toBeVisible();
  await expect(own).toBeFocused();
  await own.fill('bakers who sell abroad');
  await press(page, 'Continue');

  // Q2, with its optional box and the brief's example as the placeholder.
  await expect(page.getByText('2 of 4', { exact: true })).toBeVisible();
  await tick(page, 'I am looking to raise funding.');
  const specific = page.getByLabel("Is there anything specific you're looking for? (optional)");
  await expect(specific).toHaveAttribute('placeholder', 'For example: "I\'m looking for someone who has helped small businesses expand internationally."');
  await specific.fill('A lead investor for a seed round');
  await press(page, 'Continue');

  await expect(page.getByText('3 of 4', { exact: true })).toBeVisible();
  await expect(page.getByText(ALL_THAT_APPLY, { exact: true })).toBeVisible();
  await tick(page, 'I can give advice and mentoring.', 'I can introduce people to others in my network.');
  await press(page, 'Continue');

  await expect(page.getByText('4 of 4', { exact: true })).toBeVisible();
  await expect(page.getByText(ALL_THAT_APPLY, { exact: true })).toBeVisible();
  // No LinkedIn, so nothing is picked for them.
  await nothingFromLinkedin(page, 'Q4 by email');
  await tick(page, 'I am a founder or business owner.');
  await press(page, 'Continue');

  // Screen 7.
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await expect(page.getByText("Change anything that isn't right.", { exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ana ob2email');
  await expect(page.getByTestId('time-zone')).toHaveText(ZONE);
  // Who they want to meet, what they hope to find and the time zone are private; the rest is not.
  await expect(page.getByTestId('answer-q1').getByText('Only you see this')).toBeVisible();
  await expect(page.getByTestId('answer-q2').getByText('Only you see this')).toBeVisible();
  await expect(page.getByTestId('answer-q3').getByText('Only you see this')).toHaveCount(0);
  await expect(page.getByTestId('answer-q4').getByText('Only you see this')).toHaveCount(0);
  await expect(page.getByTestId('answer-q1')).toContainText('Investors · “bakers who sell abroad”');
  await expect(page.getByTestId('answer-q2')).toContainText('“A lead investor for a seed round”');
  // An email sign-up is asked for LinkedIn, and can leave it for later.
  await expect(page.getByText('Add your LinkedIn profile so people can learn more about you. You can do this later.', { exact: true })).toBeVisible();
  await expect(button(page, 'Add LinkedIn')).toBeVisible();
  await press(page, 'Later');
  await expect(button(page, 'Add LinkedIn')).toHaveCount(0);
  // With no photo, there is one to upload, and nothing to keep.
  await expect(button(page, 'Keep this photo')).toHaveCount(0);
  await expect(button(page, 'Upload a photo')).toBeVisible();

  await page.getByLabel('Role', { exact: true }).fill('Head baker');
  await page.getByLabel('Company', { exact: true }).fill('Crumb');
  await page.getByLabel('Industry', { exact: true }).fill('Food and drink');
  await press(page, 'Show me my matches');

  // For You, with the tour over it.
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
  await expect(page.getByTestId('how-rsn-works')).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ landed on For You, with the tour open');

  const sent = confirms[0] as { profile?: Record<string, unknown> };
  expect(sent.profile).toEqual({
    displayName: 'Ana ob2email', jobTitle: 'Head baker', company: 'Crumb', industry: 'Food and drink', timezone: ZONE,
  });
  const row = (await pool.query(
    `SELECT onboarding_status, onboarding_version, looking_to_meet, meet_other, hoping_to_find, find_specific,
            can_offer, self_kinds, job_title, company, industry, timezone
       FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row).toMatchObject({
    onboarding_status: 'completed', onboarding_version: 2,
    looking_to_meet: ['meet_investors', 'meet_other'], meet_other: 'bakers who sell abroad',
    hoping_to_find: ['find_funding'], find_specific: 'A lead investor for a seed round',
    can_offer: ['offer_advice_mentoring', 'offer_introductions'], self_kinds: ['self_founder_owner'],
    job_title: 'Head baker', company: 'Crumb', industry: 'Food and drink', timezone: ZONE,
  });
  const stages = (await pool.query<{ stage: string }>(
    `SELECT stage::text AS stage FROM onboarding_stage_events WHERE user_id = $1`, [me.id],
  )).rows.map(r => r.stage);
  expect(stages).toContain('linkedin_skipped');
});

test('continue with LinkedIn: the link from the join form is in the box, the lookup runs while they answer, and when it finds nothing they type their details', async () => {
  test.setTimeout(240_000);
  const slug = `ob2-nobody-${Date.now()}`;
  const me = await freshMember('ob2li', `https://www.linkedin.com/in/${slug}`);
  // Not the local stack: the address was looked up already and nothing was found, so the server reuses that and
  // starts no paid lookup. Locally the lookup runs for real and costs nothing.
  if (!LOCAL_API) await seedLookupState(me, `https://www.linkedin.com/in/${slug}`, 'not_found');
  const page = await openAs(me);
  await throughWelcome(page);

  const sent: number[] = [];
  const answered: Array<Promise<unknown>> = [];
  page.on('response', r => {
    if (r.request().method() !== 'POST' || !/\/onboarding\/v2\/linkedin$/.test(new URL(r.url()).pathname)) return;
    sent.push(r.status());
    if (r.ok()) answered.push(r.json().catch(() => null));
  });
  await press(page, 'Continue with LinkedIn');
  const box = page.getByLabel('Your LinkedIn profile link');
  await expect(box).toHaveValue(`linkedin.com/in/${slug}`);
  const refused = page.getByText('Enter your LinkedIn profile link, for example linkedin.com/in/your-name', { exact: true });

  // Something that is plainly not a profile link is answered at once, without a request.
  await box.fill('facebook.com/ana');
  await press(page, 'Continue');
  await expect(refused).toBeVisible();
  expect(sent).toEqual([]);
  // One only the server can judge (a one-letter name) is refused there, in the same words.
  await box.fill('linkedin.com/in/x');
  await expect(refused).toHaveCount(0);
  await press(page, 'Continue');
  await expect(refused).toBeVisible({ timeout: 15_000 });
  expect(sent).toEqual([400]);

  await box.fill(`uk.linkedin.com/in/${slug}/?trk=x`);
  // While the link is on its way, "Continue with email" waits: the two choices are never both sent.
  await page.route('**/api/onboarding/v2/linkedin', async (route) => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
  await press(page, 'Continue');
  await expect(button(page, 'Continue with email')).toBeDisabled();
  // It moves on while the lookup runs.
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await page.unroute('**/api/onboarding/v2/linkedin');
  await throughQuestions(page);

  // Nothing found here (no ScrapingDog key locally): a calm line, and the member types it in.
  await expect(page.getByTestId('linkedin-note')).toContainText(/couldn't find your details|couldn't read your LinkedIn profile/, { timeout: 60_000 });
  await expect(page.getByText('Add your LinkedIn profile so people can learn more about you. You can do this later.')).toHaveCount(0);
  await page.getByLabel('Role', { exact: true }).fill('Pastry chef');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');

  const row = (await pool.query(`SELECT linkedin_url, job_title, onboarding_status FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(row).toEqual({ linkedin_url: `https://www.linkedin.com/in/${slug}`, job_title: 'Pastry chef', onboarding_status: 'completed' });
  const stages = (await pool.query<{ stage: string }>(
    `SELECT stage::text AS stage FROM onboarding_stage_events WHERE user_id = $1`, [me.id],
  )).rows.map(r => r.stage);
  expect(stages).toContain('linkedin_connected');
  expect(stages).not.toContain('linkedin_skipped');

  // What the server did with the one address it accepted: its answer, and what it recorded.
  expect(answered).toHaveLength(1);
  const answer = (await answered[0]) as { data?: { status?: string } } | null;
  const connected = (await pool.query<{ detail: { lookup?: string; status?: string } }>(
    `SELECT detail FROM onboarding_stage_events WHERE user_id = $1 AND stage::text = 'linkedin_connected' ORDER BY created_at DESC LIMIT 1`, [me.id],
  )).rows[0];
  if (!LOCAL_API) {
    // Money proof (fix round 1, T-1): the seeded outcome was reused and no lookup started. A lookup that had started
    // answers 'searching' and records the decision 'start'.
    expect(answer?.data?.status, 'the address was answered from the seeded outcome').toBe('not_found');
    expect(connected?.detail, 'the server recorded that it looked nothing up').toMatchObject({ lookup: 'done', status: 'not_found' });
  }
  console.log(`  ✓ LinkedIn ${LOCAL_API ? 'looked up for real (local)' : 'answered without a lookup'}: answered ${answer?.data?.status}, recorded lookup=${connected?.detail?.lookup}; enrich stages ${stages.filter(s => s.startsWith('enrich_')).join(', ') || '(none)'}; finished by hand`);
});

test('LinkedIn found: details filled in and marked, Q4 picked from the role and marked, and the photo used only when they keep it', async () => {
  test.setTimeout(240_000);
  const url = `https://www.linkedin.com/in/ob2-found-${Date.now()}`;
  const me = await freshMember('ob2found', url);
  await seedFoundLookup(me, url);
  const page = await openAs(me);
  const confirms: Array<{ profile?: Record<string, unknown> }> = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/onboarding/v2/confirm')) confirms.push(r.postDataJSON()); });

  await throughWelcome(page);
  await press(page, 'Continue with LinkedIn');
  await press(page, 'Continue');
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await tick(page, 'I would like to meet investors.');
  await press(page, 'Continue');
  await tick(page, 'I am looking to raise funding.');
  await press(page, 'Continue');
  await tick(page, 'I can give advice and mentoring.');
  await press(page, 'Continue');

  // Screen 6: their LinkedIn role points at one answer, ticked for them to confirm, and the tile says where it came from.
  await expect(page.getByText(PICKED_LINE, { exact: true })).toBeVisible();
  const founder = tile(page, 'I am a founder or business owner.');
  await expect(founder).toHaveAttribute('aria-checked', 'true');
  await expect(founder.getByText(FROM_LINKEDIN, { exact: true })).toBeVisible();
  // The note describes the tile; the tile is still named by its answer alone.
  await expect(founder).toHaveAccessibleDescription(FROM_LINKEDIN);
  await expect(page.getByText(FROM_LINKEDIN, { exact: true })).toHaveCount(1);
  await expect(page.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(1);
  await press(page, 'Continue');

  // Screen 7: filled in from LinkedIn and marked; the name they gave stays theirs.
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ana ob2found');
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Founder & CEO');
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Crumb Bakery');
  await expect(page.getByLabel('Industry', { exact: true })).toHaveValue('Food and drink');
  await expect(page.getByText('From your LinkedIn')).toHaveCount(3);
  await expect(page.getByTestId('linkedin-note')).toHaveCount(0);

  // A refresh keeps the choice, so LinkedIn stays on: the choice is stored for the visit (an unknown choice would
  // count as not chosen, and the fields would be empty, as on the email path).
  expect(await storedChoice(page, me)).toBe('linkedin');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(heading(page, "Here's how others will see you")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Founder & CEO');
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Crumb Bakery');
  await expect(page.getByText('From your LinkedIn')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready.then(() => true));

  // The photo on their LinkedIn is offered, not used, until they keep it.
  const keep = button(page, 'Keep this photo');
  await expect(page.getByAltText('The photo on your LinkedIn')).toBeVisible({ timeout: 15_000 });
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  await press(page, 'Keep this photo');
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await press(page, 'Keep this photo');
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  await press(page, 'Keep this photo');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');

  expect(confirms[0].profile).toMatchObject({ jobTitle: 'Founder & CEO', company: 'Crumb Bakery', industry: 'Food and drink', useLinkedinPhoto: true });
  const row = (await pool.query(`SELECT job_title, job_title_source, company, industry, self_kinds FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(row).toEqual({
    job_title: 'Founder & CEO', job_title_source: 'inferred', company: 'Crumb Bakery', industry: 'Food and drink', self_kinds: ['self_founder_owner'],
  });
});

test('LinkedIn can suggest several descriptions: each is ticked and marked, and what they change is what is saved', async () => {
  test.setTimeout(240_000);
  const url = `https://www.linkedin.com/in/ob2-several-${Date.now()}`;
  const me = await freshMember('ob2several', url);
  // Two things in the member's own words: Q4 lists the founder answer first and the investor answer fourth.
  await seedFoundLookup(me, url, undefined, { currentRole: 'Founder & CEO | Angel investor', headline: 'Building Crumb Bakery' });
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with LinkedIn');
  await press(page, 'Continue');
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await tick(page, 'I would like to meet investors.');
  await press(page, 'Continue');
  await tick(page, 'I am looking to raise funding.');
  await press(page, 'Continue');
  await tick(page, 'I can give advice and mentoring.');
  await press(page, 'Continue');

  // Both are ticked, the line is above the options, and each ticked tile carries the note: nothing else does.
  await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
  await expect(page.getByText(PICKED_LINE, { exact: true })).toBeVisible();
  const founder = tile(page, 'I am a founder or business owner.');
  const investor = tile(page, 'I am an investor.');
  await expect(founder).toHaveAttribute('aria-checked', 'true');
  await expect(investor).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(2);
  for (const picked of [founder, investor]) {
    await expect(picked.getByText(FROM_LINKEDIN, { exact: true })).toBeVisible();
    await expect(picked).toHaveAccessibleDescription(FROM_LINKEDIN);
  }
  await expect(page.getByText(FROM_LINKEDIN, { exact: true })).toHaveCount(2);
  await expect(tile(page, 'I work for a company or organisation.')).not.toHaveAccessibleDescription(FROM_LINKEDIN);
  await nothingInTheWay(page, 'Q4 with two picked');
  // The line sits above the first option.
  const line = (await page.getByText(PICKED_LINE, { exact: true }).boundingBox())!;
  const first = (await founder.boundingBox())!;
  expect(line.y + line.height, 'the line is above the options').toBeLessThanOrEqual(first.y);
  await page.screenshot({ path: `${SHOTS}/${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-q4-several-from-linkedin.png` });

  // Changing one makes the answer theirs: the line and the notes go, and what they ticked is what is kept.
  await tick(page, 'I am an investor.');
  await tick(page, 'I work for a company or organisation.');
  await nothingFromLinkedin(page, 'Q4 after a change');
  await expect(investor).toHaveAttribute('aria-checked', 'false');
  await press(page, 'Continue');
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await expect(page.getByTestId('answer-q4')).toContainText('Founder or business owner · Employee');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
  const row = (await pool.query<{ self_kinds: string[] }>(`SELECT self_kinds FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(row.self_kinds).toEqual(['self_founder_owner', 'self_employee']);
});

test('a role LinkedIn only inferred from the rest of the page picks no description, though it still fills in the role', async () => {
  test.setTimeout(240_000);
  const url = `https://www.linkedin.com/in/ob2-inferred-${Date.now()}`;
  const me = await freshMember('ob2inferred', url);
  await seedFoundLookup(me, url, undefined, { currentRole: 'Founder & CEO | Angel investor', roleSource: 'inferred', headline: null });
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with LinkedIn');
  await press(page, 'Continue');
  await tick(page, 'I would like to meet investors.');
  await press(page, 'Continue');
  await tick(page, 'I am looking to raise funding.');
  await press(page, 'Continue');
  await tick(page, 'I can give advice and mentoring.');
  await press(page, 'Continue');

  await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
  await nothingFromLinkedin(page, 'Q4 with an inferred role');
  await expect(page.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(0);
  await tick(page, 'I lead a team or part of an organisation.');
  await press(page, 'Continue');
  // The role itself is still offered on screen 7, marked, for them to check.
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Founder & CEO | Angel investor');
  await expect(page.getByText('From your LinkedIn').first()).toBeVisible();
});

test('another tab or device follows how they chose on screen 2, as the server recorded it: LinkedIn keeps its suggestions, email and no choice keep none', async () => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  /** Answers to Q1 to Q3 are saved, so a tab opened cold on Q4 may show it; nothing is chosen in the browser. */
  const toQ4 = async (u: TestUser) => {
    expect((await apiAs(u, 'PUT', '/onboarding/v2/answers', {
      lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'], canOffer: ['offer_investment'], step: 'q4',
    })).status).toBe(200);
  };
  const withLookup = async (suffix: string) => {
    const url = `https://www.linkedin.com/in/ob2-${suffix}-${stamp}`;
    const u = await freshMember(`ob2${suffix}`, url);
    await seedFoundLookup(u, url, undefined, { currentRole: 'Founder & CEO | Angel investor' });
    await toQ4(u);
    return { u, url };
  };

  // Pressed "Continue with LinkedIn" somewhere else: the server recorded it (the lookup is the seeded one, so none starts).
  const linkedin = await withLookup('tablinkedin');
  expect((await apiAs(linkedin.u, 'POST', '/onboarding/v2/linkedin', { url: linkedin.url })).status).toBe(200);
  const onLinkedin = await openAs(linkedin.u, '/onboarding?step=q4');
  expect(await storedChoice(onLinkedin, linkedin.u), 'this tab chose nothing').toBeNull();
  await expect(heading(onLinkedin, 'How would you describe yourself?')).toBeVisible({ timeout: 30_000 });
  await expect(onLinkedin.getByText(PICKED_LINE, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(tile(onLinkedin, 'I am a founder or business owner.')).toHaveAttribute('aria-checked', 'true');
  await expect(tile(onLinkedin, 'I am an investor.')).toHaveAttribute('aria-checked', 'true');
  await expect(onLinkedin.getByText(FROM_LINKEDIN, { exact: true })).toHaveCount(2);

  // Pressed "Continue with email" somewhere else: LinkedIn found them, but they said no.
  const email = await withLookup('tabemail');
  expect((await apiAs(email.u, 'POST', '/onboarding/v2/linkedin/skip', {})).status).toBe(200);
  const onEmail = await openAs(email.u, '/onboarding?step=q4');
  await expect(heading(onEmail, 'How would you describe yourself?')).toBeVisible({ timeout: 30_000 });
  await onEmail.waitForTimeout(2500);
  await nothingFromLinkedin(onEmail, 'Q4 after email, in another tab');
  await expect(onEmail.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(0);

  // Never chose: nothing is suggested, as before.
  const neither = await withLookup('tabneither');
  const onNeither = await openAs(neither.u, '/onboarding?step=q4');
  await expect(heading(onNeither, 'How would you describe yourself?')).toBeVisible({ timeout: 30_000 });
  await onNeither.waitForTimeout(2500);
  await nothingFromLinkedin(onNeither, 'Q4 with no choice at all');
  await expect(onNeither.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(0);
});

test('continue with email means no LinkedIn, even for a member LinkedIn already found: no guess, no prefill, no photo, until [Add LinkedIn]', async () => {
  test.setTimeout(240_000);
  // Most members look like this: the link from their join form, looked up when they were approved, "found".
  const slug = `ob2-emailfound-${Date.now()}`;
  const url = `https://www.linkedin.com/in/${slug}`;
  const me = await freshMember('ob2emailli', url);
  await seedFoundLookup(me, url);
  const page = await openAs(me);
  const confirms: Array<{ profile?: Record<string, unknown> }> = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/onboarding/v2/confirm')) confirms.push(r.postDataJSON()); });

  await throughWelcome(page);
  await press(page, 'Continue with email');
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await tick(page, 'I would like to meet investors.');
  await press(page, 'Continue');
  await tick(page, 'I am looking to raise funding.');
  await press(page, 'Continue');
  await tick(page, 'I can give advice and mentoring.');
  await press(page, 'Continue');

  // Q4: nothing picked for them, and nothing said about LinkedIn.
  await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
  await nothingFromLinkedin(page, 'Q4 by email, for a member LinkedIn found');
  await expect(page.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(0);
  await tick(page, 'I am an investor.');
  await press(page, 'Continue');

  // Screen 7: the fields are theirs to fill, and LinkedIn offers nothing.
  const noLinkedin = async (where: string) => {
    await expect(heading(page, "Here's how others will see you")).toBeVisible({ timeout: 20_000 });
    for (const field of ['Role', 'Company', 'Industry']) await expect(page.getByLabel(field, { exact: true }), `${where}: ${field}`).toHaveValue('');
    await expect(page.getByText('From your LinkedIn')).toHaveCount(0);
    await expect(page.getByAltText('The photo on your LinkedIn')).toHaveCount(0);
    await expect(page.getByTestId('linkedin-note')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/We found this photo on your LinkedIn|We picked these from your LinkedIn/);
    // The email sign-up's own line, as the brief has it.
    await expect(page.getByText('Add your LinkedIn profile so people can learn more about you. You can do this later.', { exact: true })).toBeVisible();
  };
  await noLinkedin('after the questions');
  // A refresh keeps the choice: it is remembered for the visit. Here that looks the same as no choice at all, so the
  // stored choice is read too (the LinkedIn path's refresh, above, shows it kept on screen).
  expect(await storedChoice(page, me)).toBe('email');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await noLinkedin('after a refresh');
  expect(await storedChoice(page, me)).toBe('email');
  // As after the first load (openAs): a tap measured before the web font swaps in can land on the button beside it.
  await page.evaluate(() => document.fonts.ready.then(() => true));

  // [Add LinkedIn] turns it on, with their join-form link already in the box.
  await press(page, 'Add LinkedIn');
  await expect(page.getByLabel('Your LinkedIn profile link')).toHaveValue(`linkedin.com/in/${slug}`);
  await press(page, 'Add');
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Founder & CEO', { timeout: 20_000 });
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Crumb Bakery');
  await expect(page.getByText('From your LinkedIn')).toHaveCount(3);
  await expect(page.getByAltText('The photo on your LinkedIn')).toBeVisible({ timeout: 15_000 });
  await expect(button(page, 'Add LinkedIn')).toHaveCount(0);

  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
  // The photo was offered but not kept, so it is not asked for.
  expect(confirms[0].profile).toMatchObject({ jobTitle: 'Founder & CEO', company: 'Crumb Bakery' });
  expect(confirms[0].profile).not.toHaveProperty('useLinkedinPhoto');
});

// 25 Oct review (ONB-01): "step 1 should allow multiple choice", and Claus stopped at three and at two. The test that
// expected a gentle refusal at the fourth now expects none: five on every question, one unticked, and on.
test('no limits: five answers on every question, one unticked, and Continue goes on with nothing refused or greyed out', async () => {
  test.setTimeout(240_000);
  const me = await freshMember('ob2nolimit');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  const ticked = page.locator('[role="checkbox"][aria-checked="true"]');
  const confirms: Array<Record<string, unknown>> = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/onboarding/v2/confirm')) confirms.push(r.postDataJSON()); });

  // Q1: five of the eight answers, none of them "Something else", then one unticked.
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(ALL_THAT_APPLY, { exact: true })).toBeVisible();
  await tick(
    page, 'I would like to meet investors.', 'I would like to meet founders and business owners.',
    'I would like to meet freelancers and consultants.', 'I would like to meet students and people early in their career.',
    'I would like to meet managers and leaders in companies and organisations.',
  );
  await expect(ticked).toHaveCount(5);
  await nothingInTheWay(page, 'Q1 with five');
  await tick(page, 'I would like to meet investors.');
  await expect(ticked).toHaveCount(4);
  await expect(tile(page, 'I would like to meet investors.')).toHaveAttribute('aria-checked', 'false');
  await nothingInTheWay(page, 'Q1 with four');
  await press(page, 'Continue');

  await expect(heading(page, 'What are you hoping to find?')).toBeVisible();
  await tick(
    page, 'I am looking for customers or clients.', 'I am looking to raise funding.', 'I am looking for a cofounder',
    'I am looking for a new job or my next career step.', 'I am looking for advice, mentoring or to learn from others.',
  );
  await expect(ticked).toHaveCount(5);
  await nothingInTheWay(page, 'Q2 with five');
  await tick(page, 'I am looking for a cofounder');
  await expect(ticked).toHaveCount(4);
  await press(page, 'Continue');

  // "Select all that apply": every answer but "Something else", no limit line.
  await expect(heading(page, 'What can you offer others?')).toBeVisible();
  await tick(
    page, 'I can offer my products or services.', 'I can invest in promising ideas.', 'I am open to joining or building a team.',
    'I can give advice and mentoring.', 'I can introduce people to others in my network.',
    'I am happy to make new friends and have good conversations.', 'I can share what I know from my work.',
    'I can help people find jobs or refer them where I work.',
  );
  await expect(ticked).toHaveCount(8);
  await nothingInTheWay(page, 'Q3 with all eight');
  await tick(page, 'I can invest in promising ideas.');
  await expect(ticked).toHaveCount(7);
  await press(page, 'Continue');

  await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
  await tick(
    page, 'I am a founder or business owner.', 'I work for a company or organisation.', 'I lead a team or part of an organisation.',
    'I am an investor.', 'I am an advisor or mentor.',
  );
  await expect(ticked).toHaveCount(5);
  await nothingInTheWay(page, 'Q4 with five');
  await tick(page, 'I am an investor.');
  await expect(ticked).toHaveCount(4);
  // The "Something else" box holds 120 characters and counts them.
  await tick(page, "Something else. I'd like to say it in my own words.");
  await page.getByLabel('In your own words').fill('x'.repeat(130));
  await expect(page.getByLabel('In your own words')).toHaveValue('x'.repeat(120));
  await expect(page.getByText('120/120', { exact: true })).toBeVisible();
  await nothingInTheWay(page, 'Q4 with five and the words box');
  await tick(page, "Something else. I'd like to say it in my own words.");
  await press(page, 'Continue');

  // Screen 7 reads back every answer that was left ticked, in the order they were ticked.
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await expect(page.getByTestId('answer-q1')).toContainText('Founders and business owners · Freelancers and consultants · Students and early career · Managers and leaders');
  await expect(page.getByTestId('answer-q2')).toContainText('Customers or clients · Raising funding · A new job or career step · Advice, mentoring or learning');
  await expect(page.getByTestId('answer-q3')).toContainText(
    'Products or services · Joining or building a team · Advice and mentoring · Introductions · New friends and good conversations · Knowledge from my work · Job referrals',
  );
  await expect(page.getByTestId('answer-q4')).toContainText('Founder or business owner · Employee · Manager or leader · Advisor or mentor');
  await noSidewaysScroll(page, 'screen 7 with every answer');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');

  // Nothing was refused on the way: the server kept every answer, the old caps (3, 3, 2) gone.
  expect(confirms).toHaveLength(1);
  const row = (await pool.query(
    `SELECT looking_to_meet, hoping_to_find, can_offer, self_kinds, self_other, onboarding_status FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row).toEqual({
    looking_to_meet: ['meet_founders_owners', 'meet_freelancers_consultants', 'meet_students_early_career', 'meet_managers_leaders'],
    hoping_to_find: ['find_customers', 'find_funding', 'find_new_role', 'find_advice_learning'],
    can_offer: [
      'offer_products_services', 'offer_join_build_team', 'offer_advice_mentoring', 'offer_introductions',
      'offer_friends_conversations', 'offer_knowledge', 'offer_referrals',
    ],
    self_kinds: ['self_founder_owner', 'self_employee', 'self_manager_leader', 'self_advisor_experienced'],
    self_other: null,
    onboarding_status: 'completed',
  });
});

// 25 Oct review (ONB-02): four employees could not find themselves on any question, and went to "Something else".
test('an employee answers every question without "Something else", and the searches they asked for are made', async () => {
  test.setTimeout(240_000);
  const me = await freshMember('ob2employee');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  const somethingElse = () => tile(page, "Something else. I'd like to say it in my own words.");

  // A product manager at a large company: who they would meet, what they hope for, what they can give, who they are.
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  await tick(page, 'I would like to meet managers and leaders in companies and organisations.', 'I would like to meet people who are hiring.');
  await expect(somethingElse()).toHaveAttribute('aria-checked', 'false');
  await press(page, 'Continue');
  await expect(heading(page, 'What are you hoping to find?')).toBeVisible();
  await tick(page, 'I am looking for a new job or my next career step.', 'I am looking for advice, mentoring or to learn from others.');
  await expect(somethingElse()).toHaveAttribute('aria-checked', 'false');
  await press(page, 'Continue');
  await expect(heading(page, 'What can you offer others?')).toBeVisible();
  await tick(page, 'I can share what I know from my work.', 'I can help people find jobs or refer them where I work.');
  await expect(somethingElse()).toHaveAttribute('aria-checked', 'false');
  await press(page, 'Continue');
  await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
  // For someone who works for a company, the answer for them comes second, straight after the founder's.
  const options = await page.locator('[role="checkbox"]').evaluateAll(list => list.map(el => (el.textContent ?? '').trim()));
  expect(options.slice(0, 3)).toEqual(['I am a founder or business owner.', 'I work for a company or organisation.', 'I lead a team or part of an organisation.']);
  await tick(page, 'I work for a company or organisation.');
  await expect(somethingElse()).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('In your own words')).toHaveCount(0);
  await press(page, 'Continue');

  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await expect(page.getByTestId('answer-q1')).toContainText('Managers and leaders · People who are hiring');
  await expect(page.getByTestId('answer-q2')).toContainText('A new job or career step · Advice, mentoring or learning');
  await expect(page.getByTestId('answer-q3')).toContainText('Knowledge from my work · Job referrals');
  await expect(page.getByTestId('answer-q4')).toContainText('Employee');
  for (const q of ['q1', 'q2', 'q3', 'q4']) await expect(page.getByTestId(`answer-${q}`)).not.toContainText('Something else');
  await page.getByLabel('Role', { exact: true }).fill('Product manager');
  await page.getByLabel('Company', { exact: true }).fill('Crumb Logistics');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');

  const row = (await pool.query(
    `SELECT looking_to_meet, meet_other, hoping_to_find, find_other, can_offer, offer_other, self_kinds, self_other, onboarding_status
       FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row).toEqual({
    looking_to_meet: ['meet_managers_leaders', 'meet_hiring'], meet_other: null,
    hoping_to_find: ['find_new_role', 'find_advice_learning'], find_other: null,
    can_offer: ['offer_knowledge', 'offer_referrals'], offer_other: null,
    self_kinds: ['self_employee'], self_other: null,
    onboarding_status: 'completed',
  });
  // The people they asked to meet are searched for, one search each.
  const searches = (await pool.query<{ label: string; status: string }>(
    `SELECT label, status FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [me.id],
  )).rows;
  expect(searches.filter(a => a.status === 'active').map(a => a.label).sort()).toEqual(['Managers & leaders', 'People who are hiring']);
});

test('edit mode: a finished member changes one answer, saves, and is back where they came from', async () => {
  test.setTimeout(240_000);
  const me = await finishedMember('ob2edit');
  const page = await openAs(me, '/');
  await expect(page.getByTestId('how-rsn-works')).toHaveCount(0);

  // As For You's "Edit who I want to meet" does: an in-app link to /onboarding?edit=q1.
  const follow = (to: string) => page.evaluate((href) => {
    window.history.pushState({ usr: null, key: `e2e${Date.now()}`, idx: (window.history.state?.idx ?? 0) + 1 }, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, to);

  await follow('/onboarding?edit=q1');
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
  // One question, theirs ticked, no progress bar, and Cancel beside Save.
  await expect(page.getByText('1 of 4', { exact: true })).toHaveCount(0);
  await expect(tile(page, 'I would like to meet investors.')).toHaveAttribute('aria-checked', 'true');
  await expect(button(page, 'Cancel')).toBeVisible();
  await tick(page, 'I would like to meet investors.', 'I would like to meet founders and business owners.');
  await press(page, 'Save');
  await expect(page.getByText('Your changes are saved.')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => pathOf(page), { timeout: 20_000 }).toBe('/');
  let row = (await pool.query(`SELECT looking_to_meet, onboarding_status FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(row).toEqual({ looking_to_meet: ['meet_founders_owners'], onboarding_status: 'completed' });
  const agents = (await pool.query<{ label: string; status: string }>(
    `SELECT label, status FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [me.id],
  )).rows;
  expect(agents.find(a => /founder/i.test(a.label))?.status).toBe('active');
  console.log(`  ✓ saved and back on For You; searches: ${agents.map(a => `${a.label} (${a.status})`).join(', ')}`);

  // Cancel leaves everything as it was.
  await follow('/onboarding?edit=q2');
  await expect(heading(page, 'What are you hoping to find?')).toBeVisible({ timeout: 20_000 });
  await tick(page, 'I am looking for a cofounder');
  await press(page, 'Cancel');
  await expect.poll(() => pathOf(page)).toBe('/');
  row = (await pool.query(`SELECT hoping_to_find FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(row.hoping_to_find).toEqual(['find_funding']);

  // The profile: an answer's [Edit] opens the question and comes back, then Save.
  await follow('/onboarding?edit=profile');
  await expect(heading(page, "Here's how others will see you")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Crumb');
  await page.getByLabel('Company', { exact: true }).fill('Crumb and Co');
  await tapInView(page, page.getByRole('button', { name: 'Edit: What can you offer others?' }), 'Edit Q3');
  await expect(heading(page, 'What can you offer others?')).toBeVisible();
  await tick(page, 'I can introduce people to others in my network.');
  await press(page, 'Continue');
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  // What they typed before the detour is still there.
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Crumb and Co');
  await press(page, 'Save');
  await expect.poll(() => pathOf(page), { timeout: 20_000 }).toBe('/');
  row = (await pool.query(`SELECT company, can_offer FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(row).toEqual({ company: 'Crumb and Co', can_offer: ['offer_advice_mentoring', 'offer_introductions'] });

  // Opened straight onto edit mode, with nothing of the app before it: Save lands somewhere sensible.
  const direct = await openAs(me, '/onboarding?edit=q4');
  await expect(heading(direct, 'How would you describe yourself?')).toBeVisible({ timeout: 30_000 });
  await press(direct, 'Save');
  await expect.poll(() => pathOf(direct), { timeout: 20_000 }).toBe('/');
});

test('"Show me my matches" never sends what cannot be saved: it opens what is missing and says why, then [Edit] comes back to that answer', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('ob2missing');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  await throughQuestions(page);

  // From screen 7, Q1 gets "Something else" with no words, and they go Back without them.
  await tapInView(page, page.getByRole('button', { name: 'Edit: Who would you like to meet?' }), 'Edit Q1');
  await tick(page, "Something else. I'd like to say it in my own words.");
  await press(page, 'Back');
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await expect(page.getByTestId('answer-q1')).toContainText('This one still needs an answer.');
  // Back from an [Edit] lands on that answer, not on the top of the page.
  const row = (await page.getByTestId('answer-q1').boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(0);
  expect(row.y + row.height).toBeLessThanOrEqual(PHONE.height);

  const confirms: unknown[] = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/onboarding/v2/confirm')) confirms.push(r.postDataJSON()); });
  await press(page, 'Show me my matches');
  await expect(heading(page, 'Who would you like to meet?')).toBeVisible();
  await expect(page.getByText('Tell us who you would like to meet.', { exact: true })).toBeVisible();
  expect(confirms).toEqual([]);
  await page.getByLabel('In your own words').fill('boat builders');
  await press(page, 'Continue');
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
  expect((await pool.query(`SELECT meet_other FROM users WHERE id = $1`, [me.id])).rows[0].meet_other).toBe('boat builders');
});

test('the time zone: detected, searchable by the name people use, and saved', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('ob2zone');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  await throughQuestions(page);

  await expect(page.getByTestId('time-zone')).toHaveText(ZONE);
  await tapInView(page, page.getByRole('button', { name: 'Change time zone' }), 'Change time zone');
  const dialog = page.getByRole('dialog', { name: 'Choose your time zone' });
  await expect(dialog).toBeVisible();
  // The list opens on their own zone, marked.
  await expect(dialog.locator('[aria-current="true"]')).toHaveText(ZONE);
  await expect(dialog.locator('[aria-current="true"]')).toBeInViewport();
  await dialog.getByLabel('Search time zones').fill('kolkata');
  await expect(dialog.getByRole('button', { name: 'Asia/Kolkata' })).toBeVisible();
  await tapInView(page, dialog.getByRole('button', { name: 'Asia/Kolkata' }), 'Asia/Kolkata');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('time-zone')).toHaveText('Asia/Kolkata');

  // Escape closes the list and changes nothing.
  await tapInView(page, page.getByRole('button', { name: 'Change time zone' }), 'Change time zone again');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('time-zone')).toHaveText('Asia/Kolkata');

  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
  expect((await pool.query(`SELECT timezone FROM users WHERE id = $1`, [me.id])).rows[0].timezone).toBe('Asia/Kolkata');
});

test('Upload a new one: a photo from the phone is made small, becomes their photo, and is theirs to keep', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('ob2photo');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  await throughQuestions(page);

  // A real picture, larger than the 800px the upload keeps.
  const picture = await page.screenshot({ type: 'png', fullPage: false, scale: 'device' });
  await page.locator('input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: picture });
  await expect(page.getByText('Photo updated.')).toBeVisible({ timeout: 30_000 });
  await expect(button(page, 'Keep this photo')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, 'Upload a new one')).toBeVisible();
  const avatar = (await pool.query<{ avatar_url: string }>(`SELECT avatar_url FROM users WHERE id = $1`, [me.id])).rows[0].avatar_url;
  expect(avatar.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(avatar.length).toBeLessThan(2_000_000);

  // Something that is not a photo is refused before anything is sent.
  await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText('Choose a JPG, PNG or WebP photo.')).toBeVisible();
});

test('how a LinkedIn lookup ended reaches the screen through the member\'s own update, or on reconnecting, and never by a timer', async () => {
  test.setTimeout(180_000);
  const url = `https://www.linkedin.com/in/ob2-wait-${Date.now()}`;
  const me = await freshMember('ob2wait', url);
  await answeredUpToProfile(me);
  /** The lookup's state as the server records it, for the address on the profile. */
  const lookup = (status: 'searching' | 'not_found') => seedLookupState(me, url, status);
  /** What the end of a lookup sends: the member's own user tag (any write of theirs sends the same). */
  const theirUpdate = async () => expect((await apiAs(me, 'PUT', '/onboarding/v2/answers', {})).status).toBe(200);

  await lookup('searching');
  const sockets: WebSocketRoute[] = [];
  let connects = 0;
  const page = await openAs(me, '/onboarding?step=profile', PHONE, async (p) => {
    // This tab chose LinkedIn on screen 2 (remembered for the visit).
    await p.addInitScript((key: string) => sessionStorage.setItem(key, 'linkedin'), `rsn_onb_v2_via_${me.id}`);
    // The app's socket, passed through message by message, so the test sees it connect and can drop it like a
    // phone losing signal. "40" is Socket.IO's "connected".
    await p.routeWebSocket(/\/socket\.io\//, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => { if (String(m).startsWith('40')) connects += 1; ws.send(m); });
      ws.onMessage((m) => server.send(m));
      sockets.push(ws);
    });
  });
  const note = page.getByTestId('linkedin-note');
  await expect(note).toContainText("We're still reading your LinkedIn profile.", { timeout: 30_000 });
  // Connecting reads the state once (anything sent before the socket was there is otherwise lost): let it land.
  await expect.poll(() => connects, { message: 'the app connected its socket' }).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');

  // It ends, and nothing is sent: the screen does not go and look for itself.
  await lookup('not_found');
  await page.waitForTimeout(8000);
  await expect(note).toContainText("We're still reading your LinkedIn profile.");
  // Their update arrives: the screen reads the state and says how it ended.
  await theirUpdate();
  await expect(note).toContainText("We couldn't find your details on LinkedIn.", { timeout: 15_000 });
  await expect(button(page, 'Check your LinkedIn link')).toBeVisible();

  // Another lookup runs, and ends while the connection is down, so its update is lost.
  await lookup('searching');
  await theirUpdate();
  await expect(note).toContainText("We're still reading your LinkedIn profile.", { timeout: 15_000 });
  const connectedBefore = connects;
  await lookup('not_found');
  await sockets[sockets.length - 1].close();
  // The socket comes back on its own, and the screen reads the state again on reconnecting.
  await expect.poll(() => connects, { message: 'the socket reconnected', timeout: 20_000 }).toBeGreaterThan(connectedBefore);
  await expect(note).toContainText("We couldn't find your details on LinkedIn.", { timeout: 15_000 });
});

test('after the first confirm, the page a member followed a link to is honoured; anything else is For You', async () => {
  test.setTimeout(240_000);
  // As the gate sends a member who followed a link before finishing: /onboarding?redirect=<that page>.
  const followed = await freshMember('ob2redir');
  await answeredUpToProfile(followed);
  const page = await openAs(followed, '/onboarding?step=profile&redirect=%2Fsupport');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/support');

  // Final review, 21 Oct 2026 (C1): the tour opens over the page they followed, and finishing it no longer takes them
  // to For You, so on a phone they see the page they came for. A refresh in the middle keeps that.
  const tour = page.getByTestId('how-rsn-works');
  await expect(tour).toBeVisible({ timeout: 30_000 });
  await press(page, 'Next');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(tour).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await tapInView(page, page.getByRole('button', { name: /^Go to card 4/ }), 'the fourth dot');
  // It leaves them here, so its last button says Done, not "See my matches" (fix round 1, M-1).
  await expect(button(page, 'See my matches')).toHaveCount(0);
  await press(page, 'Done');
  await expect(tour).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(pathOf(page), 'finishing the tour leaves them on the page they followed').toBe('/support');
  expect((await pool.query(`SELECT tour_outcome FROM users WHERE id = $1`, [followed.id])).rows[0].tour_outcome).toBe('completed');

  // Skipped instead, on another page they followed: the same.
  const skipper = await freshMember('ob2redirskip');
  await answeredUpToProfile(skipper);
  const third = await openAs(skipper, '/onboarding?step=profile&redirect=%2Fsessions');
  await press(third, 'Show me my matches');
  await expect.poll(() => pathOf(third), { timeout: 30_000 }).toBe('/sessions');
  await expect(third.getByTestId('how-rsn-works')).toBeVisible({ timeout: 30_000 });
  await press(third, 'Skip');
  await expect(third.getByTestId('how-rsn-works')).toHaveCount(0, { timeout: 20_000 });
  await third.waitForTimeout(1500);
  expect(pathOf(third), 'skipping the tour leaves them on the page they followed').toBe('/sessions');

  const sent = await freshMember('ob2redirbad');
  await answeredUpToProfile(sent);
  const other = await openAs(sent, '/onboarding?step=profile&redirect=%2F%2Fevil.example%2Fx');
  await press(other, 'Show me my matches');
  await expect.poll(() => pathOf(other), { timeout: 30_000 }).toBe('/');
  expect(other.url().startsWith(APP)).toBe(true);

  // Onboarding itself, in any case (C11): the router opens /ONBOARDING as onboarding, so it is For You instead.
  const cased = await freshMember('ob2redircase');
  await answeredUpToProfile(cased);
  const fourth = await openAs(cased, '/onboarding?step=profile&redirect=%2FONBOARDING%3Fstep%3Dq1');
  await press(fourth, 'Show me my matches');
  await expect.poll(() => pathOf(fourth), { timeout: 30_000 }).toBe('/');
  await expect(fourth.getByTestId('how-rsn-works')).toBeVisible({ timeout: 30_000 });
  // On For You itself, where most members land, the last button is the deck's "See my matches".
  await fourth.evaluate(() => document.fonts.ready.then(() => true));
  await tapInView(fourth, fourth.getByRole('button', { name: /^Go to card 4/ }), 'the fourth dot on For You');
  await expect(button(fourth, 'See my matches')).toBeVisible();
  await expect(button(fourth, 'Done')).toHaveCount(0);
});

/**
 * The control is whole on screen and nothing lies over it: no toast's box touches it, and five points across it (the
 * middle, and in from each side) are the control itself when the browser is asked what is there.
 */
async function expectWhole(page: Page, target: Locator, label: string) {
  const box = (await target.boundingBox())!;
  expect(box, `${label}: not drawn`).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${label}: not all inside the window`).toBe(true);
  const toasts = await page.getByRole('button', { name: 'Dismiss notification' }).evaluateAll((list) =>
    list.map((b) => { const r = (b.parentElement ?? b).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  for (const t of toasts) {
    const overlaps = t.x < box.x + box.width && box.x < t.x + t.width && t.y < box.y + box.height && box.y < t.y + t.height;
    expect(overlaps, `${label}: a toast lies over it`).toBe(false);
  }
  const points = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.25], [0.5, 0.75]].map(([fx, fy]) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }));
  const covered = await target.evaluate((el, pts) => pts.filter((p) => { const hit = document.elementFromPoint(p.x, p.y); return !hit || !el.contains(hit); }).length, points);
  expect(covered, `${label}: part of it is covered`).toBe(0);
}

// Fix round 1 (M-1, M-7): at a small and a large phone. An existing member's first Edit answers save makes the tour due,
// and its success toast sat over the tour's Skip for 2.5 seconds; and staying on the page, its last button said "See
// my matches".
for (const size of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
  test(`a finished member whose first edit makes the tour due (${size.width}x${size.height}): nothing covers the tour, it says Done, and it leaves them on the page they changed it from`, async () => {
    test.setTimeout(240_000);
    // Exactly how a member who finished before the tour existed looks: completed, version 2 answers, no tour stamp.
    const me = await createTestUser(`ob2firstedit${size.width}`);
    made.push(me.id);
    await pool.query(
      `UPDATE users SET onboarding_version = 2, looking_to_meet = ARRAY['meet_investors']::text[], hoping_to_find = ARRAY['find_funding']::text[],
         can_offer = ARRAY['offer_advice_mentoring']::text[], self_kinds = ARRAY['self_founder_owner']::text[], timezone = $2,
         tour_due_at = NULL, tour_seen_at = NULL, tour_outcome = NULL
       WHERE id = $1`,
      [me.id, ZONE],
    );
    const page = await openAs(me, '/profile', size);
    await expect(page.getByRole('heading', { name: 'Only you see this' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('how-rsn-works')).toHaveCount(0);

    // Your profile's Edit answers opens every answer on screen 7 (C2), and Save goes back.
    const edit = page.getByRole('link', { name: 'Edit answers' });
    await expect(edit).toHaveAttribute('href', '/onboarding?edit=profile');
    await tapInView(page, edit, 'Edit answers');
    await expect(heading(page, "Here's how others will see you")).toBeVisible({ timeout: 30_000 });
    for (const q of ['Who would you like to meet?', 'What are you hoping to find?', 'What can you offer others?', 'How would you describe yourself?']) {
      await expect(page.getByRole('button', { name: `Edit: ${q}` })).toBeVisible();
    }
    await press(page, 'Save');
    await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/profile');

    // The save made the tour due, and it opens here, at once with nothing over it: no saved toast (the tour, over the
    // page they changed, says so), and Skip and the main button are whole and can be pressed.
    const tour = page.getByTestId('how-rsn-works');
    await expect(tour).toBeVisible({ timeout: 30_000 });
    await expect(button(page, 'Next')).toBeFocused();
    for (let look = 0; look < 3; look += 1) {
      await expect(page.getByText('Your changes are saved.')).toHaveCount(0);
      await expectWhole(page, button(page, 'Skip'), `look ${look + 1}: Skip`);
      await expectWhole(page, button(page, 'Next'), `look ${look + 1}: Next`);
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: `${SHOTS}/${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${size.width}x${size.height}-tour-after-first-edit.png` });

    // It leaves them here, so its last button says Done, and Done leaves them on Your profile.
    await tapInView(page, page.getByRole('button', { name: /^Go to card 4/ }), 'the fourth dot');
    await expect(button(page, 'See my matches')).toHaveCount(0);
    await expectWhole(page, button(page, 'Done'), 'Done');
    await press(page, 'Done');
    await expect(tour).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(pathOf(page), 'the tour leaves them where edit mode brought them back').toBe('/profile');
    expect((await pool.query(`SELECT tour_outcome FROM users WHERE id = $1`, [me.id])).rows[0].tour_outcome).toBe('completed');
  });
}

test('screen 7: emptying a stored company sends "" so it is cleared, and a field never filled and left empty sends nothing', async () => {
  test.setTimeout(180_000);
  const me = await finishedMember('ob2clear');
  const page = await openAs(me, '/onboarding?edit=profile');
  await expect(heading(page, "Here's how others will see you")).toBeVisible({ timeout: 30_000 });
  const confirms: Array<{ profile?: Record<string, unknown> }> = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/onboarding/v2/confirm')) confirms.push(r.postDataJSON()); });
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Crumb');
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('');
  await page.getByLabel('Company', { exact: true }).fill('');
  await press(page, 'Save');
  await expect.poll(() => confirms.length, { timeout: 20_000 }).toBe(1);
  // The server's contract (the other half of this fix): missing or null keeps a value, "" clears it.
  expect(confirms[0].profile).toEqual({ displayName: 'Ana ob2clear', company: '', timezone: ZONE });
  // This member has seen the tour, so the save says so; and "saved" is true: the company is gone (fix round 1, T-2).
  await expect(page.getByText('Your changes are saved.')).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await pool.query<{ company: string | null; job_title: string | null; display_name: string }>(
    `SELECT company, job_title, display_name FROM users WHERE id = $1`, [me.id],
  )).rows[0], { message: 'the stored company is cleared, and nothing else is', timeout: 20_000 })
    .toEqual({ company: null, job_title: null, display_name: 'Ana ob2clear' });
});

test('a refusal from the server is said inline, on the thing it is about, in the server\'s words', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('ob2refuse');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  await throughQuestions(page);

  // The client sends nothing the server refuses, so these answers are the server's own words, played back.
  const refusals = [
    { details: { 'profile.timezone': ['Choose your time zone from the list, for example Asia/Kathmandu.'] } },
    { details: { 'canOffer.0': ['Choose one of the answers shown.'] } },
  ];
  await page.route('**/api/onboarding/v2/confirm', async (route) => {
    const next = refusals.shift();
    if (!next) return route.abort('internetdisconnected');
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', ...next } }) });
  });

  // About the time zone: under the time zone.
  await press(page, 'Show me my matches');
  await expect(page.getByText('Choose your time zone from the list, for example Asia/Kathmandu.', { exact: true })).toBeVisible();
  await expect(page.getByText('Validation failed')).toHaveCount(0);
  // About an answer: that question opens with the sentence under its options, and Continue goes back to screen 7.
  await press(page, 'Show me my matches');
  await expect(heading(page, 'What can you offer others?')).toBeVisible();
  await expect(page.getByText('Choose one of the answers shown.', { exact: true })).toBeVisible();
  await press(page, 'Continue');
  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  // No answer at all: a lost connection, said on the screen, never the library's words.
  await press(page, 'Show me my matches');
  await expect(page.getByText('Connection lost. Check your internet and try again.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Network Error|AxiosError|ERR_/)).toHaveCount(0);

  // With the server back, it goes through.
  await page.unroute('**/api/onboarding/v2/confirm');
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
});

test('someone who has not finished cannot use edit mode: it is the flow, from where they are', async () => {
  test.setTimeout(120_000);
  const me = await freshMember('ob2noedit');
  const page = await openAs(me, '/onboarding?edit=q3');
  await expect(heading(page, "Welcome to REASON. We're glad you're here.")).toBeVisible({ timeout: 30_000 });
});

test('a refresh in the middle loses nothing, and Back walks back through the answers', async () => {
  test.setTimeout(180_000);
  const me = await freshMember('ob2resume');
  const page = await openAs(me);
  await throughWelcome(page);
  await press(page, 'Continue with email');
  await tick(page, 'I would like to meet advisors, mentors and experienced professionals.');
  await press(page, 'Continue');
  await tick(page, 'I am looking for a cofounder');
  await press(page, 'Continue');
  await expect(heading(page, 'What can you offer others?')).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(heading(page, 'What can you offer others?')).toBeVisible({ timeout: 30_000 });
  await press(page, 'Back');
  await expect(tile(page, 'I am looking for a cofounder')).toHaveAttribute('aria-checked', 'true');
  await press(page, 'Back');
  await expect(tile(page, 'I would like to meet advisors, mentors and experienced professionals.')).toHaveAttribute('aria-checked', 'true');

  // Coming back later, with no step in the address, resumes at the furthest step the draft reached.
  const later = await openAs(me, '/onboarding');
  await expect(heading(later, 'What can you offer others?')).toBeVisible({ timeout: 30_000 });
});

test('the whole flow works on a 360px phone: every button reachable and at least 44px, nothing off the side', async () => {
  test.setTimeout(240_000);
  const me = await freshMember('ob2small');
  const page = await openAs(me, '/onboarding', { width: 360, height: 640 });

  await expect(heading(page, "Welcome to REASON. We're glad you're here.")).toBeVisible({ timeout: 30_000 });
  await noSidewaysScroll(page, 'welcome');
  await press(page, "Let's go");
  await noSidewaysScroll(page, 'sign up');
  for (const name of ['Continue with LinkedIn', 'Continue with email']) {
    const box = await expectReachable(page, button(page, name), name);
    expect(box.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
  }
  await press(page, 'Continue with email');

  // The last answer of each list, before "Something else": the longest scroll to reach it.
  const steps: [string, string][] = [
    ['Q1', 'I would like to meet people who are hiring.'],
    ['Q2', 'I am looking for partners or collaborators.'],
    ['Q3', 'I can help people find jobs or refer them where I work.'],
    ['Q4', 'I am a student or early in my career.'],
  ];
  for (const [where, label] of steps) {
    await expect(tile(page, label)).toBeVisible({ timeout: 20_000 });
    const t = tile(page, label);
    await t.scrollIntoViewIfNeeded();
    const box = await t.boundingBox();
    expect(box!.height, `${where}: the option is only ${Math.round(box!.height)}px tall`).toBeGreaterThanOrEqual(44);
    await tapReachable(page, t, `${where}: option`);
    await noSidewaysScroll(page, where);
    for (const name of ['Back', 'Continue']) {
      const b = await expectReachable(page, button(page, name), `${where}: ${name}`);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await press(page, 'Continue');
  }

  await expect(heading(page, "Here's how others will see you")).toBeVisible();
  await noSidewaysScroll(page, 'profile');
  const finish = await expectReachable(page, button(page, 'Show me my matches'), '"Show me my matches" at 360px');
  expect(finish.height).toBeGreaterThanOrEqual(44);
  for (const name of ['Edit: Who would you like to meet?', 'Change time zone']) {
    const control = page.getByRole('button', { name });
    await control.scrollIntoViewIfNeeded();
    const b = await expectReachable(page, control, name);
    expect(b.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
  }
  await press(page, 'Show me my matches');
  await expect.poll(() => pathOf(page), { timeout: 30_000 }).toBe('/');
});

// With the phone keyboard up the window is short. The lists are longer now (nine answers), so "Something else" is
// further down: the words box and Continue must both still be on screen, at 360 as well as 390.
for (const width of [360, 390]) {
  test(`with the phone keyboard up (a ${width}px window 420px tall), the words box and Continue are both on screen, on the first question and the last`, async () => {
    test.setTimeout(180_000);
    const me = await freshMember(`ob2kbd${width}`);
    const page = await openAs(me, '/onboarding', { width, height: 420 });
    await throughWelcome(page);
    await press(page, 'Continue with email');
    await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });

    /** "Something else" ticked, the box focused and filled, and the box and Continue both whole inside the window. */
    const typeInWords = async (words: string) => {
      const other = tile(page, "Something else. I'd like to say it in my own words.");
      await other.scrollIntoViewIfNeeded();
      await tapReachable(page, other, '"Something else"');
      const own = page.getByLabel('In your own words');
      await own.focus();
      await own.fill(words);
      await own.scrollIntoViewIfNeeded();
      await expectReachable(page, own, 'the words box');
      await expectReachable(page, button(page, 'Continue'), 'Continue');
      await noSidewaysScroll(page, 'a short window');
    };

    await typeInWords('people who restore old boats');
    await press(page, 'Continue');
    await expect(heading(page, 'What are you hoping to find?')).toBeVisible();
    await tick(page, 'I am looking to raise funding.');
    await press(page, 'Continue');
    await expect(heading(page, 'What can you offer others?')).toBeVisible();
    await tick(page, 'I can give advice and mentoring.');
    await press(page, 'Continue');
    await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
    await typeInWords('a lighthouse keeper');
    await press(page, 'Continue');
    await expect(heading(page, "Here's how others will see you")).toBeVisible();
  });
}
