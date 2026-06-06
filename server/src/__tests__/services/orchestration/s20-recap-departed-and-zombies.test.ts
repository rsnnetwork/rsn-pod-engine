// ─── S20 — recap counts the departed; finished events don't resurrect
// participants (live-test z1, 2026-06-06, 12 participants) ──────────────────
//
// z1 facts (DB-verified): saif (r1) and waseem (r3) were demoted mid-round
// when their MINIMIZED Chrome tabs got throttled (heartbeat stopped → 15s
// grace → demote; the rooms correctly continued). Three recap surfaces then
// under-reported them because they read match SLOTS only — the 4th–6th
// members of the slot-only family (endRound S2, late-return S14, replay S18):
//   - "You attended 3 of 5" (getPeopleMet roundsAttended) — they attended 4;
//   - Mutual Matches said 3 but LISTED 1 (saif) / 2 (waseem) — the counts
//     come from meeting_records (departed-aware) while the connections list
//     came from slots: count/list drift Ali spotted on sight;
//   - Meet Again Rate 25% — the rate divides by the (broken) connections
//     list; true values were 50% (saif) and 60% (waseem).
// Plus: reopening the COMPLETED event from the woken-up tabs fell into the
// join path's auto-checkin and resurrected swept 'left' rows → two
// "Checked In" zombies on the participants page.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S20 — getPeopleMet is departed-aware', () => {
  const fn = () => sliceFn(readServer('services/rating/rating.service.ts'), 'export async function getPeopleMet');

  it('roundsAttended counts slots ∪ departed', () => {
    const f = fn();
    const idx = f.indexOf('COUNT(DISTINCT round_number)');
    const block = f.slice(idx, idx + 500);
    expect(block).toMatch(/\$2 = ANY\(departed_user_ids\)/);
  });

  it('the connections partner expansion unions departed_user_ids with DISTINCT', () => {
    const f = fn();
    expect(f).toMatch(/SELECT DISTINCT pid AS partner_id/);
    expect(f).toMatch(/\|\| COALESCE\(m\.departed_user_ids, '\{\}'::uuid\[\]\)/);
  });

  it('the connections membership filter unions departed_user_ids', () => {
    const f = fn();
    expect(f).toMatch(/m\.participant_c_id = \$1\s*\n\s*OR \$1 = ANY\(m\.departed_user_ids\)/);
  });
});

describe('S20 — rounds_completed counts the departed (endRound)', () => {
  it('attendanceCounts = slots ∪ departed feeds incrementRoundsCompletedBatch; transitions stay slot-only', () => {
    const fn = sliceFn(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function endRound');
    expect(fn).toMatch(/const attendanceCounts = new Map<string, number>\(\)/);
    expect(fn).toMatch(/\.\.\.\(match\.departedUserIds \?\? \[\]\)/);
    expect(fn).toMatch(/incrementRoundsCompletedBatch\(sessionId, attendanceCounts\)/);
    // The IN_MAIN_ROOM walk-back still iterates the SLOT-ONLY map — a
    // departed user may have left the event entirely.
    expect(fn).toMatch(/for \(const userId of roundUserCounts\.keys\(\)\)/);
  });
});

describe('S20 — a finished event never resurrects participants', () => {
  it('the join-path auto-checkin skips COMPLETED and CANCELLED sessions', () => {
    const fn = sliceFn(readServer('services/orchestration/handlers/participant-flow.ts'), 'export async function handleJoinSession');
    expect(fn).toMatch(/effectiveStatus === SessionStatus\.SCHEDULED\s*\n\s*\|\| effectiveStatus === SessionStatus\.COMPLETED\s*\n\s*\|\| effectiveStatus === SessionStatus\.CANCELLED/);
  });
});
