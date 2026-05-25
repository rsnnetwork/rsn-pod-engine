// server/src/__tests__/services/orchestration/canonical-phase1-spine.test.ts
import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

describe('Canonical room-state Phase 1 — spine', () => {
  it('canonical-state uses a namespace distinct from the rsn:session: blob', () => {
    const src = readServer('services/orchestration/state/canonical-state.ts');
    expect(src).toMatch(/rsn:canonical:/);
    expect(src).not.toMatch(/['"`]rsn:session:['"`]/);
  });

  it('session-fsm exports the transition table and guard', () => {
    const src = readServer('services/orchestration/state/session-fsm.ts');
    expect(src).toMatch(/export const SESSION_LEGAL_TRANSITIONS/);
    expect(src).toMatch(/export function canTransitionSession/);
  });

  it('persistSessionState fires the shadow write', () => {
    const src = readServer('services/orchestration/state/session-state.ts');
    expect(src).toMatch(/shadowWriteCanonical\(activeSession\)/);
  });
});
