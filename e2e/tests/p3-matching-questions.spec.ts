import { test, expect, type Browser, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  APP, DEVICE, RUN, RUN_WIDTH, SERVER, api, cleanupRun, expectNotReloaded, launch, made, markNotReloaded,
  noSidewaysScroll, openAs, pool, seedPod, shot, tall, throwaway, viewportOptions, where, type TestUser,
} from '../helpers/sweep';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// EXTRA MATCHING QUESTIONS, ON SCREEN (10 Nov 2026 spec 02, Part 3 Task 10, the preview client for Task 5's routes; K5:
// answers are soft preferences). Against the preview (E2E_APP_URL = preview.rsn.network, E2E_VERCEL_SHARE for its
// protection), which talks to the production API. Run three times: chromium at 360px (default), E2E_DEVICE="iPhone 14"
// (WebKit) and E2E_DEVICE="iPad Mini" (a tablet).
//
//   bar       (desktop run only) the host's event page at 1280px: Go Live, Add to calendar and the organiser's tools in
//             ONE row, the Matching board on the same line as Go Live, nothing pushed right with an auto margin.
//   organiser the host opens the event page: the "Extra matching questions" card with the K5 line and the empty
//             sentence; Add question → "Which sector?", Fintech / Health, same, Required → Save: the card lists it
//             ("One answer · Match people with the same answer · Required"), and the question is stored.
//   guest     a fresh address opens the call link signed out: email, the 6-digit code (its keyed hash written here, as
//             p2-call-link-entry does), then ONE details step showing the name field AND the sector tiles (56px) →
//             Fintech → Join: "You're in", and the guest's answer is stored.
//   member    member A on the event page: Register (or the page's own registration) → "Before you join" sheet with the
//             sector tiles → Health → Register → "Registered"; A's answer is stored; the "Your answers" row reads it.
//   groups    on a second event with the founders/funders groups, member B gets the group tiles in the same sheet →
//             Founders → Register → "Registered", B's group stored.
//   privacy   the host's participant list and matching board show A's "Health" chip; A's own event page and the guest's
//             pages show nobody's answers, and the guest's reads (questions, schedule) carry no one else's answers.
//   widths    every new control fits the 360px screen, and no page scrolls sideways.
//
// Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end (the guest by its exact address).
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
/** The phone's or tablet's own width with E2E_DEVICE, else the smallest phone the screens are built for. */
const WIDTH = DEVICE ? RUN_WIDTH : 360;
const TITLE = `P3T10 questions ${RUN}`;
const GROUP_TITLE = `P3T10 groups ${RUN}`;
const LIVE = 10_000;
const QUESTION_KEY = 'which_sector';

let browser: Browser;
let host: TestUser;
let a: TestUser;
let b: TestUser;
let podId = '';
let eventId = '';
let groupEventId = '';
let code = '';
let hostPage: Page;
let guestPage: Page;
let guestId = '';
const guestEmail = `${uuid()}@rsn-e2e.invalid`;
const contexts: BrowserContext[] = [];

/** What is on screen (the call link also draws its summary beside the step from 1024px, hidden below). */
const shown = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();

/** The box sits inside the window's width. */
async function fitsWidth(page: Page, target: Locator, label: string): Promise<void> {
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) return false;
    return box.x >= -0.5 && box.x + box.width <= view.width + 0.5;
  }, { message: `${label} fits the ${page.viewportSize()?.width}px screen`, timeout: 10_000 }).toBe(true);
}

/** At least 56px tall: the answer tiles, as the call link's group tiles. */
async function tile56(target: Locator, label: string): Promise<void> {
  await expect.poll(async () => (await target.boundingBox())?.height ?? 0, { message: `${label}: at least 56px tall`, timeout: 10_000 })
    .toBeGreaterThanOrEqual(55.5);
}

/** Put the keyed hash of a code the spec chose on the newest entry link of `email` for `id`, and answer the code. */
async function knownEntryCode(email: string, id: string): Promise<string> {
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE email = $1 AND purpose = 'event_entry' AND target_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [email, id],
  );
  expect(row.rows[0], 'the entry link was written').toBeTruthy();
  const typed = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${typed}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return typed;
}

/** A person's stored answers on the event, question key → option keys. */
async function storedAnswers(sessionId: string, userId: string): Promise<Record<string, string[]>> {
  const r = await pool.query<{ key: string; option_keys: string[] }>(
    `SELECT q.key, a.option_keys FROM event_question_answers a JOIN event_matching_questions q ON q.id = a.question_id
      WHERE a.session_id = $1 AND a.user_id = $2`, [sessionId, userId]);
  return Object.fromEntries(r.rows.map((row) => [row.key, row.option_keys]));
}

