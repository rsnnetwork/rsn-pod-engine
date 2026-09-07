import { chromium, webkit, devices, type Browser, type BrowserContextOptions } from '@playwright/test';

// Engine + device selection for headed prod smokes across browsers.
//   E2E_ENGINE=webkit   → Safari engine (default: chromium)
//   E2E_DEVICE='iPhone 14' → a Playwright device descriptor (iOS = webkit + touch)
//   E2E_HEADED=0        → headless (default: headed, so a human can watch)
export function pickEngine() {
  return process.env.E2E_ENGINE === 'webkit' ? webkit : chromium;
}

export async function launchBrowser(): Promise<Browser> {
  return pickEngine().launch({ headless: process.env.E2E_HEADED === '0' });
}

/** Context options: a device descriptor when E2E_DEVICE is set (uses its own
 *  viewport/userAgent/touch), otherwise a plain desktop viewport. */
export function contextOptions(fallbackViewport = { width: 1100, height: 800 }): BrowserContextOptions {
  const name = process.env.E2E_DEVICE;
  const dev = name ? (devices as Record<string, BrowserContextOptions>)[name] : null;
  return dev ? { ...dev } : { viewport: fallbackViewport };
}

export function engineLabel(): string {
  const engine = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';
  return process.env.E2E_DEVICE ? `${engine}/${process.env.E2E_DEVICE}` : engine;
}
