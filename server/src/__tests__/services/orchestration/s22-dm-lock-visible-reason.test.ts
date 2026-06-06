// ─── S22 — DM lock: the WHY is visible, and the server stays the gate ──────
//
// Ali (6 Jun): "DMs locked unless you're a mutual match — and applied to the
// SYSTEM, not only UI; hover must show the correct message." The system side
// already holds: dm.service.sendMessage re-runs canMessage() on every send
// and 403s with a per-reason message (blocked / not_mutual / no_encounter).
// The UI side relied on a native title tooltip — which needs a ~1.5s hover
// and NEVER fires on touch devices. The reason now renders as visible text
// under the disabled button on the profile page.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

describe('S22 — server is the gate (pins the existing enforcement)', () => {
  it('sendMessage re-checks canMessage and 403s with per-reason copy', () => {
    const src = readServer('services/dm/dm.service.ts');
    const i = src.indexOf('export async function sendMessage');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\n// ─── Broadcast send', i));
    expect(fn).toMatch(/const auth = await canMessage\(fromUserId, toUserId\)/);
    expect(fn).toMatch(/throw new AppError\(403, ErrorCodes\.AUTH_FORBIDDEN, message\)/);
    expect(fn).toMatch(/not_mutual/);
    expect(fn).toMatch(/no_encounter/);
  });

  it('canMessage requires mutual_meet_again for NEW threads', () => {
    const src = readServer('services/dm/dm.service.ts');
    const i = src.indexOf('export async function canMessage');
    const fn = src.slice(i, src.indexOf('\n// ─── Sending', i));
    expect(fn).toMatch(/mutual_meet_again FROM encounter_history/);
    expect(fn).toMatch(/reason: 'not_mutual'/);
    expect(fn).toMatch(/reason: 'no_encounter'/);
  });
});

describe('S22 — the reason is VISIBLE on the profile page (not tooltip-only)', () => {
  it('both locked states render the explanation as text under the button', () => {
    const src = readClient('features/profile/PublicProfilePage.tsx');
    expect(src).toMatch(/DMs unlock when you both say “meet again”/);
    expect(src).toMatch(/DMs unlock after you meet at an event/);
    // The visible span sits alongside (not instead of) the title attribute.
    const notMutualIdx = src.indexOf("cantMessageReason === 'not_mutual'");
    const block = src.slice(notMutualIdx, notMutualIdx + 900);
    expect(block).toMatch(/title="DMs unlock when you both say 'meet again'"/);
    expect(block).toMatch(/<span className="text-\[11px\] text-gray-400">/);
  });
});