async function placeStatus(sessionId: string, userId: string): Promise<string | null> {
  const r = await pool.query<{ status: string }>('SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
  return r.rows[0]?.status ?? null;
}

/**
 * The page's own registration may open the sheet by itself (Register is busy until it answers); otherwise the member
 * presses Register. Whichever comes first: the sheet can open over Register between a look and a press (WebKit, iPhone
 * and iPad, 11 Nov 2026), so a press the sheet beat to the screen is not waited on; the sheet is looked for again.
 */
async function openBeforeYouJoin(page: Page): Promise<Locator> {
  const sheet = page.getByTestId('before-you-join-sheet');
  const register = page.getByTestId('event-register');
  await expect(sheet.or(register).first()).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    if (!(await sheet.isVisible())) await register.click({ timeout: 2_000 });
    await expect(sheet).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: 'Before you join' })).toBeVisible();
  return sheet;
}

/** The vertical middle of a box (two controls of the same height on one line share it). */
async function middleOf(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  expect(box, 'the control is on screen').toBeTruthy();
  return box!.y + box!.height / 2;
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) signs the members and sets a known entry code').toBeTruthy();
  browser = await launch();
  host = await throwaway('Host', { first: 'Organiser' });
  a = await throwaway('A', { first: 'Ada' });
  b = await throwaway('B', { first: 'Ben' });
  podId = await seedPod(host, `P3T10 pod ${RUN}`, [a, b]);

  const scheduledAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  const config = { eventType: 'speed_networking', numberOfRounds: 2, maxParticipants: 20 };
  const created = await api(host, 'POST', '/sessions', { podId, title: TITLE, scheduledAt, config });
  expect(created.status, created.text).toBe(201);
  eventId = created.json.data.id;
  made.sessions.push(eventId);
  const open = await api(host, 'PUT', `/sessions/${eventId}/admission`, { mode: 'open' });
  expect(open.status, open.text).toBe(200);
  const link = await api(host, 'GET', `/sessions/${eventId}/call-link`);
  expect(link.status, link.text).toBe(200);
  code = link.json.data.code;

  // The second event: Founders and funders, every round across groups (the preset), and no questions.
  const second = await api(host, 'POST', '/sessions', { podId, title: GROUP_TITLE, scheduledAt, config });
  expect(second.status, second.text).toBe(201);
  groupEventId = second.json.data.id;
  made.sessions.push(groupEventId);
  const groups = await api(host, 'PUT', `/sessions/${groupEventId}/groups`, {
    groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
    question: 'Are you a founder or a funder?', allowMultiple: false, fallback: 'leave_unmatched',
    rounds: [{ fromRound: 1, toRound: 2, mode: 'cross_group', allowedPairs: [] }],
  });
  expect(groups.status, groups.text).toBe(200);
});

test.afterAll(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  await cleanupRun([() => pool.query('DELETE FROM magic_links WHERE email = $1', [guestEmail])]);
  await browser?.close();
});

test(`bar: at 1280px the organiser's tools sit on the same line as Go Live, left-aligned (${where()})`, async () => {
  test.skip(!!DEVICE, 'a desktop-width check: the phone and tablet runs wrap the bar by design');
  test.setTimeout(90_000);
  const { page } = await openAs(browser, host, `/sessions/${eventId}`, { width: 1280 });
  const bar = page.getByTestId('event-actions');
  await expect(bar).toBeVisible({ timeout: 30_000 });
  const goLive = bar.getByRole('button', { name: 'Go Live' });
  const calendar = bar.getByRole('button', { name: 'Add to calendar' });
  const board = bar.getByTestId('matching-board-link');
  const invite = bar.getByRole('button', { name: 'Invite people' });
  for (const [control, label] of [[goLive, 'Go Live'], [calendar, 'Add to calendar'], [board, 'Matching board'], [invite, 'Invite people']] as const) {
    await expect(control, `${label} is in the one bar`).toBeVisible();
    await tall(control, label);
  }
  // The first organiser tool fits beside the primary actions at 1280px: it is on their line, not a second row.
  const line = await middleOf(goLive);
  expect(Math.abs((await middleOf(calendar)) - line), 'Add to calendar is on the Go Live line').toBeLessThanOrEqual(3);
  expect(Math.abs((await middleOf(board)) - line), 'Matching board is on the Go Live line').toBeLessThanOrEqual(3);
  // Left-aligned: the bar starts with Go Live, and nothing in it is pushed right with an auto margin.
  const barBox = await bar.boundingBox();
  const goBox = await goLive.boundingBox();
  expect(Math.abs((goBox?.x ?? 0) - (barBox?.x ?? 0)), 'Go Live starts the bar').toBeLessThanOrEqual(1);
  const margins = await bar.evaluate((el) => Array.from(el.children).map((child) => getComputedStyle(child).marginLeft));
  expect(margins.every((m) => m === '0px'), `no auto margin in the bar (${margins.join(', ')})`).toBe(true);
  await shot(page, 'questions-action-bar-1280');
});

