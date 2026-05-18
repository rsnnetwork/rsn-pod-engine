// Bug 22 (18 May Ali) — extra round added via "Another Round" must
// behave like a normal round across every layer.
//
// Before this fix the bump only lived in:
//   - activeSession.config.numberOfRounds (in-memory)
//   - Redis snapshot (via persistSessionState's serialised session.config)
//
// The DB sessions.config row was never touched, which made the recap
// page (getPeopleMet reads sessions.config.numberOfRounds) show "3 of 3"
// even when the host ran a 4th round. Same gap on a server restart with
// no Redis: recovery from sessions.config gets the stale 3, losing the
// 4th round entirely.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Bug 22 — Extra round persists everywhere', () => {
  const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');

  it('CLOSING_LOBBY → "Another Round" bumps numberOfRounds in-memory AND in sessions.config DB', () => {
    // Locate the CLOSING_LOBBY branch in handleHostGenerateMatches.
    const idx = flowSrc.indexOf("activeSession.status === SessionStatus.CLOSING_LOBBY");
    expect(idx).toBeGreaterThan(-1);
    const block = flowSrc.slice(idx, idx + 3500);

    // In-memory bump goes through the bumpedRounds variable so both the
    // local activeSession.config update AND the DB UPDATE use the same
    // value.
    expect(block).toMatch(
      /const\s+bumpedRounds\s*=\s*\(activeSession\.config\.numberOfRounds[\s\S]{0,80}\+\s*1/,
    );
    expect(block).toMatch(/numberOfRounds:\s*bumpedRounds/);

    // Bug 22: jsonb_set updates the DB config so recap, REST fetches, and
    // a server restart all see the bumped value.
    expect(block).toMatch(/jsonb_set\(config,\s*'\{numberOfRounds\}'/);
    expect(block).toMatch(/UPDATE sessions[\s\S]{0,200}SET config = jsonb_set/);
  });

  it('CLOSING_LOBBY → "Another Round" emits host:event_plan_repaired with the new roundCount', () => {
    const idx = flowSrc.indexOf("activeSession.status === SessionStatus.CLOSING_LOBBY");
    const block = flowSrc.slice(idx, idx + 3500);
    // The broadcast tells EventPlanStrip / lobby header to repaint the
    // round count from the new bumpedRounds value.
    expect(block).toMatch(
      /emit\(\s*'host:event_plan_repaired'[\s\S]{0,400}roundCount:\s*bumpedRounds/,
    );
  });
});
