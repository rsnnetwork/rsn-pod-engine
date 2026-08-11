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
    // The visible span sits alongside (not instead of) the title attribute.
    const notMutualIdx = src.indexOf("cantMessageReason === 'not_mutual'");
    const block = src.slice(notMutualIdx, notMutualIdx + 900);
    expect(block).toMatch(/title="DMs unlock when you both say 'meet again'"/);
    expect(block).toMatch(/<span className="text-\[11px\] text-gray-400">/);
  });

  // 6 Aug: the no_encounter state used to be a DEAD button reading "Message —
  // meet first", shown even to someone who had already been asked, or who had
  // asked YOU. S22's requirement is that the WHY is visible text rather than a
  // tooltip; it never required the button be inert. Every branch now carries its
  // own visible line, and two of the three are a way through rather than a wall.
  it('the no-encounter state explains itself in visible text, in every branch', () => {
    const src = readClient('features/profile/PublicProfilePage.tsx');
    const i = src.indexOf("cantMessageReason === 'no_encounter'");
    if (i < 0) throw new Error('the no_encounter branch has gone from PublicProfilePage');
    const block = src.slice(i, src.indexOf(') : null}', i));

    // Three states, each with a visible explanation under it.
    expect(block).toMatch(/Meeting request sent/);
    expect(block).toMatch(/You can message once they accept/);
    expect(block).toMatch(/They asked to meet you — respond/);
    expect(block).toMatch(/Waiting on you in Messages/);
    expect(block).toMatch(/I want to meet/);
    expect(block).toMatch(/Messaging unlocks once they accept/);
    // A decline is surfaced, not silently swallowed.
    expect(block).toMatch(/A previous request was declined/);
    // Reasons are visible spans, not tooltip-only — three of them.
    expect((block.match(/<span className="text-\[11px\] text-gray-400">/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
    // And the state is reachable by a test, so the E2E can assert the outcome.
    expect(block).toMatch(/data-testid="meet-state"/);
  });
});
