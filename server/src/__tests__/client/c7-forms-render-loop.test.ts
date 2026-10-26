// server/src/__tests__/client/c7-forms-render-loop.test.ts
// The four C7 forms, RENDERED with every effect live, must settle and then stay still (C7 fix round 1, 26 Oct 2026).
// A render loop does not always crash: a quiet one (an effect that sets state each render, a prop's identity in a
// dependency list) keeps a phone busy and the page janky while every pin passes. Here the real Schedule an Event page,
// Create a Pod (and Duplicate Pod), Edit Pod and Edit Event are bundled with their real dependencies (react-hook-form,
// React Query, the router; only the API and the auth store are stood in, in render-loop/stubs) and opened in
// Chromium. A React Profiler counts every commit: once the forms have drawn and the parent has stopped re-rendering
// them with fresh props, the count must not move at all.
//
// It needs Playwright's Chromium, as the e2e specs do. Where none is installed (the CI image installs none), the suite
// is skipped and says so; every local and pre-ship run of the full suite has it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build, type Plugin } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = path.resolve(__dirname, '../../../..');
const CLIENT_SRC = path.join(ROOT, 'client', 'src');
const HARNESS = path.join(__dirname, 'render-loop');

const chromiumPath = (() => {
  try {
    const p = chromium.executablePath();
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();
if (!chromiumPath) {
  // The one place a skipped run must not be quiet.
  process.stderr.write('c7-forms-render-loop: skipped, no Playwright Chromium here (npx playwright install chromium)\n');
}
const describeWithChromium = chromiumPath ? describe : describe.skip;

/** The client's `@/` imports, from client/src, except the API and the auth store, which the harness stands in. */
const clientAlias: Plugin = {
  name: 'client-alias',
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/api$/ }, () => ({ path: path.join(HARNESS, 'stubs', 'api.ts') }));
    b.onResolve({ filter: /^@\/stores\/authStore$/ }, () => ({ path: path.join(HARNESS, 'stubs', 'authStore.ts') }));
    b.onResolve({ filter: /^@\// }, async (args) => {
      const r = await b.resolve(`./${args.path.slice(2)}`, { resolveDir: CLIENT_SRC, kind: args.kind });
      return { path: r.path, errors: r.errors };
    });
  },
};

interface Scenario {
  label: string;
  form: 'create-event' | 'create-pod' | 'duplicate-pod' | 'edit-pod' | 'edit-event';
  role: 'member' | 'admin';
  podId?: string;
  event?: 'rounds' | 'meeting';
  ticks: number;
  strict: boolean;
}

// A pod director who is not an admin, with and without ?podId= (the reviewer's cases), every form, and the parent
// rendering again with fresh props where a page does that; an admin and StrictMode as well.
const SCENARIOS: Scenario[] = [
  { label: 'Schedule an Event from a Reason pod (?podId=)', form: 'create-event', role: 'member', podId: 'P1', ticks: 0, strict: false },
  { label: 'Schedule an Event from a speed-networking pod (?podId=)', form: 'create-event', role: 'member', podId: 'P2', ticks: 0, strict: false },
  { label: 'Schedule an Event, pod chosen on the form (no ?podId=)', form: 'create-event', role: 'member', ticks: 0, strict: false },
  { label: 'Schedule an Event in StrictMode', form: 'create-event', role: 'member', podId: 'P1', ticks: 0, strict: true },
  { label: 'Schedule an Event as an admin (templates)', form: 'create-event', role: 'admin', podId: 'P2', ticks: 0, strict: false },
  { label: 'Create a Pod', form: 'create-pod', role: 'member', ticks: 10, strict: false },
  { label: 'Duplicate Pod (fresh values each render)', form: 'duplicate-pod', role: 'member', ticks: 10, strict: false },
  { label: 'Edit Pod (a fresh pod each render)', form: 'edit-pod', role: 'member', ticks: 10, strict: false },
  { label: 'Edit Event, speed networking (a fresh event each render)', form: 'edit-event', role: 'member', event: 'rounds', ticks: 10, strict: false },
  { label: 'Edit Event, video meeting (a fresh event each render)', form: 'edit-event', role: 'member', event: 'meeting', ticks: 10, strict: false },
];

const commits = (page: Page) => page.evaluate(() => (globalThis as unknown as { __commits: number }).__commits);

/** Wait until the commit count has not moved for 600ms (at most 10s); then count what happens in 1.5s of nothing. */
async function watch(page: Page): Promise<{ drawn: boolean; settled: boolean; mount: number; idle: number }> {
  const drawn = await page.waitForSelector('form', { timeout: 20_000 }).then(() => true, () => false);
  let last = -1;
  let stillFor = 0;
  const until = Date.now() + 10_000;
  while (Date.now() < until && stillFor < 600) {
    const now = await commits(page);
    stillFor = now === last ? stillFor + 100 : 0;
    last = now;
    await page.waitForTimeout(100);
  }
  const mount = await commits(page);
  await page.waitForTimeout(1500);
  return { drawn, settled: stillFor >= 600, mount, idle: (await commits(page)) - mount };
}

describeWithChromium('the C7 forms settle, then sit still: no render loop, loud or quiet', () => {
  let browser: Browser;
  let page: string;

  beforeAll(async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-render-loop-'));
    await build({
      entryPoints: [path.join(HARNESS, 'harness.tsx')],
      bundle: true,
      outfile: path.join(out, 'bundle.js'),
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      nodePaths: [path.join(ROOT, 'node_modules'), path.join(ROOT, 'client', 'node_modules')],
      // A development build: the Profiler only reports commits there.
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{"DEV":true,"MODE":"development"}' },
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      plugins: [clientAlias],
      logLevel: 'silent',
    });
    fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="./bundle.js"></script></body></html>');
    page = `file://${path.join(out, 'index.html').replace(/\\/g, '/')}`;
    browser = await chromium.launch({ executablePath: chromiumPath as string });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('every form, for a non-admin director with and without ?podId=, an admin and in StrictMode', async () => {
    const results = await Promise.all(SCENARIOS.map(async (scenario) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const tab = await ctx.newPage();
      const errors: string[] = [];
      tab.on('pageerror', (e) => errors.push(String(e)));
      await tab.addInitScript((s) => { (globalThis as unknown as { __scenario: unknown }).__scenario = s; }, scenario);
      await tab.goto(page);
      const seen = await watch(tab);
      await ctx.close();
      return { label: scenario.label, ...seen, errors };
    }));
    // One line per form, so a failure names the form and its numbers.
    expect(results.map((r) => `${r.label}: drawn=${r.drawn} settled=${r.settled} idle=${r.idle} errors=${r.errors.length}`))
      .toEqual(results.map((r) => `${r.label}: drawn=true settled=true idle=0 errors=0`));
    for (const r of results) expect([r.label, r.mount < 200]).toEqual([r.label, true]);
  }, 120_000);
});
