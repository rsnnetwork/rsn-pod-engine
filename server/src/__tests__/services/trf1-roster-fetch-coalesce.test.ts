// TRF-1 (audit C3) — source pins for the client roster:changed coalescer and
// the applyFullState stale-response guards. The behavioral guarantees (timing,
// convergence) are asserted by the headed Playwright prod E2E; these pins stop
// the structure from silently regressing back to an instant per-event refetch.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');
}
function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('TRF-1 — roster:changed coalescer (useSessionSocket.ts)', () => {
  const src = readClient('hooks/useSessionSocket.ts');

  it('the roster:changed handler schedules a coalesced fetch, not an immediate one', () => {
    const after = src.slice(src.indexOf("socket.on('roster:changed'"));
    const handler = after.slice(0, after.indexOf('});') + 3);
    expect(handler).toMatch(/scheduleRosterFetch\(\)/);
    expect(handler).not.toMatch(/fetchSessionStateSnapshot\(\)/); // not a direct call anymore
  });

  it('uses a 3s coalescing window with a one-in-flight guard', () => {
    expect(src).toMatch(/ROSTER_FETCH_WINDOW_MS\s*=\s*3000/);
    expect(src).toMatch(/rosterFetchInFlight/);
    expect(src).toMatch(/rosterPending/);
  });

  it('still references fetchSessionStateSnapshot after the roster handler (phase4 pin intact)', () => {
    const after = src.slice(src.indexOf("socket.on('roster:changed'"));
    expect(after).toMatch(/fetchSessionStateSnapshot/);
  });

  it('clears the roster timer in the effect cleanup', () => {
    expect(src).toMatch(/clearTimeout\(rosterTimer\)/);
  });

  it('permissions:updated still fetches immediately (NOT routed through the coalescer)', () => {
    const after = src.slice(src.indexOf("socket.on('permissions:updated'"));
    const handler = after.slice(0, after.indexOf('});') + 3);
    expect(handler).toMatch(/fetchSessionStateSnapshot\(\)/);
    expect(handler).not.toMatch(/scheduleRosterFetch/);
  });
});

describe('TRF-1 — applyFullState stale-response guards (sessionStore.ts)', () => {
  const src = readClient('stores/sessionStore.ts');

  it('drops a strictly-older REST response via a monotonic fullStateStamp', () => {
    expect(src).toMatch(/fullStateStamp/);
    const fn = src.slice(src.indexOf('applyFullState:'));
    expect(fn).toMatch(/stamp\s*<\s*s\.fullStateStamp/);
  });

  it('does not overwrite participants when the REST seq is older than the applied socket seq', () => {
    const fn = src.slice(src.indexOf('applyFullState:'));
    expect(fn).toMatch(/<\s*s\.snapshotSeq/);
  });

  it('fullStateStamp is reset to 0', () => {
    const fn = src.slice(src.indexOf('reset:'));
    expect(fn).toMatch(/fullStateStamp:\s*0/);
  });
});

describe('TRF-1 — snapshot service exposes seq', () => {
  const src = readServer('services/session/session-state-snapshot.service.ts');
  it('reads the canonical seq and composes it into the snapshot', () => {
    expect(src).toMatch(/readCanonical/);
    expect(src).toMatch(/seq:\s*canonical\?\.seq\s*\?\?\s*null/);
  });
});
