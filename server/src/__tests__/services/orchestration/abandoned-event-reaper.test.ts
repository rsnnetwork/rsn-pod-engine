// ─── Abandoned-event reaper (22 Sep 2026) ────────────────────────────────────
//
// Nothing ends an event whose host simply walks away. Shradha's 17 Sep "test"
// sat in round_transition for four days and a second sat in lobby_open for
// fourteen hours; between them they were the "requested room does not exist"
// line the LiveKit sweep wrote every fifteen seconds.
//
// This is source-shaped on purpose. The reaper is a setInterval inside
// initOrchestration, which cannot be invoked without standing up a socket
// server; what has to be guaranteed is the SHAPE of what it would do — which
// column it trusts, which statuses it touches, that a report mode writes
// nothing, and that ending goes through the one function with the DB claim.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

const src = nodeFs.readFileSync(
  nodePath.join(__dirname, '../../../services/orchestration/orchestration.service.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

const reaper = (() => {
  const start = src.indexOf('// ── Abandoned-event reaper');
  const end = src.indexOf('// ── Register socket handlers ──', start);
  return src.slice(start, end > -1 ? end : src.length);
})();

/**
 * The same block with its commentary removed. The comments above this reaper
 * explain what it deliberately does NOT do ("never updated_at", "goes through
 * completeSession"), so a pin that reads them proves the opposite of what it
 * claims — an assertion satisfied by prose.
 */
const code = reaper.replace(/^\s*\/\/.*$/gm, '');

describe('abandoned-event reaper — which events it may touch', () => {
  it('exists, inside initOrchestration', () => {
    expect(reaper.length).toBeGreaterThan(200);
    expect(reaper).toMatch(/setInterval/);
  });

  it('only considers events that are live but not terminal', () => {
    const inClause = reaper.match(/status IN \(([^)]+)\)/)?.[1] ?? '';
    for (const live of ['lobby_open', 'round_active', 'round_rating', 'round_transition']) {
      expect(inClause).toContain(live);
    }
    // Never an event that has already finished, or one nobody has started.
    for (const terminal of ['completed', 'cancelled', 'scheduled']) {
      expect(inClause).not.toContain(terminal);
    }
  });

  // updated_at is bumped by a trigger on ANY write to the row — including the
  // orphan-lobby reaper's own — so it says nothing about whether an event is
  // alive. active_state_updated_at is written by lifecycle transitions alone.
  it('judges liveness by active_state_updated_at, never updated_at', () => {
    expect(code).toMatch(/active_state_updated_at/);
    // Every updated_at in the query must be the active_state one.
    const bare = (code.match(/(?<!active_state_)updated_at/g) ?? []);
    expect(bare).toHaveLength(0);
    // Falls back down a chain, so an event that never transitioned still ages.
    expect(code).toMatch(/COALESCE\(active_state_updated_at, started_at, scheduled_at\)/);
  });

  it('also requires the event to have been SCHEDULED that long ago', () => {
    // Belt: an event scheduled for next week whose row was touched today can
    // never be reaped by an accident of the first clause.
    expect(reaper).toMatch(/scheduled_at < NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
  });

  it('is bounded, so one tick can never sweep the table', () => {
    expect(reaper).toMatch(/LIMIT 20/);
  });

  it('takes the threshold from config rather than hard-coding hours', () => {
    expect(reaper).toMatch(/config\.abandonedEventAfterHours/);
  });
});

describe('abandoned-event reaper — what it does about them', () => {
  it('does not run at all unless it is switched on', () => {
    expect(reaper).toMatch(/config\.abandonedEventReaper !== 'off'/);
  });

  it('report mode names every event it would end, and returns before writing', () => {
    const guard = code.indexOf("config.abandonedEventReaper !== 'end'");
    const ends = code.indexOf('completeSession');
    expect(guard).toBeGreaterThan(-1);
    expect(ends).toBeGreaterThan(-1);
    // The early return sits BEFORE anything that could end an event.
    expect(guard).toBeLessThan(ends);
    expect(code).toMatch(/WOULD end this event/);
  });

  it('ends only through completeSession, which owns the cross-instance claim', () => {
    expect(code).toMatch(/completeSession\(io, row\.id\)/);
    // Never its own UPDATE: that would skip the teardown and the claim.
    expect(code).not.toMatch(/UPDATE sessions/);
  });

  it('one event that will not end never stops the others', () => {
    expect(code).toMatch(/Promise\.allSettled/);
    expect(code).toMatch(/rejected/);
  });

  it('a failing tick is warned about, never thrown out of the interval', () => {
    expect(code).toMatch(/catch \(err\)[\s\S]*logger\.warn/);
  });
});

describe('the switch itself', () => {
  const cfg = nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../config/index.ts'), 'utf8',
  ).replace(/\r\n/g, '\n');

  it('is off unless set, and only accepts the three modes', () => {
    expect(cfg).toMatch(/\['off', 'report', 'end'\] as const/);
    expect(cfg).toMatch(/process\.env\.ABANDONED_EVENT_REAPER/);
    // An unknown value falls back to off rather than to something that writes.
    expect(cfg).toMatch(/\?\? 'off'/);
  });

  it('defaults to four hours, longer than any event RSN runs', () => {
    expect(cfg).toMatch(/ABANDONED_EVENT_AFTER_HOURS \?\? 4/);
  });
});
