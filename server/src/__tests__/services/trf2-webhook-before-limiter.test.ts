// TRF-2 (audit C3) — LiveKit's signed webhooks must NOT pass through the /api
// rate limiter. A round transition emits 100+ participant_joined/left events
// from a few LiveKit Cloud IPs within a minute; if those count against the IP
// bucket they get 429'd exactly when canonical-state reconciliation matters.
// Express matches mounts in order, so /api/webhooks must be mounted BEFORE the
// limiter to short-circuit it.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('TRF-2 — webhook mount precedes the API limiter', () => {
  const idx = readServer('index.ts');

  it('mounts /api/webhooks BEFORE app.use(/api, apiLimiter)', () => {
    const webhookIdx = idx.indexOf("app.use('/api/webhooks'");
    const limiterIdx = idx.indexOf("app.use('/api', apiLimiter)");
    expect(webhookIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(webhookIdx).toBeLessThan(limiterIdx);
  });

  it('mounts the webhook router exactly once (no leftover duplicate mount)', () => {
    const count = (idx.match(/app\.use\('\/api\/webhooks',\s*webhooksRouter\)/g) || []).length;
    expect(count).toBe(1);
  });
});
