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

describe('Bug 22 / 23 May — bonus round counted only when actually started', () => {
  const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');
  const lifecycleSrc = readServer('services/orchestration/handlers/round-lifecycle.ts');

  it('the round-count bump lives at round START (transitionToRound), not the preview', () => {
    // 23 May (Stefan live test) — moved out of the CLOSING_LOBBY "Another
    // Round" preview into actual round start, so a previewed-but-never-started
    // round never inflates the recap "X of N". Idempotent (only when this round
    // exceeds the configured count) and still persisted to sessions.config.
    const idx = lifecycleSrc.indexOf('export async function transitionToRound');
    expect(idx).toBeGreaterThan(-1);
    // LCY-4 (audit C4) moved the bonus-bump to after batch-activation (~7k chars
    // into the function), so slice the FULL function body, not a fixed 2500-char
    // window which would now miss the bump.
    const end = lifecycleSrc.indexOf('\nexport', idx + 1);
    const block = lifecycleSrc.slice(idx, end > -1 ? end : idx + 9000);
    expect(block).toMatch(/roundNumber\s*>\s*\(activeSession\.config\.numberOfRounds/);
    expect(block).toMatch(/numberOfRounds:\s*roundNumber/);
    expect(block).toMatch(/jsonb_set\([\s\S]{0,160}'\{numberOfRounds\}'/);
  });

  it('the CLOSING_LOBBY "Another Round" preview no longer bumps the count', () => {
    const idx = flowSrc.indexOf("activeSession.status === SessionStatus.CLOSING_LOBBY");
    expect(idx).toBeGreaterThan(-1);
    const block = flowSrc.slice(idx, idx + 2000);
    // No optimistic bump here anymore — the preview just re-opens the round.
    expect(block).not.toMatch(/const\s+bumpedRounds/);
    expect(block).not.toMatch(/numberOfRounds:\s*bumpedRounds/);
  });
});
