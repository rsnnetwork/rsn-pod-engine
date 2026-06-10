// #5 (June-10 debrief) — Host force-close of a stuck rating window.
// The TESTEVENT (c624b66a) sat on the silent 90s backstop every round because
// present participants didn't rate and the host had no discoverable escape.
// This pins the dedicated, idempotent host:force_close_rating control end-to-end.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const serverSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');

describe('#5 — host force-close rating window', () => {
  const hostActions = serverSrc('services/orchestration/handlers/host-actions.ts');
  const wiring = serverSrc('services/orchestration/orchestration.service.ts');
  const hostControls = clientSrc('features/live/HostControls.tsx');

  it('server: exports a dedicated handleHostForceCloseRating handler', () => {
    expect(hostActions).toMatch(/export async function handleHostForceCloseRating\(/);
  });

  it('server: the handler is session-guarded, host-gated, and idempotent (acts only in ROUND_RATING)', () => {
    const start = hostActions.indexOf('export async function handleHostForceCloseRating(');
    const fn = hostActions.slice(start, hostActions.indexOf('\nexport ', start + 1));
    expect(fn).toMatch(/withSessionGuard\(/);            // serialized — double-click safe
    expect(fn).toMatch(/verifyHost\(/);                  // host/co-host only
    expect(fn).toMatch(/SessionStatus\.ROUND_RATING/);   // no-op unless actually in rating
    expect(fn).toMatch(/_endRatingWindow\(/);            // closes the window via the lifecycle fn
  });

  it('server: the event is wired in the orchestration layer', () => {
    expect(wiring).toMatch(/wrapHandler\('host:force_close_rating',\s*socket,\s*handleHostForceCloseRating\)/);
  });

  it('client: the host bar emits host:force_close_rating during the rating phase', () => {
    expect(hostControls).toMatch(/host:force_close_rating/);
  });
});
