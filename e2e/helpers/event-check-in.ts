// e2e/helpers/event-check-in.ts
// A live event asks a member "What brings you here today?" when they come in (EventCheckInModal, 25 Jun 2026), and the
// sheet covers the event's top bar until it is answered or skipped. A spec that walks the event skips it, as a member
// may, before it presses anything behind it. Specs written before the sheet (ws2, ws3) timed out behind it.
import type { Page } from '@playwright/test';

const QUESTION = 'What brings you here today?';

/** Skip the event's check-in question when it shows within `waitMs`; true when it was there. */
export async function skipEventCheckIn(page: Page, waitMs = 15_000): Promise<boolean> {
  const question = page.getByRole('heading', { name: QUESTION });
  try {
    await question.waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    return false;
  }
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  // The innermost box holding both the question and a Skip is the sheet itself, so another Skip on the page is never pressed.
  const sheet = page.locator('div', { has: question }).filter({ has: skip }).last();
  await sheet.getByRole('button', { name: 'Skip', exact: true }).click();
  await question.waitFor({ state: 'hidden', timeout: 10_000 });
  return true;
}
