// ─── June-13 (Stefan's event #2) — isolated-in-stale-breakout heal ────────────
//
// A participant whose tab was throttled/backgrounded during a round-end could be
// left with a canonical 'breakout' location pointing at a match that had ALREADY
// ENDED. The resync token rail (handleResync → buildYou) then minted them a
// token for that dead breakout room on every reconnect, so they sat ISOLATED in
// the main room (seeing only themself) — and a REFRESH did NOT fix it because
// the stale location persisted in Redis. handleResync now heals it: a breakout
// whose match is not 'active' is rewritten to 'main' and a lobby token is
// minted, so the returner lands back with everyone else. Reproduced live
// (offline→online during the round-end leaves the user in `match-...` while the
// partner is in `lobby-...`); pinned so the heal can't silently regress.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

const read = (rel: string) => nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
function sliceFn(src: string, marker: string): string {
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  const end = src.indexOf('\nexport ', i + 1);
  return src.slice(i, end === -1 ? i + 6000 : end);
}

describe("June-13 — handleResync heals a stale breakout location to main", () => {
  const fn = () => sliceFn(read('services/orchestration/state/state-snapshot.ts'), 'export async function handleResync');

  it('checks whether a breakout location\'s match is still active', () => {
    const f = fn();
    expect(f).toMatch(/location\.type === 'breakout'/);
    expect(f).toMatch(/SELECT status FROM matches WHERE id = \$1/);
    expect(f).toMatch(/!== 'active'/);
  });

  it('rewrites a dead-breakout location to main before minting the token', () => {
    const f = fn();
    expect(f).toMatch(/clearCanonicalLocationToMain/);
    expect(f).toMatch(/location:\s*\{\s*type:\s*'main'\s*\}/);
    // The heal must run BEFORE buildYou mints the token, so the token is a LOBBY
    // token, not a dead-breakout one.
    const healIdx = f.indexOf('clearCanonicalLocationToMain');
    const buildIdx = f.indexOf('buildYou(');
    expect(healIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(healIdx).toBeLessThan(buildIdx);
  });
});
