import { test, expect } from '@playwright/test';
import { APP, gotoRetry } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 8 Oct 2026 — "Continue with Google" turns into a disabled "Redirecting..." the moment it is
// pressed. Press Back from Google and the browser (Safari on a phone above all) can bring the
// sign-in page back from its back-forward cache exactly as it was left: the button still
// disabled, and no code running to say otherwise. The one signal is a `pageshow` event with
// `persisted` set. The page now listens for it.
//
// No member and no database: the request that would send the browser to Google is answered
// with "no content", which keeps the page where it is, in the state a cached page is kept in.
// RED against the bundle before the fix (the button stays on "Redirecting..." and disabled).
// ─────────────────────────────────────────────────────────────────────────────

test.describe('coming back to the sign-in page from Google', () => {
  test('a page the browser restores from its cache gets its Google button back', async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext(contextOptions({ width: 390, height: 844 }));
      const page = await context.newPage();
      console.log(`[login-back-from-google] engine=${engineLabel()} app=${APP}`);

      // The start of the Google sign-in answers with nothing; the page stays and its button stays pressed.
      let sentToGoogle = 0;
      await page.route('**/auth/google**', (route) => {
        sentToGoogle += 1;
        return route.fulfill({ status: 204 });
      });

      await gotoRetry(page, `${APP}/login`);
      const google = page.getByRole('button', { name: /Continue with Google|Redirecting/ });
      await expect(google).toHaveText('Continue with Google');
      await expect(google).toBeEnabled();

      await google.click();
      await expect.poll(() => sentToGoogle).toBe(1);
      await expect(google).toHaveText('Redirecting...');
      await expect(google).toBeDisabled();

      // A page shown for any other reason is not a restore: nothing changes.
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
      await expect(google).toBeDisabled();

      // The browser puts the page back from its cache: the button is ready again.
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await expect(google).toHaveText('Continue with Google');
      await expect(google).toBeEnabled();

      // And it works again: a second press goes out as the first did.
      await google.click();
      await expect.poll(() => sentToGoogle).toBe(2);
      await expect(google).toBeDisabled();
    } finally {
      await browser.close();
    }
  });
});
