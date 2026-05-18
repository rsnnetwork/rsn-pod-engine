// Stefan's 18 May post-test feedback — Bug 18.
//
// Event plan must recompute when participants join AFTER the host
// clicks Start but BEFORE round 1 begins. Pre-fix `maybeRepairFutureRounds`
// returned early when currentRound < 1, leaving the plan stuck at
// whatever generateSessionSchedule produced at Start — Stefan's exact
// complaint: "the system was showing 3 rounds 3 pairs but should show 4
// rounds 4 pairs when two more participants join".
//
// Two pieces of the fix:
//   1. Guard widened: skip ONLY when status is SCHEDULED (no plan yet)
//      or COMPLETED. Every other status (LOBBY_OPEN, ROUND_ACTIVE, …)
//      gets a repair on every roster change.
//   2. Trailing-edge throttle: a burst of joins within the 5-second
//      throttle window now schedules ONE trailing repair after the
//      window closes, so the latest roster is always reflected.
//   3. The host:event_plan_repaired emit now carries roundCount +
//      totalPairs so the host's "Plan: X rounds · Y pairs" headline
//      updates alongside the per-round badges.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}
function readShared(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../shared/src', rel),
    'utf8',
  );
}

describe('Bug 18 — Event plan recomputes when participants join mid-event', () => {
  const flowSrc = readServer('services/orchestration/handlers/participant-flow.ts');
  const eventsSrc = readShared('types/events.ts');
  const socketSrc = readClient('hooks/useSessionSocket.ts');

  it('maybeRepairFutureRounds skips only SCHEDULED or COMPLETED sessions (not pre-round-1 lobby)', () => {
    const fnStart = flowSrc.indexOf('async function maybeRepairFutureRounds');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = flowSrc.slice(fnStart, fnStart + 2500);
    // The legacy `currentRound < 1` early-return is gone.
    expect(fn).not.toMatch(/activeSession\.currentRound\s*<\s*1\)\s*return/);
    // New guards: SCHEDULED (no plan yet) + COMPLETED (event over).
    expect(fn).toMatch(/activeSession\.status\s*===\s*SessionStatus\.SCHEDULED\)\s*return/);
    expect(fn).toMatch(/activeSession\.status\s*===\s*SessionStatus\.COMPLETED\)\s*return/);
  });

  it('trailing-edge throttle schedules a follow-up repair when within the throttle window', () => {
    // A burst of joiners within the 5-second window must result in ONE
    // trailing repair that captures the freshest roster — otherwise the
    // first joiner triggers a repair and every subsequent one is lost.
    expect(flowSrc).toMatch(/_futureRepairTrailing\s*=\s*new Map/);
    const fnStart = flowSrc.indexOf('async function maybeRepairFutureRounds');
    const fn = flowSrc.slice(fnStart, fnStart + 3000);
    expect(fn).toMatch(/_futureRepairTrailing\.has\(sessionId\)/);
    expect(fn).toMatch(/setTimeout\([\s\S]{0,200}runRepair\(io,\s*sessionId/);
  });

  it('runRepair emits host:event_plan_repaired with roundCount + totalPairs', () => {
    const fnStart = flowSrc.indexOf('async function runRepair');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = flowSrc.slice(fnStart, fnStart + 2500);
    // Reads the latest counts from the matches table.
    expect(fn).toMatch(/COUNT\(DISTINCT\s+round_number\)/);
    expect(fn).toMatch(/COUNT\(\*\)::text AS total_pairs/);
    // Emits them on the event payload.
    expect(fn).toMatch(
      /emit\(\s*'host:event_plan_repaired'[\s\S]{0,400}roundCount,?\s*[\s\S]{0,100}totalPairs/,
    );
  });

  it('shared event type carries optional roundCount + totalPairs', () => {
    const fnStart = eventsSrc.indexOf("'host:event_plan_repaired'");
    expect(fnStart).toBeGreaterThan(-1);
    const block = eventsSrc.slice(fnStart, fnStart + 600);
    expect(block).toMatch(/roundCount\?:\s*number/);
    expect(block).toMatch(/totalPairs\?:\s*number/);
  });

  it('client listener updates eventPlanSummary store on repair', () => {
    const startIdx = socketSrc.indexOf("socket.on('host:event_plan_repaired'");
    expect(startIdx).toBeGreaterThan(-1);
    const slice = socketSrc.slice(startIdx, startIdx + 2000);
    // Plucks the new totals off the payload and writes them to the store
    // so the headline "Plan: X rounds · Y pairs" updates alongside the
    // per-round badges.
    expect(slice).toMatch(/data\?\.roundCount/);
    expect(slice).toMatch(/data\?\.totalPairs/);
    expect(slice).toMatch(/store\.setEventPlanSummary\?\.\(/);
  });
});
