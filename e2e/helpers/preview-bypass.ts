// Vercel deployment-protection bypass for headed E2E against a branch preview.
//
// A protected preview 302s every request to Vercel SSO. The share link sets an
// auth cookie on first load, so each browser context must visit it once before
// any test navigation. Set E2E_VERCEL_SHARE to the `_vercel_share` token
// (from get_access_to_vercel_url) to enable; absent, this is a no-op so the
// same specs run unchanged against production.

import type { BrowserContext, Page } from '@playwright/test';
import { APP } from './live-ui';

const SHARE = process.env.E2E_VERCEL_SHARE || '';

export const usingPreview = () => !!SHARE;

/** Prime a fresh context with the share cookie. Safe to call when unset. */
export async function primePreview(ctx: BrowserContext): Promise<void> {
  if (!SHARE) return;
  const page: Page = await ctx.newPage();
  try {
    await page.goto(`${APP}/?_vercel_share=${SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
  } finally {
    await page.close().catch(() => {});
  }
}
