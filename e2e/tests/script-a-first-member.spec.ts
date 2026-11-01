// e2e/tests/script-a-first-member.spec.ts
//
// SCRIPT A, "First-time member and connection" (25 Oct walkthrough, spec-25oct-transcription.md), re-read against the
// 30 Oct changes (T19, 2 Nov 2026). Headed, real browsers, never reloaded where a step watches another person:
//   01 A new member signs up as an employee, not a founder, picking several answers on every question. The new
//      onboarding is mandatory (T3b) and screen 7 needs where they are based: nothing and a bare country are refused.
//   02 The tour shows its heading and explanation before "Examples only. These are not real members.", above the
//      picture of made-up people.
//   03 LinkedIn is offered, and the whole flow finishes without it (Continue with email).
//   04 They find another member by name (search), open the profile and come Back to the same results.
//   05 They send a request: the other member's Messages, open the whole time, shows "<First> wants to meet you" (T5)
//      without a reload; the button reads "Request sent" and a second press sends nothing more. The other accepts: the
//      sender's open profile loses the bar and offers Message (T5) without a reload. A third member asks the new
//      member, who declines: the asker's open profile reads "Request declined" without a reload, and declining again
//      changes nothing.
// Throwaway members only (<id>@rsn-e2e.invalid), deleted by id. Locally: run-local-spec.sh; on the preview:
// run-stable.sh, Chromium, WebKit and iPhone 14, E2E_WIDTH=768 / 1024 for the tablet widths.

