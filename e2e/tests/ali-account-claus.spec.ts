import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import crypto from 'node:crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// ALI'S OWN ACCOUNT THROUGH CLAUS'S CHAT, HEADED, ON PRODUCTION (15 Sep 2026,
// Ali: "test the onboarding chat for alihammza143 too, is it good according
// to what Claus wanted"). The account must be FREE before this runs
// (e2e/reset-test-account.mjs alihammza143@gmail.com --apply) and is reset
// again afterwards by the same script; this spec never deletes it.
//
// Join form → approval (API) → one-click link → the card from his live
// LinkedIn page → the chat, answered the way a real member would, with every
// host turn checked against Claus's rules → confirm → agents → the record.
// The whole transcript is printed for the written assessment.

const EMAIL = 'alihammza143@gmail.com';
const LINKEDIN = 'https://www.linkedin.com/in/ali-hamza-b0650a281/';
const FULL_NAME = 'Ali Hamza';
const SHOTS = 'shots/ali-claus';

let browser: Browser;
let admin: TestUser;
let userId = '';
const ctxs: BrowserContext[] = [];
let shotNo = 0;
async function shot(page: Page, name: string) {
  shotNo += 1;
  await page.screenshot({ path: `${SHOTS}/${String(shotNo).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {});
}
const bubbles = (page: Page) => page.locator('.whitespace-pre-wrap');
const transcript: string[] = [];

/** Claus's rules for an asking turn (the same checks the journey spec applies). */
function expectHostTurn(reply: string, label: string) {
  const r = reply.trim();
  const questions = (r.match(/\?/g) || []).length;
  expect(questions, `${label}: exactly one question`).toBe(1);
  expect(r.split(/\s+/).length, `${label}: short enough to read`).toBeLessThanOrEqual(45);
  expect(r, `${label}: never asks them to list who they want to meet`).not.toMatch(/who (do|would) you (want|like) to meet/i);
  expect(r, `${label}: never asks them to describe what they offer`).not.toMatch(/what can you (offer|help)/i);
  expect(r, `${label}: never asks them to describe their profile`).not.toMatch(/describe (yourself|your profile)|tell me about yourself/i);
  expect(r, `${label}: never reads the answer back`).not.toMatch(/^(so you|you're |you are |you want |sounds like|it sounds like)/i);
  expect(r, `${label}: no dashes`).not.toMatch(/[—–]/);
  // An "A or B?" choice put to the member ("already using it, or open to it?")
  // is the thing Claus forbids; "someone who runs or builds for a factory" is
  // ordinary phrasing. Only the comma-separated alternative form is flagged.
  const q = r.split(/(?<=[.!])\s+/).find((s) => s.includes('?')) || r;
  expect(q, `${label}: no "A, or B?" choice`).not.toMatch(/,\s*or\b[^?]*\?/i);
}

async function say(page: Page, text: string, label: string) {
  const before = await bubbles(page).count();
  const box = page.locator('textarea[aria-label="Your answer"]');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(bubbles(page)).toHaveCount(before + 2, { timeout: 60_000 });
  const reply = ((await bubbles(page).last().textContent()) || '').trim();
  if (reply.includes('503') || /unavailable right now/i.test(reply)) throw new Error('LLM-disabled fallback: Anthropic balance empty?');
  transcript.push(`MEMBER: ${text}`, `HOST:   ${reply}`);
  const confirm = page.getByRole('button', { name: /Yes, use this/i });
  let done = await confirm.isVisible().catch(() => false);
  if (!done && !reply.includes('?')) done = await confirm.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  if (!done) expectHostTurn(reply, label);
  return { reply, done };
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.beforeAll(async () => {
  const existing = await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [EMAIL]);
  if (existing.rows.length) throw new Error(`${EMAIL} still has a user row: reset it first (e2e/reset-test-account.mjs --apply)`);
  admin = await createTestUser('aliclausadmin', 'super_admin');
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [admin?.id].filter(Boolean) });
  console.log('\n===== TRANSCRIPT =====\n' + transcript.join('\n') + '\n======================');
});

test("Ali's account: live LinkedIn card, Claus's chat, agents, record", async () => {
  test.setTimeout(900_000);

  // 1. Join form on a phone.
  const pub = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctxs.push(pub);
  await primePreview(pub);
  const form = await pub.newPage();
  await gotoRetry(form, `${APP}/request-to-join`);
  await form.getByPlaceholder('Your full name').fill(FULL_NAME);
  await form.getByPlaceholder('you@example.com').fill(EMAIL);
  await form.getByPlaceholder('your-username').fill(LINKEDIN);
  await form.getByPlaceholder(/Tell us about yourself/i).fill('I build AWS backends and want to move into building software for manufacturing companies.');
  await form.locator('button[type="submit"]').click();
  await expect(form.getByText(/Thank you for your interest in RSN/i)).toBeVisible({ timeout: 30_000 });
  await shot(form, 'join-submitted');
  const jr = await pool.query(`SELECT id FROM join_requests WHERE lower(email) = $1`, [EMAIL]);
  const requestId = jr.rows[0].id;

  // 2. Approval (the admin page was proven yesterday; the API is the same route).
  const approve = await api('PATCH', `/join-requests/${requestId}/review`, { decision: 'approved' }, admin.accessToken);
  expect(approve.status, JSON.stringify(approve.json)).toBe(200);
  await expect.poll(async () =>
    (await pool.query(`SELECT enriched IS NOT NULL AS done FROM join_requests WHERE id = $1`, [requestId])).rows[0].done,
    { timeout: 300_000, intervals: [5_000] }).toBe(true);
  const pre = (await pool.query(`SELECT enriched FROM join_requests WHERE id = $1`, [requestId])).rows[0].enriched;
  const p = pre.profile || {};
  console.log(`  preload: sources=${JSON.stringify(pre.sources)} | company=${p.currentCompany} | role=${p.currentRole} (${p.roleSource}) | headline=${p.headline} | about=${String(p.summary || '').slice(0, 90)} | certs=${(p.certifications || []).length} | recs=${(p.recommendations || []).length} | photo=${!!p.photoUrl}`);
  expect(pre.sources.join(' '), 'the live page was read').toContain(':live');

  // 3. One-click link.
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [EMAIL, crypto.createHash('sha256').update(token).digest('hex')]);
  const mem = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctxs.push(mem);
  await primePreview(mem);
  const page = await mem.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/auth/verify?token=${token}`);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 60_000 });
  userId = (await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [EMAIL])).rows[0].id;

  // 4. The card.
  const cont = page.getByRole('button', { name: /Yes, continue/i });
  await expect(cont).toBeVisible({ timeout: 120_000 });
  // A photo is stored only when the page offers a real one; Ali's own page
  // hands a logged-out scraper LinkedIn's grey placeholder, which is no photo.
  if (p.photoUrl) {
    await expect.poll(async () =>
      (await pool.query(`SELECT avatar_blob IS NOT NULL AS b FROM users WHERE id = $1`, [userId])).rows[0].b,
      { timeout: 90_000, intervals: [3_000] }).toBe(true);
  } else {
    console.log('  no real photo on the page (placeholder only): the card offers Google photo / upload instead');
  }
  await shot(page, 'card');
  const cardText = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
  console.log(`  card: ${cardText.slice(cardText.indexOf('Name'), cardText.indexOf('Name') + 420)}`);
  await cont.click();

  // 5. Claus's chat, answered like a real member.
  await expect(bubbles(page).first()).toBeVisible({ timeout: 60_000 });
  const opening = ((await bubbles(page).first().textContent()) || '').trim();
  transcript.push(`HOST:   ${opening}`);
  expect(opening).toMatch(/Do you mind sharing what brought you here\?$/);
  await shot(page, 'chat-opening');

  const answers = [
    'I run a small dev shop in Islamabad building AWS backends, and I want to move from client work into building products for manufacturing companies.',
    'The hard part is that I do not know the manufacturing world from the inside. I keep guessing what a factory actually needs from software.',
    'A couple of honest conversations with people who run factories or supply chains, and maybe one person who has sold software into that world.',
    'Mostly mid-sized factories in Pakistan and the Gulf, the ones that still run on spreadsheets.',
    'That would be enough for me to pick one problem and build for it.',
  ];
  let second = '';
  let done = false;
  for (let i = 0; i < answers.length && !done; i++) {
    const r = await say(page, answers[i], `turn ${i + 1}`);
    if (i === 0) second = r.reply;
    done = r.done;
  }
  // The second question adapts to the answer; it is never the stock line.
  expect(second, 'adapted, not the stock line').not.toMatch(/what.s taking up your attention (these days|most right now)\??\s*$/i);

  const confirmBtn = page.getByRole('button', { name: /Yes, use this/i });
  for (let i = 0; i < 3 && !(await confirmBtn.isVisible().catch(() => false)); i++) {
    const finish = page.getByRole('button', { name: /I'm done/i });
    if (await finish.isVisible().catch(() => false)) {
      const before = await bubbles(page).count();
      await finish.click();
      await expect(bubbles(page)).toHaveCount(before + 2, { timeout: 60_000 });
      const reply = ((await bubbles(page).last().textContent()) || '').trim();
      transcript.push(`MEMBER: (I'm done)`, `HOST:   ${reply}`);
    }
  }
  await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
  const closing = ((await bubbles(page).last().textContent()) || '').trim();
  expect(closing, 'the closing is a statement').not.toContain('?');
  const hostTurns = await bubbles(page).evaluateAll((els) => els.filter((e) => e.classList.contains('self-start')).length);
  // Claus's shape: three openings, at most one follow-up after each, then the closing.
  expect(hostTurns, 'host turns incl. the opening and the closing').toBeLessThanOrEqual(7);
  await shot(page, 'chat-closing');
  await confirmBtn.click();

  // 6. Agents.
  await expect(page).toHaveURL(/\/agents/, { timeout: 60_000 });
  const toast = page.getByText(/searching now/i).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  console.log(`  TOAST: ${((await toast.textContent()) || '').trim()}`);
  await shot(page, 'agents');
  const agents = (await pool.query(`SELECT id, label, want_text, status, last_matched_at FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
  expect(agents.length).toBeGreaterThan(0);
  const active = agents.filter((a) => a.status === 'active');
  expect(active.length, 'exactly one main agent').toBe(1);
  expect(active[0].last_matched_at).not.toBeNull();
  console.log(`  AGENTS: ${agents.map((a) => `${a.label} [${a.status}] "${a.want_text}"`).join(' | ')}`);
  const matches = (await pool.query(`SELECT am.score, am.reason, x.display_name, x.job_title, x.company, x.industry FROM agent_matches am JOIN users x ON x.id = am.candidate_user_id WHERE am.agent_id = $1 ORDER BY am.score DESC`, [active[0].id])).rows;
  console.log(`  MATCHES (${matches.length}): ${matches.map((m) => `${m.display_name} (${m.job_title || '-'} @ ${m.company || '-'}, ${m.industry || '-'}) ${m.score}: ${m.reason}`).join('\n    ')}`);
  for (const a of agents) await expect(page.getByTestId(`agent-${a.id}`)).toBeVisible({ timeout: 30_000 });

  // 7. The record.
  const rec = (await pool.query(`SELECT onboarding_status::text s, company, job_title, job_title_source, bio, expertise_text, who_i_want_to_meet, why_i_want_to_meet, avatar_url FROM users WHERE id = $1`, [userId])).rows[0];
  const ip = (await pool.query(`SELECT matching_intent mi, profile_strength ps FROM user_intent_profiles WHERE user_id = $1`, [userId])).rows[0];
  console.log(`  RECORD: status=${rec.s} | company=${rec.company} | role=${rec.job_title} (${rec.job_title_source}) | bio=${String(rec.bio || '').slice(0, 80)} | expertise=${rec.expertise_text}\n  WANTS: ${rec.who_i_want_to_meet}\n  WHY: ${rec.why_i_want_to_meet}\n  INTENT: strength=${ip.ps} role=${ip.mi.userRole} company=${ip.mi.userCompany} industry=${ip.mi.userIndustry} wants=${JSON.stringify(ip.mi.desiredPeople)} roles=${JSON.stringify(ip.mi.desiredRoles)}`);
  expect(rec.s).toBe('completed');
  if (p.photoUrl) expect(rec.avatar_url).toBeTruthy();
  expect(rec.who_i_want_to_meet, 'who he wants to meet was read out of the answers').toMatch(/manufactur|factor|supply/i);
});
