// e2e/helpers/confirm-dialog.ts
// T2 (1 Nov 2026): the client no longer calls window.confirm(); every "are you sure?" is a ConfirmDialog drawn in the
// page. A spec that used to accept the browser's dialog (page.on('dialog', d => d.accept())) arms this too, and every
// such question on that page is answered with its confirm button whenever it stands in the way of the spec's next
// action or assertion.
import type { Page } from '@playwright/test';

const armed = new WeakSet<Page>();

/** Answer every in-page question on this page with its confirm button. Arm it once per page; arming again is a no-op. */
export async function acceptConfirmDialogs(page: Page): Promise<void> {
  if (armed.has(page)) return;
  armed.add(page);
  await page.addLocatorHandler(page.getByTestId('confirm-dialog-confirm'), async (button) => {
    await button.click();
  });
}

/** Press the confirm button of the question now on screen (for a spec that answers it itself). */
export async function confirmInPage(page: Page): Promise<void> {
  await page.getByTestId('confirm-dialog-confirm').click();
}