import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import {
  APP, RUN, api, cleanupRun, expectNotReloaded, firstName, gotoRetry, launch, markNotReloaded, noSidewaysScroll, openAs,
  pool, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';

const SLOW = 60_000;
const LIVE = 25_000;
const WELCOME = "Answer a few quick questions and we'll suggest potential mutuals for you.";
const CAPTION = 'Examples only. These are not real members.';

let browser: Browser;
let ava: TestUser, ben: TestUser, cleo: TestUser;

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
async function press(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.click();
}
const tick = (page: Page, label: string) => press(page, page.getByRole('checkbox', { name: label, exact: true }));
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.beforeAll(async () => {
  browser = await launch();
  ava = await throwaway('Ava', { onboarding: 'fresh' });
  ben = await throwaway('Ben', { set: { job_title: 'Head of Product', company: 'Harbor Labs' } });
  cleo = await throwaway('Cleo');
  console.log(`[script-a] ${where()} app=${APP}`);
});

test.afterAll(async () => {
  await cleanupRun();
  await browser?.close().catch(() => undefined);
});

test('Script A: a first-time employee onboards, finds a member, sends, accepts and declines requests, each change on the other screen live', async () => {
  test.setTimeout(480_000);
  // Ben's Messages, open from the start and never reloaded.
  const benInbox = (await openAs(browser, ben, '/messages')).page;
  await expect(benInbox.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: SLOW });
  await markNotReloaded(benInbox);

  const me = await openAs(browser, ava, '/');
  const page = me.page;

  await test.step('01 the new onboarding is where a new member starts, with its welcome word for word', async () => {
    await expect.poll(() => new URL(page.url()).pathname, { timeout: SLOW }).toBe('/onboarding');
    await expect(heading(page, "Welcome to REASON. We're glad you're here.")).toBeVisible({ timeout: SLOW });
    await expect(page.getByText(WELCOME, { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/\bRSN\b/);
    await press(page, button(page, "Let's go"));
  });

  await test.step('03 LinkedIn is offered; the member goes on with email', async () => {
    await expect(heading(page, "Let's get you started")).toBeVisible();
    await expect(button(page, 'Continue with LinkedIn')).toBeVisible();
    await press(page, button(page, 'Continue with email'));
  });

  await test.step('01 an employee picks several answers on every question, never "Something else"', async () => {
    const somethingElse = () => page.getByRole('checkbox', { name: "Something else. I'd like to say it in my own words.", exact: true });
    await expect(heading(page, 'Who would you like to meet?')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Select all that apply.', { exact: true })).toBeVisible();
    await tick(page, 'I would like to meet managers and leaders in companies and organisations.');
    await tick(page, 'I would like to meet people who are hiring.');
    await expect(somethingElse()).toHaveAttribute('aria-checked', 'false');
    await press(page, button(page, 'Continue'));
    await expect(heading(page, 'What are you hoping to find?')).toBeVisible();
    await tick(page, 'I am looking for a new job or my next career step.');
    await tick(page, 'I am looking for advice, mentoring or to learn from others.');
    await press(page, button(page, 'Continue'));
    await expect(heading(page, 'What can you offer others?')).toBeVisible();
    await tick(page, 'I can share what I know from my work.');
    await tick(page, 'I can help people find jobs or refer them where I work.');
    await press(page, button(page, 'Continue'));
    await expect(heading(page, 'How would you describe yourself?')).toBeVisible();
    await tick(page, 'I work for a company or organisation.');
    await expect(somethingElse()).toHaveAttribute('aria-checked', 'false');
    await press(page, button(page, 'Continue'));
    await expect(heading(page, "Here's how others will see you")).toBeVisible();
    await expect(page.getByTestId('answer-q1')).toContainText('Managers and leaders · People who are hiring');
    await expect(page.getByTestId('answer-q4')).toContainText('Employee');
    await noSidewaysScroll(page, 'screen 7');
  });

  await test.step('01 (30 Oct, 1.2) screen 7 needs where they are based: nothing and "USA" are refused', async () => {
    const field = page.getByLabel('Where are you based?', { exact: true });
    await expect(field).toHaveValue('');
    const go = button(page, 'Show me my matches');
    await tall(go, 'Show me my matches');
    await press(page, go);
    await expect(page.getByText('Please add your city and country.', { exact: true })).toBeVisible();
    await field.fill('USA');
    await expect(page.getByText('Add your city too', { exact: true })).toBeVisible();
    await press(page, go);
    await expect(page.getByRole('alert').filter({ hasText: 'Add your city too' })).toBeVisible();
    await field.fill('Lisbon, Portugal');
    await page.getByLabel('Role', { exact: true }).fill('Product manager');
    await page.getByLabel('Company', { exact: true }).fill('Crumb Logistics');
    await shot(page, 'a-screen7');
    await press(page, go);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: SLOW }).toBe('/');
    const row = (await pool.query('SELECT onboarding_version, location, self_kinds FROM users WHERE id = $1', [ava.id])).rows[0];
    expect(row).toEqual({ onboarding_version: 2, location: 'Lisbon, Portugal', self_kinds: ['self_employee'] });
  });

  await test.step('02 the tour: its heading and explanation, then "Examples only", then the picture', async () => {
    const tour = page.getByTestId('how-rsn-works');
    await expect(tour).toBeVisible({ timeout: SLOW });
    for (const [i, title] of ['For You', 'Matches', 'Meetings', 'Circles & events'].entries()) {
      const slide = tour.locator('[aria-roledescription="slide"]');
      await expect(slide.getByRole('heading', { name: title })).toBeVisible();
      const h = (await slide.getByRole('heading', { name: title }).boundingBox())!;
      const caption = (await slide.getByText(CAPTION, { exact: true }).boundingBox())!;
      const picture = (await slide.getByTestId('tour-picture').boundingBox())!;
      expect(h.y + h.height, `${title}: the heading is above the caption`).toBeLessThanOrEqual(caption.y + 1);
      expect(caption.y + caption.height, `${title}: the caption is above the picture`).toBeLessThanOrEqual(picture.y + 1);
      if (i < 3) await press(page, page.getByRole('button', { name: /^Next$/ }));
    }
    await press(page, page.getByRole('button', { name: 'See my matches' }));
    await expect(tour).toHaveCount(0);
  });

  await test.step('04 they find another member by name (the search every member has), open the profile and come Back to the results', async () => {
    // For You ranks the whole network, so on production a throwaway member is not reliably on a new member's first
    // screen; search by name is the path the product guarantees for "find another member" (search.spec.ts).
    const search = page.getByRole('search').getByRole('textbox', { name: 'Search people' });
    await search.fill(ben.displayName);
    await search.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=/, { timeout: SLOW });
    const result = page.locator(`a[href^="/people/${ben.id}"]`).first();
    await expect(result).toBeVisible({ timeout: SLOW });
    await noSidewaysScroll(page, 'the search results');
    const resultsAt = page.url();
    await result.click();
    await expect(page.getByRole('heading', { level: 1, name: ben.displayName })).toBeVisible({ timeout: SLOW });
    expect(new URL(page.url()).pathname).toBe(`/people/${ben.id}`);
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page).toHaveURL(resultsAt);
    await expect(result).toBeVisible({ timeout: SLOW });
    await result.click();
    await expect(page.getByRole('heading', { level: 1, name: ben.displayName })).toBeVisible({ timeout: SLOW });
  });

  await test.step('05 send: one request, "Request sent"; Ben\'s open Messages shows "<First> wants to meet you" without a reload', async () => {
    const note = `Hello Ben, I would like to learn how you hire (${RUN}).`;
    const bar = page.getByRole('region', { name: 'Your move' });
    await bar.getByRole('button', { name: 'Meet', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: `Meet ${ben.displayName}` });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox').fill(note);
    await tall(sheet.getByRole('button', { name: 'Send request' }), 'Send request');
    await sheet.getByRole('button', { name: 'Send request' }).click();
    await expect(sheet).toBeHidden({ timeout: LIVE });
    const sent = bar.getByRole('button', { name: 'Request sent', exact: true });
    await expect(sent).toHaveAttribute('aria-disabled', 'true');
    // Pressed again it sends nothing more.
    await sent.click({ force: true }).catch(() => undefined);
    const rows = await pool.query<{ message: string }>('SELECT message FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2', [ava.id, ben.id]);
    expect(rows.rows.map((r) => r.message), 'one request, the note exactly').toEqual([note]);
    const request = benInbox.getByTestId('meeting-request').filter({ hasText: `(${RUN})` });
    await expect(request.locator('[data-part="heading"]'), 'Ben\'s Messages, without a reload').toHaveText(`${firstName(ava)} wants to meet you`, { timeout: LIVE });
    await expect(request.locator('[data-part="note"] blockquote')).toContainText('I would like to learn how you hire');
    await expectNotReloaded(benInbox, 'Ben\'s Messages');
  });

  await test.step('05 accept: Ava\'s open profile of Ben loses the bar and offers Message without a reload; it cannot be accepted twice', async () => {
    const onBen = (await openAs(browser, ava, `/people/${ben.id}?from=For%20You`)).page;
    await expect(onBen.getByRole('region', { name: 'Your move' }).getByRole('button', { name: 'Request sent' })).toBeVisible({ timeout: SLOW });
    await markNotReloaded(onBen);
    const request = benInbox.getByTestId('meeting-request').filter({ hasText: `(${RUN})` });
    await request.getByRole('button', { name: 'Accept' }).click();
    await benInbox.waitForURL(/\/messages\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(onBen.getByRole('region', { name: 'Your move' }), 'the bar goes').toHaveCount(0, { timeout: LIVE });
    await expect(onBen.getByRole('link', { name: 'Message' }), 'Message comes').toBeVisible({ timeout: LIVE });
    await expectNotReloaded(onBen, 'Ava\'s profile of Ben');
    const poke = (await pool.query<{ id: string }>('SELECT id FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2', [ava.id, ben.id])).rows[0].id;
    await api(ben, 'POST', `/pokes/${poke}/accept`);
    const convs = await pool.query(
      'SELECT 1 FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)', [ava.id, ben.id]);
    expect(convs.rows, 'one conversation after a second accept').toHaveLength(1);
    await onBen.context().close();
  });

  await test.step('05 decline: Cleo asks; Ava declines; Cleo\'s open profile of Ava reads "Request declined" without a reload; again changes nothing', async () => {
    const cleoOnAva = (await openAs(browser, cleo, `/people/${ava.id}?from=For%20You`)).page;
    await expect(cleoOnAva.getByRole('heading', { level: 1, name: ava.displayName })).toBeVisible({ timeout: SLOW });
    const asked = await api(cleo, 'POST', `/matches/platform/${ava.id}/interest`, { note: `Cleo would like to meet (${RUN}).`, format: 'video_20' });
    expect(asked.status, asked.text).toBe(201);
    await gotoRetry(cleoOnAva, `${APP}/people/${ava.id}?from=For%20You`);
    await expect(cleoOnAva.getByRole('region', { name: 'Your move' }).getByRole('button', { name: 'Request sent' })).toBeVisible({ timeout: SLOW });
    await markNotReloaded(cleoOnAva);
    await gotoRetry(page, `${APP}/messages`);
    const request = page.getByTestId('meeting-request').filter({ hasText: `Cleo would like to meet (${RUN}).` });
    await expect(request.locator('[data-part="heading"]')).toHaveText(`${firstName(cleo)} wants to meet you`, { timeout: SLOW });
    await request.getByRole('button', { name: 'Decline' }).click();
    await expect(request, 'gone from Ava\'s Messages').toHaveCount(0, { timeout: LIVE });
    await expect(cleoOnAva.getByRole('region', { name: 'Your move' }).getByRole('button', { name: 'Request declined' }), 'Cleo\'s page, without a reload')
      .toBeVisible({ timeout: LIVE });
    await expectNotReloaded(cleoOnAva, 'Cleo\'s profile of Ava');
    await api(ava, 'POST', `/pokes/${asked.json.data.id}/decline`);
    const status = await pool.query<{ status: string }>('SELECT status FROM user_pokes WHERE id = $1', [asked.json.data.id]);
    expect(status.rows[0].status).toBe('declined');
    const conv = await pool.query('SELECT 1 FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)', [ava.id, cleo.id]);
    expect(conv.rows, 'a declined request makes no conversation').toHaveLength(0);
    await shot(cleoOnAva, 'a-declined');
  });
});
