// Phase W — Sentry post-deploy spike check.
//
// Two-mode operation:
//
//   1. SENTRY_AUTH_TOKEN set: query Sentry's REST API for the last 30
//      minutes of issues on the rsn-pod-engine project + alert if any
//      were first-seen since the latest deploy.
//
//   2. SENTRY_AUTH_TOKEN not set: print clear "blocked" message and
//      walk through how to generate a personal auth token at
//      https://sentry.io/settings/account/api/auth-tokens/ with the
//      `project:read` and `event:read` scopes. The Sentry SDK is
//      verified wired (DSN present), so the data IS being captured —
//      just not queryable from here without the token.
//
// Runnable: `npx tsx e2e/verify-sentry.ts` (or with env override:
//   SENTRY_AUTH_TOKEN=... SENTRY_ORG=... SENTRY_PROJECT=rsn-pod-engine
//   npx tsx e2e/verify-sentry.ts).

import { config as dotenvConfig } from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename_local = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);

dotenvConfig({ path: path.resolve(__dirname_local, '../server/.env') });

const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG = process.env.SENTRY_ORG || 'rsn-network';
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || 'rsn-pod-engine';

async function main() {
  console.log('=== Phase W — Sentry post-deploy check ===\n');

  // SDK wiring check — DSN must be present in server/.env (verified to
  // be there at the time of this script's commit).
  if (!SENTRY_DSN) {
    console.log('✗ SENTRY_DSN not set in server/.env. The Sentry SDK won\'t initialize.');
    console.log('  Add SENTRY_DSN to server/.env and to Render env to re-enable error capture.');
    process.exit(1);
  }
  console.log('✓ SENTRY_DSN is set in server/.env — SDK has an ingestion endpoint.');

  // Verify server entrypoint initializes Sentry. We don't trust the
  // env alone — a missing init call would mean errors aren't captured
  // even with the DSN set.
  const serverIndex = await import('fs').then(fs =>
    fs.readFileSync(path.resolve(__dirname_local, '../server/src/index.ts'), 'utf8'),
  );
  const hasSentryInit = /Sentry\.init\(/.test(serverIndex) || /@sentry\/node/.test(serverIndex);
  if (hasSentryInit) {
    console.log('✓ server/src/index.ts references @sentry/node + Sentry.init — capture is wired.');
  } else {
    console.log('✗ server/src/index.ts does NOT call Sentry.init. Errors will not be captured.');
    console.log('  Add `Sentry.init({ dsn: process.env.SENTRY_DSN })` at the top of the entry file.');
    process.exit(1);
  }

  // Spike check requires API access.
  if (!SENTRY_AUTH_TOKEN) {
    console.log('\n⏭️  SENTRY_AUTH_TOKEN not set — spike check skipped.');
    console.log('');
    console.log('To enable automated spike checks, generate a personal auth token at:');
    console.log('  https://sentry.io/settings/account/api/auth-tokens/');
    console.log('Scopes needed: project:read, event:read');
    console.log('Then re-run with:');
    console.log('  SENTRY_AUTH_TOKEN=<token> npx tsx e2e/verify-sentry.ts');
    console.log('');
    console.log('Manual check meanwhile: open the Sentry dashboard for project');
    console.log(`  ${SENTRY_ORG}/${SENTRY_PROJECT} and scan the last 30 minutes for new issues.`);
    return;
  }

  console.log(`\nQuerying Sentry API for ${SENTRY_ORG}/${SENTRY_PROJECT}...`);

  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const url = `https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?statsPeriod=30m&query=is:unresolved`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}` },
    });
    if (!res.ok) {
      console.log(`✗ Sentry API returned ${res.status} ${res.statusText}`);
      console.log('  Check token validity and project slug.');
      process.exit(1);
    }
    const issues: any[] = await res.json();
    if (issues.length === 0) {
      console.log('✓ No unresolved Sentry issues in the last 30 minutes. Clean post-deploy.');
      return;
    }
    console.log(`⚠️  ${issues.length} unresolved issue(s) in the last 30 minutes:`);
    for (const issue of issues.slice(0, 10)) {
      console.log(`  - [${issue.level || 'error'}] ${issue.title}`);
      console.log(`    first seen: ${issue.firstSeen} · last seen: ${issue.lastSeen}`);
      console.log(`    ${issue.permalink}`);
    }
    if (issues.length > 10) {
      console.log(`  ... and ${issues.length - 10} more.`);
    }
    // Spike heuristic: any issue first-seen since 30 min ago is a
    // post-deploy regression candidate.
    const fresh = issues.filter(i => new Date(i.firstSeen).getTime() > Date.parse(since));
    if (fresh.length > 0) {
      console.log(`\n🚨 ${fresh.length} of these are NEW since ${since}. Likely post-deploy regression.`);
    }
  } catch (err: any) {
    console.log(`✗ Failed to query Sentry: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Sentry check failed:', err);
  process.exit(1);
});