test(`organiser: the host adds "Which sector?" and the card lists it (${where()})`, async () => {
  test.setTimeout(120_000);
  ({ page: hostPage } = await openAs(browser, host, `/sessions/${eventId}`, { width: WIDTH }));
  const card = hostPage.getByTestId('event-questions-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('heading', { name: 'Extra matching questions' })).toBeVisible();
  await expect(card).toContainText('Answers help RSN choose between allowed meetings. They never override blocks or group rules.');
  await expect(card.getByTestId('questions-empty')).toHaveText('No extra questions. Add one if your matching needs more than groups.');
  const add = card.getByTestId('questions-add');
  await expect(add).toHaveText('Add question');
  await tall(add, 'Add question');
  await fitsWidth(hostPage, add, 'Add question');
  await markNotReloaded(hostPage);

  await add.click();
  const editor = hostPage.getByRole('dialog', { name: 'Add question' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('Question').fill('Which sector?');
  await expect(editor.getByTestId('question-kind-single')).toBeChecked();
  const options = editor.getByTestId('question-option');
  await options.nth(0).fill('Fintech');
  await options.nth(1).fill('Health');
  await expect(editor.getByTestId('question-prefer-same')).toBeChecked();
  await editor.getByTestId('question-required').check();
  for (const label of ['Add answer', 'Save question', 'Cancel']) {
    const control = editor.getByRole('button', { name: label });
    await tall(control, label);
    await fitsWidth(hostPage, control, label);
  }
  await noSidewaysScroll(hostPage, 'the question editor');
  await shot(hostPage, 'questions-editor');
  const saved = hostPage.waitForResponse((r: Response) => r.url().includes(`/api/sessions/${eventId}/questions`) && r.request().method() === 'PUT');
  await editor.getByTestId('question-save').click();
  expect((await saved).status(), 'the question was saved').toBe(200);
  await expect(editor).toBeHidden({ timeout: LIVE });

  const summary = card.getByTestId('question-summary');
  await expect(summary).toHaveCount(1, { timeout: LIVE });
  await expect(summary).toContainText('Which sector?');
  await expect(summary).toContainText('One answer · Match people with the same answer · Required');
  await expect(summary).toContainText('Fintech');
  await expect(summary).toContainText('Health');
  await tall(summary.getByTestId('question-edit'), 'Edit');
  await tall(summary.getByTestId('question-remove'), 'Remove');
  await fitsWidth(hostPage, summary.getByTestId('question-remove'), 'Remove');
  await noSidewaysScroll(hostPage, "the host's event page");
  await expectNotReloaded(hostPage, "the host's page");
  await shot(hostPage, 'questions-card');

  const stored = await pool.query<{ key: string; required: boolean; kind: string; prefer: string }>(
    'SELECT key, required, kind, prefer FROM event_matching_questions WHERE session_id = $1', [eventId]);
  expect(stored.rows).toEqual([{ key: QUESTION_KEY, required: true, kind: 'single', prefer: 'same' }]);
});

test(`guest: the call link's details step asks the name AND the sector, then enters (${where()})`, async () => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext(viewportOptions(WIDTH));
  contexts.push(ctx);
  await primePreview(ctx);
  guestPage = await ctx.newPage();
  const page = guestPage;
  await page.goto(`${APP}/call/${code}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: TITLE, level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(shown(page, /This event will ask for: your email, your name, one matching question/)).toBeVisible();
  await page.getByTestId('call-join').click();
  await page.getByLabel('Email address').fill(guestEmail);
  const sent = page.waitForResponse((r: Response) => r.url().includes(`/call-links/${code}/email`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  const body = await (await sent).json();
  await expect(page.getByRole('heading', { name: 'Check your inbox for a 6-digit code' })).toBeVisible();
  const typed = body?.data?.devCode ?? await knownEntryCode(guestEmail, eventId);
  await page.getByLabel('6-digit code from the email').fill(typed);

  // One step: the name field AND the sector tiles.
  const step = page.getByTestId('call-details-step');
  await expect(step).toBeVisible({ timeout: 30_000 });
  await expect(step.getByLabel('Your name')).toBeVisible();
  const sector = step.getByTestId(`call-question-${QUESTION_KEY}`);
  await expect(sector).toBeVisible();
  await expect(sector).toContainText('Which sector?');
  await expect(sector).not.toContainText('(optional)');
  const fintech = sector.locator('label').filter({ hasText: 'Fintech' });
  await tile56(fintech, 'the Fintech tile');
  await fitsWidth(page, fintech, 'the Fintech tile');
  await fitsWidth(page, sector.locator('label').filter({ hasText: 'Health' }), 'the Health tile');
  await noSidewaysScroll(page, 'the details step');
  await shot(page, 'questions-call-details');

  // A required question unanswered is said at the question, and nothing is sent.
  await step.getByLabel('Your name').fill(`Gus ${RUN}`);
  await page.getByRole('button', { name: 'Join the event' }).click();
  await expect(sector.getByRole('alert')).toHaveText('Choose an answer.');
  await fintech.click();
  const entered = page.waitForResponse((r: Response) => r.url().includes(`/call-links/${code}/enter`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Join the event' }).click();
  const enter = await entered;
  expect(enter.status(), 'the entry was taken').toBe(200);
  expect(enter.request().postDataJSON(), 'the entry carried the name and the answer').toMatchObject({
    displayName: `Gus ${RUN}`, answers: { [QUESTION_KEY]: ['fintech'] },
  });
  await expect(page.getByTestId('call-waiting')).toBeVisible({ timeout: 30_000 });

  const guest = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [guestEmail]);
  expect(guest.rows[0], 'the guest account').toBeTruthy();
  guestId = guest.rows[0].id;
  made.users.push(guestId);
  expect(await placeStatus(eventId, guestId)).toBe('registered');
  expect(await storedAnswers(eventId, guestId)).toEqual({ [QUESTION_KEY]: ['fintech'] });
});

test(`member: Register opens "Before you join", Health, then Registered (${where()})`, async () => {
  test.setTimeout(120_000);
  const { page } = await openAs(browser, a, `/sessions/${eventId}`, { width: WIDTH });
  const sheet = await openBeforeYouJoin(page);
  await markNotReloaded(page);
  await expect(sheet).toContainText('Which sector?');
  await expect(sheet.getByTestId('answers-group-question')).toHaveCount(0);
  const question = sheet.getByTestId(`answers-question-${QUESTION_KEY}`);
  const health = question.locator('label').filter({ hasText: 'Health' });
  await tile56(health, 'the Health tile');
  await fitsWidth(page, health, 'the Health tile');
  const submit = page.getByTestId('answers-submit');
  await expect(submit).toHaveText('Register');
  await tall(submit, 'Register in the sheet');
  await fitsWidth(page, submit, 'Register in the sheet');
  await noSidewaysScroll(page, 'the event page with the sheet open');
  await shot(page, 'questions-before-you-join');

  // Nothing chosen: said at the question, nothing sent.
  await submit.click();
  await expect(question.getByRole('alert')).toHaveText('Choose an answer.');
  await health.click();
  const answered = page.waitForResponse((r: Response) => r.url().includes(`/api/sessions/${eventId}/register`) && r.request().method() === 'POST');
  await submit.click();
  const res = await answered;
  expect(res.status(), 'the retry registered A').toBe(201);
  expect(res.request().postDataJSON(), 'the retry carried the answers').toEqual({ answers: { [QUESTION_KEY]: ['health'] } });
  await expect(page.getByTestId('before-you-join-sheet')).toBeHidden({ timeout: LIVE });
  await expect(page.getByTestId('event-registered').first()).toBeVisible({ timeout: LIVE });
  await expect(page.getByTestId('event-registered').first()).toContainText('Registered');
  await expectNotReloaded(page, "A's page");
  expect(await placeStatus(eventId, a.id)).toBe('registered');
  expect(await storedAnswers(eventId, a.id)).toEqual({ [QUESTION_KEY]: ['health'] });

  // "Your answers" reads A's own answer, with Change answers (44px), and A's page shows nobody's chips.
  const mine = page.getByTestId('my-answers-row');
  await expect(mine).toContainText('Your answers', { timeout: LIVE });
  await expect(mine).toContainText('Which sector? Health');
  await tall(mine.getByTestId('my-answers-change'), 'Change answers');
  await fitsWidth(page, mine.getByTestId('my-answers-change'), 'Change answers');
  await expect(page.getByTestId('participant-answer-chips')).toHaveCount(0);
  await noSidewaysScroll(page, "A's event page");
  await shot(page, 'questions-registered');
});

test(`groups: on a founders/funders event the same sheet shows the group tiles (${where()})`, async () => {
  test.setTimeout(120_000);
  const { page } = await openAs(browser, b, `/sessions/${groupEventId}`, { width: WIDTH });
  const sheet = await openBeforeYouJoin(page);
  const group = sheet.getByTestId('answers-group-question');
  await expect(group).toBeVisible({ timeout: LIVE });
  await expect(group).toContainText('Are you a founder or a funder?');
  const founders = group.locator('label').filter({ hasText: 'Founders' });
  await tile56(founders, 'the Founders tile');
  await fitsWidth(page, founders, 'the Founders tile');
  await noSidewaysScroll(page, 'the group sheet');
  await shot(page, 'questions-group-sheet');
  await founders.click();
  const answered = page.waitForResponse((r: Response) => r.url().includes(`/api/sessions/${groupEventId}/register`) && r.request().method() === 'POST');
  await page.getByTestId('answers-submit').click();
  const res = await answered;
  expect(res.status(), 'the retry registered B').toBe(201);
  expect(res.request().postDataJSON()).toEqual({ groupKeys: ['founder'] });
  await expect(page.getByTestId('event-registered').first()).toBeVisible({ timeout: LIVE });
  expect(await placeStatus(groupEventId, b.id)).toBe('registered');
  const keys = await pool.query<{ key: string }>(
    `SELECT g.key FROM event_participant_groups pg JOIN event_groups g ON g.id = pg.group_id
      WHERE pg.session_id = $1 AND pg.user_id = $2`, [groupEventId, b.id]);
  expect(keys.rows.map((r) => r.key), "B's group").toEqual(['founder']);
});

test(`privacy: the host sees A's answer on the list and the board; the guest sees nobody's (${where()})`, async () => {
  test.setTimeout(120_000);
  // The host's open page: A's chip arrives without a reload (session:<id>:questions and :participants).
  const chips = hostPage.locator('#participants').getByTestId('participant-answer-chips');
  await expect(chips.filter({ hasText: 'Health' })).toHaveCount(1, { timeout: LIVE });
  await expect(chips.filter({ hasText: 'Fintech' })).toHaveCount(1, { timeout: LIVE });
  await expectNotReloaded(hostPage, "the host's page");
  await expect(hostPage.getByTestId('event-questions-card').getByTestId('question-summary')).toContainText('1 person', { timeout: LIVE });
  await noSidewaysScroll(hostPage, "the host's page with answer chips");
  await shot(hostPage, 'questions-host-chips');

  // The matching board: A's seat carries A's answer.
  await hostPage.goto(`${APP}/sessions/${eventId}/board`, { waitUntil: 'domcontentloaded' });
  const seat = hostPage.getByTestId(`board-person-${a.id}`).first();
  await expect(seat).toBeVisible({ timeout: 30_000 });
  await expect(seat.getByTestId('seat-answers')).toContainText('Health', { timeout: LIVE });
  await expect(hostPage.getByTestId(`board-person-${guestId}`).first().getByTestId('seat-answers')).toContainText('Fintech');
  await noSidewaysScroll(hostPage, 'the board');
  await shot(hostPage, 'questions-board');

  // The guest's own page shows no one's answers; the guest's reads carry only their own.
  await expect(guestPage.getByTestId('participant-answer-chips')).toHaveCount(0);
  await expect(guestPage.getByTestId('seat-answers')).toHaveCount(0);
  await expect(guestPage.getByText('Health', { exact: true })).toHaveCount(0);
  const token = await guestPage.evaluate(() => localStorage.getItem('rsn_access'));
  expect(token, "the guest's own token").toBeTruthy();
  const read = async (p: string) => {
    const res = await fetch(`${SERVER}/api${p}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, text: await res.text() };
  };
  const questions = await read(`/sessions/${eventId}/questions`);
  expect(questions.status, questions.text).toBe(200);
  const view = JSON.parse(questions.text).data;
  expect(view.mine).toEqual({ [QUESTION_KEY]: ['fintech'] });
  expect(view.answers, "a guest reads nobody else's answers").toBeUndefined();
  expect(view.counts).toBeUndefined();
  const schedule = await read(`/sessions/${eventId}/schedule/mine`);
  expect(schedule.text).not.toContain('"answers"');
  expect(schedule.text).not.toContain('health');
});
